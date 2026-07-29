import type { ActorContext } from '@gaoq/shared-types';
import type { ClientSession } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import {
  AnnualPayrollReconciliationError,
  calculatePayroll,
  type PayrollCalculationInput,
} from '../domain/index.js';
import { PayrollAnnualReconciliationService } from './payroll-annual-reconciliation.service.js';

const tenant = { tenantId: 'tenant-001', source: 'access_token' as const };
const session = {} as ClientSession;
const employeeId = 'employee-001';
const januaryPeriodId = '01J8ZQK7V0A2M4N6P8R0T2W4P1';
const februaryPeriodId = '01J8ZQK7V0A2M4N6P8R0T2W4P2';
const januaryRunId = '01J8ZQK7V0A2M4N6P8R0T2W4R1';
const februaryRunId = '01J8ZQK7V0A2M4N6P8R0T2W4R2';
const januaryInputId = '01J8ZQK7V0A2M4N6P8R0T2W4A1';
const februaryInputId = '01J8ZQK7V0A2M4N6P8R0T2W4A2';
const januaryLineId = '01J8ZQK7V0A2M4N6P8R0T2W4N1';
const februaryLineId = '01J8ZQK7V0A2M4N6P8R0T2W4N2';
const januaryFilingId = '01J8ZQK7V0A2M4N6P8R0T2W4F1';
const februaryFilingId = '01J8ZQK7V0A2M4N6P8R0T2W4F2';

const january: PayrollCalculationInput = {
  tenantId: tenant.tenantId, employeeId, period: '2026-01',
  currency: 'CNY', engineVersion: 'payroll-engine-v1',
  rulePack: {
    id: 'rule-001', version: 1, monthlyBasicDeductionMinor: 500_000,
    roundingMode: 'HALF_UP',
    taxBrackets: [{ upperBoundMinor: null, rateBps: 300, quickDeductionMinor: 0 }],
  },
  taxableEarnings: [{ code: 'BASE', amountMinor: 1_000_000 }],
  nonTaxableEarnings: [], employeeSocialInsuranceMinor: 100_000,
  employeeHousingFundMinor: 50_000, specialAdditionalDeductionMinor: 0,
  otherPreTaxWithholdingMinor: 0, postTaxDeductionMinor: 0,
  cumulativeBefore: {
    taxableIncomeMinor: 0, basicDeductionMinor: 0, socialInsuranceMinor: 0,
    housingFundMinor: 0, specialAdditionalDeductionMinor: 0,
    otherDeductionMinor: 0, taxWithheldMinor: 0,
  },
};
const januaryResult = calculatePayroll(january);
const february: PayrollCalculationInput = {
  ...january, period: '2026-02', cumulativeBefore: januaryResult.cumulativeAfter,
};
const februaryResult = calculatePayroll(february);

function actor(
  actorType: ActorContext['actorType'] = 'service',
  scopes: readonly string[] = ['erp:payroll:annual:prepare'],
): ActorContext {
  return {
    actorType, actorId: 'annual-tax-service', tenantId: tenant.tenantId,
    roleCodes: [], scopes,
    departmentIds: [], traceId: 'trace-annual-001',
  };
}

function query<T>(value: T | (() => T)) {
  const result = {
    sort: vi.fn(() => result),
    session: vi.fn(() => result),
    lean: vi.fn(() => result),
    exec: vi.fn(() => Promise.resolve(
      typeof value === 'function' ? (value as () => T)() : value,
    )),
  };
  return result;
}

function assemble() {
  const context = new TenantContextService();
  let annualRecord: Record<string, unknown> | null = null;
  let annualBundle: unknown = null;
  const idempotency = { execute: vi.fn(async (
    _operation: string, _key: string, _input: unknown,
    handler: (value: ClientSession) => Promise<Record<string, unknown>>,
  ) => handler(session)) };
  const periods = { find: vi.fn().mockReturnValue(query([
    {
      id: januaryPeriodId, period: '2026-01', status: 'reconciled',
      activeRunId: januaryRunId,
    },
    {
      id: februaryPeriodId, period: '2026-02', status: 'reconciled',
      activeRunId: februaryRunId,
    },
  ])) };
  const inputs = { findOne: vi.fn((filter: { periodId: string }) => query({
    id: filter.periodId === januaryPeriodId ? januaryInputId : februaryInputId,
    inputHash: filter.periodId === januaryPeriodId
      ? januaryResult.inputHash : februaryResult.inputHash,
    dataKeyId: 'key', dataIv: 'iv', dataCiphertext: 'input', dataAuthTag: 'tag',
  })) };
  const results = { findOne: vi.fn((filter: { periodId: string }) => query({
    id: filter.periodId === januaryPeriodId ? januaryLineId : februaryLineId,
    resultHash: filter.periodId === januaryPeriodId
      ? januaryResult.resultHash : februaryResult.resultHash,
    dataKeyId: 'key', dataIv: 'iv', dataCiphertext: 'result', dataAuthTag: 'tag',
  })) };
  const filings = { findOne: vi.fn((filter: { periodId: string }) => query({
    id: filter.periodId === januaryPeriodId ? januaryFilingId : februaryFilingId,
    contentHash: filter.periodId === januaryPeriodId ? 'j'.repeat(43) : 'f'.repeat(43),
    taxSubmissionEvidenceId: filter.periodId === januaryPeriodId
      ? 'tax-evidence-jan' : 'tax-evidence-feb',
    dataKeyId: 'key', dataIv: 'iv', dataCiphertext: 'filing', dataAuthTag: 'tag',
  })) };
  const annualRecords = {
    findOne: vi.fn().mockImplementation(() => query(() => annualRecord)),
    create: vi.fn(([value]: readonly Record<string, unknown>[]) => {
      annualRecord = { ...value };
      return Promise.resolve([]);
    }),
  };
  const protectedBundles: unknown[] = [];
  const crypto = {
    unprotect: vi.fn((aad: { resourceType: string; resourceId: string }) => {
      if (aad.resourceType === 'input_snapshot') {
        return aad.resourceId === januaryInputId ? january : february;
      }
      if (aad.resourceType === 'calculation_line') {
        return aad.resourceId === januaryLineId ? januaryResult : februaryResult;
      }
      if (aad.resourceType === 'annual_reconciliation') return annualBundle;
      const isJanuary = aad.resourceId === januaryFilingId;
      return { content: JSON.stringify({
        schema: 'CN_IIT_WITHHOLDING_MANIFEST_V1',
        lines: [{
          employeeId,
          calculationLineId: isJanuary ? januaryLineId : februaryLineId,
          withholdingTaxMinor: isJanuary
            ? januaryResult.withholdingTaxMinor : februaryResult.withholdingTaxMinor,
          resultHash: isJanuary ? januaryResult.resultHash : februaryResult.resultHash,
        }],
      }) };
    }),
    protect: vi.fn((_aad: unknown, value: unknown) => {
      protectedBundles.push(value);
      annualBundle = value;
      return {
        keyId: 'annual-key', iv: 'i'.repeat(16),
        ciphertext: 'c'.repeat(32), authTag: 'a'.repeat(22),
      };
    }),
  };
  const outbox = { append: vi.fn().mockResolvedValue(undefined) };
  const service = new PayrollAnnualReconciliationService(
    idempotency as never, context, crypto as never, outbox as never,
    periods as never, inputs as never, results as never, filings as never,
    annualRecords as never,
  );
  return {
    context,
    service,
    idempotency,
    periods,
    inputs,
    results,
    filings,
    crypto,
    annualRecords,
    outbox,
    protectedBundles,
    readAnnualRecord: () => annualRecord,
    writeAnnualRecord: (value: Record<string, unknown> | null) => {
      annualRecord = value;
    },
    writeAnnualBundle: (value: unknown) => {
      annualBundle = value;
    },
  };
}

async function prepare(
  store: ReturnType<typeof assemble>,
  input: Parameters<PayrollAnnualReconciliationService['prepare']>[1] = {
    employeeId,
    taxYear: '2026',
  },
) {
  return store.context.run({ tenant, actor: actor() }, () =>
    store.service.prepare('annual-helper', input));
}

describe('PayrollAnnualReconciliationService', () => {
  it('重放锁定工资并核对逐月已提交税表后追加年度证据', async () => {
    const store = assemble();
    const result = await store.context.run({ tenant, actor: actor() }, () =>
      store.service.prepare('annual-001', { employeeId, taxYear: '2026' }));

    expect(result).toMatchObject({
      employeeId, taxYear: '2026', version: 1, periodCount: 2,
      totalPayrollWithheldMinor: 21_000, totalFiledWithholdingMinor: 21_000,
      status: 'awaiting_assessment', differences: [],
    });
    expect(store.annualRecords.create).toHaveBeenCalledWith([
      expect.objectContaining({
        employeeId, taxYear: '2026', status: 'awaiting_assessment',
        officialAssessmentId: null, preparedBy: 'annual-tax-service',
      }),
    ], { session });
    const bundle = store.protectedBundles[0] as {
      readonly result: { readonly evidenceHash: string };
      readonly sourceReferences: readonly {
        readonly period: string;
        readonly filingId: string;
      }[];
    };
    expect(bundle.result.evidenceHash).toBe(result.evidenceHash);
    expect(bundle.sourceReferences).toMatchObject([
      { period: '2026-01', filingId: januaryFilingId },
      { period: '2026-02', filingId: februaryFilingId },
    ]);
    const event = store.outbox.append.mock.calls[0]?.[0] as unknown as {
      readonly data: Readonly<Record<string, unknown>>;
    };
    expect(JSON.stringify(event.data)).not.toMatch(/employee|21000|tax-evidence/u);
  });

  it('绑定税局年度评估并按员工与税年生成追加版本', async () => {
    const store = assemble();
    await prepare(store);
    const result = await prepare(store, {
      employeeId,
      taxYear: '2026',
      officialAssessment: {
        assessmentId: 'assessment-2026',
        assessmentEvidenceId: 'assessment-evidence-2026',
        assessedTaxMinor: 21_000,
        sourceDigest: 's'.repeat(43),
      },
    });
    expect(result).toMatchObject({
      version: 2,
      status: 'assessment_matched',
      officialAssessedTaxMinor: 21_000,
    });
    expect(store.readAnnualRecord()).toMatchObject({
      officialAssessmentId: 'assessment-2026',
      officialAssessmentEvidenceId: 'assessment-evidence-2026',
      officialAssessmentSourceDigest: 's'.repeat(43),
    });
  });

  it.each([
    actor('user'),
    actor('service', []),
  ])('拒绝未受信任或缺少权限的年度核对主体：$actorType', async (principal) => {
    const store = assemble();
    await expect(store.context.run({ tenant, actor: principal }, () =>
      store.service.prepare('denied', { employeeId, taxYear: '2026' })))
      .rejects.toMatchObject({
        response: {
          code: principal.scopes.length === 0
            ? 'AUTH_SCOPE_DENIED'
            : 'PAYROLL_ANNUAL_SERVICE_REQUIRED',
        },
      });
  });

  it.each([
    { employeeId: '', taxYear: '2026' },
    { employeeId, taxYear: '26' },
    { employeeId, taxYear: '2026', extra: true },
    { employeeId, taxYear: '2026', officialAssessment: {
      assessmentId: '', assessmentEvidenceId: 'evidence',
      assessedTaxMinor: 1, sourceDigest: 's'.repeat(43),
    } },
    { employeeId, taxYear: '2026', officialAssessment: {
      assessmentId: 'assessment', assessmentEvidenceId: '',
      assessedTaxMinor: 1, sourceDigest: 's'.repeat(43),
    } },
    { employeeId, taxYear: '2026', officialAssessment: {
      assessmentId: 'assessment', assessmentEvidenceId: 'evidence',
      assessedTaxMinor: 1, sourceDigest: 'bad',
    } },
    { employeeId, taxYear: '2026', officialAssessment: {
      assessmentId: 'assessment', assessmentEvidenceId: 'evidence',
      assessedTaxMinor: Number.NaN, sourceDigest: 's'.repeat(43),
    } },
    { employeeId, taxYear: '2026', officialAssessment: {
      assessmentId: 'assessment', assessmentEvidenceId: 'evidence',
      assessedTaxMinor: -1, sourceDigest: 's'.repeat(43),
    } },
    { employeeId, taxYear: '2026', officialAssessment: {
      assessmentId: 'assessment', assessmentEvidenceId: 'evidence',
      assessedTaxMinor: 1, sourceDigest: 's'.repeat(43), extra: true,
    } },
  ])('拒绝非法年度制备输入 %#', async (input) => {
    const store = assemble();
    await expect(prepare(store, input as never)).rejects.toMatchObject({
      response: { code: 'PAYROLL_ANNUAL_INPUT_INVALID' },
    });
  });

  it('跳过无活动运行周期和员工完全无工资的周期', async () => {
    const store = assemble();
    store.periods.find.mockReturnValueOnce(query([
      { id: 'period-null', period: '2026-01', activeRunId: null },
      { id: januaryPeriodId, period: '2026-01', activeRunId: januaryRunId },
      { id: 'period-empty', period: '2026-02', activeRunId: februaryRunId },
    ]));
    store.inputs.findOne.mockImplementation((
      (filter: { periodId: string }) => query(
        filter.periodId === 'period-empty'
          ? null
          : {
            id: januaryInputId,
            inputHash: januaryResult.inputHash,
            dataKeyId: 'key', dataIv: 'iv',
            dataCiphertext: 'input', dataAuthTag: 'tag',
          },
      )
    ) as never);
    store.results.findOne.mockImplementation((
      (filter: { periodId: string }) => query(
        filter.periodId === 'period-empty'
          ? null
          : {
            id: januaryLineId,
            resultHash: januaryResult.resultHash,
            dataKeyId: 'key', dataIv: 'iv',
            dataCiphertext: 'result', dataAuthTag: 'tag',
          },
      )
    ) as never);
    await expect(prepare(store)).resolves.toMatchObject({ periodCount: 1 });
  });

  it.each([
    ['input', null],
    ['result', null],
    ['filing', null],
    ['evidence', null],
  ])('工资、结果或税务来源缺失时失败关闭：%s', async (kind, value) => {
    const store = assemble();
    store.periods.find.mockReturnValueOnce(query([{
      id: januaryPeriodId,
      period: '2026-01',
      activeRunId: januaryRunId,
    }]));
    if (kind === 'input') store.inputs.findOne.mockReturnValueOnce(query(value) as never);
    if (kind === 'result') store.results.findOne.mockReturnValueOnce(query(value) as never);
    if (kind === 'filing') store.filings.findOne.mockReturnValueOnce(query(value) as never);
    if (kind === 'evidence') {
      store.filings.findOne.mockReturnValueOnce(query({
        id: januaryFilingId,
        contentHash: 'j'.repeat(43),
        taxSubmissionEvidenceId: null,
        dataKeyId: 'key', dataIv: 'iv',
        dataCiphertext: 'filing', dataAuthTag: 'tag',
      }) as never);
    }
    await expect(prepare(store)).rejects.toMatchObject({
      response: { code: 'PAYROLL_ANNUAL_SOURCE_INCOMPLETE' },
    });
  });

  it('税年内没有任何员工工资时返回不存在', async () => {
    const store = assemble();
    store.periods.find.mockReturnValueOnce(query([{
      id: januaryPeriodId,
      period: '2026-01',
      activeRunId: januaryRunId,
    }]));
    store.inputs.findOne.mockReturnValueOnce(query(null) as never);
    store.results.findOne.mockReturnValueOnce(query(null) as never);
    await expect(prepare(store)).rejects.toMatchObject({
      response: { code: 'PAYROLL_ANNUAL_EMPLOYEE_NOT_FOUND' },
    });
  });

  it.each([
    ['inputHash', 'bad'],
    ['resultHash', 'bad'],
  ])('拒绝工资控制摘要与密文不一致：%s', async (field, value) => {
    const store = assemble();
    if (field === 'inputHash') {
      store.inputs.findOne.mockReturnValueOnce(query({
        id: januaryInputId,
        inputHash: value,
        dataKeyId: 'key', dataIv: 'iv',
        dataCiphertext: 'input', dataAuthTag: 'tag',
      }));
    } else {
      store.results.findOne.mockReturnValueOnce(query({
        id: januaryLineId,
        resultHash: value,
        dataKeyId: 'key', dataIv: 'iv',
        dataCiphertext: 'result', dataAuthTag: 'tag',
      }));
    }
    await expect(prepare(store)).rejects.toMatchObject({
      response: { code: 'PAYROLL_ANNUAL_PAYROLL_INTEGRITY_FAILED' },
    });
  });

  it.each([
    {
      employeeId: 'other-employee',
      calculationLineId: januaryLineId,
      withholdingTaxMinor: januaryResult.withholdingTaxMinor,
      resultHash: januaryResult.resultHash,
    },
    {
      employeeId,
      calculationLineId: '01J8ZQK7V0A2M4N6P8R0T2W4N9',
      withholdingTaxMinor: januaryResult.withholdingTaxMinor,
      resultHash: januaryResult.resultHash,
    },
    {
      employeeId,
      calculationLineId: januaryLineId,
      withholdingTaxMinor: januaryResult.withholdingTaxMinor,
      resultHash: 'x'.repeat(43),
    },
  ])('拒绝与锁定工资不一致的税务清单员工行 %#', async (line) => {
    const store = assemble();
    store.periods.find.mockReturnValueOnce(query([{
      id: januaryPeriodId,
      period: '2026-01',
      activeRunId: januaryRunId,
    }]));
    const defaultUnprotect = store.crypto.unprotect.getMockImplementation()!;
    store.crypto.unprotect.mockImplementation(
      (aad: { resourceType: string; resourceId: string }) => {
        const value = defaultUnprotect(aad);
        if (aad.resourceType !== 'tax_filing') return value;
        return {
          ...(value as { readonly content: string }),
          content: JSON.stringify({
            schema: 'CN_IIT_WITHHOLDING_MANIFEST_V1',
            lines: [line],
          }),
        };
      },
    );
    await expect(prepare(store)).rejects.toMatchObject({
      response: { code: 'PAYROLL_ANNUAL_FILING_LINE_INVALID' },
    });
  });

  it.each([
    {},
    { code: 11000 },
    new AnnualPayrollReconciliationError('PAYROLL_ANNUAL_TEST', 'test'),
  ])('映射受保护数据、唯一键与领域冲突 %#', async (failure) => {
    const store = assemble();
    if (failure instanceof AnnualPayrollReconciliationError) {
      store.idempotency.execute.mockRejectedValueOnce(failure);
      await expect(prepare(store)).rejects.toMatchObject({
        response: { code: 'PAYROLL_ANNUAL_TEST' },
      });
      return;
    }
    if ('code' in failure) {
      store.idempotency.execute.mockRejectedValueOnce(failure);
      await expect(prepare(store)).rejects.toMatchObject({
        response: { code: 'PAYROLL_ANNUAL_WRITE_CONFLICT' },
      });
      return;
    }
    store.crypto.unprotect.mockImplementationOnce(() => {
      throw new SyntaxError('invalid JSON');
    });
    await expect(prepare(store)).rejects.toMatchObject({
      response: { code: 'PAYROLL_ANNUAL_PROTECTED_DATA_INVALID' },
    });
  });

  it('读取与控制面摘要执行权限、标识、存在性和完整性校验', async () => {
    const store = assemble();
    const prepared = await prepare(store);
    const reader = actor('user', ['erp:payroll:annual:read']);
    await expect(store.context.run({ tenant, actor: reader }, () =>
      store.service.get(prepared.id))).resolves.toMatchObject({
      id: prepared.id,
      employeeId,
    });
    await expect(store.context.run({ tenant, actor: reader }, () =>
      store.service.getControlStatus(prepared.id))).resolves.toEqual({
      id: prepared.id,
      taxYear: '2026',
      periodCount: 2,
      firstPeriod: '2026-01',
      lastPeriod: '2026-02',
      status: 'awaiting_assessment',
      version: 1,
      evidenceHash: prepared.evidenceHash,
    });
    await expect(store.context.run({ tenant, actor: actor('user', []) }, () =>
      store.service.get(prepared.id))).rejects.toMatchObject({
      response: { code: 'AUTH_SCOPE_DENIED' },
    });
    await expect(store.context.run({ tenant, actor: reader }, () =>
      store.service.get('bad'))).rejects.toMatchObject({
      response: { code: 'PAYROLL_ANNUAL_ID_INVALID' },
    });
    store.writeAnnualRecord(null);
    await expect(store.context.run({ tenant, actor: reader }, () =>
      store.service.get(prepared.id))).rejects.toMatchObject({
      response: { code: 'PAYROLL_ANNUAL_NOT_FOUND' },
    });
  });

  it.each([
    { evidenceHash: 'x'.repeat(43) },
    { taxYear: '2025' },
    { status: 'frozen' },
    { periodCount: 1 },
    { firstPeriod: '2026-02' },
    { lastPeriod: '2026-01' },
  ])('拒绝年度记录控制字段与密文不一致 %#', async (change) => {
    const store = assemble();
    const prepared = await prepare(store);
    store.writeAnnualBundle({
      ...(store.protectedBundles[0] as Record<string, unknown>),
      result: {
        ...(store.protectedBundles[0] as {
          result: Record<string, unknown>;
        }).result,
        ...change,
      },
    });
    await expect(store.context.run({
      tenant,
      actor: actor('user', ['erp:payroll:annual:read']),
    }, () => store.service.get(prepared.id))).rejects.toMatchObject({
      response: { code: 'PAYROLL_ANNUAL_RECORD_INTEGRITY_FAILED' },
    });
  });

  it('读取时密文结构非法映射为稳定冲突', async () => {
    const store = assemble();
    const prepared = await prepare(store);
    store.writeAnnualBundle({});
    await expect(store.context.run({
      tenant,
      actor: actor('user', ['erp:payroll:annual:read']),
    }, () => store.service.get(prepared.id))).rejects.toMatchObject({
      response: { code: 'PAYROLL_ANNUAL_PROTECTED_DATA_INVALID' },
    });
  });
});
