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
import { EmployeeRepository } from '../../org/persistence/org.repositories.js';
import { ApprovalApplicationService } from '../../approval/application/approval-application.service.js';
import {
  calculatePayroll,
  payrollDigest,
  PayrollCalculationError,
  type PayrollRulePackSnapshot,
} from '../domain/index.js';
import { PayrollDataCryptoService } from '../persistence/payroll-data-crypto.service.js';
import { PayrollOutboxWriter } from '../persistence/payroll-outbox.writer.js';
import {
  PayrollCompensationProfileRecord,
  type PayrollCompensationProfileDocument,
  PayrollRulePackRecord,
  type PayrollRulePackDocument,
} from '../persistence/payroll.schemas.js';
import type { AttestCompensationProfileDto, AttestPayrollRulePackDto } from './payroll.dto.js';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HASH_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SOURCE_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const profileSchema = z.object({
  currency: z.literal('CNY'),
  jurisdictionCode: z.string().regex(ID_PATTERN),
  taxableEarnings: z.array(z.object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
    amountMinor: z.number().int().safe().nonnegative(),
  }).strict()).max(128),
  nonTaxableEarnings: z.array(z.object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
    amountMinor: z.number().int().safe().nonnegative(),
  }).strict()).max(128),
  employeeSocialInsuranceMinor: z.number().int().safe().nonnegative(),
  employeeHousingFundMinor: z.number().int().safe().nonnegative(),
  specialAdditionalDeductionMinor: z.number().int().safe().nonnegative(),
  otherPreTaxWithholdingMinor: z.number().int().safe().nonnegative(),
  postTaxDeductionMinor: z.number().int().safe().nonnegative(),
  attendanceAdjustment: z.object({
    overtimePayMinorPerMinute: z.number().int().safe().nonnegative(),
    absenceDeductionMinorPerMinute: z.number().int().safe().nonnegative(),
    unpaidLeaveDeductionMinorPerMinute: z.number().int().safe().nonnegative(),
  }).strict(),
}).strict();

export interface CompensationProfileSummary extends Record<string, unknown> {
  readonly id: string;
  readonly employeeId: string;
  readonly jurisdictionCode: string;
  readonly version: number;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly profileHash: string;
}

export interface RulePackSummary extends Record<string, unknown> {
  readonly id: string;
  readonly code: string;
  readonly jurisdictionCode: string;
  readonly version: number;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly rulesHash: string;
  readonly sourceDigest: string;
}

export interface ImportPayrollCompensationFromMigrationInput {
  readonly targetId: string | null;
  readonly employeeId: string;
  readonly version: number;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly approvalHistoryId: string;
  readonly approvalEvidenceChecksum: string;
  readonly data: z.infer<typeof profileSchema>;
  readonly createdAt: string;
  readonly migrationEvidenceRef: string;
  readonly evidenceChecksum: string;
}

export interface ImportPayrollRulePackFromMigrationInput {
  readonly targetId: string | null;
  readonly code: string;
  readonly jurisdictionCode: string;
  readonly version: number;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly monthlyBasicDeductionMinor: number;
  readonly taxBrackets: readonly {
    readonly upperBoundMinor: number | null;
    readonly rateBps: number;
    readonly quickDeductionMinor: number;
  }[];
  readonly sourceDigest: string;
  readonly sourceReference: string;
  readonly approvalHistoryId: string;
  readonly approvalEvidenceChecksum: string;
  readonly createdAt: string;
  readonly migrationEvidenceRef: string;
  readonly evidenceChecksum: string;
}

/** 接收外部审批/法规发布器的可信证明，并形成不可变薪资主数据版本。 */
@Injectable()
export class PayrollMasterDataService {
  constructor(
    private readonly idempotency: IdempotencyService,
    private readonly context: TenantContextService,
    private readonly employees: EmployeeRepository,
    private readonly approvals: ApprovalApplicationService,
    private readonly crypto: PayrollDataCryptoService,
    private readonly outbox: PayrollOutboxWriter,
    @InjectModel(PayrollCompensationProfileRecord.name)
    private readonly profiles: Model<PayrollCompensationProfileDocument>,
    @InjectModel(PayrollRulePackRecord.name)
    private readonly rulePacks: Model<PayrollRulePackDocument>,
  ) {}

  /** 迁移专用：恢复 L4 薪酬版本，不触发普通证明事件或覆盖既有版本。 */
  async importCompensationFromMigration(
    key: string,
    input: ImportPayrollCompensationFromMigrationInput,
  ): Promise<CompensationProfileSummary> {
    this.assertMigrationWriter();
    this.assertInterval(input.effectiveFrom, input.effectiveTo);
    assertMigrationEnvelope(input);
    const parsed = profileSchema.safeParse(input.data);
    if (!parsed.success) throw new BadRequestException({
      code: 'PAYROLL_MIGRATION_COMPENSATION_DATA_INVALID', message: '迁移薪酬档案结构非法',
    });
    this.assertUniqueComponents(parsed.data.taxableEarnings, parsed.data.nonTaxableEarnings);
    return this.run(() => this.idempotency.execute(
      'payroll.compensation.import_from_migration', key, input, async (session) => {
        if (await this.employees.findById(input.employeeId, session) === null) {
          throw new NotFoundException({
            code: 'PAYROLL_MIGRATION_EMPLOYEE_NOT_FOUND', message: '迁移薪酬员工不存在',
          });
        }
        const approval = await this.approvals.verifyPayrollMigrationReference(
          input.approvalHistoryId, 'payroll_compensation', session,
        );
        const createdAt = strictMigrationInstant(input.createdAt);
        if (approval.evidenceChecksum !== input.approvalEvidenceChecksum ||
          Date.parse(approval.completedAt) > createdAt.getTime()) {
          throw invalidMigrationApproval();
        }
        const id = input.targetId ?? createEventId(createdAt);
        const profileHash = payrollDigest(parsed.data);
        if (input.targetId !== null) {
          const existing = await this.profiles.findOne({ tenantId: this.tenantId(), id })
            .session(session).lean().exec();
          if (existing === null || existing.employeeId !== input.employeeId ||
            existing.jurisdictionCode !== parsed.data.jurisdictionCode ||
            existing.version !== input.version || existing.effectiveFrom !== input.effectiveFrom ||
            existing.effectiveTo !== input.effectiveTo ||
            existing.approvalEvidenceId !== approval.id || existing.profileHash !== profileHash ||
            existing.createdAt.toISOString() !== input.createdAt ||
            existing.migrationEvidenceRef !== input.migrationEvidenceRef ||
            existing.migrationEvidenceChecksum !== input.evidenceChecksum ||
            payrollDigest(this.unprotectProfile(existing)) !== profileHash) {
            throw new ConflictException({
              code: 'PAYROLL_MIGRATION_COMPENSATION_IMMUTABLE',
              message: '既有薪酬档案、审批或 WORM 证据不一致，禁止覆盖',
            });
          }
          return compensationSummary(existing);
        }
        await this.assertCompensationVersionAndInterval(input, session);
        const protectedData = this.crypto.protect({
          tenantId: this.tenantId(), resourceType: 'compensation_profile',
          resourceId: id, version: input.version,
        }, parsed.data);
        await this.profiles.create([{
          id, tenantId: this.tenantId(), employeeId: input.employeeId, version: input.version,
          jurisdictionCode: parsed.data.jurisdictionCode,
          effectiveFrom: input.effectiveFrom, effectiveTo: input.effectiveTo,
          approvalEvidenceId: approval.id, status: 'active', profileHash,
          dataKeyId: protectedData.keyId, dataIv: protectedData.iv,
          dataCiphertext: protectedData.ciphertext, dataAuthTag: protectedData.authTag,
          migrationEvidenceRef: input.migrationEvidenceRef,
          migrationEvidenceChecksum: input.evidenceChecksum,
          createdAt, updatedAt: createdAt,
        }], { session });
        await this.outbox.append({
          type: 'payroll.compensation_profile.migrated', tenantId: this.tenantId(),
          aggregateId: id, version: input.version, occurredAt: input.createdAt, data: {
            employeeId: input.employeeId, effectiveFrom: input.effectiveFrom,
            effectiveTo: input.effectiveTo,
            jurisdictionCode: parsed.data.jurisdictionCode, profileHash,
          },
        }, session);
        return Object.freeze({
          id, employeeId: input.employeeId, version: input.version,
          jurisdictionCode: parsed.data.jurisdictionCode,
          effectiveFrom: input.effectiveFrom, effectiveTo: input.effectiveTo, profileHash,
        });
      },
    ));
  }

  /** 迁移专用：恢复法定规则版本并重新运行确定性规则校验。 */
  async importRulePackFromMigration(
    key: string,
    input: ImportPayrollRulePackFromMigrationInput,
  ): Promise<RulePackSummary> {
    this.assertMigrationWriter();
    this.assertInterval(input.effectiveFrom, input.effectiveTo);
    assertMigrationEnvelope(input);
    if (!ID_PATTERN.test(input.code) || !ID_PATTERN.test(input.jurisdictionCode) ||
      !HASH_PATTERN.test(input.sourceDigest) ||
      !SOURCE_REFERENCE_PATTERN.test(input.sourceReference)) throw new BadRequestException({
      code: 'PAYROLL_MIGRATION_RULE_REFERENCE_INVALID', message: '迁移规则来源非法',
    });
    return this.run(() => this.idempotency.execute(
      'payroll.rule_pack.import_from_migration', key, input, async (session) => {
        const approval = await this.approvals.verifyPayrollMigrationReference(
          input.approvalHistoryId, 'payroll_rule_pack', session,
        );
        const createdAt = strictMigrationInstant(input.createdAt);
        if (approval.evidenceChecksum !== input.approvalEvidenceChecksum ||
          Date.parse(approval.completedAt) > createdAt.getTime()) throw invalidMigrationApproval();
        const id = input.targetId ?? createEventId(createdAt);
        const rulePack: PayrollRulePackSnapshot = Object.freeze({
          id, version: input.version,
          monthlyBasicDeductionMinor: input.monthlyBasicDeductionMinor,
          taxBrackets: Object.freeze(input.taxBrackets.map((item) => Object.freeze({ ...item }))),
          roundingMode: 'HALF_UP',
        });
        this.validateRulePack(rulePack);
        const rulesHash = payrollDigest(rulePack);
        if (input.targetId !== null) {
          const existing = await this.rulePacks.findOne({ tenantId: this.tenantId(), id })
            .session(session).lean().exec();
          if (existing === null || existing.code !== input.code ||
            existing.jurisdictionCode !== input.jurisdictionCode ||
            existing.version !== input.version || existing.effectiveFrom !== input.effectiveFrom ||
            existing.effectiveTo !== input.effectiveTo ||
            existing.monthlyBasicDeductionMinor !== input.monthlyBasicDeductionMinor ||
            existing.roundingMode !== 'HALF_UP' ||
            payrollDigest(existing.taxBrackets) !== payrollDigest(input.taxBrackets) ||
            existing.rulesHash !== rulesHash ||
            existing.sourceDigest !== input.sourceDigest ||
            existing.sourceReference !== input.sourceReference ||
            existing.approvalEvidenceId !== approval.id ||
            existing.createdAt.toISOString() !== input.createdAt ||
            existing.migrationEvidenceRef !== input.migrationEvidenceRef ||
            existing.migrationEvidenceChecksum !== input.evidenceChecksum) {
            throw new ConflictException({
              code: 'PAYROLL_MIGRATION_RULE_IMMUTABLE',
              message: '既有规则包、审批或 WORM 证据不一致，禁止覆盖',
            });
          }
          return rulePackSummary(existing);
        }
        await this.assertRuleVersionAndInterval(input, session);
        await this.rulePacks.create([{
          id, tenantId: this.tenantId(), code: input.code, version: input.version,
          jurisdictionCode: input.jurisdictionCode, effectiveFrom: input.effectiveFrom,
          effectiveTo: input.effectiveTo,
          monthlyBasicDeductionMinor: input.monthlyBasicDeductionMinor,
          taxBrackets: input.taxBrackets.map((item) => ({ ...item })),
          roundingMode: 'HALF_UP', rulesHash,
          sourceDigest: input.sourceDigest, sourceReference: input.sourceReference,
          approvalEvidenceId: approval.id, status: 'published',
          migrationEvidenceRef: input.migrationEvidenceRef,
          migrationEvidenceChecksum: input.evidenceChecksum,
          createdAt, updatedAt: createdAt,
        }], { session });
        await this.outbox.append({
          type: 'payroll.rule_pack.migrated', tenantId: this.tenantId(),
          aggregateId: id, version: input.version, occurredAt: input.createdAt, data: {
            code: input.code, jurisdictionCode: input.jurisdictionCode,
            effectiveFrom: input.effectiveFrom, effectiveTo: input.effectiveTo,
            rulesHash, sourceDigest: input.sourceDigest,
          },
        }, session);
        return Object.freeze({
          id, code: input.code, jurisdictionCode: input.jurisdictionCode,
          version: input.version, effectiveFrom: input.effectiveFrom,
          effectiveTo: input.effectiveTo, rulesHash, sourceDigest: input.sourceDigest,
        });
      },
    ));
  }

  async attestCompensation(
    key: string,
    input: AttestCompensationProfileDto,
  ): Promise<CompensationProfileSummary> {
    this.assertTrustedService('erp:payroll:compensation:attest');
    const effectiveTo = input.effectiveTo ?? null;
    this.assertInterval(input.effectiveFrom, effectiveTo);
    if (!ID_PATTERN.test(input.employeeId) || !ID_PATTERN.test(input.jurisdictionCode) ||
      !ID_PATTERN.test(input.approvalEvidenceId)) {
      throw new BadRequestException({
        code: 'PAYROLL_COMPENSATION_REFERENCE_INVALID', message: '薪酬档案引用非法',
      });
    }
    const parsed = profileSchema.safeParse({
      currency: 'CNY', jurisdictionCode: input.jurisdictionCode,
      taxableEarnings: input.taxableEarnings,
      nonTaxableEarnings: input.nonTaxableEarnings,
      employeeSocialInsuranceMinor: input.employeeSocialInsuranceMinor,
      employeeHousingFundMinor: input.employeeHousingFundMinor,
      specialAdditionalDeductionMinor: input.specialAdditionalDeductionMinor,
      otherPreTaxWithholdingMinor: input.otherPreTaxWithholdingMinor,
      postTaxDeductionMinor: input.postTaxDeductionMinor,
      attendanceAdjustment: input.attendanceAdjustment,
    });
    if (!parsed.success) throw new BadRequestException({
      code: 'PAYROLL_COMPENSATION_DATA_INVALID', message: '薪酬档案结构或金额非法',
    });
    const data = parsed.data;
    this.assertUniqueComponents(data.taxableEarnings, data.nonTaxableEarnings);
    return this.run(() => this.idempotency.execute(
      'payroll.compensation.attest', key, input, async (session) => {
      if (await this.employees.findById(input.employeeId, session) === null) {
        throw new NotFoundException({
          code: 'PAYROLL_EMPLOYEE_NOT_FOUND', message: 'ERP 员工主数据不存在',
        });
      }
      const overlapping = await this.profiles.findOne({
        tenantId: this.tenantId(), employeeId: input.employeeId,
        ...overlapFilter(input.effectiveFrom, effectiveTo),
      }).session(session).lean().exec();
      if (overlapping !== null) throw new ConflictException({
        code: 'PAYROLL_COMPENSATION_EFFECTIVE_OVERLAP', message: '薪酬档案生效区间重叠',
      });
      const latest = await this.profiles.findOne({
        tenantId: this.tenantId(), employeeId: input.employeeId,
      }).sort({ version: -1 }).session(session).lean().exec();
      const now = new Date();
      const id = createEventId(now);
      const version = (latest?.version ?? 0) + 1;
      const profileHash = payrollDigest(data);
      const protectedData = this.crypto.protect({
        tenantId: this.tenantId(), resourceType: 'compensation_profile',
        resourceId: id, version,
      }, data);
      await this.profiles.create([{
        id, tenantId: this.tenantId(), employeeId: input.employeeId, version,
        jurisdictionCode: input.jurisdictionCode,
        effectiveFrom: input.effectiveFrom, effectiveTo,
        approvalEvidenceId: input.approvalEvidenceId, status: 'active', profileHash,
        dataKeyId: protectedData.keyId, dataIv: protectedData.iv,
        dataCiphertext: protectedData.ciphertext, dataAuthTag: protectedData.authTag,
      }], { session });
      await this.outbox.append({
        type: 'payroll.compensation_profile.attested', tenantId: this.tenantId(),
        aggregateId: id, version, occurredAt: now.toISOString(), data: {
          employeeId: input.employeeId, effectiveFrom: input.effectiveFrom,
          effectiveTo, jurisdictionCode: input.jurisdictionCode, profileHash,
        },
      }, session);
      return Object.freeze({
        id, employeeId: input.employeeId, jurisdictionCode: input.jurisdictionCode, version,
        effectiveFrom: input.effectiveFrom, effectiveTo, profileHash,
      });
      },
    ));
  }

  async attestRulePack(key: string, input: AttestPayrollRulePackDto): Promise<RulePackSummary> {
    this.assertTrustedService('erp:payroll:rule:attest');
    const effectiveTo = input.effectiveTo ?? null;
    this.assertInterval(input.effectiveFrom, effectiveTo);
    if (
      !ID_PATTERN.test(input.code) || !ID_PATTERN.test(input.jurisdictionCode) ||
      !ID_PATTERN.test(input.approvalEvidenceId) || !HASH_PATTERN.test(input.sourceDigest) ||
      !SOURCE_REFERENCE_PATTERN.test(input.sourceReference)
    ) throw new BadRequestException({
      code: 'PAYROLL_RULE_PACK_REFERENCE_INVALID', message: '法定规则来源或审批引用非法',
    });
    return this.run(() => this.idempotency.execute(
      'payroll.rule_pack.attest', key, input, async (session) => {
      const overlap = await this.rulePacks.findOne({
        tenantId: this.tenantId(), jurisdictionCode: input.jurisdictionCode,
        status: 'published', ...overlapFilter(input.effectiveFrom, effectiveTo),
      }).session(session).lean().exec();
      if (overlap !== null) throw new ConflictException({
        code: 'PAYROLL_RULE_PACK_EFFECTIVE_OVERLAP', message: '同法域规则包生效区间重叠',
      });
      const latest = await this.rulePacks.findOne({
        tenantId: this.tenantId(), jurisdictionCode: input.jurisdictionCode,
      }).sort({ version: -1 }).session(session).lean().exec();
      const now = new Date();
      const id = createEventId(now);
      const version = (latest?.version ?? 0) + 1;
      const rulePack: PayrollRulePackSnapshot = Object.freeze({
        id, version, monthlyBasicDeductionMinor: input.monthlyBasicDeductionMinor,
        taxBrackets: Object.freeze(input.taxBrackets.map((item) => Object.freeze({ ...item }))),
        roundingMode: 'HALF_UP',
      });
      this.validateRulePack(rulePack);
      const rulesHash = payrollDigest(rulePack);
      await this.rulePacks.create([{
        id, tenantId: this.tenantId(), code: input.code, version,
        jurisdictionCode: input.jurisdictionCode,
        effectiveFrom: input.effectiveFrom, effectiveTo,
        monthlyBasicDeductionMinor: input.monthlyBasicDeductionMinor,
        taxBrackets: input.taxBrackets, roundingMode: 'HALF_UP', rulesHash,
        sourceDigest: input.sourceDigest, sourceReference: input.sourceReference,
        approvalEvidenceId: input.approvalEvidenceId, status: 'published',
      }], { session });
      await this.outbox.append({
        type: 'payroll.rule_pack.attested', tenantId: this.tenantId(), aggregateId: id,
        version, occurredAt: now.toISOString(), data: {
          code: input.code, jurisdictionCode: input.jurisdictionCode,
          effectiveFrom: input.effectiveFrom, effectiveTo,
          rulesHash, sourceDigest: input.sourceDigest,
        },
      }, session);
      return Object.freeze({
        id, code: input.code, jurisdictionCode: input.jurisdictionCode, version,
        effectiveFrom: input.effectiveFrom, effectiveTo,
        rulesHash, sourceDigest: input.sourceDigest,
      });
      },
    ));
  }

  private validateRulePack(rulePack: PayrollRulePackSnapshot): void {
    calculatePayroll({
      tenantId: this.tenantId(), employeeId: 'rule-validation', period: '2000-01',
      currency: 'CNY', engineVersion: 'rule-validation', rulePack,
      taxableEarnings: [], nonTaxableEarnings: [], employeeSocialInsuranceMinor: 0,
      employeeHousingFundMinor: 0, specialAdditionalDeductionMinor: 0,
      otherPreTaxWithholdingMinor: 0, postTaxDeductionMinor: 0,
      cumulativeBefore: {
        taxableIncomeMinor: 0, basicDeductionMinor: 0, socialInsuranceMinor: 0,
        housingFundMinor: 0, specialAdditionalDeductionMinor: 0,
        otherDeductionMinor: 0, taxWithheldMinor: 0,
      },
    });
  }

  private async assertCompensationVersionAndInterval(
    input: ImportPayrollCompensationFromMigrationInput,
    session: ClientSession,
  ): Promise<void> {
    const [overlap, latest] = await Promise.all([
      this.profiles.findOne({
        tenantId: this.tenantId(), employeeId: input.employeeId,
        ...overlapFilter(input.effectiveFrom, input.effectiveTo),
      }).session(session).lean().exec(),
      this.profiles.findOne({ tenantId: this.tenantId(), employeeId: input.employeeId })
        .sort({ version: -1 }).session(session).lean().exec(),
    ]);
    if (overlap !== null || (latest?.version ?? 0) + 1 !== input.version) {
      throw new ConflictException({
        code: 'PAYROLL_MIGRATION_COMPENSATION_CHAIN_INVALID',
        message: '薪酬档案版本不连续或生效区间重叠',
      });
    }
  }

  private async assertRuleVersionAndInterval(
    input: ImportPayrollRulePackFromMigrationInput,
    session: ClientSession,
  ): Promise<void> {
    const [overlap, latest] = await Promise.all([
      this.rulePacks.findOne({
        tenantId: this.tenantId(), jurisdictionCode: input.jurisdictionCode,
        ...overlapFilter(input.effectiveFrom, input.effectiveTo),
      }).session(session).lean().exec(),
      this.rulePacks.findOne({
        tenantId: this.tenantId(), jurisdictionCode: input.jurisdictionCode,
      }).sort({ version: -1 }).session(session).lean().exec(),
    ]);
    if (overlap !== null || (latest?.version ?? 0) + 1 !== input.version) {
      throw new ConflictException({
        code: 'PAYROLL_MIGRATION_RULE_CHAIN_INVALID',
        message: '规则包版本不连续或生效区间重叠',
      });
    }
  }

  private unprotectProfile(record: PayrollCompensationProfileRecord): z.infer<typeof profileSchema> {
    return profileSchema.parse(this.crypto.unprotect({
      tenantId: record.tenantId, resourceType: 'compensation_profile',
      resourceId: record.id, version: record.version,
    }, {
      keyId: record.dataKeyId, iv: record.dataIv,
      ciphertext: record.dataCiphertext, authTag: record.dataAuthTag,
    }));
  }

  private assertMigrationWriter(): void {
    const actor = this.context.getActorRequired();
    if (!['service', 'system_job'].includes(actor.actorType) ||
      !actor.scopes.includes('erp:migration:execute') ||
      !actor.scopes.includes('erp:payroll:migration:write')) {
      throw new ForbiddenException({
        code: 'PAYROLL_MIGRATION_WRITER_DENIED',
        message: '薪资迁移必须由受信任服务身份执行',
      });
    }
  }

  private assertTrustedService(scope: string): void {
    const actor = this.context.getActorRequired();
    if (!actor.scopes.includes(scope)) throw new ForbiddenException({
      code: 'AUTH_SCOPE_DENIED', message: '缺少薪酬主数据权限',
    });
    if (actor.actorType !== 'service' && actor.actorType !== 'system_job') {
      throw new ForbiddenException({
        code: 'PAYROLL_MASTER_DATA_SERVICE_REQUIRED', message: '仅受信任连接器可登记薪酬主数据',
      });
    }
  }

  private assertInterval(from: string, to: string | null): void {
    if (
      !isCalendarDate(from) ||
      (to !== null && (!isCalendarDate(to) || to < from))
    ) {
      throw new BadRequestException({
        code: 'PAYROLL_EFFECTIVE_INTERVAL_INVALID', message: '生效日期区间非法',
      });
    }
  }

  private assertUniqueComponents(
    taxable: readonly { readonly code: string }[],
    nonTaxable: readonly { readonly code: string }[],
  ): void {
    const codes = [...taxable, ...nonTaxable].map((item) => item.code);
    if (new Set(codes).size !== codes.length || codes.includes('ATTENDANCE_OVERTIME')) {
      throw new BadRequestException({
        code: 'PAYROLL_COMPONENT_CODE_DUPLICATE_OR_RESERVED',
        message: '工资项目编码重复或使用了系统保留编码',
      });
    }
  }

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); } catch (error) {
      if (error instanceof PayrollCalculationError) throw new BadRequestException({
        code: error.code, message: error.message,
      });
      if (isDuplicateKeyError(error)) throw new ConflictException({
        code: 'PAYROLL_MASTER_DATA_VERSION_CONFLICT', message: '薪酬或法定规则版本发生并发冲突',
      });
      throw error;
    }
  }

  private tenantId(): string { return this.context.getTenantRequired().tenantId; }
}

function overlapFilter(from: string, to: string | null): Record<string, unknown> {
  return {
    effectiveFrom: to === null ? { $exists: true } : { $lte: to },
    $or: [{ effectiveTo: null }, { effectiveTo: { $gte: from } }],
  };
}

function isCalendarDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11_000;
}

function assertMigrationEnvelope(input: {
  readonly version: number;
  readonly approvalHistoryId: string;
  readonly approvalEvidenceChecksum: string;
  readonly migrationEvidenceRef: string;
  readonly evidenceChecksum: string;
}): void {
  if (!Number.isSafeInteger(input.version) || input.version < 1 || input.version > 10_000 ||
    !ID_PATTERN.test(input.approvalHistoryId) ||
    !HASH_PATTERN.test(input.approvalEvidenceChecksum) ||
    !MIGRATION_EVIDENCE_REF_PATTERN.test(input.migrationEvidenceRef) ||
    !HASH_PATTERN.test(input.evidenceChecksum)) throw new BadRequestException({
    code: 'PAYROLL_MIGRATION_ENVELOPE_INVALID', message: '薪资迁移版本或证据无效',
  });
}

function strictMigrationInstant(value: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value ||
    parsed.getTime() > Date.now() + 5 * 60 * 1_000) throw new BadRequestException({
    code: 'PAYROLL_MIGRATION_TIME_INVALID', message: '薪资迁移时间必须为历史 UTC 毫秒时间',
  });
  return parsed;
}

function invalidMigrationApproval(): ConflictException {
  return new ConflictException({
    code: 'PAYROLL_MIGRATION_APPROVAL_MISMATCH', message: '薪资迁移审批或证据摘要不一致',
  });
}

function compensationSummary(record: PayrollCompensationProfileRecord): CompensationProfileSummary {
  return Object.freeze({
    id: record.id, employeeId: record.employeeId, version: record.version,
    effectiveFrom: record.effectiveFrom, effectiveTo: record.effectiveTo,
    jurisdictionCode: record.jurisdictionCode,
    profileHash: record.profileHash,
  });
}

function rulePackSummary(record: PayrollRulePackRecord): RulePackSummary {
  return Object.freeze({
    id: record.id, code: record.code, jurisdictionCode: record.jurisdictionCode,
    version: record.version, effectiveFrom: record.effectiveFrom,
    effectiveTo: record.effectiveTo, rulesHash: record.rulesHash,
    sourceDigest: record.sourceDigest,
  });
}

const MIGRATION_EVIDENCE_REF_PATTERN =
  /^erp:\/\/data-migrations\/runs\/[0-7][0-9A-HJKMNP-TV-Z]{25}\/attachments\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
