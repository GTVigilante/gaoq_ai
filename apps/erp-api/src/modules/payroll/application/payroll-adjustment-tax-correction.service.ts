import { createHash } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { createEventId } from '@gaoq/shared-utils';
import type { ClientSession, Model } from 'mongoose';
import { z } from 'zod';

import type { AppEnvironment } from '../../../config/environment.js';
import {
  ProductionExecutionAuthorizationService,
  productionExecutionSubjectHash,
  type ProductionExecutionAuthorization,
} from '../../../core/production-execution/production-execution-authorization.service.js';
import { IdempotencyService } from '../../../core/idempotency/idempotency.service.js';
import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { VerifiedAccessToken } from '../../identity/auth.types.js';
import { WebAuthnService } from '../../identity/strong-auth/webauthn.service.js';
import { LegacyPayrollBoundaryService } from '../legacy-payroll-boundary.service.js';
import {
  PayrollTaxGateway,
  PayrollTaxImmutableArchive,
} from '../integration/payroll-tax.ports.js';
import { PayrollDataCryptoService } from '../persistence/payroll-data-crypto.service.js';
import { PayrollOutboxWriter } from '../persistence/payroll-outbox.writer.js';
import {
  PayrollAdjustmentTaxCorrectionRecord,
  type PayrollAdjustmentTaxCorrectionDocument,
} from '../persistence/payroll.schemas.js';
import {
  PayrollAdjustmentService,
  type LockedPayrollTaxCorrectionSource,
} from './payroll-adjustment.service.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const HASH = /^[A-Za-z0-9_-]{43}$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const resultControlSchema = z.object({
  resultHash: z.string().regex(HASH),
  taxableEarningsMinor: z.number().int().safe().nonnegative(),
  withholdingTaxMinor: z.number().int().safe(),
}).strict();
const correctionManifestSchema = z.object({
  schema: z.literal('CN_IIT_WITHHOLDING_CORRECTION_V1'),
  correctionFilingId: z.string().regex(ULID),
  tenantId: z.string().regex(ID),
  adjustmentId: z.string().regex(ULID),
  adjustmentHash: z.string().regex(HASH),
  period: z.string().regex(MONTH),
  reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
  employeeId: z.string().regex(ID),
  original: resultControlSchema,
  corrected: resultControlSchema,
  delta: z.object({
    taxableEarningsMinor: z.number().int().safe(),
    withholdingTaxMinor: z.number().int().safe(),
    cumulativeTaxWithheldMinor: z.number().int().safe(),
  }).strict(),
}).strict();
const protectedCorrectionSchema = z.object({
  content: z.string().min(2).max(8 * 1024 * 1024),
  adjustmentControlActorIds: z.array(z.string().regex(ID)).max(4),
}).strict();

export interface PayrollAdjustmentTaxCorrectionSummary extends Record<string, unknown> {
  readonly id: string;
  readonly adjustmentId: string;
  readonly adjustmentHash: string;
  readonly period: string;
  readonly format: 'CN_IIT_WITHHOLDING_CORRECTION_V1';
  readonly contentHash: string;
  readonly correctedTaxableEarningsMinor: number;
  readonly correctedWithholdingTaxMinor: number;
  readonly taxableEarningsDeltaMinor: number;
  readonly withholdingTaxDeltaMinor: number;
  readonly objectEvidenceId: string | null;
  readonly taxSubmissionId: string | null;
  readonly taxSubmissionEvidenceId: string | null;
  readonly status: 'archiving' | 'prepared' | 'approved' | 'submitting' | 'submitted';
  readonly version: number;
}

/** 标准 MCP 可读取的最小税务更正控制面；不含员工、金额或 WORM 地址。 */
export interface PayrollAdjustmentTaxCorrectionControlSummary extends Record<string, unknown> {
  readonly id: string;
  readonly adjustmentId: string;
  readonly period: string;
  readonly format: 'CN_IIT_WITHHOLDING_CORRECTION_V1';
  readonly contentHash: string;
  readonly objectEvidenceId: string | null;
  readonly taxSubmissionEvidenceId: string | null;
  readonly status: PayrollAdjustmentTaxCorrectionSummary['status'];
  readonly version: number;
}

/**
 * 已锁定工资调整的个税更正链。
 *
 * 清单先落本地密文控制记录，再写独立 WORM；强认证审批和税局提交分别隔离，
 * 税局受理后才回写调整税务终态。
 */
@Injectable()
export class PayrollAdjustmentTaxCorrectionService {
  constructor(
    private readonly idempotency: IdempotencyService,
    private readonly context: TenantContextService,
    private readonly boundary: LegacyPayrollBoundaryService,
    private readonly adjustments: PayrollAdjustmentService,
    private readonly strongAuth: WebAuthnService,
    private readonly crypto: PayrollDataCryptoService,
    private readonly archive: PayrollTaxImmutableArchive,
    private readonly gateway: PayrollTaxGateway,
    private readonly config: ConfigService<AppEnvironment, true>,
    private readonly productionAuthorization: ProductionExecutionAuthorizationService,
    private readonly outbox: PayrollOutboxWriter,
    @InjectModel(PayrollAdjustmentTaxCorrectionRecord.name)
    private readonly corrections: Model<PayrollAdjustmentTaxCorrectionDocument>,
  ) {}

  async prepare(
    key: string,
    adjustmentId: string,
    expectedAdjustmentVersion: number,
  ): Promise<PayrollAdjustmentTaxCorrectionSummary> {
    const actor = this.context.getActorRequired();
    if (
      actor.actorType !== 'user' ||
      !actor.scopes.includes('erp:payroll:adjustment:tax_correction:prepare') ||
      !actor.scopes.includes('erp:payroll:adjustment:tax_correction:source:read')
    ) throw new ForbiddenException({
      code: 'PAYROLL_ADJUSTMENT_TAX_CORRECTION_PREPARER_DENIED',
      message: '工资调整税务更正只允许受控人工税务制备人执行',
    });
    this.boundary.assertLegacy();
    if (
      !ULID.test(adjustmentId) ||
      !Number.isSafeInteger(expectedAdjustmentVersion) ||
      expectedAdjustmentVersion < 1
    ) throw new BadRequestException({
      code: 'PAYROLL_ADJUSTMENT_TAX_CORRECTION_PREPARE_INPUT_INVALID',
      message: '工资调整税务更正来源或版本非法',
    });
    const staged = await this.run(() => this.idempotency.execute(
      'payroll.adjustment_tax_correction.prepare',
      key,
      { adjustmentId, expectedAdjustmentVersion },
      async (session) => {
        const existing = await this.corrections.findOne({
          tenantId: this.tenantId(),
          adjustmentId,
        }).session(session).lean().exec();
        if (existing !== null) {
          if (
            existing.preparedBy !== actor.actorId ||
            !['archiving', 'prepared'].includes(existing.status)
          ) throw new ConflictException({
            code: 'PAYROLL_ADJUSTMENT_TAX_CORRECTION_ALREADY_ADVANCED',
            message: '工资调整税务更正已由其他人员制备或进入后续控制阶段',
          });
          return summary(await this.requireVerifiedCorrection(existing.id, session));
        }
        const source = await this.adjustments.getLockedTaxCorrectionSource(
          adjustmentId,
          expectedAdjustmentVersion,
          session,
        );
        if (source.controlActorIds.includes(actor.actorId)) {
          throw new ForbiddenException({
            code: 'PAYROLL_ADJUSTMENT_TAX_CORRECTION_INDEPENDENCE_REQUIRED',
            message: '税务更正制备人必须独立于调整重算、送审、审批和锁定控制链',
          });
        }
        return this.stage(source, actor.actorId, session);
      },
    ));
    return this.run(() => this.materialize(
      deriveKey(key, 'materialize-tax-correction'),
      staged.id,
    ));
  }

  async approve(
    key: string,
    filingId: string,
    expectedVersion: number,
    evidenceId: string,
    token: VerifiedAccessToken,
  ): Promise<PayrollAdjustmentTaxCorrectionSummary> {
    const actor = this.context.getActorRequired();
    if (
      actor.actorType !== 'user' ||
      token.actorType !== 'user' ||
      token.tenantId !== this.tenantId() ||
      token.actorId !== actor.actorId ||
      !actor.scopes.includes('erp:payroll:adjustment:tax_correction:approve')
    ) throw new ForbiddenException({
      code: 'PAYROLL_ADJUSTMENT_TAX_CORRECTION_APPROVER_DENIED',
      message: '工资调整税务更正审批身份上下文非法',
    });
    this.boundary.assertLegacy();
    assertVersionCommand(filingId, expectedVersion, evidenceId);
    const evidence = await this.strongAuth.requireVerifiedEvidence({
      evidenceId,
      tenantId: token.tenantId,
      actorId: token.actorId,
      sessionId: token.sessionId,
      operationId: filingId,
    });
    return this.run(() => this.idempotency.execute(
      'payroll.adjustment_tax_correction.approve',
      key,
      { filingId, expectedVersion, evidenceId },
      async (session) => {
        const filing = await this.requireVerifiedCorrection(filingId, session);
        const protectedData = protectedCorrectionSchema.parse(this.crypto.unprotect({
          tenantId: this.tenantId(),
          resourceType: 'adjustment_tax_correction',
          resourceId: filing.id,
          version: 1,
        }, protectedValue(filing)));
        if (
          filing.status !== 'prepared' ||
          filing.version !== expectedVersion ||
          filing.objectRef === null ||
          filing.objectEvidenceId === null ||
          filing.preparedBy === actor.actorId ||
          protectedData.adjustmentControlActorIds.includes(actor.actorId)
        ) throw new ConflictException({
          code: 'PAYROLL_ADJUSTMENT_TAX_CORRECTION_APPROVAL_STATE_INVALID',
          message: '税务更正清单未归档、版本变化或审批职责未分离',
        });
        const updated = await this.corrections.updateOne({
          tenantId: this.tenantId(),
          id: filing.id,
          status: 'prepared',
          version: expectedVersion,
        }, { $set: {
          approvedBy: actor.actorId,
          strongAuthEvidenceId: evidence.evidenceId,
          strongAuthReferenceType: 'webauthn_evidence',
          status: 'approved',
          version: expectedVersion + 1,
        } }, { session, runValidators: true });
        if (updated.modifiedCount !== 1) throw new ConflictException({
          code: 'PAYROLL_ADJUSTMENT_TAX_CORRECTION_APPROVAL_WRITE_CONFLICT',
          message: '工资调整税务更正审批发生并发冲突',
        });
        await this.outbox.append({
          type: 'payroll.adjustment_tax_correction.approved',
          tenantId: this.tenantId(),
          aggregateId: filing.id,
          version: expectedVersion + 1,
          occurredAt: new Date().toISOString(),
          data: {
            adjustmentHash: filing.adjustmentHash,
            period: filing.period,
            contentHash: filing.contentHash,
            strongAuthMethod: evidence.method,
            status: 'approved',
          },
        }, session);
        return summary({
          ...filing,
          approvedBy: actor.actorId,
          strongAuthEvidenceId: evidence.evidenceId,
          strongAuthReferenceType: 'webauthn_evidence',
          status: 'approved',
          version: expectedVersion + 1,
        });
      },
    ));
  }

  async submit(
    key: string,
    filingId: string,
    expectedVersion: number,
  ): Promise<PayrollAdjustmentTaxCorrectionSummary> {
    const actor = this.context.getActorRequired();
    if (
      !['service', 'system_job'].includes(actor.actorType) ||
      !actor.scopes.includes('erp:payroll:adjustment:tax_correction:submit')
    ) throw new ForbiddenException({
      code: 'PAYROLL_ADJUSTMENT_TAX_CORRECTION_SUBMITTER_DENIED',
      message: '工资调整税务更正只允许受信任税务连接器提交',
    });
    this.boundary.assertLegacy();
    assertVersionCommand(filingId, expectedVersion);
    const authorization = await this.authorizeProductionSubmission(
      filingId,
      expectedVersion,
    );
    const staged = await this.run(() => this.idempotency.execute(
      'payroll.adjustment_tax_correction.stage_submission',
      key,
      { filingId, expectedVersion },
      async (session) => {
        const filing = await this.requireVerifiedCorrection(filingId, session);
        if (
          filing.status === 'submitted' &&
          filing.version === expectedVersion + 1 &&
          filing.taxSubmissionId !== null &&
          filing.taxSubmissionEvidenceId !== null
        ) return summary(filing);
        if (
          filing.status === 'submitting' &&
          filing.version === expectedVersion &&
          filing.objectRef !== null
        ) return summary(filing);
        if (
          filing.status !== 'approved' ||
          filing.version !== expectedVersion ||
          filing.objectRef === null ||
          filing.objectEvidenceId === null ||
          filing.approvedBy === null ||
          filing.strongAuthEvidenceId === null
        ) throw new ConflictException({
          code: 'PAYROLL_ADJUSTMENT_TAX_CORRECTION_SUBMISSION_STATE_INVALID',
          message: '工资调整税务更正未完成有效审批或版本已变化',
        });
        const updated = await this.corrections.updateOne({
          tenantId: this.tenantId(),
          id: filing.id,
          status: 'approved',
          version: expectedVersion,
        }, { $set: { status: 'submitting' } }, { session, runValidators: true });
        if (updated.modifiedCount !== 1) throw new ConflictException({
          code: 'PAYROLL_ADJUSTMENT_TAX_CORRECTION_SUBMISSION_STAGE_CONFLICT',
          message: '工资调整税务更正提交暂存发生并发冲突',
        });
        return summary({ ...filing, status: 'submitting' });
      },
    ));
    if (staged.status === 'submitted') return staged;
    const filing = await this.requireVerifiedCorrection(filingId);
    if (
      filing.status !== 'submitting' ||
      filing.version !== expectedVersion ||
      filing.objectRef === null
    ) throw new ConflictException({
      code: 'PAYROLL_ADJUSTMENT_TAX_CORRECTION_SUBMISSION_STAGE_INVALID',
      message: '工资调整税务更正提交暂存状态非法',
    });
    const receipt = await this.gateway.submit({
      tenantId: this.tenantId(),
      filingId: filing.id,
      period: filing.period,
      objectRef: filing.objectRef,
      contentHash: filing.contentHash,
      employeeCount: 1,
      totalTaxableEarningsMinor: filing.correctedTaxableEarningsMinor,
      totalWithholdingTaxMinor: filing.correctedWithholdingTaxMinor,
      productionAuthorization: authorization,
    });
    return this.run(() => this.idempotency.execute(
      'payroll.adjustment_tax_correction.finalize_submission',
      deriveKey(key, 'finalize-tax-correction'),
      {
        filingId,
        expectedVersion,
        submissionId: receipt.submissionId,
        evidenceId: receipt.evidenceId,
      },
      async (session) => {
        const current = await this.requireVerifiedCorrection(filingId, session);
        if (
          current.status === 'submitted' &&
          current.version === expectedVersion + 1 &&
          current.taxSubmissionId === receipt.submissionId &&
          current.taxSubmissionEvidenceId === receipt.evidenceId
        ) return summary(current);
        if (current.status !== 'submitting' || current.version !== expectedVersion) {
          throw new ConflictException({
            code: 'PAYROLL_ADJUSTMENT_TAX_CORRECTION_FINALIZE_STATE_INVALID',
            message: '工资调整税务更正提交终态或版本非法',
          });
        }
        const updated = await this.corrections.updateOne({
          tenantId: this.tenantId(),
          id: current.id,
          status: 'submitting',
          version: expectedVersion,
        }, { $set: {
          taxSubmissionId: receipt.submissionId,
          taxSubmissionEvidenceId: receipt.evidenceId,
          status: 'submitted',
          version: expectedVersion + 1,
        } }, { session, runValidators: true });
        if (updated.modifiedCount !== 1) throw new ConflictException({
          code: 'PAYROLL_ADJUSTMENT_TAX_CORRECTION_SUBMISSION_WRITE_CONFLICT',
          message: '工资调整税务更正提交发生并发冲突',
        });
        await this.adjustments.recordTaxCorrectionSubmitted({
          adjustmentId: current.adjustmentId,
          adjustmentHash: current.adjustmentHash,
          filingId: current.id,
        }, session);
        await this.outbox.append({
          type: 'payroll.adjustment_tax_correction.submitted',
          tenantId: this.tenantId(),
          aggregateId: current.id,
          version: expectedVersion + 1,
          occurredAt: new Date().toISOString(),
          data: {
            adjustmentHash: current.adjustmentHash,
            period: current.period,
            contentHash: current.contentHash,
            taxSubmissionId: receipt.submissionId,
            taxSubmissionEvidenceId: receipt.evidenceId,
            ...(receipt.productionAuthorizationEvidenceId === null ? {} : {
              productionAuthorizationEvidenceId:
                receipt.productionAuthorizationEvidenceId,
            }),
            status: 'submitted',
          },
        }, session);
        return summary({
          ...current,
          taxSubmissionId: receipt.submissionId,
          taxSubmissionEvidenceId: receipt.evidenceId,
          status: 'submitted',
          version: expectedVersion + 1,
        });
      },
    ));
  }

  async get(id: string): Promise<PayrollAdjustmentTaxCorrectionSummary> {
    this.assertScope('erp:payroll:adjustment:tax_correction:read');
    this.boundary.assertLegacy();
    return this.run(async () => summary(await this.requireVerifiedCorrection(id)));
  }

  async getControlStatus(
    id: string,
  ): Promise<PayrollAdjustmentTaxCorrectionControlSummary> {
    const value = await this.get(id);
    return Object.freeze({
      id: value.id,
      adjustmentId: value.adjustmentId,
      period: value.period,
      format: value.format,
      contentHash: value.contentHash,
      objectEvidenceId: value.objectEvidenceId,
      taxSubmissionEvidenceId: value.taxSubmissionEvidenceId,
      status: value.status,
      version: value.version,
    });
  }

  private async stage(
    source: LockedPayrollTaxCorrectionSource,
    preparedBy: string,
    session: ClientSession,
  ): Promise<PayrollAdjustmentTaxCorrectionSummary> {
    const now = new Date();
    const id = createEventId(now);
    const manifest = correctionManifestSchema.parse({
      schema: 'CN_IIT_WITHHOLDING_CORRECTION_V1',
      correctionFilingId: id,
      tenantId: this.tenantId(),
      adjustmentId: source.adjustmentId,
      adjustmentHash: source.adjustmentHash,
      period: source.period,
      reasonCode: source.reasonCode,
      employeeId: source.employeeId,
      original: {
        resultHash: source.originalResultHash,
        taxableEarningsMinor: source.originalTaxableEarningsMinor,
        withholdingTaxMinor: source.originalWithholdingTaxMinor,
      },
      corrected: {
        resultHash: source.correctedResultHash,
        taxableEarningsMinor: source.correctedTaxableEarningsMinor,
        withholdingTaxMinor: source.correctedWithholdingTaxMinor,
      },
      delta: {
        taxableEarningsMinor: source.taxableEarningsDeltaMinor,
        withholdingTaxMinor: source.withholdingTaxDeltaMinor,
        cumulativeTaxWithheldMinor: source.cumulativeTaxWithheldDeltaMinor,
      },
    });
    const content = JSON.stringify(manifest);
    const contentHash = digest(content);
    const protectedData = this.crypto.protect({
      tenantId: this.tenantId(),
      resourceType: 'adjustment_tax_correction',
      resourceId: id,
      version: 1,
    }, {
      content,
      adjustmentControlActorIds: source.controlActorIds,
    });
    const record: PayrollAdjustmentTaxCorrectionRecord = {
      id,
      tenantId: this.tenantId(),
      adjustmentId: source.adjustmentId,
      adjustmentHash: source.adjustmentHash,
      period: source.period,
      format: 'CN_IIT_WITHHOLDING_CORRECTION_V1',
      contentHash,
      correctedTaxableEarningsMinor: source.correctedTaxableEarningsMinor,
      correctedWithholdingTaxMinor: source.correctedWithholdingTaxMinor,
      taxableEarningsDeltaMinor: source.taxableEarningsDeltaMinor,
      withholdingTaxDeltaMinor: source.withholdingTaxDeltaMinor,
      preparedBy,
      approvedBy: null,
      strongAuthEvidenceId: null,
      strongAuthReferenceType: null,
      objectRef: null,
      objectEvidenceId: null,
      taxSubmissionId: null,
      taxSubmissionEvidenceId: null,
      status: 'archiving',
      version: 1,
      dataKeyId: protectedData.keyId,
      dataIv: protectedData.iv,
      dataCiphertext: protectedData.ciphertext,
      dataAuthTag: protectedData.authTag,
      createdAt: now,
      updatedAt: now,
    };
    await this.corrections.create([record], { session });
    await this.adjustments.recordTaxCorrectionPrepared({
      adjustmentId: source.adjustmentId,
      adjustmentHash: source.adjustmentHash,
      filingId: id,
      expectedVersion: source.adjustmentVersion,
    }, session);
    return summary(record);
  }

  private async materialize(
    key: string,
    filingId: string,
  ): Promise<PayrollAdjustmentTaxCorrectionSummary> {
    const filing = await this.requireVerifiedCorrection(filingId);
    if (filing.status !== 'archiving') return summary(filing);
    const protectedData = protectedCorrectionSchema.parse(this.crypto.unprotect({
      tenantId: this.tenantId(),
      resourceType: 'adjustment_tax_correction',
      resourceId: filing.id,
      version: 1,
    }, protectedValue(filing)));
    const bytes = Buffer.from(protectedData.content, 'utf8');
    const receipt = await this.archive.put({
      tenantId: this.tenantId(),
      filingId: filing.id,
      objectKey: `payroll-tax/${filing.id}/${filing.contentHash}.json`,
      sha256: filing.contentHash,
      bytes,
    });
    return this.run(() => this.idempotency.execute(
      'payroll.adjustment_tax_correction.materialize',
      key,
      {
        filingId,
        contentHash: filing.contentHash,
        objectEvidenceId: receipt.evidenceId,
      },
      async (session) => {
        const current = await this.requireVerifiedCorrection(filingId, session);
        if (
          current.status === 'prepared' &&
          current.version === 2 &&
          current.objectRef === receipt.objectRef &&
          current.objectEvidenceId === receipt.evidenceId
        ) return summary(current);
        if (current.status !== 'archiving' || current.version !== 1) {
          throw new ConflictException({
            code: 'PAYROLL_ADJUSTMENT_TAX_CORRECTION_MATERIALIZE_STATE_INVALID',
            message: '工资调整税务更正归档终态或版本非法',
          });
        }
        const updated = await this.corrections.updateOne({
          tenantId: this.tenantId(),
          id: current.id,
          status: 'archiving',
          version: 1,
        }, { $set: {
          objectRef: receipt.objectRef,
          objectEvidenceId: receipt.evidenceId,
          status: 'prepared',
          version: 2,
        } }, { session, runValidators: true });
        if (updated.modifiedCount !== 1) throw new ConflictException({
          code: 'PAYROLL_ADJUSTMENT_TAX_CORRECTION_MATERIALIZE_WRITE_CONFLICT',
          message: '工资调整税务更正归档发生并发冲突',
        });
        await this.outbox.append({
          type: 'payroll.adjustment_tax_correction.prepared',
          tenantId: this.tenantId(),
          aggregateId: current.id,
          version: 2,
          occurredAt: new Date().toISOString(),
          data: {
            adjustmentHash: current.adjustmentHash,
            period: current.period,
            contentHash: current.contentHash,
            objectEvidenceId: receipt.evidenceId,
            status: 'prepared',
          },
        }, session);
        return summary({
          ...current,
          objectRef: receipt.objectRef,
          objectEvidenceId: receipt.evidenceId,
          status: 'prepared',
          version: 2,
        });
      },
    ));
  }

  private async requireVerifiedCorrection(
    id: string,
    session?: ClientSession,
  ): Promise<PayrollAdjustmentTaxCorrectionRecord> {
    if (!ULID.test(id)) throw new BadRequestException({
      code: 'PAYROLL_ADJUSTMENT_TAX_CORRECTION_ID_INVALID',
      message: '工资调整税务更正标识非法',
    });
    const query = this.corrections.findOne({ tenantId: this.tenantId(), id });
    if (session !== undefined) query.session(session);
    const record = await query.lean().exec();
    if (record === null) throw new NotFoundException({
      code: 'PAYROLL_ADJUSTMENT_TAX_CORRECTION_NOT_FOUND',
      message: '工资调整税务更正清单不存在',
    });
    const protectedData = protectedCorrectionSchema.parse(this.crypto.unprotect({
      tenantId: this.tenantId(),
      resourceType: 'adjustment_tax_correction',
      resourceId: record.id,
      version: 1,
    }, protectedValue(record)));
    const manifest = correctionManifestSchema.parse(
      JSON.parse(protectedData.content) as unknown,
    );
    if (
      digest(protectedData.content) !== record.contentHash ||
      manifest.correctionFilingId !== record.id ||
      manifest.tenantId !== record.tenantId ||
      manifest.adjustmentId !== record.adjustmentId ||
      manifest.adjustmentHash !== record.adjustmentHash ||
      manifest.period !== record.period ||
      manifest.corrected.taxableEarningsMinor !==
        record.correctedTaxableEarningsMinor ||
      manifest.corrected.withholdingTaxMinor !==
        record.correctedWithholdingTaxMinor ||
      manifest.delta.taxableEarningsMinor !== record.taxableEarningsDeltaMinor ||
      manifest.delta.withholdingTaxMinor !== record.withholdingTaxDeltaMinor
    ) throw new ConflictException({
      code: 'PAYROLL_ADJUSTMENT_TAX_CORRECTION_INTEGRITY_FAILED',
      message: '工资调整税务更正控制字段、密文或正文摘要不一致',
    });
    return record;
  }

  private async authorizeProductionSubmission(
    filingId: string,
    expectedVersion: number,
  ): Promise<ProductionExecutionAuthorization | null> {
    if (this.config.get('PAYROLL_TAX_GATEWAY_MODE', { infer: true }) !== 'production') {
      return null;
    }
    const filing = await this.requireVerifiedCorrection(filingId);
    if (
      filing.status === 'submitted' &&
      filing.version === expectedVersion + 1
    ) return null;
    if (
      !['approved', 'submitting'].includes(filing.status) ||
      filing.version !== expectedVersion ||
      filing.objectRef === null
    ) throw new ConflictException({
      code: 'PAYROLL_ADJUSTMENT_TAX_CORRECTION_AUTHORIZATION_SUBJECT_INVALID',
      message: '工资调整税务更正状态、版本或不可变对象不足以申请生产授权',
    });
    return this.productionAuthorization.authorize({
      action: 'payroll-tax-submission',
      tenantId: this.tenantId(),
      resourceId: filing.id,
      subjectHash: productionExecutionSubjectHash([
        filing.adjustmentId,
        filing.adjustmentHash,
        filing.period,
        filing.objectRef,
        filing.contentHash,
        filing.correctedTaxableEarningsMinor,
        filing.correctedWithholdingTaxMinor,
      ]),
      expectedVersion,
    });
  }

  private assertScope(scope: string): void {
    if (!this.context.getActorRequired().scopes.includes(scope)) {
      throw new ForbiddenException({
        code: 'PAYROLL_ADJUSTMENT_TAX_CORRECTION_SCOPE_REQUIRED',
        message: `缺少必要权限 ${scope}`,
      });
    }
  }

  private tenantId(): string {
    return this.context.getTenantRequired().tenantId;
  }

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof SyntaxError) {
        throw new ConflictException({
          code: 'PAYROLL_ADJUSTMENT_TAX_CORRECTION_PROTECTED_DATA_INVALID',
          message: '工资调整税务更正受保护数据非法',
        });
      }
      if (
        typeof error === 'object' &&
        error !== null &&
        (error as { readonly code?: unknown }).code === 11_000
      ) throw new ConflictException({
        code: 'PAYROLL_ADJUSTMENT_TAX_CORRECTION_ALREADY_EXISTS',
        message: '工资调整已存在税务更正清单',
      });
      throw error;
    }
  }
}

function summary(
  record: PayrollAdjustmentTaxCorrectionRecord,
): PayrollAdjustmentTaxCorrectionSummary {
  return Object.freeze({
    id: record.id,
    adjustmentId: record.adjustmentId,
    adjustmentHash: record.adjustmentHash,
    period: record.period,
    format: record.format,
    contentHash: record.contentHash,
    correctedTaxableEarningsMinor: record.correctedTaxableEarningsMinor,
    correctedWithholdingTaxMinor: record.correctedWithholdingTaxMinor,
    taxableEarningsDeltaMinor: record.taxableEarningsDeltaMinor,
    withholdingTaxDeltaMinor: record.withholdingTaxDeltaMinor,
    objectEvidenceId: record.objectEvidenceId,
    taxSubmissionId: record.taxSubmissionId,
    taxSubmissionEvidenceId: record.taxSubmissionEvidenceId,
    status: record.status,
    version: record.version,
  });
}

function assertVersionCommand(
  filingId: string,
  expectedVersion: number,
  evidenceId?: string,
): void {
  if (
    !ULID.test(filingId) ||
    !Number.isSafeInteger(expectedVersion) ||
    expectedVersion < 1 ||
    (evidenceId !== undefined && !ULID.test(evidenceId))
  ) throw new BadRequestException({
    code: 'PAYROLL_ADJUSTMENT_TAX_CORRECTION_COMMAND_INVALID',
    message: '工资调整税务更正命令引用非法',
  });
}

function deriveKey(key: string, suffix: string): string {
  return createHash('sha256')
    .update(JSON.stringify([key, suffix]), 'utf8')
    .digest('base64url');
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64url');
}

function protectedValue(record: PayrollAdjustmentTaxCorrectionRecord) {
  return {
    keyId: record.dataKeyId,
    iv: record.dataIv,
    ciphertext: record.dataCiphertext,
    authTag: record.dataAuthTag,
  };
}
