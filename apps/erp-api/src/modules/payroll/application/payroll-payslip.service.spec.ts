import type { ActorContext } from '@gaoq/shared-types';
import { describe, expect, it, vi } from 'vitest';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { calculatePayroll, type PayrollCalculationInput } from '../domain/index.js';
import { PayrollPayslipService } from './payroll-payslip.service.js';

const tenant = { tenantId: 'tenant-001', source: 'access_token' as const };
const actor: ActorContext = {
  actorType: 'user', actorId: 'actor-001', tenantId: tenant.tenantId,
  roleCodes: ['employee'], scopes: ['erp:payroll:sheet:read_self'],
  departmentIds: ['department-001'], traceId: 'trace-001',
};
const input: PayrollCalculationInput = {
  tenantId: tenant.tenantId, employeeId: 'employee-001', period: '2026-07',
  currency: 'CNY', engineVersion: 'engine-v1',
  rulePack: {
    id: 'rule-001', version: 1, monthlyBasicDeductionMinor: 500_000,
    taxBrackets: [{ upperBoundMinor: null, rateBps: 300, quickDeductionMinor: 0 }],
    roundingMode: 'HALF_UP',
  },
  taxableEarnings: [{ code: 'BASE', amountMinor: 1_000_000 }], nonTaxableEarnings: [],
  employeeSocialInsuranceMinor: 100_000, employeeHousingFundMinor: 50_000,
  specialAdditionalDeductionMinor: 0, otherPreTaxWithholdingMinor: 0,
  postTaxDeductionMinor: 0,
  cumulativeBefore: {
    taxableIncomeMinor: 0, basicDeductionMinor: 0, socialInsuranceMinor: 0,
    housingFundMinor: 0, specialAdditionalDeductionMinor: 0,
    otherDeductionMinor: 0, taxWithheldMinor: 0,
  },
};
const result = calculatePayroll(input);
const periodId = '01K00000000000000000000001';
const runId = '01K00000000000000000000002';
const inputId = '01K00000000000000000000003';
const resultId = '01K00000000000000000000004';
const envelope = {
  dataKeyId: 'payroll-key',
  dataIv: 'AAAAAAAAAAAAAAAA',
  dataCiphertext: 'BBBBBBBBBBBBBBBB',
  dataAuthTag: 'CCCCCCCCCCCCCCCCCCCCCC',
};

function query<T>(value: T) {
  return { lean: () => ({ exec: () => Promise.resolve(value) }) };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

interface AssembleOptions {
  readonly mode?: 'external' | 'legacy';
  readonly profile?: { readonly employeeId: string } | null;
  readonly period?: Record<string, unknown> | null;
  readonly inputRecord?: Record<string, unknown> | null;
  readonly resultRecord?: Record<string, unknown> | null;
  readonly decryptedInput?: unknown;
  readonly decryptedResult?: unknown;
}

function assemble(options: AssembleOptions = {}) {
  const context = new TenantContextService();
  const profiles = {
    resolveActive: vi.fn().mockResolvedValue(
      options.profile === undefined ? { employeeId: 'employee-001' } : options.profile,
    ),
  };
  const periodRecord = options.period === undefined ? {
    id: periodId, tenantId: 'tenant-001', period: '2026-07',
    currency: 'CNY', status: 'locked', activeRunId: runId,
    updatedAt: new Date('2026-07-31T10:00:00.000Z'),
  } : options.period;
  const storedInput = options.inputRecord === undefined ? {
    id: inputId, tenantId: 'tenant-001', runId,
    periodId, employeeId: 'employee-001',
    inputHash: result.inputHash, ...envelope,
  } : options.inputRecord;
  const storedResult = options.resultRecord === undefined ? {
    id: resultId, tenantId: 'tenant-001', runId,
    periodId, employeeId: 'employee-001',
    resultHash: result.resultHash, ...envelope,
  } : options.resultRecord;
  const periods = { findOne: vi.fn().mockReturnValue(query(periodRecord)) };
  const inputs = { findOne: vi.fn().mockReturnValue(query(storedInput)) };
  const results = { findOne: vi.fn().mockReturnValue(query(storedResult)) };
  const decryptedInput = Object.hasOwn(options, 'decryptedInput')
    ? options.decryptedInput : clone(input);
  const decryptedResult = Object.hasOwn(options, 'decryptedResult')
    ? options.decryptedResult : clone(result);
  const crypto = {
    unprotect: vi.fn()
      .mockReturnValueOnce(decryptedInput)
      .mockReturnValueOnce(decryptedResult),
  };
  const boundary = {
    assertLegacy: vi.fn(() => {
      if ((options.mode ?? 'legacy') === 'legacy') return;
      throw Object.assign(new Error('工资能力已迁移至专业算薪系统'), {
        response: {
          code: 'PAYROLL_MOVED_TO_PROFESSIONAL_SYSTEM',
          payrollWebOrigin: 'https://payroll.example.test',
        },
      });
    }),
  };
  const service = new PayrollPayslipService(
    context,
    profiles as never,
    crypto as never,
    periods as never,
    inputs as never,
    results as never,
    boundary as never,
  );
  return {
    context, profiles, periodRecord, storedInput, storedResult,
    periods, inputs, results, crypto, boundary, service,
  };
}

async function read(
  store: ReturnType<typeof assemble>,
  currentActor: ActorContext = actor,
  period: unknown = '2026-07',
) {
  return store.context.run({ tenant, actor: currentActor }, () =>
    store.service.getMyPayslip(period as string));
}

function expectIntegrity(promise: Promise<unknown>) {
  return expect(promise).rejects.toMatchObject({
    response: { code: 'PAYROLL_PAYSLIP_INTEGRITY_FAILED' },
  });
}

describe('PayrollPayslipService', () => {
  it.each(['locked', 'disbursing', 'reconciling', 'reconciled'] as const)(
    '只用可信主体反查员工，并从 %s 周期返回冻结的本人薪资单',
    async (status) => {
      const periodRecord = {
        ...assemble().periodRecord,
        status,
      };
      const store = assemble({ period: periodRecord });
      const payslip = await read(store);
      expect(store.profiles.resolveActive).toHaveBeenCalledWith('tenant-001', 'actor-001');
      expect(store.inputs.findOne).toHaveBeenCalledWith({
        tenantId: 'tenant-001', employeeId: 'employee-001',
        runId, periodId,
      });
      expect(store.crypto.unprotect).toHaveBeenNthCalledWith(1, {
        tenantId: 'tenant-001', resourceType: 'input_snapshot',
        resourceId: inputId, version: 1,
      }, {
        keyId: envelope.dataKeyId, iv: envelope.dataIv,
        ciphertext: envelope.dataCiphertext, authTag: envelope.dataAuthTag,
      });
      expect(payslip).toMatchObject({
        period: '2026-07', currency: 'CNY', grossPayMinor: 1_000_000,
        withholdingTaxMinor: 10_500, netPayMinor: 839_500,
        publishedAt: '2026-07-31T10:00:00.000Z',
      });
      expect(payslip).not.toHaveProperty('employeeId');
      expect(payslip).not.toHaveProperty('cumulativeBefore');
      expect(Object.isFrozen(payslip)).toBe(true);
      expect(Object.isFrozen(payslip.taxableEarnings)).toBe(true);
      expect(Object.isFrozen(payslip.taxableEarnings[0])).toBe(true);
    },
  );

  it('外部专业工资模式在访问任何旧工资数据前失败关闭', async () => {
    const store = assemble({ mode: 'external' });
    await expect(read(store)).rejects.toMatchObject({
      response: {
        code: 'PAYROLL_MOVED_TO_PROFESSIONAL_SYSTEM',
        payrollWebOrigin: 'https://payroll.example.test',
      },
    });
    expect(store.profiles.resolveActive).not.toHaveBeenCalled();
    expect(store.periods.findOne).not.toHaveBeenCalled();
    expect(store.crypto.unprotect).not.toHaveBeenCalled();
  });

  it('缺少本人读取权限时先拒绝且不暴露工资系统模式', async () => {
    const store = assemble({ mode: 'external' });
    await expect(read(store, { ...actor, scopes: [] })).rejects.toMatchObject({
      response: { code: 'AUTH_SCOPE_DENIED' },
    });
    expect(store.boundary.assertLegacy).not.toHaveBeenCalled();
  });

  it('服务主体不能冒充人员读取本人薪资单', async () => {
    const store = assemble();
    await expect(read(store, {
      ...actor, actorType: 'service',
    })).rejects.toMatchObject({
      response: { code: 'PAYROLL_PAYSLIP_USER_REQUIRED' },
    });
    expect(store.profiles.resolveActive).not.toHaveBeenCalled();
  });

  it.each([null, { employeeId: '' }, { employeeId: '$employee' }])(
    '缺失或损坏的员工身份统一失败关闭：%j',
    async (profile) => {
      const store = assemble({ profile });
      await expect(read(store)).rejects.toMatchObject({
        response: { code: 'PAYROLL_EMPLOYEE_IDENTITY_REQUIRED' },
      });
      expect(store.periods.findOne).not.toHaveBeenCalled();
    },
  );

  it.each(['2026-00', '2026-13', '2026-7', '', 202607, Symbol('month')])(
    '非法月份统一表现为不存在：%s',
    async (period) => {
      const store = assemble();
      await expect(read(store, actor, period)).rejects.toMatchObject({
        response: { code: 'PAYROLL_PAYSLIP_NOT_FOUND' },
      });
      expect(store.profiles.resolveActive).not.toHaveBeenCalled();
    },
  );

  it.each([null, { ...assemble().periodRecord, activeRunId: null }])(
    '未发布或无活动运行的周期不解密员工数据',
    async (period) => {
      const store = assemble({ period });
      await expect(read(store)).rejects.toMatchObject({
        response: { code: 'PAYROLL_PAYSLIP_NOT_FOUND' },
      });
      expect(store.crypto.unprotect).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['tenantId', 'tenant-other'],
    ['period', '2026-06'],
    ['currency', 'USD'],
    ['status', 'approved'],
    ['activeRunId', 'run-invalid'],
    ['id', 'period-invalid'],
    ['updatedAt', new Date('invalid')],
    ['updatedAt', '2026-07-31T10:00:00.000Z'],
  ] as const)('反向校验周期记录字段 %s', async (field, value) => {
    const period = { ...assemble().periodRecord, [field]: value };
    const store = assemble({ period });
    await expectIntegrity(read(store));
    expect(store.inputs.findOne).not.toHaveBeenCalled();
  });

  it.each(['custom-prototype', 'symbol', 'accessor', 'proxy'])(
    '周期记录拒绝非普通数据对象：%s',
    async (kind) => {
      const base = { ...assemble().periodRecord };
      let period: Record<string, unknown>;
      if (kind === 'custom-prototype') {
        period = Object.assign(Object.create({ inherited: true }) as object, base);
      } else if (kind === 'symbol') {
        period = { ...base, [Symbol('hidden')]: true };
      } else if (kind === 'accessor') {
        period = { ...base };
        Object.defineProperty(period, 'currency', { get: () => 'CNY', enumerable: true });
      } else {
        period = new Proxy(base, {
          ownKeys: () => {
            throw new Error('PROXY_TRAP');
          },
        });
      }
      const store = assemble({ period });
      await expectIntegrity(read(store));
      expect(store.inputs.findOne).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['inputRecord', null],
    ['resultRecord', null],
  ] as const)('缺少工资输入或结果记录时不解密：%s', async (field, value) => {
    const store = assemble({ [field]: value });
    await expect(read(store)).rejects.toMatchObject({
      response: { code: 'PAYROLL_PAYSLIP_NOT_FOUND' },
    });
    expect(store.crypto.unprotect).not.toHaveBeenCalled();
  });

  it.each([
    ['tenantId', 'tenant-other'],
    ['runId', 'run-other'],
    ['periodId', 'period-other'],
    ['employeeId', 'employee-other'],
    ['id', 'input-invalid'],
    ['inputHash', 'short'],
  ] as const)('反向校验输入记录字段 %s', async (field, value) => {
    const inputRecord = { ...assemble().storedInput, [field]: value };
    const store = assemble({ inputRecord });
    await expectIntegrity(read(store));
    expect(store.crypto.unprotect).not.toHaveBeenCalled();
  });

  it('输入行代理陷阱统一映射为完整性失败', async () => {
    const inputRecord = new Proxy({ ...assemble().storedInput }, {
      getPrototypeOf: () => {
        throw new Error('PROXY_TRAP');
      },
    });
    const store = assemble({ inputRecord });
    await expectIntegrity(read(store));
    expect(store.crypto.unprotect).not.toHaveBeenCalled();
  });

  it.each([
    ['tenantId', 'tenant-other'],
    ['runId', 'run-other'],
    ['periodId', 'period-other'],
    ['employeeId', 'employee-other'],
    ['id', 'result-invalid'],
    ['resultHash', 'short'],
  ] as const)('反向校验结果记录字段 %s', async (field, value) => {
    const resultRecord = { ...assemble().storedResult, [field]: value };
    const store = assemble({ resultRecord });
    await expectIntegrity(read(store));
    expect(store.crypto.unprotect).not.toHaveBeenCalled();
  });

  it.each([
    ['dataKeyId', '$key'],
    ['dataKeyId', 'K'.repeat(65)],
    ['dataIv', 'I'.repeat(15)],
    ['dataIv', 'I'.repeat(17)],
    ['dataIv', 'iv+bad'],
    ['dataCiphertext', ''],
    ['dataCiphertext', 'cipher+bad'],
    ['dataAuthTag', 'short'],
    ['dataAuthTag', 'A'.repeat(21) + '+'],
  ] as const)('密文信封字段 %s 损坏时不调用解密', async (field, value) => {
    const inputRecord = { ...assemble().storedInput, [field]: value };
    const store = assemble({ inputRecord });
    await expectIntegrity(read(store));
    expect(store.crypto.unprotect).not.toHaveBeenCalled();
  });

  it.each([
    null,
    { ...input, unknown: true },
    { ...input, taxableEarnings: 'not-an-array' },
    { ...input, taxableEarnings: [{ code: 'BASE', amountMinor: 1_000_000 }, {
      code: 'BASE', amountMinor: 1,
    }] },
    { ...input, tenantId: 'tenant-other' },
  ])('拒绝非严格或绑定不一致的解密输入：%j', async (decryptedInput) => {
    const store = assemble({ decryptedInput });
    await expectIntegrity(read(store));
  });

  it.each([
    null,
    { ...result, unknown: true },
    { ...result, steps: [] },
    { ...result, resultHash: 'A'.repeat(43) },
    { ...result, inputHash: 'A'.repeat(43) },
    { ...result, grossPayMinor: result.grossPayMinor + 1 },
  ])('拒绝非严格或摘要不一致的解密结果：%j', async (decryptedResult) => {
    const store = assemble({ decryptedResult });
    await expectIntegrity(read(store));
  });

  it('解密异常统一映射为完整性失败', async () => {
    const store = assemble();
    store.crypto.unprotect.mockReset().mockImplementation(() => {
      throw new Error('KMS_DOWN');
    });
    await expectIntegrity(read(store));
  });
});
