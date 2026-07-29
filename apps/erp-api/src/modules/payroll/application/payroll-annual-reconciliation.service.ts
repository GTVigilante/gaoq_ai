import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createEventId } from '@gaoq/shared-utils';
import type { Model } from 'mongoose';
import { z } from 'zod';

import { IdempotencyService } from '../../../core/idempotency/idempotency.service.js';
import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { LegacyPayrollBoundaryService } from '../legacy-payroll-boundary.service.js';
import {
  AnnualPayrollReconciliationError,
  reconcileAnnualPayrollWithholding,
  type AnnualPayrollWithholdingReconciliationResult,
  type OfficialAnnualTaxAssessment,
  type PayrollCalculationInput,
  type PayrollCalculationResult,
} from '../domain/index.js';
import { PayrollDataCryptoService } from '../persistence/payroll-data-crypto.service.js';
import { PayrollOutboxWriter } from '../persistence/payroll-outbox.writer.js';
import {
  PayrollAnnualReconciliationRecord,
  type PayrollAnnualReconciliationDocument,
  PayrollCalculationLineRecord,
  type PayrollCalculationLineDocument,
  PayrollInputSnapshotRecord,
  type PayrollInputSnapshotDocument,
  PayrollPeriodRecord,
  type PayrollPeriodDocument,
  PayrollTaxFilingRecord,
  type PayrollTaxFilingDocument,
} from '../persistence/payroll.schemas.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const HASH = /^[A-Za-z0-9_-]{43}$/;
const YEAR = /^\d{4}$/;
const componentSchema = z.object({
  code: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
  amountMinor: z.number().int().safe().nonnegative(),
}).strict();
const cumulativeSchema = z.object({
  taxableIncomeMinor: z.number().int().safe().nonnegative(),
  basicDeductionMinor: z.number().int().safe().nonnegative(),
  socialInsuranceMinor: z.number().int().safe().nonnegative(),
  housingFundMinor: z.number().int().safe().nonnegative(),
  specialAdditionalDeductionMinor: z.number().int().safe().nonnegative(),
  otherDeductionMinor: z.number().int().safe().nonnegative(),
  taxWithheldMinor: z.number().int().safe().nonnegative(),
}).strict();
const inputSchema = z.object({
  tenantId: z.string().regex(ID), employeeId: z.string().regex(ID),
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  currency: z.literal('CNY'), engineVersion: z.string().regex(ID),
  rulePack: z.object({
    id: z.string().regex(ID), version: z.number().int().positive(),
    monthlyBasicDeductionMinor: z.number().int().safe().nonnegative(),
    taxBrackets: z.array(z.object({
      upperBoundMinor: z.number().int().safe().nonnegative().nullable(),
      rateBps: z.number().int().min(0).max(10_000),
      quickDeductionMinor: z.number().int().safe().nonnegative(),
    }).strict()).min(1).max(64),
    roundingMode: z.literal('HALF_UP'),
  }).strict(),
  taxableEarnings: z.array(componentSchema).max(128),
  nonTaxableEarnings: z.array(componentSchema).max(128),
  employeeSocialInsuranceMinor: z.number().int().safe().nonnegative(),
  employeeHousingFundMinor: z.number().int().safe().nonnegative(),
  specialAdditionalDeductionMinor: z.number().int().safe().nonnegative(),
  otherPreTaxWithholdingMinor: z.number().int().safe().nonnegative(),
  postTaxDeductionMinor: z.number().int().safe().nonnegative(),
  cumulativeBefore: cumulativeSchema,
  compensationAllocations: z.array(z.object({
    profileId: z.string().regex(ID), profileVersion: z.number().int().positive(),
    profileHash: z.string().regex(HASH), jurisdictionCode: z.string().regex(ID),
    effectiveFrom: z.string(), effectiveTo: z.string().nullable(),
    allocatedFrom: z.string(), allocatedTo: z.string(),
    allocatedDays: z.number().int().min(1).max(31),
    periodDays: z.number().int().min(28).max(31),
    allocationMethod: z.literal('CALENDAR_DAY_HALF_UP'),
  }).strict()).min(1).max(31).optional(),
}).strict();
const resultSchema = z.object({
  currency: z.literal('CNY'), inputHash: z.string().regex(HASH),
  grossPayMinor: z.number().int().safe().nonnegative(),
  taxableEarningsMinor: z.number().int().safe().nonnegative(),
  withholdingTaxMinor: z.number().int().safe(),
  netPayMinor: z.number().int().safe().nonnegative(),
  cumulativeAfter: cumulativeSchema, steps: z.array(z.unknown()),
  resultHash: z.string().regex(HASH),
}).strict();
const filingManifestSchema = z.object({
  schema: z.literal('CN_IIT_WITHHOLDING_MANIFEST_V1'),
  lines: z.array(z.object({
    employeeId: z.string().regex(ID),
    calculationLineId: z.string().regex(ID),
    withholdingTaxMinor: z.number().int().safe(),
    resultHash: z.string().regex(HASH),
  }).passthrough()).min(1).max(5_000),
}).passthrough();
const protectedFilingSchema = z.object({
  content: z.string().min(2).max(8 * 1024 * 1024),
}).strict();
const annualResultSchema = z.object({
  taxYear: z.string().regex(YEAR), currency: z.literal('CNY'),
  periodCount: z.number().int().min(1).max(12),
  firstPeriod: z.string(), lastPeriod: z.string(),
  totalTaxableEarningsMinor: z.number().int().safe().nonnegative(),
  totalPayrollWithheldMinor: z.number().int().safe(),
  totalFiledWithholdingMinor: z.number().int().safe(),
  cumulativeTaxLiabilityMinor: z.number().int().safe().nonnegative(),
  officialAssessedTaxMinor: z.number().int().safe().nonnegative().nullable(),
  employeePayableToTaxAuthorityMinor: z.number().int().safe().nonnegative(),
  employeeRefundFromTaxAuthorityMinor: z.number().int().safe().nonnegative(),
  differences: z.array(z.enum([
    'MONTHLY_FILING_MISMATCH', 'ANNUAL_FILING_TOTAL_MISMATCH',
  ])).max(2),
  status: z.enum([
    'awaiting_assessment', 'assessment_matched',
    'requires_employee_settlement', 'frozen',
  ]),
  evidenceHash: z.string().regex(HASH),
}).strict();

export interface PrepareAnnualPayrollReconciliationInput {
  readonly employeeId: string;
  readonly taxYear: string;
  readonly officialAssessment?: OfficialAnnualTaxAssessment;
}

export interface AnnualPayrollReconciliationSummary
  extends AnnualPayrollWithholdingReconciliationResult, Record<string, unknown> {
  readonly id: string;
  readonly employeeId: string;
  readonly version: number;
}

export interface AnnualPayrollReconciliationControlSummary extends Record<string, unknown> {
  readonly id: string;
  readonly taxYear: string;
  readonly periodCount: number;
  readonly firstPeriod: string;
  readonly lastPeriod: string;
  readonly status: AnnualPayrollWithholdingReconciliationResult['status'];
  readonly version: number;
  readonly evidenceHash: string;
}

/** 员工年度工资代扣与税局评估核对；不替代个人申报或执行税款收付。 */
@Injectable()
export class PayrollAnnualReconciliationService {
  constructor(
    private readonly idempotency: IdempotencyService,
    private readonly context: TenantContextService,
    private readonly boundary: LegacyPayrollBoundaryService,
    private readonly crypto: PayrollDataCryptoService,
    private readonly outbox: PayrollOutboxWriter,
    @InjectModel(PayrollPeriodRecord.name)
    private readonly periods: Model<PayrollPeriodDocument>,
    @InjectModel(PayrollInputSnapshotRecord.name)
    private readonly inputs: Model<PayrollInputSnapshotDocument>,
    @InjectModel(PayrollCalculationLineRecord.name)
    private readonly results: Model<PayrollCalculationLineDocument>,
    @InjectModel(PayrollTaxFilingRecord.name)
    private readonly filings: Model<PayrollTaxFilingDocument>,
    @InjectModel(PayrollAnnualReconciliationRecord.name)
    private readonly annualRecords: Model<PayrollAnnualReconciliationDocument>,
  ) {}

  async prepare(
    key: string,
    input: PrepareAnnualPayrollReconciliationInput,
  ): Promise<AnnualPayrollReconciliationSummary> {
    this.assertPrepareActor();
    this.boundary.assertLegacy();
    assertInput(input);
    return this.run(() => this.idempotency.execute(
      'payroll.annual_reconciliation.prepare', key, input, async (session) => {
        const periods = await this.periods.find({
          tenantId: this.tenantId(),
          period: { $gte: `${input.taxYear}-01`, $lte: `${input.taxYear}-12` },
          status: { $in: ['locked', 'disbursing', 'reconciling', 'reconciled'] },
          activeRunId: { $type: 'string' },
        }).sort({ period: 1 }).session(session).lean().exec();
        const entries = [];
        const sourceReferences: Array<Readonly<Record<string, string>>> = [];
        for (const period of periods) {
          if (period.activeRunId === null) continue;
          const [inputRecord, resultRecord, filing] = await Promise.all([
            this.inputs.findOne({
              tenantId: this.tenantId(), periodId: period.id,
              runId: period.activeRunId, employeeId: input.employeeId,
            }).session(session).lean().exec(),
            this.results.findOne({
              tenantId: this.tenantId(), periodId: period.id,
              runId: period.activeRunId, employeeId: input.employeeId,
            }).session(session).lean().exec(),
            this.filings.findOne({
              tenantId: this.tenantId(), periodId: period.id,
              payrollRunId: period.activeRunId, status: 'submitted',
            }).session(session).lean().exec(),
          ]);
          if (inputRecord === null && resultRecord === null) continue;
          if (inputRecord === null || resultRecord === null || filing === null ||
            filing.taxSubmissionEvidenceId === null) throw new ConflictException({
            code: 'PAYROLL_ANNUAL_SOURCE_INCOMPLETE',
            message: '年度工资输入、结果或已提交税务清单不完整',
          });
          const protectedInput = inputSchema.parse(this.crypto.unprotect({
            tenantId: this.tenantId(), resourceType: 'input_snapshot',
            resourceId: inputRecord.id, version: 1,
          }, protectedValue(inputRecord))) as PayrollCalculationInput;
          const protectedResult = resultSchema.parse(this.crypto.unprotect({
            tenantId: this.tenantId(), resourceType: 'calculation_line',
            resourceId: resultRecord.id, version: 1,
          }, protectedValue(resultRecord))) as PayrollCalculationResult;
          if (protectedResult.inputHash !== inputRecord.inputHash ||
            protectedResult.resultHash !== resultRecord.resultHash) throw new ConflictException({
            code: 'PAYROLL_ANNUAL_PAYROLL_INTEGRITY_FAILED',
            message: '年度工资输入或结果控制摘要不一致',
          });
          const protectedManifest = protectedFilingSchema.parse(this.crypto.unprotect({
            tenantId: this.tenantId(), resourceType: 'tax_filing',
            resourceId: filing.id, version: 1,
          }, protectedValue(filing)));
          const manifest = parseManifest(protectedManifest.content);
          const filedLine = manifest.lines.find((line) => line.employeeId === input.employeeId);
          if (filedLine === undefined || filedLine.calculationLineId !== resultRecord.id ||
            filedLine.resultHash !== resultRecord.resultHash) throw new ConflictException({
            code: 'PAYROLL_ANNUAL_FILING_LINE_INVALID',
            message: '年度税务清单员工行与锁定工资行不一致',
          });
          entries.push(Object.freeze({
            period: period.period, input: protectedInput, result: protectedResult,
            filingId: filing.id, filingEvidenceId: filing.taxSubmissionEvidenceId,
            filingStatus: 'submitted' as const,
            filedWithholdingTaxMinor: filedLine.withholdingTaxMinor,
          }));
          sourceReferences.push(Object.freeze({
            period: period.period, inputSnapshotId: inputRecord.id,
            inputHash: inputRecord.inputHash, resultLineId: resultRecord.id,
            resultHash: resultRecord.resultHash, filingId: filing.id,
            filingContentHash: filing.contentHash,
            filingEvidenceId: filing.taxSubmissionEvidenceId,
          }));
        }
        if (entries.length < 1) throw new NotFoundException({
          code: 'PAYROLL_ANNUAL_EMPLOYEE_NOT_FOUND',
          message: '税年内不存在可核对的员工锁定工资',
        });
        const result = reconcileAnnualPayrollWithholding({
          tenantId: this.tenantId(), employeeId: input.employeeId,
          taxYear: input.taxYear, entries,
          ...(input.officialAssessment === undefined ? {} : {
            officialAssessment: input.officialAssessment,
          }),
        });
        const latest = await this.annualRecords.findOne({
          tenantId: this.tenantId(), employeeId: input.employeeId, taxYear: input.taxYear,
        }).sort({ version: -1 }).session(session).lean().exec();
        const version = (latest?.version ?? 0) + 1;
        const now = new Date();
        const id = createEventId(now);
        const protectedData = this.crypto.protect({
          tenantId: this.tenantId(), resourceType: 'annual_reconciliation',
          resourceId: id, version,
        }, {
          result,
          sourceReferences: Object.freeze(sourceReferences),
          officialAssessment: input.officialAssessment ?? null,
        });
        const record = {
          id, tenantId: this.tenantId(), employeeId: input.employeeId,
          taxYear: input.taxYear, periodCount: result.periodCount,
          firstPeriod: result.firstPeriod, lastPeriod: result.lastPeriod,
          officialAssessmentId: input.officialAssessment?.assessmentId ?? null,
          officialAssessmentEvidenceId:
            input.officialAssessment?.assessmentEvidenceId ?? null,
          officialAssessmentSourceDigest: input.officialAssessment?.sourceDigest ?? null,
          status: result.status, evidenceHash: result.evidenceHash,
          preparedBy: this.context.getActorRequired().actorId, version,
          dataKeyId: protectedData.keyId, dataIv: protectedData.iv,
          dataCiphertext: protectedData.ciphertext, dataAuthTag: protectedData.authTag,
          createdAt: now, updatedAt: now,
        };
        await this.annualRecords.create([record], { session });
        await this.outbox.append({
          type: 'payroll.annual_reconciliation.prepared', tenantId: this.tenantId(),
          aggregateId: id, version, occurredAt: now.toISOString(),
          data: {
            taxYear: input.taxYear, periodCount: result.periodCount,
            status: result.status, evidenceHash: result.evidenceHash,
          },
        }, session);
        return summary(record, result);
      },
    ));
  }

  async get(id: string): Promise<AnnualPayrollReconciliationSummary> {
    this.assertScope('erp:payroll:annual:read');
    this.boundary.assertLegacy();
    if (!ULID.test(id)) throw new BadRequestException({
      code: 'PAYROLL_ANNUAL_ID_INVALID', message: '年度工资代扣核对标识非法',
    });
    return this.run(async () => {
      const record = await this.annualRecords.findOne({
        tenantId: this.tenantId(), id,
      }).lean().exec();
      if (record === null) throw new NotFoundException({
        code: 'PAYROLL_ANNUAL_NOT_FOUND', message: '年度工资代扣核对不存在',
      });
      const bundle = z.object({ result: annualResultSchema }).passthrough().parse(
        this.crypto.unprotect({
          tenantId: this.tenantId(), resourceType: 'annual_reconciliation',
          resourceId: record.id, version: record.version,
        }, protectedValue(record)),
      );
      if (bundle.result.evidenceHash !== record.evidenceHash ||
        bundle.result.taxYear !== record.taxYear ||
        bundle.result.status !== record.status ||
        bundle.result.periodCount !== record.periodCount ||
        bundle.result.firstPeriod !== record.firstPeriod ||
        bundle.result.lastPeriod !== record.lastPeriod) throw new ConflictException({
        code: 'PAYROLL_ANNUAL_RECORD_INTEGRITY_FAILED',
        message: '年度工资代扣核对控制字段与密文不一致',
      });
      return summary(record, bundle.result);
    });
  }

  /** AI/控制面只读脱敏摘要；不返回员工、税额、税表或税局证据标识。 */
  async getControlStatus(id: string): Promise<AnnualPayrollReconciliationControlSummary> {
    const value = await this.get(id);
    return Object.freeze({
      id: value.id, taxYear: value.taxYear, periodCount: value.periodCount,
      firstPeriod: value.firstPeriod, lastPeriod: value.lastPeriod,
      status: value.status, version: value.version, evidenceHash: value.evidenceHash,
    });
  }

  private assertPrepareActor(): void {
    this.assertScope('erp:payroll:annual:prepare');
    const actor = this.context.getActorRequired();
    if (!['service', 'system_job'].includes(actor.actorType)) throw new ForbiddenException({
      code: 'PAYROLL_ANNUAL_SERVICE_REQUIRED',
      message: '年度工资代扣核对只允许受信任薪税服务执行',
    });
  }

  private assertScope(scope: string): void {
    if (!this.context.getActorRequired().scopes.includes(scope)) throw new ForbiddenException({
      code: 'AUTH_SCOPE_DENIED', message: '缺少年度工资代扣核对权限',
    });
  }

  private tenantId(): string {
    return this.context.getTenantRequired().tenantId;
  }

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof AnnualPayrollReconciliationError) {
        throw new ConflictException({ code: error.code, message: error.message });
      }
      if (error instanceof z.ZodError || error instanceof SyntaxError) {
        throw new ConflictException({
          code: 'PAYROLL_ANNUAL_PROTECTED_DATA_INVALID',
          message: '年度工资或税务密文结构非法',
        });
      }
      if (isDuplicateKeyError(error)) throw new ConflictException({
        code: 'PAYROLL_ANNUAL_WRITE_CONFLICT',
        message: '年度工资代扣核对版本或标识冲突',
      });
      throw error;
    }
  }
}

function assertInput(input: PrepareAnnualPayrollReconciliationInput): void {
  const keys = Object.keys(input).sort().join(',');
  const assessment = input.officialAssessment;
  if (!['employeeId,taxYear', 'employeeId,officialAssessment,taxYear'].includes(keys) ||
    !ID.test(input.employeeId) || !YEAR.test(input.taxYear) ||
    (assessment !== undefined && (
      Object.keys(assessment).sort().join(',') !==
        'assessedTaxMinor,assessmentEvidenceId,assessmentId,sourceDigest' ||
      !ID.test(assessment.assessmentId) || !ID.test(assessment.assessmentEvidenceId) ||
      !HASH.test(assessment.sourceDigest) ||
      !Number.isSafeInteger(assessment.assessedTaxMinor) ||
      assessment.assessedTaxMinor < 0
    ))) {
    throw new BadRequestException({
      code: 'PAYROLL_ANNUAL_INPUT_INVALID', message: '年度工资代扣核对引用非法',
    });
  }
}

function parseManifest(content: string) {
  return filingManifestSchema.parse(JSON.parse(content) as unknown);
}

function summary(
  record: PayrollAnnualReconciliationRecord,
  result: AnnualPayrollWithholdingReconciliationResult,
): AnnualPayrollReconciliationSummary {
  return Object.freeze({
    id: record.id, employeeId: record.employeeId, version: record.version,
    ...result,
  });
}

function protectedValue(record: {
  readonly dataKeyId: string;
  readonly dataIv: string;
  readonly dataCiphertext: string;
  readonly dataAuthTag: string;
}) {
  return {
    keyId: record.dataKeyId, iv: record.dataIv,
    ciphertext: record.dataCiphertext, authTag: record.dataAuthTag,
  };
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error &&
    (error as { readonly code?: unknown }).code === 11000;
}
