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
import type { VerifiedAccessToken } from '../../identity/auth.types.js';
import { WebAuthnService } from '../../identity/strong-auth/webauthn.service.js';
import { LegacyPayrollBoundaryService } from '../legacy-payroll-boundary.service.js';
import {
  compareShadowPayroll,
  payrollDigest,
  ShadowPayrollComparisonError,
  type LegacyShadowPayrollLine,
  type ShadowPayrollDifferenceCode,
  type ShadowPayrollLine,
} from '../domain/index.js';
import { PayrollDataCryptoService } from '../persistence/payroll-data-crypto.service.js';
import { PayrollOutboxWriter } from '../persistence/payroll-outbox.writer.js';
import {
  PayrollCalculationLineRecord,
  type PayrollCalculationLineDocument,
  PayrollCutoverReadinessRecord,
  type PayrollCutoverReadinessDocument,
  PayrollPeriodRecord,
  type PayrollPeriodDocument,
  PayrollShadowCycleRecord,
  type PayrollShadowCycleDocument,
  PayrollShadowDifferenceRecord,
  type PayrollShadowDifferenceDocument,
  PayrollShadowExplanationRecord,
  type PayrollShadowExplanationDocument,
  PayrollShadowSignoffRecord,
  type PayrollShadowSignoffDocument,
} from '../persistence/payroll.schemas.js';

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HASH = /^[A-Za-z0-9_-]{43}$/;
const EXPLANATION_CODES = [
  'LEGACY_RULE_VERSION', 'LEGACY_INPUT_CUTOFF', 'LEGACY_ROUNDING',
  'LEGACY_MASTER_DATA', 'APPROVED_MANUAL_ADJUSTMENT', 'OTHER_VERIFIED',
] as const;
export type ShadowPayrollExplanationCode = typeof EXPLANATION_CODES[number];

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
const differenceDataSchema = z.object({
  employeeId: z.string().regex(ID),
  code: z.enum([
    'LEGACY_EMPLOYEE_MISSING', 'ERP_EMPLOYEE_MISSING', 'GROSS_AMOUNT_MISMATCH',
    'WITHHOLDING_TAX_MISMATCH', 'NET_AMOUNT_MISMATCH',
  ]),
  erpMinor: z.number().int().safe().nullable(), legacyMinor: z.number().int().safe().nullable(),
  deltaMinor: z.number().int().safe().nullable(), evidenceHash: z.string().regex(HASH),
}).strict();

export interface ImportShadowPayrollInput {
  readonly periodId: string;
  readonly sourceSystem: string;
  readonly sourceExportId: string;
  readonly sourceObjectEvidenceId: string;
  readonly sourceSignatureEvidenceId: string;
  readonly sourceManifestHash: string;
  readonly lines: readonly LegacyShadowPayrollLine[];
}

export interface PayrollShadowCycleSummary extends Record<string, unknown> {
  readonly id: string;
  readonly periodId: string;
  readonly payrollRunId: string;
  readonly period: string;
  readonly sourceSystem: string;
  readonly sourceManifestHash: string;
  readonly payrollResultHash: string;
  readonly comparisonHash: string;
  readonly status:
    | 'needs_explanation'
    | 'ready_for_payroll_signoff'
    | 'ready_for_finance_signoff'
    | 'signed';
  readonly erpEmployeeCount: number;
  readonly legacyEmployeeCount: number;
  readonly erpTotalGrossMinor: number;
  readonly legacyTotalGrossMinor: number;
  readonly erpTotalTaxMinor: number;
  readonly legacyTotalTaxMinor: number;
  readonly erpTotalNetMinor: number;
  readonly legacyTotalNetMinor: number;
  readonly differenceCodes: readonly ShadowPayrollDifferenceCode[];
  readonly differenceCount: number;
  readonly explainedDifferenceCount: number;
  readonly unresolvedDifferenceCount: number;
  readonly totalAbsoluteDifferenceMinor: number;
  readonly payrollSignoffId: string | null;
  readonly financeSignoffId: string | null;
  readonly cutoverReadinessId: string | null;
  readonly version: number;
}

export interface PayrollCutoverReadinessSummary extends Record<string, unknown> {
  readonly id: string;
  readonly firstCycleId: string;
  readonly secondCycleId: string;
  readonly startPeriod: string;
  readonly endPeriod: string;
  readonly evidenceHash: string;
  readonly status: 'eligible';
  readonly version: number;
}

export interface PayrollShadowDifferenceView {
  readonly id: string;
  readonly code: ShadowPayrollDifferenceCode;
  readonly employeeId: string;
  readonly erpMinor: number | null;
  readonly legacyMinor: number | null;
  readonly deltaMinor: number | null;
  readonly evidenceHash: string;
  readonly explanationCode: ShadowPayrollExplanationCode | null;
  readonly explanationEvidenceId: string | null;
}

/** 两期薪资影子验证应用服务；写操作只接受明确角色，MCP 仅复用只读摘要。 */
@Injectable()
export class PayrollShadowService {
  constructor(
    private readonly idempotency: IdempotencyService,
    private readonly context: TenantContextService,
    private readonly boundary: LegacyPayrollBoundaryService,
    private readonly crypto: PayrollDataCryptoService,
    private readonly strongAuth: WebAuthnService,
    private readonly outbox: PayrollOutboxWriter,
    @InjectModel(PayrollPeriodRecord.name)
    private readonly periods: Model<PayrollPeriodDocument>,
    @InjectModel(PayrollCalculationLineRecord.name)
    private readonly calculationLines: Model<PayrollCalculationLineDocument>,
    @InjectModel(PayrollShadowCycleRecord.name)
    private readonly cycles: Model<PayrollShadowCycleDocument>,
    @InjectModel(PayrollShadowDifferenceRecord.name)
    private readonly differences: Model<PayrollShadowDifferenceDocument>,
    @InjectModel(PayrollShadowExplanationRecord.name)
    private readonly explanations: Model<PayrollShadowExplanationDocument>,
    @InjectModel(PayrollShadowSignoffRecord.name)
    private readonly signoffs: Model<PayrollShadowSignoffDocument>,
    @InjectModel(PayrollCutoverReadinessRecord.name)
    private readonly readiness: Model<PayrollCutoverReadinessDocument>,
  ) {}

  async importCycle(key: string, input: ImportShadowPayrollInput): Promise<PayrollShadowCycleSummary> {
    this.assertScope('erp:payroll:shadow:import');
    const actor = this.context.getActorRequired();
    if (actor.actorType !== 'service' && actor.actorType !== 'system_job') {
      throw new ForbiddenException({
        code: 'SHADOW_PAYROLL_TRUSTED_CONNECTOR_REQUIRED',
        message: '影子工资只允许受信任旧系统连接器导入',
      });
    }
    this.boundary.assertLegacy();
    this.assertImportInput(input);
    return this.run(() => this.idempotency.execute(
      'payroll.shadow.import', key, input, async (session) => {
        const period = await this.requirePeriod(input.periodId, session);
        if (
          !['locked', 'reconciled'].includes(period.status) || period.activeRunId === null ||
          period.resultHash === null || period.employeeCount === null ||
          period.totalGrossMinor === null || period.totalTaxMinor === null ||
          period.totalNetMinor === null
        ) throw new ConflictException({
          code: 'SHADOW_PAYROLL_PERIOD_NOT_FROZEN', message: '影子比较要求工资运行已锁定或完成对账',
        });
        const erpLines = await this.loadErpLines(period, session);
        const result = compareShadowPayroll({
          period: period.period, payrollRunId: period.activeRunId,
          payrollResultHash: period.resultHash,
          sourceSystem: input.sourceSystem, sourceExportId: input.sourceExportId,
          sourceObjectEvidenceId: input.sourceObjectEvidenceId,
          sourceSignatureEvidenceId: input.sourceSignatureEvidenceId,
          sourceManifestHash: input.sourceManifestHash,
          erpLines, legacyLines: input.lines,
        });
        if (
          result.erpEmployeeCount !== period.employeeCount ||
          result.erpTotalGrossMinor !== period.totalGrossMinor ||
          result.erpTotalTaxMinor !== period.totalTaxMinor ||
          result.erpTotalNetMinor !== period.totalNetMinor
        ) throw new ConflictException({
          code: 'SHADOW_PAYROLL_ERP_CONTROL_TOTAL_MISMATCH', message: 'ERP 工资控制总额不一致',
        });
        const id = createEventId();
        const ciphertext = this.crypto.protect({
          tenantId: this.tenantId(), resourceType: 'shadow_cycle', resourceId: id, version: 1,
        }, Object.freeze({
          contract: 'GAOQ_SHADOW_PAYROLL_SOURCE_EVIDENCE_V1',
          sourceSystem: input.sourceSystem, sourceExportId: input.sourceExportId,
          sourceManifestHash: input.sourceManifestHash,
          sourceObjectEvidenceId: input.sourceObjectEvidenceId,
          sourceSignatureEvidenceId: input.sourceSignatureEvidenceId,
          lines: Object.freeze(input.lines.map((line) => Object.freeze({ ...line }))),
        }));
        const record = {
          id, tenantId: this.tenantId(), periodId: period.id, payrollRunId: period.activeRunId,
          period: period.period, sourceSystem: input.sourceSystem,
          sourceExportId: input.sourceExportId,
          sourceObjectEvidenceId: input.sourceObjectEvidenceId,
          sourceSignatureEvidenceId: input.sourceSignatureEvidenceId,
          sourceManifestHash: input.sourceManifestHash, payrollResultHash: period.resultHash,
          comparisonHash: result.comparisonHash,
          erpEmployeeCount: result.erpEmployeeCount,
          legacyEmployeeCount: result.legacyEmployeeCount,
          erpTotalGrossMinor: result.erpTotalGrossMinor,
          legacyTotalGrossMinor: result.legacyTotalGrossMinor,
          erpTotalTaxMinor: result.erpTotalTaxMinor,
          legacyTotalTaxMinor: result.legacyTotalTaxMinor,
          erpTotalNetMinor: result.erpTotalNetMinor,
          legacyTotalNetMinor: result.legacyTotalNetMinor,
          differenceCount: result.differences.length,
          differenceCodes: [...result.differenceCodes],
          totalAbsoluteDifferenceMinor: result.totalAbsoluteDifferenceMinor,
          importedBy: actor.actorId, version: 1,
          ...protectedRecord(ciphertext),
        };
        await this.cycles.create([record], { session });
        for (const difference of result.differences) {
          const differenceId = createEventId();
          const protectedDifference = this.crypto.protect({
            tenantId: this.tenantId(), resourceType: 'shadow_difference',
            resourceId: differenceId, version: 1,
          }, difference);
          await this.differences.create([{
            id: differenceId, tenantId: this.tenantId(), cycleId: id,
            code: difference.code, evidenceHash: difference.evidenceHash,
            ...protectedRecord(protectedDifference),
          }], { session });
        }
        await this.outbox.append({
          type: 'payroll.shadow_cycle.compared', tenantId: this.tenantId(),
          aggregateId: id, version: 1, occurredAt: new Date().toISOString(), data: {
            period: period.period, payrollRunId: period.activeRunId,
            comparisonHash: result.comparisonHash,
            sourceManifestHash: input.sourceManifestHash,
            erpEmployeeCount: result.erpEmployeeCount,
            legacyEmployeeCount: result.legacyEmployeeCount,
            differenceCount: result.differences.length,
            totalAbsoluteDifferenceMinor: result.totalAbsoluteDifferenceMinor,
            status: result.differences.length === 0
              ? 'ready_for_payroll_signoff' : 'needs_explanation',
          },
        }, session);
        return cycleSummary(record, 0, null, null, null);
      },
    ));
  }

  async explainDifference(
    key: string,
    cycleId: string,
    differenceId: string,
    explanationCode: ShadowPayrollExplanationCode,
    evidenceId: string,
  ): Promise<PayrollShadowCycleSummary> {
    this.assertScope('erp:payroll:shadow:explain');
    const actor = this.context.getActorRequired();
    if (actor.actorType !== 'user') throw new ForbiddenException({
      code: 'SHADOW_PAYROLL_EXPLANATION_HUMAN_REQUIRED', message: '影子差异归因必须由已验证人员执行',
    });
    this.boundary.assertLegacy();
    if (
      !ULID.test(cycleId) || !ULID.test(differenceId) ||
      !EXPLANATION_CODES.includes(explanationCode) || !ID.test(evidenceId)
    ) throw new BadRequestException({
      code: 'SHADOW_PAYROLL_EXPLANATION_INPUT_INVALID', message: '影子差异归因引用非法',
    });
    return this.run(() => this.idempotency.execute(
      'payroll.shadow.explain', key,
      { cycleId, differenceId, explanationCode, evidenceId }, async (session) => {
        const cycle = await this.requireCycle(cycleId, session);
        const existingSignoff = await this.signoffs.findOne({
          tenantId: this.tenantId(), cycleId,
        }).session(session).lean().exec();
        if (existingSignoff !== null) throw new ConflictException({
          code: 'SHADOW_PAYROLL_ALREADY_SIGNED', message: '财务签署后禁止新增差异归因',
        });
        const difference = await this.differences.findOne({
          tenantId: this.tenantId(), id: differenceId, cycleId,
        }).session(session).lean().exec();
        if (difference === null) throw new NotFoundException({
          code: 'SHADOW_PAYROLL_DIFFERENCE_NOT_FOUND', message: '影子工资差异不存在',
        });
        const id = createEventId();
        const evidenceHash = payrollDigest({
          contract: 'GAOQ_SHADOW_PAYROLL_EXPLANATION_V1', cycleId, differenceId,
          differenceEvidenceHash: difference.evidenceHash, explanationCode, evidenceId,
          explainedBy: actor.actorId,
        });
        await this.explanations.create([{
          id, tenantId: this.tenantId(), cycleId, differenceId,
          explanationCode, evidenceId, explainedBy: actor.actorId, evidenceHash,
        }], { session });
        const explained = await this.explanations.countDocuments({
          tenantId: this.tenantId(), cycleId,
        }).session(session).exec();
        await this.outbox.append({
          type: 'payroll.shadow_difference.explained', tenantId: this.tenantId(),
          aggregateId: cycle.id, version: explained + 1, occurredAt: new Date().toISOString(),
          data: {
            period: cycle.period, comparisonHash: cycle.comparisonHash,
            differenceCount: cycle.differenceCount, explainedDifferenceCount: explained,
            unresolvedDifferenceCount: cycle.differenceCount - explained,
            status: explained === cycle.differenceCount
              ? 'ready_for_payroll_signoff' : 'needs_explanation',
          },
        }, session);
        return cycleSummary(cycle, explained, null, null, null);
      },
    ));
  }

  async signCycle(
    key: string,
    cycleId: string,
    strongAuthEvidenceId: string,
    token: VerifiedAccessToken,
    role: 'payroll_owner' | 'finance_owner',
  ): Promise<PayrollShadowCycleSummary> {
    this.assertScope(role === 'payroll_owner'
      ? 'erp:payroll:shadow:sign_payroll' : 'erp:payroll:shadow:sign_finance');
    const actor = this.context.getActorRequired();
    if (
      actor.actorType !== 'user' || token.actorType !== 'user' ||
      token.tenantId !== this.tenantId() || token.actorId !== actor.actorId
    ) throw new ForbiddenException({
      code: 'SHADOW_PAYROLL_SIGNER_IDENTITY_INVALID', message: '影子周期签署身份上下文非法',
    });
    this.boundary.assertLegacy();
    if (!ULID.test(cycleId) || !ULID.test(strongAuthEvidenceId)) {
      throw new BadRequestException({
        code: 'SHADOW_PAYROLL_SIGNOFF_INPUT_INVALID', message: '影子周期签署引用非法',
      });
    }
    const evidence = await this.strongAuth.requireVerifiedEvidence({
      evidenceId: strongAuthEvidenceId, tenantId: token.tenantId, actorId: token.actorId,
      sessionId: token.sessionId, operationId: `${cycleId}:${role}`,
    });
    return this.run(() => this.idempotency.execute(
      `payroll.shadow.sign.${role}`, key, { cycleId, strongAuthEvidenceId, role },
      async (session) => {
        const cycle = await this.requireCycle(cycleId, session);
        const period = await this.requirePeriod(cycle.periodId, session);
        const currentSignoff = await this.signoffs.findOne({
          tenantId: this.tenantId(), cycleId, role,
        }).session(session).lean().exec();
        if (currentSignoff !== null) {
          const allSignoffs = await this.signoffs.find({
            tenantId: this.tenantId(), cycleId,
          }).session(session).lean().exec();
          const ready = await this.readiness.findOne({
            tenantId: this.tenantId(), secondCycleId: cycleId,
          }).session(session).lean().exec();
          return cycleSummary(
            cycle, cycle.differenceCount,
            signoffFor(allSignoffs, 'payroll_owner'),
            signoffFor(allSignoffs, 'finance_owner'), ready,
          );
        }
        const [differenceRecords, explanationRecords] = await Promise.all([
          this.differences.find({ tenantId: this.tenantId(), cycleId })
            .sort({ id: 1 }).session(session).lean().exec(),
          this.explanations.find({ tenantId: this.tenantId(), cycleId })
            .sort({ differenceId: 1 }).session(session).lean().exec(),
        ]);
        if (
          differenceRecords.length !== cycle.differenceCount ||
          explanationRecords.length !== cycle.differenceCount ||
          new Set(explanationRecords.map((item) => item.differenceId)).size !== cycle.differenceCount
        ) throw new ConflictException({
          code: 'SHADOW_PAYROLL_UNEXPLAINED_DIFFERENCES', message: '存在未解释差异，禁止财务签署',
        });
        const payrollSignoff = await this.signoffs.findOne({
          tenantId: this.tenantId(), cycleId, role: 'payroll_owner',
        }).session(session).lean().exec();
        if (role === 'finance_owner' && payrollSignoff === null) {
          throw new ConflictException({
            code: 'SHADOW_PAYROLL_PAYROLL_SIGNOFF_REQUIRED',
            message: '必须先由独立薪酬负责人签署影子比较证据',
          });
        }
        const conflictingActors = new Set((role === 'payroll_owner'
          ? [cycle.importedBy, period.preparedBy, period.lockedBy,
            ...explanationRecords.map((item) => item.explainedBy)]
          : [cycle.importedBy, period.preparedBy, period.approvedBy, period.lockedBy,
            payrollSignoff?.signedBy,
            ...explanationRecords.map((item) => item.explainedBy)])
          .filter((value): value is string => typeof value === 'string'));
        if (conflictingActors.has(actor.actorId)) throw new ConflictException({
          code: 'SHADOW_PAYROLL_SIGNOFF_DUTY_CONFLICT', message: '财务签署职责未与导入、制单、审批、锁定或归因分离',
        });
        const explanationSetHash = payrollDigest(explanationRecords.map((item) => ({
          differenceId: item.differenceId, evidenceHash: item.evidenceHash,
        })));
        const signedAt = new Date();
        const signoffId = createEventId();
        const signoffEvidenceHash = payrollDigest({
          contract: 'GAOQ_SHADOW_PAYROLL_SIGNOFF_V1', cycleId, role,
          comparisonHash: cycle.comparisonHash, explanationSetHash,
          signedBy: actor.actorId, strongAuthEvidenceId: evidence.evidenceId,
          strongAuthMethod: evidence.method, signedAt: signedAt.toISOString(),
        });
        const signoff = {
          id: signoffId, tenantId: this.tenantId(), cycleId, period: cycle.period,
          role,
          comparisonHash: cycle.comparisonHash, explanationSetHash,
          signedBy: actor.actorId, strongAuthEvidenceId: evidence.evidenceId,
          evidenceHash: signoffEvidenceHash, signedAt, version: 1,
        };
        await this.signoffs.create([signoff], { session });
        const ready = role === 'finance_owner'
          ? await this.createReadinessIfConsecutive(cycle, signoff, signedAt, session) : null;
        await this.outbox.append({
          type: 'payroll.shadow_cycle.signed', tenantId: this.tenantId(),
          aggregateId: cycle.id, version: cycle.differenceCount + 2,
          occurredAt: signedAt.toISOString(), data: {
            period: cycle.period, comparisonHash: cycle.comparisonHash,
            differenceCount: cycle.differenceCount,
            explanationSetHash, signoffEvidenceHash, strongAuthMethod: evidence.method,
            signoffRole: role,
            status: role === 'payroll_owner' ? 'payroll_signed' : 'signed',
          },
        }, session);
        if (ready !== null) await this.outbox.append({
          type: 'payroll.cutover_readiness.eligible', tenantId: this.tenantId(),
          aggregateId: ready.id, version: 1, occurredAt: signedAt.toISOString(), data: {
            firstCycleId: ready.firstCycleId, secondCycleId: ready.secondCycleId,
            startPeriod: ready.startPeriod, endPeriod: ready.endPeriod,
            evidenceHash: ready.evidenceHash, status: ready.status,
          },
        }, session);
        return cycleSummary(
          cycle, cycle.differenceCount,
          role === 'payroll_owner' ? signoff : payrollSignoff,
          role === 'finance_owner' ? signoff : null,
          ready,
        );
      },
    ));
  }

  async getCycle(id: string): Promise<PayrollShadowCycleSummary> {
    this.assertScope('erp:payroll:shadow:read');
    this.boundary.assertLegacy();
    if (!ULID.test(id)) throw new BadRequestException({
      code: 'SHADOW_PAYROLL_CYCLE_ID_INVALID', message: '影子周期标识非法',
    });
    const cycle = await this.requireCycle(id);
    const [explained, signoffs, ready] = await Promise.all([
      this.explanations.countDocuments({ tenantId: this.tenantId(), cycleId: id }).exec(),
      this.signoffs.find({ tenantId: this.tenantId(), cycleId: id }).lean().exec(),
      this.readiness.findOne({ tenantId: this.tenantId(), secondCycleId: id }).lean().exec(),
    ]);
    return cycleSummary(
      cycle, explained, signoffFor(signoffs, 'payroll_owner'),
      signoffFor(signoffs, 'finance_owner'), ready,
    );
  }

  /** 仅供 ERP 受控财务界面读取 L4 行级差异；MCP 永不调用。 */
  async getDifferences(id: string): Promise<readonly PayrollShadowDifferenceView[]> {
    this.assertScope('erp:payroll:shadow:difference:read');
    const actor = this.context.getActorRequired();
    if (actor.actorType !== 'user') throw new ForbiddenException({
      code: 'SHADOW_PAYROLL_DIFFERENCE_HUMAN_REQUIRED', message: '行级工资差异只允许已验证人员读取',
    });
    this.boundary.assertLegacy();
    if (!ULID.test(id)) throw new BadRequestException({
      code: 'SHADOW_PAYROLL_CYCLE_ID_INVALID', message: '影子周期标识非法',
    });
    const cycle = await this.requireCycle(id);
    const [records, explanations] = await Promise.all([
      this.differences.find({ tenantId: this.tenantId(), cycleId: id })
        .sort({ id: 1 }).lean().exec(),
      this.explanations.find({ tenantId: this.tenantId(), cycleId: id })
        .sort({ differenceId: 1 }).lean().exec(),
    ]);
    if (records.length !== cycle.differenceCount) throw new ConflictException({
      code: 'SHADOW_PAYROLL_DIFFERENCE_SET_INTEGRITY_FAILED', message: '影子工资差异集不完整',
    });
    const explanationByDifference = new Map(explanations.map((item) => [item.differenceId, item]));
    return Object.freeze(records.map((record) => {
      try {
        const value = differenceDataSchema.parse(this.crypto.unprotect({
          tenantId: this.tenantId(), resourceType: 'shadow_difference',
          resourceId: record.id, version: 1,
        }, protectedValue(record)));
        const { evidenceHash, ...withoutHash } = value;
        if (
          evidenceHash !== record.evidenceHash || payrollDigest(withoutHash) !== evidenceHash ||
          value.code !== record.code
        ) throw new Error('SHADOW_PAYROLL_DIFFERENCE_HASH_MISMATCH');
        const explanation = explanationByDifference.get(record.id);
        return Object.freeze({
          id: record.id, code: value.code, employeeId: value.employeeId,
          erpMinor: value.erpMinor, legacyMinor: value.legacyMinor, deltaMinor: value.deltaMinor,
          evidenceHash,
          explanationCode: explanation?.explanationCode as ShadowPayrollExplanationCode | undefined ?? null,
          explanationEvidenceId: explanation?.evidenceId ?? null,
        });
      } catch {
        throw new ConflictException({
          code: 'SHADOW_PAYROLL_DIFFERENCE_INTEGRITY_FAILED', message: '影子工资差异完整性失败',
        });
      }
    }));
  }

  async getReadiness(id: string): Promise<PayrollCutoverReadinessSummary> {
    this.assertScope('erp:payroll:shadow:read');
    this.boundary.assertLegacy();
    if (!ULID.test(id)) throw new BadRequestException({
      code: 'PAYROLL_CUTOVER_READINESS_ID_INVALID', message: '工资可切换证据标识非法',
    });
    const record = await this.readiness.findOne({ tenantId: this.tenantId(), id }).lean().exec();
    if (record === null) throw new NotFoundException({
      code: 'PAYROLL_CUTOVER_READINESS_NOT_FOUND', message: '工资可切换证据不存在',
    });
    return readinessSummary(record);
  }

  private async createReadinessIfConsecutive(
    cycle: PayrollShadowCycleRecord,
    signoff: Pick<PayrollShadowSignoffRecord, 'id' | 'evidenceHash'>,
    generatedAt: Date,
    session: ClientSession,
  ): Promise<PayrollCutoverReadinessRecord | null> {
    const previousPeriod = previousMonth(cycle.period);
    const previous = await this.signoffs.findOne({
      tenantId: this.tenantId(), period: previousPeriod, role: 'finance_owner',
    }).session(session).lean().exec();
    if (previous === null) return null;
    const existing = await this.readiness.findOne({
      tenantId: this.tenantId(), secondCycleId: cycle.id,
    }).session(session).lean().exec();
    if (existing !== null) return existing;
    const id = createEventId();
    const record: PayrollCutoverReadinessRecord = {
      id, tenantId: this.tenantId(), firstCycleId: previous.cycleId, secondCycleId: cycle.id,
      startPeriod: previousPeriod, endPeriod: cycle.period,
      evidenceHash: payrollDigest({
        contract: 'GAOQ_PAYROLL_TWO_CYCLE_CUTOVER_READINESS_V1',
        firstCycleId: previous.cycleId, firstSignoffId: previous.id,
        firstSignoffEvidenceHash: previous.evidenceHash,
        secondCycleId: cycle.id, secondSignoffId: signoff.id,
        secondSignoffEvidenceHash: signoff.evidenceHash,
        startPeriod: previousPeriod, endPeriod: cycle.period,
      }),
      status: 'eligible', generatedAt, version: 1,
      createdAt: generatedAt, updatedAt: generatedAt,
    };
    await this.readiness.create([record], { session });
    return record;
  }

  private async loadErpLines(
    period: PayrollPeriodRecord,
    session: ClientSession,
  ): Promise<readonly ShadowPayrollLine[]> {
    const records = await this.calculationLines.find({
      tenantId: this.tenantId(), periodId: period.id, runId: period.activeRunId,
    }).sort({ employeeId: 1 }).session(session).lean().exec();
    if (records.length !== period.employeeCount || records.length < 1) throw new ConflictException({
      code: 'SHADOW_PAYROLL_ERP_LINES_INCOMPLETE', message: 'ERP 工资结果行不完整',
    });
    return Object.freeze(records.map((record) => {
      try {
        const result = resultSchema.parse(this.crypto.unprotect({
          tenantId: this.tenantId(), resourceType: 'calculation_line',
          resourceId: record.id, version: 1,
        }, protectedValue(record)));
        const { resultHash, ...withoutHash } = result;
        if (resultHash !== record.resultHash || payrollDigest(withoutHash) !== resultHash) {
          throw new Error('SHADOW_PAYROLL_ERP_LINE_HASH_MISMATCH');
        }
        return Object.freeze({
          employeeId: record.employeeId, grossPayMinor: result.grossPayMinor,
          withholdingTaxMinor: result.withholdingTaxMinor, netPayMinor: result.netPayMinor,
          resultHash,
        });
      } catch {
        throw new ConflictException({
          code: 'SHADOW_PAYROLL_ERP_LINE_INTEGRITY_FAILED', message: 'ERP 工资结果行完整性失败',
        });
      }
    }));
  }

  private async requireCycle(id: string, session?: ClientSession): Promise<PayrollShadowCycleRecord> {
    const query = this.cycles.findOne({ tenantId: this.tenantId(), id });
    if (session !== undefined) query.session(session);
    const record = await query.lean().exec();
    if (record === null) throw new NotFoundException({
      code: 'SHADOW_PAYROLL_CYCLE_NOT_FOUND', message: '影子工资周期不存在',
    });
    return record;
  }

  private async requirePeriod(id: string, session?: ClientSession): Promise<PayrollPeriodRecord> {
    const query = this.periods.findOne({ tenantId: this.tenantId(), id });
    if (session !== undefined) query.session(session);
    const record = await query.lean().exec();
    if (record === null) throw new NotFoundException({
      code: 'PAYROLL_PERIOD_NOT_FOUND', message: '工资周期不存在',
    });
    return record;
  }

  private assertImportInput(input: ImportShadowPayrollInput): void {
    if (
      Object.keys(input).sort().join(',') !==
        'lines,periodId,sourceExportId,sourceManifestHash,sourceObjectEvidenceId,sourceSignatureEvidenceId,sourceSystem' ||
      !ULID.test(input.periodId) || !ID.test(input.sourceSystem) ||
      !ID.test(input.sourceExportId) || !ID.test(input.sourceObjectEvidenceId) ||
      !ID.test(input.sourceSignatureEvidenceId) || !HASH.test(input.sourceManifestHash) ||
      !Array.isArray(input.lines)
    ) throw new BadRequestException({
      code: 'SHADOW_PAYROLL_IMPORT_INPUT_INVALID', message: '影子工资导入引用非法',
    });
  }

  private assertScope(scope: string): void {
    if (!this.context.getActorRequired().scopes.includes(scope)) throw new ForbiddenException({
      code: 'AUTH_SCOPE_DENIED', message: '缺少影子工资权限',
    });
  }

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); } catch (error) {
      if (error instanceof ShadowPayrollComparisonError) {
        throw new ConflictException({ code: error.code, message: error.message });
      }
      throw error;
    }
  }

  private tenantId(): string { return this.context.getTenantRequired().tenantId; }
}

function cycleSummary(
  cycle: Pick<PayrollShadowCycleRecord,
    'id' | 'periodId' | 'payrollRunId' | 'period' | 'sourceSystem' | 'sourceManifestHash' |
    'payrollResultHash' | 'comparisonHash' | 'erpEmployeeCount' | 'legacyEmployeeCount' |
    'erpTotalGrossMinor' | 'legacyTotalGrossMinor' | 'erpTotalTaxMinor' |
    'legacyTotalTaxMinor' | 'erpTotalNetMinor' | 'legacyTotalNetMinor' | 'differenceCodes' |
    'differenceCount' | 'totalAbsoluteDifferenceMinor' | 'version'>,
  explained: number,
  payrollSignoff: Pick<PayrollShadowSignoffRecord, 'id'> | null,
  financeSignoff: Pick<PayrollShadowSignoffRecord, 'id'> | null,
  ready: Pick<PayrollCutoverReadinessRecord, 'id'> | null,
): PayrollShadowCycleSummary {
  const unresolved = cycle.differenceCount - explained;
  return Object.freeze({
    id: cycle.id, periodId: cycle.periodId, payrollRunId: cycle.payrollRunId,
    period: cycle.period, sourceSystem: cycle.sourceSystem,
    sourceManifestHash: cycle.sourceManifestHash, payrollResultHash: cycle.payrollResultHash,
    comparisonHash: cycle.comparisonHash,
    status: unresolved !== 0 ? 'needs_explanation'
      : payrollSignoff === null ? 'ready_for_payroll_signoff'
        : financeSignoff === null ? 'ready_for_finance_signoff' : 'signed',
    erpEmployeeCount: cycle.erpEmployeeCount, legacyEmployeeCount: cycle.legacyEmployeeCount,
    erpTotalGrossMinor: cycle.erpTotalGrossMinor,
    legacyTotalGrossMinor: cycle.legacyTotalGrossMinor,
    erpTotalTaxMinor: cycle.erpTotalTaxMinor, legacyTotalTaxMinor: cycle.legacyTotalTaxMinor,
    erpTotalNetMinor: cycle.erpTotalNetMinor, legacyTotalNetMinor: cycle.legacyTotalNetMinor,
    differenceCodes: Object.freeze([...cycle.differenceCodes]) as readonly ShadowPayrollDifferenceCode[],
    differenceCount: cycle.differenceCount, explainedDifferenceCount: explained,
    unresolvedDifferenceCount: unresolved,
    totalAbsoluteDifferenceMinor: cycle.totalAbsoluteDifferenceMinor,
    payrollSignoffId: payrollSignoff?.id ?? null,
    financeSignoffId: financeSignoff?.id ?? null,
    cutoverReadinessId: ready?.id ?? null,
    version: cycle.version,
  });
}

function signoffFor(
  signoffs: readonly Pick<PayrollShadowSignoffRecord, 'id' | 'role'>[],
  role: 'payroll_owner' | 'finance_owner',
): Pick<PayrollShadowSignoffRecord, 'id'> | null {
  return signoffs.find((item) => item.role === role) ?? null;
}

function readinessSummary(record: PayrollCutoverReadinessRecord): PayrollCutoverReadinessSummary {
  return Object.freeze({
    id: record.id, firstCycleId: record.firstCycleId, secondCycleId: record.secondCycleId,
    startPeriod: record.startPeriod, endPeriod: record.endPeriod,
    evidenceHash: record.evidenceHash, status: record.status, version: record.version,
  });
}

function previousMonth(period: string): string {
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5, 7));
  const previousYear = month === 1 ? year - 1 : year;
  const previous = month === 1 ? 12 : month - 1;
  return `${String(previousYear).padStart(4, '0')}-${String(previous).padStart(2, '0')}`;
}

function protectedRecord(value: {
  readonly keyId: string; readonly iv: string; readonly ciphertext: string; readonly authTag: string;
}) {
  return {
    dataKeyId: value.keyId, dataIv: value.iv,
    dataCiphertext: value.ciphertext, dataAuthTag: value.authTag,
  };
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
