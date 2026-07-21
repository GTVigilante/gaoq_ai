import { createHash } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createEventId } from '@gaoq/shared-utils';
import type { ClientSession, Model } from 'mongoose';
import { z } from 'zod';

import { IdempotencyService } from '../../../core/idempotency/idempotency.service.js';
import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import {
  EmploymentRepository,
  PersonRepository,
} from '../../org/persistence/org.repositories.js';
import type { VerifiedAccessToken } from '../../identity/auth.types.js';
import { WebAuthnService } from '../../identity/strong-auth/webauthn.service.js';
import {
  generateTaxFilingManifest,
  payrollDigest,
  TaxFilingManifestError,
} from '../domain/index.js';
import {
  PayrollTaxGateway,
  PayrollTaxImmutableArchive,
} from '../integration/payroll-tax.ports.js';
import { PayrollDataCryptoService } from '../persistence/payroll-data-crypto.service.js';
import { PayrollOutboxWriter } from '../persistence/payroll-outbox.writer.js';
import {
  PayrollCalculationLineRecord,
  type PayrollCalculationLineDocument,
  PayrollPeriodRecord,
  type PayrollPeriodDocument,
  PayrollTaxFilingRecord,
  type PayrollTaxFilingDocument,
} from '../persistence/payroll.schemas.js';

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const HASH = /^[A-Za-z0-9_-]{43}$/;
const cumulativeSchema = z.object({
  taxableIncomeMinor: z.number().int().safe().nonnegative(),
  basicDeductionMinor: z.number().int().safe().nonnegative(),
  socialInsuranceMinor: z.number().int().safe().nonnegative(),
  housingFundMinor: z.number().int().safe().nonnegative(),
  specialAdditionalDeductionMinor: z.number().int().safe().nonnegative(),
  otherDeductionMinor: z.number().int().safe().nonnegative(),
  taxWithheldMinor: z.number().int().safe().nonnegative(),
}).strict();
const resultSchema = z.object({
  currency: z.literal('CNY'), inputHash: z.string().regex(HASH),
  grossPayMinor: z.number().int().safe().nonnegative(),
  taxableEarningsMinor: z.number().int().safe().nonnegative(),
  withholdingTaxMinor: z.number().int().safe(), netPayMinor: z.number().int().safe().nonnegative(),
  cumulativeAfter: cumulativeSchema, steps: z.array(z.unknown()), resultHash: z.string().regex(HASH),
}).strict();
const protectedManifestSchema = z.object({ content: z.string().min(2).max(8 * 1024 * 1024) }).strict();

export interface PayrollTaxFilingSummary extends Record<string, unknown> {
  readonly id: string;
  readonly periodId: string;
  readonly payrollRunId: string;
  readonly format: 'CN_IIT_WITHHOLDING_MANIFEST_V1';
  readonly status: 'archiving' | 'prepared' | 'approved' | 'submitting' | 'submitted' | 'rejected';
  readonly version: number;
  readonly contentHash: string;
  readonly employeeCount: number;
  readonly totalTaxableEarningsMinor: number;
  readonly totalWithholdingTaxMinor: number;
  readonly objectEvidenceId: string | null;
  readonly taxSubmissionId: string | null;
  readonly taxSubmissionEvidenceId: string | null;
}

/** 锁定工资到税务内部规范清单的两阶段 WORM 制备；不接触证件明文或官方税局凭据。 */
@Injectable()
export class PayrollTaxFilingService {
  constructor(
    private readonly idempotency: IdempotencyService,
    private readonly context: TenantContextService,
    private readonly employments: EmploymentRepository,
    private readonly persons: PersonRepository,
    private readonly strongAuth: WebAuthnService,
    private readonly crypto: PayrollDataCryptoService,
    private readonly archive: PayrollTaxImmutableArchive,
    private readonly gateway: PayrollTaxGateway,
    private readonly outbox: PayrollOutboxWriter,
    @InjectModel(PayrollPeriodRecord.name)
    private readonly periods: Model<PayrollPeriodDocument>,
    @InjectModel(PayrollCalculationLineRecord.name)
    private readonly lines: Model<PayrollCalculationLineDocument>,
    @InjectModel(PayrollTaxFilingRecord.name)
    private readonly filings: Model<PayrollTaxFilingDocument>,
  ) {}

  async getStatus(filingId: string): Promise<PayrollTaxFilingSummary> {
    const actor = this.context.getActorRequired();
    if (!actor.scopes.includes('erp:payroll:tax:read')) throw new ForbiddenException({
      code: 'AUTH_SCOPE_DENIED', message: '缺少个税申报状态读取权限',
    });
    if (!ULID.test(filingId)) throw new BadRequestException({
      code: 'PAYROLL_TAX_FILING_ID_INVALID', message: '个税申报清单标识非法',
    });
    return summary(await this.requireFiling(filingId));
  }

  async approve(
    key: string,
    filingId: string,
    expectedVersion: number,
    evidenceId: string,
    token: VerifiedAccessToken,
  ): Promise<PayrollTaxFilingSummary> {
    const actor = this.context.getActorRequired();
    if (!actor.scopes.includes('erp:payroll:tax:approve')) throw new ForbiddenException({
      code: 'AUTH_SCOPE_DENIED', message: '缺少个税申报审批权限',
    });
    if (
      actor.actorType !== 'user' || token.actorType !== 'user' ||
      token.tenantId !== this.tenantId() || token.actorId !== actor.actorId
    ) throw new ForbiddenException({
      code: 'PAYROLL_TAX_APPROVER_IDENTITY_INVALID', message: '个税申报审批身份上下文非法',
    });
    if (
      !ULID.test(filingId) || !ULID.test(evidenceId) ||
      !Number.isSafeInteger(expectedVersion) || expectedVersion < 1
    ) throw new BadRequestException({
      code: 'PAYROLL_TAX_APPROVAL_INPUT_INVALID', message: '个税申报审批引用非法',
    });
    const evidence = await this.strongAuth.requireVerifiedEvidence({
      evidenceId, tenantId: token.tenantId, actorId: token.actorId,
      sessionId: token.sessionId, operationId: filingId,
    });
    return this.run(() => this.idempotency.execute(
      'payroll.tax_filing.approve', key, { filingId, expectedVersion, evidenceId },
      async (session) => {
        const filing = await this.requireFiling(filingId, session);
        const period = await this.requirePeriod(filing.periodId, session);
        const conflictingActors = new Set([
          filing.preparedBy, period.preparedBy, period.approvedBy, period.lockedBy,
        ].filter((value): value is string => typeof value === 'string'));
        if (
          filing.status !== 'prepared' || filing.version !== expectedVersion ||
          filing.objectRef === null || filing.objectEvidenceId === null ||
          conflictingActors.has(actor.actorId)
        ) throw new ConflictException({
          code: 'PAYROLL_TAX_APPROVAL_STATE_INVALID',
          message: '个税清单未完成归档、版本变化或审批职责未分离',
        });
        const updated = await this.filings.updateOne({
          tenantId: this.tenantId(), id: filing.id,
          status: 'prepared', version: expectedVersion,
        }, { $set: {
          status: 'approved', version: expectedVersion + 1,
          approvedBy: actor.actorId, strongAuthEvidenceId: evidence.evidenceId,
        } }, { session, runValidators: true });
        if (updated.modifiedCount !== 1) throw new ConflictException({
          code: 'PAYROLL_TAX_APPROVAL_WRITE_CONFLICT', message: '个税申报审批发生并发冲突',
        });
        await this.outbox.append({
          type: 'payroll.tax_filing.approved', tenantId: this.tenantId(),
          aggregateId: filing.id, version: expectedVersion + 1,
          occurredAt: new Date().toISOString(), data: {
            period: period.period, payrollRunId: filing.payrollRunId,
            contentHash: filing.contentHash, employeeCount: filing.employeeCount,
            totalTaxableEarningsMinor: filing.totalTaxableEarningsMinor,
            totalWithholdingTaxMinor: filing.totalWithholdingTaxMinor,
            strongAuthMethod: evidence.method, status: 'approved',
          },
        }, session);
        return summary({
          ...filing, status: 'approved', version: expectedVersion + 1,
          approvedBy: actor.actorId, strongAuthEvidenceId: evidence.evidenceId,
        });
      },
    ));
  }

  async submit(
    key: string,
    filingId: string,
    expectedVersion: number,
  ): Promise<PayrollTaxFilingSummary> {
    const actor = this.context.getActorRequired();
    if (!actor.scopes.includes('erp:payroll:tax:submit')) throw new ForbiddenException({
      code: 'AUTH_SCOPE_DENIED', message: '缺少个税申报提交权限',
    });
    if (actor.actorType !== 'service' && actor.actorType !== 'system_job') {
      throw new ForbiddenException({
        code: 'PAYROLL_TAX_SUBMISSION_SERVICE_REQUIRED',
        message: '只允许受信任税务连接器执行个税申报提交',
      });
    }
    if (!ULID.test(filingId) || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      throw new BadRequestException({
        code: 'PAYROLL_TAX_SUBMISSION_INPUT_INVALID', message: '个税申报提交引用非法',
      });
    }
    const staged = await this.run(() => this.idempotency.execute(
      'payroll.tax_filing.stage_submission', key, { filingId, expectedVersion },
      async (session) => {
        const filing = await this.requireFiling(filingId, session);
        if (
          filing.status === 'submitted' && filing.version === expectedVersion + 1 &&
          filing.taxSubmissionId !== null && filing.taxSubmissionEvidenceId !== null
        ) return summary(filing);
        if (
          filing.status === 'submitting' && filing.version === expectedVersion &&
          filing.objectRef !== null && filing.objectEvidenceId !== null
        ) return summary(filing);
        if (
          filing.status !== 'approved' || filing.version !== expectedVersion ||
          filing.objectRef === null || filing.objectEvidenceId === null ||
          filing.approvedBy === null || filing.strongAuthEvidenceId === null
        ) throw new ConflictException({
          code: 'PAYROLL_TAX_SUBMISSION_STATE_INVALID',
          message: '个税清单未完成有效审批或版本已变化',
        });
        const updated = await this.filings.updateOne({
          tenantId: this.tenantId(), id: filing.id,
          status: 'approved', version: expectedVersion,
        }, { $set: { status: 'submitting' } }, { session, runValidators: true });
        if (updated.modifiedCount !== 1) throw new ConflictException({
          code: 'PAYROLL_TAX_SUBMISSION_STAGE_CONFLICT', message: '个税申报提交暂存发生并发冲突',
        });
        return summary({ ...filing, status: 'submitting' });
      },
    ));
    if (
      staged.status === 'submitted' && staged.taxSubmissionId !== null &&
      staged.taxSubmissionEvidenceId !== null
    ) return staged;
    const filing = await this.requireFiling(staged.id);
    const period = await this.requirePeriod(filing.periodId);
    if (
      filing.status !== 'submitting' || filing.version !== expectedVersion ||
      filing.objectRef === null || filing.objectEvidenceId === null
    ) throw new ConflictException({
      code: 'PAYROLL_TAX_SUBMISSION_STAGE_INVALID', message: '个税申报提交暂存状态非法',
    });
    const receipt = await this.gateway.submit({
      tenantId: this.tenantId(), filingId: filing.id, period: period.period,
      objectRef: filing.objectRef, contentHash: filing.contentHash,
      employeeCount: filing.employeeCount,
      totalTaxableEarningsMinor: filing.totalTaxableEarningsMinor,
      totalWithholdingTaxMinor: filing.totalWithholdingTaxMinor,
    });
    return this.run(() => this.idempotency.execute(
      'payroll.tax_filing.finalize_submission', deriveKey(key, 'finalize-submission'), {
        filingId, expectedVersion, submissionId: receipt.submissionId,
        evidenceId: receipt.evidenceId,
      }, async (session) => {
        const current = await this.requireFiling(filingId, session);
        if (
          current.status === 'submitted' && current.version === expectedVersion + 1 &&
          current.taxSubmissionId === receipt.submissionId &&
          current.taxSubmissionEvidenceId === receipt.evidenceId
        ) return summary(current);
        if (current.status !== 'submitting' || current.version !== expectedVersion) {
          throw new ConflictException({
            code: 'PAYROLL_TAX_SUBMISSION_FINALIZE_STATE_INVALID',
            message: '个税申报提交完成状态或版本非法',
          });
        }
        const updated = await this.filings.updateOne({
          tenantId: this.tenantId(), id: current.id,
          status: 'submitting', version: expectedVersion,
        }, { $set: {
          status: 'submitted', version: expectedVersion + 1,
          taxSubmissionId: receipt.submissionId,
          taxSubmissionEvidenceId: receipt.evidenceId,
        } }, { session, runValidators: true });
        if (updated.modifiedCount !== 1) throw new ConflictException({
          code: 'PAYROLL_TAX_SUBMISSION_WRITE_CONFLICT', message: '个税申报提交发生并发冲突',
        });
        await this.outbox.append({
          type: 'payroll.tax_filing.submitted', tenantId: this.tenantId(),
          aggregateId: current.id, version: expectedVersion + 1,
          occurredAt: new Date().toISOString(), data: {
            period: period.period, payrollRunId: current.payrollRunId,
            contentHash: current.contentHash, employeeCount: current.employeeCount,
            totalTaxableEarningsMinor: current.totalTaxableEarningsMinor,
            totalWithholdingTaxMinor: current.totalWithholdingTaxMinor,
            taxSubmissionId: receipt.submissionId,
            taxSubmissionEvidenceId: receipt.evidenceId, status: 'submitted',
          },
        }, session);
        return summary({
          ...current, status: 'submitted', version: expectedVersion + 1,
          taxSubmissionId: receipt.submissionId,
          taxSubmissionEvidenceId: receipt.evidenceId,
        });
      },
    ));
  }

  async prepare(
    key: string,
    periodId: string,
    expectedVersion: number,
  ): Promise<PayrollTaxFilingSummary> {
    const actor = this.context.getActorRequired();
    if (!actor.scopes.includes('erp:payroll:tax:prepare')) throw new ForbiddenException({
      code: 'AUTH_SCOPE_DENIED', message: '缺少个税申报制备权限',
    });
    if (actor.actorType !== 'user') throw new ForbiddenException({
      code: 'PAYROLL_TAX_PREPARER_HUMAN_REQUIRED', message: '个税申报制备只能由已验证人员执行',
    });
    if (!ULID.test(periodId) || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      throw new BadRequestException({
        code: 'PAYROLL_TAX_PREPARE_INPUT_INVALID', message: '个税申报制备引用非法',
      });
    }
    const staged = await this.run(() => this.idempotency.execute(
      'payroll.tax_filing.stage', key, { periodId, expectedVersion },
      async (session) => this.stage(periodId, expectedVersion, actor.actorId, session),
    ));
    return this.materialize(deriveKey(key, 'materialize-tax'), staged.id);
  }

  private async stage(
    periodId: string,
    expectedVersion: number,
    preparedBy: string,
    session: ClientSession,
  ): Promise<PayrollTaxFilingSummary> {
    const existing = await this.filings.findOne({
      tenantId: this.tenantId(), periodId,
    }).session(session).lean().exec();
    if (existing !== null) {
      if (existing.preparedBy !== preparedBy || existing.status === 'rejected') {
        throw new ConflictException({
          code: 'PAYROLL_TAX_FILING_ALREADY_EXISTS',
          message: '工资周期已由其他制备人创建个税清单或清单已拒绝',
        });
      }
      return summary(existing);
    }
    const period = await this.periods.findOne({
      tenantId: this.tenantId(), id: periodId,
    }).session(session).lean().exec();
    if (period === null) throw new NotFoundException({
      code: 'PAYROLL_PERIOD_NOT_FOUND', message: '工资周期不存在',
    });
    if (
      period.status !== 'locked' || period.version !== expectedVersion ||
      period.activeRunId === null || period.resultHash === null || period.employeeCount === null ||
      period.totalTaxMinor === null || period.lockedBy === null ||
      preparedBy === period.lockedBy || preparedBy === period.preparedBy
    ) throw new ConflictException({
      code: 'PAYROLL_TAX_PERIOD_NOT_READY', message: '工资周期未锁定、版本变化或职责未分离',
    });
    const records = await this.lines.find({
      tenantId: this.tenantId(), periodId: period.id, runId: period.activeRunId,
    }).sort({ employeeId: 1 }).session(session).lean().exec();
    if (
      records.length !== period.employeeCount || records.length < 1 || records.length > 5_000 ||
      new Set(records.map((record) => record.employeeId)).size !== records.length
    ) throw new ConflictException({
      code: 'PAYROLL_TAX_LINES_INCOMPLETE', message: '锁定工资税务员工行不完整',
    });
    const employeeIds = records.map((record) => record.employeeId);
    const employmentRecords = await this.employments.findOverlappingByEmployeeIds(
      employeeIds, `${period.period}-01`, monthEnd(period.period), session,
    );
    if (
      employmentRecords.length !== records.length ||
      new Set(employmentRecords.map((record) => record.employeeId)).size !== records.length
    ) throw new ConflictException({
      code: 'PAYROLL_TAX_EMPLOYMENT_AMBIGUOUS', message: '税务周期劳动关系缺失或重叠',
    });
    const people = await this.persons.findByIds(
      employmentRecords.map((record) => record.personId), session,
    );
    if (people.length !== records.length || new Set(people.map((person) => person.id)).size !== records.length) {
      throw new ConflictException({
        code: 'PAYROLL_TAX_IDENTITY_EVIDENCE_INCOMPLETE', message: '税务身份核验证据不完整',
      });
    }
    const employmentByEmployee = new Map(employmentRecords.map((record) => [record.employeeId, record]));
    const personById = new Map(people.map((person) => [person.id, person]));
    const manifestLines = records.map((record) => {
      const result = resultSchema.parse(this.crypto.unprotect({
        tenantId: this.tenantId(), resourceType: 'calculation_line',
        resourceId: record.id, version: 1,
      }, protectedValue(record)));
      const { resultHash, ...withoutHash } = result;
      const employment = employmentByEmployee.get(record.employeeId);
      const person = employment === undefined ? undefined : personById.get(employment.personId);
      if (
        resultHash !== record.resultHash || payrollDigest(withoutHash) !== resultHash ||
        person === undefined
      ) throw new ConflictException({
        code: 'PAYROLL_TAX_LINE_INTEGRITY_FAILED', message: '税务工资行或身份绑定完整性失败',
      });
      return Object.freeze({
        employeeId: record.employeeId, calculationLineId: record.id,
        identityEvidenceId: person.identityEvidenceId,
        taxableEarningsMinor: result.taxableEarningsMinor,
        withholdingTaxMinor: result.withholdingTaxMinor,
        cumulativeTaxableIncomeMinor: result.cumulativeAfter.taxableIncomeMinor,
        cumulativeTaxWithheldMinor: result.cumulativeAfter.taxWithheldMinor,
        resultHash,
      });
    });
    const filingId = createEventId();
    const generated = generateTaxFilingManifest({
      filingId, tenantId: this.tenantId(), period: period.period,
      payrollRunId: period.activeRunId, payrollResultHash: period.resultHash,
      lines: manifestLines,
    });
    const totalTax = manifestLines.reduce(
      (sum, line) => sum + BigInt(line.withholdingTaxMinor), 0n,
    );
    if (totalTax !== BigInt(period.totalTaxMinor)) throw new ConflictException({
      code: 'PAYROLL_TAX_TOTAL_MISMATCH', message: '税务清单与锁定工资税额不一致',
    });
    const protectedManifest = this.crypto.protect({
      tenantId: this.tenantId(), resourceType: 'tax_filing', resourceId: filingId, version: 1,
    }, { content: generated.content });
    await this.filings.create([{
      id: filingId, tenantId: this.tenantId(), periodId: period.id,
      payrollRunId: period.activeRunId, payrollResultHash: period.resultHash,
      format: generated.format, contentHash: generated.contentHash,
      employeeCount: generated.employeeCount,
      totalTaxableEarningsMinor: generated.totalTaxableEarningsMinor,
      totalWithholdingTaxMinor: generated.totalWithholdingTaxMinor,
      preparedBy, approvedBy: null, strongAuthEvidenceId: null,
      objectRef: null, objectEvidenceId: null, taxSubmissionId: null,
      taxSubmissionEvidenceId: null, status: 'archiving', version: 1,
      ...protectedRecord(protectedManifest),
    }], { session });
    return Object.freeze({
      id: filingId, periodId: period.id, payrollRunId: period.activeRunId,
      format: generated.format, status: 'archiving', version: 1,
      contentHash: generated.contentHash, employeeCount: generated.employeeCount,
      totalTaxableEarningsMinor: generated.totalTaxableEarningsMinor,
      totalWithholdingTaxMinor: generated.totalWithholdingTaxMinor,
      objectEvidenceId: null, taxSubmissionId: null, taxSubmissionEvidenceId: null,
    });
  }

  private async materialize(key: string, filingId: string): Promise<PayrollTaxFilingSummary> {
    const filing = await this.filings.findOne({
      tenantId: this.tenantId(), id: filingId,
    }).lean().exec();
    if (filing === null) throw new NotFoundException({
      code: 'PAYROLL_TAX_FILING_NOT_FOUND', message: '个税申报清单不存在',
    });
    if (['prepared', 'approved', 'submitting', 'submitted'].includes(filing.status)) {
      return summary(filing);
    }
    if (filing.status !== 'archiving' || filing.version !== 1) throw new ConflictException({
      code: 'PAYROLL_TAX_MATERIALIZATION_STATE_INVALID', message: '个税清单不处于可归档状态',
    });
    const manifest = protectedManifestSchema.parse(this.crypto.unprotect({
      tenantId: this.tenantId(), resourceType: 'tax_filing', resourceId: filing.id, version: 1,
    }, protectedValue(filing)));
    if (createHash('sha256').update(manifest.content, 'utf8').digest('base64url') !== filing.contentHash) {
      throw new ConflictException({
        code: 'PAYROLL_TAX_CONTENT_HASH_MISMATCH', message: '个税清单密文摘要不一致',
      });
    }
    const bytes = Buffer.from(manifest.content, 'utf8');
    let receipt: Awaited<ReturnType<PayrollTaxImmutableArchive['put']>>;
    try {
      receipt = await this.archive.put({
        tenantId: this.tenantId(), filingId: filing.id,
        objectKey: `payroll-tax/${filing.id}/${filing.contentHash}.json`,
        sha256: filing.contentHash, bytes,
      });
    } finally { bytes.fill(0); }
    return this.run(() => this.idempotency.execute(
      'payroll.tax_filing.materialize', key, {
        filingId: filing.id, contentHash: filing.contentHash,
        objectRef: receipt.objectRef, evidenceId: receipt.evidenceId,
      }, async (session) => {
        const updated = await this.filings.updateOne({
          tenantId: this.tenantId(), id: filing.id, status: 'archiving', version: 1,
        }, { $set: {
          objectRef: receipt.objectRef, objectEvidenceId: receipt.evidenceId,
          status: 'prepared', version: 2,
        } }, { session, runValidators: true });
        if (updated.modifiedCount !== 1) throw new ConflictException({
          code: 'PAYROLL_TAX_ARCHIVE_WRITE_CONFLICT', message: '个税清单归档发生并发冲突',
        });
        await this.outbox.append({
          type: 'payroll.tax_filing.prepared', tenantId: this.tenantId(),
          aggregateId: filing.id, version: 2, occurredAt: new Date().toISOString(), data: {
            period: await this.periodValue(filing.periodId, session),
            payrollRunId: filing.payrollRunId, format: filing.format,
            contentHash: filing.contentHash, employeeCount: filing.employeeCount,
            totalTaxableEarningsMinor: filing.totalTaxableEarningsMinor,
            totalWithholdingTaxMinor: filing.totalWithholdingTaxMinor,
            objectEvidenceId: receipt.evidenceId, status: 'prepared',
          },
        }, session);
        return summary({
          ...filing, objectRef: receipt.objectRef, objectEvidenceId: receipt.evidenceId,
          status: 'prepared', version: 2,
        });
      },
    ));
  }

  private async periodValue(periodId: string, session: ClientSession): Promise<string> {
    return (await this.requirePeriod(periodId, session)).period;
  }

  private async requireFiling(
    id: string,
    session?: ClientSession,
  ): Promise<PayrollTaxFilingRecord> {
    const query = this.filings.findOne({ tenantId: this.tenantId(), id });
    if (session !== undefined) query.session(session);
    const filing = await query.lean().exec();
    if (filing === null) throw new NotFoundException({
      code: 'PAYROLL_TAX_FILING_NOT_FOUND', message: '个税申报清单不存在',
    });
    return filing;
  }

  private async requirePeriod(
    id: string,
    session?: ClientSession,
  ): Promise<PayrollPeriodRecord> {
    const query = this.periods.findOne({ tenantId: this.tenantId(), id });
    if (session !== undefined) query.session(session);
    const period = await query.lean().exec();
    if (period === null) throw new NotFoundException({
      code: 'PAYROLL_PERIOD_NOT_FOUND', message: '工资周期不存在',
    });
    return period;
  }

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); } catch (error) {
      if (error instanceof TaxFilingManifestError) {
        throw new ConflictException({ code: error.code, message: error.message });
      }
      if (error instanceof z.ZodError) throw new ConflictException({
        code: 'PAYROLL_TAX_PROTECTED_DATA_INVALID', message: '个税制备所需密文非法',
      });
      if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11_000) {
        throw new ConflictException({
          code: 'PAYROLL_TAX_FILING_ALREADY_EXISTS', message: '工资周期已存在个税清单',
        });
      }
      throw error;
    }
  }

  private tenantId(): string { return this.context.getTenantRequired().tenantId; }
}

function summary(record: PayrollTaxFilingRecord): PayrollTaxFilingSummary {
  return Object.freeze({
    id: record.id, periodId: record.periodId, payrollRunId: record.payrollRunId,
    format: record.format, status: record.status, version: record.version,
    contentHash: record.contentHash, employeeCount: record.employeeCount,
    totalTaxableEarningsMinor: record.totalTaxableEarningsMinor,
    totalWithholdingTaxMinor: record.totalWithholdingTaxMinor,
    objectEvidenceId: record.objectEvidenceId, taxSubmissionId: record.taxSubmissionId,
    taxSubmissionEvidenceId: record.taxSubmissionEvidenceId,
  });
}

function protectedValue(value: {
  readonly dataKeyId: string; readonly dataIv: string;
  readonly dataCiphertext: string; readonly dataAuthTag: string;
}) {
  return {
    keyId: value.dataKeyId, iv: value.dataIv,
    ciphertext: value.dataCiphertext, authTag: value.dataAuthTag,
  };
}

function protectedRecord(value: {
  readonly keyId: string; readonly iv: string;
  readonly ciphertext: string; readonly authTag: string;
}) {
  return {
    dataKeyId: value.keyId, dataIv: value.iv,
    dataCiphertext: value.ciphertext, dataAuthTag: value.authTag,
  };
}

function deriveKey(root: string, stage: string): string {
  return `payroll:${createHash('sha256').update(JSON.stringify([root, stage]), 'utf8').digest('base64url')}`;
}

function monthEnd(month: string): string {
  const [year, value] = month.split('-').map(Number);
  if (year === undefined || value === undefined) throw new Error('PAYROLL_TAX_PERIOD_INVALID');
  return new Date(Date.UTC(year, value, 0)).toISOString().slice(0, 10);
}
