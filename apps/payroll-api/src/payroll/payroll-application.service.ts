import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import {
  calculatePayrollLine,
  type PayrollLineInput,
  type PayrollLineResult,
} from '@gaoq/payroll-core';
import { createHash, randomUUID } from 'node:crypto';
import { Connection, type Model } from 'mongoose';
import { z } from 'zod';

import { IdentityContextService } from '../identity/identity-context.service.js';
import {
  MasterDataProjectionRecord,
  type MasterDataProjectionDocument,
} from '../master-data/master-data.schemas.js';
import { PayrollDataCryptoService } from './payroll-data-crypto.service.js';
import {
  PayrollCompensationProfileRecord,
  type PayrollCompensationProfileDocument,
  PayrollResultRecord,
  type PayrollResultDocument,
  PayrollRunRecord,
  type PayrollRunDocument,
} from './payroll.schemas.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DATE_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const MONEY_PATTERN = /^(0|[1-9]\d*)$/;

const componentSchema = z.object({
  code: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  direction: z.enum(['earning', 'deduction']),
  amountMinor: z.string().regex(MONEY_PATTERN),
  taxable: z.boolean(),
}).strict();

const compensationSchema = z.object({
  employeeId: z.string().regex(ID_PATTERN),
  version: z.number().int().min(1),
  effectiveFrom: z.string().regex(DATE_PATTERN),
  effectiveTo: z.string().regex(DATE_PATTERN).nullable(),
  components: z.array(componentSchema).min(1).max(200),
}).strict();

const createRunSchema = z.object({
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
}).strict();

const calculationLineSchema = z.object({
  employeeId: z.string().regex(ID_PATTERN),
  ruleVersion: z.number().int().min(1),
  components: z.array(componentSchema).min(1).max(200),
  socialInsuranceEmployeeMinor: z.string().regex(MONEY_PATTERN),
  housingFundEmployeeMinor: z.string().regex(MONEY_PATTERN),
  specialDeductionMinor: z.string().regex(MONEY_PATTERN),
  withholdingTaxMinor: z.string().regex(MONEY_PATTERN),
}).strict();

const calculateRunSchema = z.object({
  expectedVersion: z.number().int().min(1),
  lines: z.array(calculationLineSchema).min(1).max(10_000),
}).strict();

const transitionRunSchema = z.object({
  expectedVersion: z.number().int().min(1),
}).strict();

export interface PayrollRunView {
  readonly id: string;
  readonly period: string;
  readonly status: string;
  readonly employeeCount: number;
  readonly totalGrossMinor: string;
  readonly totalNetMinor: string;
  readonly inputDigest: string | null;
  readonly resultDigest: string | null;
  readonly version: number;
  readonly submittedBy: string | null;
  readonly lockedBy: string | null;
}

export interface SelfPayslipView extends PayrollLineResult {
  readonly payrollRunId: string;
  readonly status: 'locked' | 'reconciling' | 'reconciled';
}

/** 专业算薪应用服务：不可变档案、确定性运行和 L4 工资结果统一编排。 */
@Injectable()
export class PayrollApplicationService {
  constructor(
    private readonly identity: IdentityContextService,
    private readonly crypto: PayrollDataCryptoService,
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(MasterDataProjectionRecord.name)
    private readonly masterData: Model<MasterDataProjectionDocument>,
    @InjectModel(PayrollCompensationProfileRecord.name)
    private readonly profiles: Model<PayrollCompensationProfileDocument>,
    @InjectModel(PayrollRunRecord.name)
    private readonly runs: Model<PayrollRunDocument>,
    @InjectModel(PayrollResultRecord.name)
    private readonly results: Model<PayrollResultDocument>,
  ) {}

  async createCompensation(raw: unknown): Promise<{
    readonly id: string;
    readonly version: number;
    readonly plaintextDigest: string;
  }> {
    const actor = this.identity.requireScope('erp:payroll:compensation:write');
    const input = this.parse(compensationSchema, raw, '薪酬档案结构非法');
    await this.assertEmployeeExists(actor.tenantId, input.employeeId);
    if (input.effectiveTo !== null && input.effectiveTo < input.effectiveFrom) {
      throw new BadRequestException({
        code: 'COMPENSATION_INTERVAL_INVALID',
        message: '薪酬档案结束日期不能早于生效日期',
      });
    }
    const employeeBlindIndex = this.crypto.employeeBlindIndex(
      actor.tenantId,
      input.employeeId,
    );
    const id = randomUUID();
    const protectedValue = this.crypto.protect({
      tenantId: actor.tenantId,
      resourceType: 'compensation_profile',
      resourceId: id,
      version: input.version,
    }, {
      employeeId: input.employeeId,
      components: input.components,
    });
    await this.connection.transaction(async (session) => {
      const latest = await this.profiles.findOne({
        tenantId: actor.tenantId,
        employeeBlindIndex,
      }).sort({ version: -1 }).session(session).lean().exec();
      if (
        (latest === null && input.version !== 1) ||
        (latest !== null && input.version !== latest.version + 1)
      ) {
        throw new ConflictException({
          code: 'COMPENSATION_VERSION_CONFLICT',
          message: '薪酬档案版本必须连续递增',
        });
      }
      const overlap = await this.profiles.findOne({
        tenantId: actor.tenantId,
        employeeBlindIndex,
        effectiveFrom: { $lte: input.effectiveTo ?? '9999-12-31' },
        $or: [
          { effectiveTo: null },
          { effectiveTo: { $gte: input.effectiveFrom } },
        ],
      }).session(session).lean().exec();
      if (overlap !== null) {
        throw new ConflictException({
          code: 'COMPENSATION_INTERVAL_OVERLAP',
          message: '薪酬档案生效区间重叠',
        });
      }
      await this.profiles.create([{
        id,
        tenantId: actor.tenantId,
        employeeBlindIndex,
        version: input.version,
        effectiveFrom: input.effectiveFrom,
        effectiveTo: input.effectiveTo,
        ...protectedValue,
      }], { session });
    });
    return Object.freeze({
      id,
      version: input.version,
      plaintextDigest: protectedValue.plaintextDigest,
    });
  }

  async createRun(raw: unknown): Promise<PayrollRunView> {
    const actor = this.identity.requireScope('erp:payroll:run:create');
    const input = this.parse(createRunSchema, raw, '工资周期结构非法');
    const run = await this.runs.create({
      id: randomUUID(),
      tenantId: actor.tenantId,
      period: input.period,
      status: 'draft',
      employeeCount: 0,
      totalGrossMinor: '0',
      totalNetMinor: '0',
      inputDigest: null,
      resultDigest: null,
      version: 1,
      submittedBy: null,
      lockedBy: null,
      submittedAt: null,
      lockedAt: null,
    });
    return runView(run.toObject());
  }

  async calculateRun(id: string, raw: unknown): Promise<PayrollRunView> {
    const actor = this.identity.requireScope('erp:payroll:run:calculate');
    if (actor.actorType !== 'service' && actor.actorType !== 'system_job') {
      throw new ForbiddenException({
        code: 'PAYROLL_CALCULATION_SERVICE_REQUIRED',
        message: '正式工资计算只允许受信服务任务执行',
      });
    }
    const input = this.parse(calculateRunSchema, raw, '工资计算输入非法');
    const run = await this.runs.findOne({
      tenantId: actor.tenantId,
      id,
    }).lean().exec();
    if (run === null) throw this.runNotFound();
    if (run.status !== 'draft' || run.version !== input.expectedVersion) {
      throw new ConflictException({
        code: 'PAYROLL_RUN_VERSION_CONFLICT',
        message: '工资运行状态或版本不允许计算',
      });
    }
    const employeeIds = input.lines.map((line) => line.employeeId);
    if (new Set(employeeIds).size !== employeeIds.length) {
      throw new BadRequestException({
        code: 'PAYROLL_EMPLOYEE_DUPLICATED',
        message: '同一工资运行禁止重复员工',
      });
    }
    const employeeCount = await this.masterData.countDocuments({
      tenantId: actor.tenantId,
      kind: 'employee',
      aggregateId: { $in: employeeIds },
      'payload.status': { $in: ['probation', 'active'] },
    }).exec();
    if (employeeCount !== employeeIds.length) {
      throw new BadRequestException({
        code: 'PAYROLL_EMPLOYEE_INACTIVE_OR_MISSING',
        message: '工资输入包含不存在或非在职员工',
      });
    }
    const lines = input.lines.map((line): PayrollLineResult =>
      calculatePayrollLine({
        tenantId: actor.tenantId,
        employeeId: line.employeeId,
        period: run.period,
        ruleVersion: line.ruleVersion,
        components: line.components,
        socialInsuranceEmployeeMinor: line.socialInsuranceEmployeeMinor,
        housingFundEmployeeMinor: line.housingFundEmployeeMinor,
        specialDeductionMinor: line.specialDeductionMinor,
        withholdingTaxMinor: line.withholdingTaxMinor,
      } satisfies PayrollLineInput));
    const ordered = [...lines].sort((left, right) =>
      left.employeeId.localeCompare(right.employeeId));
    const inputDigest = digest(input.lines);
    const resultDigest = digest(ordered.map((line) => line.resultDigest));
    const totalGrossMinor = ordered
      .reduce((total, line) => total + BigInt(line.grossMinor), 0n)
      .toString();
    const totalNetMinor = ordered
      .reduce((total, line) => total + BigInt(line.netMinor), 0n)
      .toString();
    await this.connection.transaction(async (session) => {
      const records = ordered.map((line) => {
        const resultId = randomUUID();
        return {
          id: resultId,
          tenantId: actor.tenantId,
          payrollRunId: id,
          employeeBlindIndex: this.crypto.employeeBlindIndex(
            actor.tenantId,
            line.employeeId,
          ),
          version: 1,
          ...this.crypto.protect({
            tenantId: actor.tenantId,
            resourceType: 'payroll_result',
            resourceId: resultId,
            version: 1,
          }, line),
        };
      });
      await this.results.insertMany(records, { session });
      const updated = await this.runs.updateOne(
        {
          tenantId: actor.tenantId,
          id,
          status: 'draft',
          version: input.expectedVersion,
        },
        {
          $set: {
            status: 'calculated',
            employeeCount: ordered.length,
            totalGrossMinor,
            totalNetMinor,
            inputDigest,
            resultDigest,
            version: input.expectedVersion + 1,
          },
        },
        { session },
      ).exec();
      if (updated.modifiedCount !== 1) {
        throw new ConflictException({
          code: 'PAYROLL_RUN_CONCURRENT_WRITE',
          message: '工资运行发生并发修改',
        });
      }
    });
    return this.getRun(id);
  }

  async submitRun(id: string, raw: unknown): Promise<PayrollRunView> {
    const actor = this.identity.requireScope('erp:payroll:run:submit');
    if (actor.actorType !== 'user') {
      throw new ForbiddenException({
        code: 'PAYROLL_SUBMISSION_USER_REQUIRED',
        message: '工资运行提交必须由已登录用户执行',
      });
    }
    const input = this.parse(transitionRunSchema, raw, '工资运行提交参数非法');
    const updated = await this.runs.updateOne(
      {
        tenantId: actor.tenantId,
        id,
        status: 'calculated',
        version: input.expectedVersion,
      },
      {
        $set: {
          status: 'pending_approval',
          submittedBy: actor.actorId,
          submittedAt: new Date(),
          version: input.expectedVersion + 1,
        },
      },
    ).exec();
    if (updated.modifiedCount !== 1) throw this.runTransitionConflict();
    return this.getRun(id);
  }

  async lockRun(id: string, raw: unknown): Promise<PayrollRunView> {
    const actor = this.identity.requireScope('erp:payroll:run:approve');
    if (actor.actorType !== 'user') {
      throw new ForbiddenException({
        code: 'PAYROLL_APPROVAL_USER_REQUIRED',
        message: '工资运行审批必须由已登录用户执行',
      });
    }
    const input = this.parse(transitionRunSchema, raw, '工资运行审批参数非法');
    const run = await this.runs.findOne({
      tenantId: actor.tenantId,
      id,
    }).lean().exec();
    if (run === null) throw this.runNotFound();
    if (run.submittedBy === actor.actorId) {
      throw new ForbiddenException({
        code: 'PAYROLL_SEGREGATION_OF_DUTIES',
        message: '提交人与审批锁定人必须为不同用户',
      });
    }
    const updated = await this.runs.updateOne(
      {
        tenantId: actor.tenantId,
        id,
        status: 'pending_approval',
        version: input.expectedVersion,
        submittedBy: { $ne: actor.actorId },
      },
      {
        $set: {
          status: 'locked',
          lockedBy: actor.actorId,
          lockedAt: new Date(),
          version: input.expectedVersion + 1,
        },
      },
    ).exec();
    if (updated.modifiedCount !== 1) throw this.runTransitionConflict();
    return this.getRun(id);
  }

  async getSelfPayslip(period: string): Promise<SelfPayslipView> {
    const actor = this.identity.requireScope('erp:payroll:payslip:self');
    if (actor.actorType !== 'user' || actor.employeeId === null) {
      throw new ForbiddenException({
        code: 'PAYSLIP_EMPLOYEE_BINDING_REQUIRED',
        message: '工资条访问必须绑定 GaoQ 员工身份',
      });
    }
    const parsedPeriod = createRunSchema.shape.period.safeParse(period);
    if (!parsedPeriod.success) {
      throw new BadRequestException({
        code: 'PAYSLIP_PERIOD_INVALID',
        message: '工资条周期非法',
      });
    }
    const run = await this.runs.findOne({
      tenantId: actor.tenantId,
      period,
      status: { $in: ['locked', 'reconciling', 'reconciled'] },
    }).sort({ lockedAt: -1 }).lean().exec();
    if (run === null) {
      throw new NotFoundException({
        code: 'PAYSLIP_NOT_PUBLISHED',
        message: '该周期工资条尚未发布',
      });
    }
    const result = await this.results.findOne({
      tenantId: actor.tenantId,
      payrollRunId: run.id,
      employeeBlindIndex: this.crypto.employeeBlindIndex(
        actor.tenantId,
        actor.employeeId,
      ),
    }).lean().exec();
    if (result === null) {
      throw new NotFoundException({
        code: 'PAYSLIP_NOT_FOUND',
        message: '未找到本人工资条',
      });
    }
    const line = this.crypto.unprotect<PayrollLineResult>({
      tenantId: actor.tenantId,
      resourceType: 'payroll_result',
      resourceId: result.id,
      version: result.version,
    }, result);
    if (line.employeeId !== actor.employeeId || line.period !== period) {
      throw new Error('工资条密文身份绑定校验失败');
    }
    return Object.freeze({
      ...line,
      payrollRunId: run.id,
      status: run.status as SelfPayslipView['status'],
    });
  }

  async getRun(id: string): Promise<PayrollRunView> {
    const actor = this.identity.requireScope('erp:payroll:run:read');
    const run = await this.runs.findOne({
      tenantId: actor.tenantId,
      id,
    }).lean().exec();
    if (run === null) throw this.runNotFound();
    return runView(run);
  }

  private async assertEmployeeExists(
    tenantId: string,
    employeeId: string,
  ): Promise<void> {
    const employee = await this.masterData.findOne({
      tenantId,
      kind: 'employee',
      aggregateId: employeeId,
    }).lean().exec();
    if (employee === null) {
      throw new NotFoundException({
        code: 'EMPLOYEE_PROJECTION_NOT_FOUND',
        message: '员工主数据投影不存在',
      });
    }
  }

  private parse<T extends z.ZodType>(
    schema: T,
    raw: unknown,
    message: string,
  ): z.infer<T> {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'PAYROLL_INPUT_INVALID',
        message,
      });
    }
    return parsed.data;
  }

  private runNotFound(): NotFoundException {
    return new NotFoundException({
      code: 'PAYROLL_RUN_NOT_FOUND',
      message: '工资运行不存在',
    });
  }

  private runTransitionConflict(): ConflictException {
    return new ConflictException({
      code: 'PAYROLL_RUN_TRANSITION_CONFLICT',
      message: '工资运行状态、版本或职责分离规则不允许当前操作',
    });
  }
}

const digest = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

const runView = (run: PayrollRunRecord): PayrollRunView => Object.freeze({
  id: run.id,
  period: run.period,
  status: run.status,
  employeeCount: run.employeeCount,
  totalGrossMinor: run.totalGrossMinor,
  totalNetMinor: run.totalNetMinor,
  inputDigest: run.inputDigest,
  resultDigest: run.resultDigest,
  version: run.version,
  submittedBy: run.submittedBy ?? null,
  lockedBy: run.lockedBy ?? null,
});
