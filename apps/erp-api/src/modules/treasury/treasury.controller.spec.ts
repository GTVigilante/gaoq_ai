import { BadRequestException, Logger, RequestMethod } from '@nestjs/common';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants.js';
import { describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../../core/audit/audit.service.js';
import type { ErpRequest } from '../../core/http/request-context.js';
import { REQUIRED_SCOPES_KEY } from '../identity/auth.decorators.js';
import type { VerifiedAccessToken } from '../identity/auth.types.js';
import { LegacyPayrollBoundaryGuard } from '../payroll/legacy-payroll-boundary.guard.js';
import type { TreasuryBankAccountService } from './application/treasury-bank-account.service.js';
import type { TreasuryBankReturnService } from './application/treasury-bank-return.service.js';
import type { TreasuryDisbursementService } from './application/treasury-disbursement.service.js';
import type { TreasuryReconciliationService } from './application/treasury-reconciliation.service.js';
import type { TreasuryRecoveryService } from './application/treasury-recovery.service.js';
import { TreasuryController } from './treasury.controller.js';

const KEY = 'treasury-key-001';
const TOKEN: VerifiedAccessToken = {
  issuer: 'https://issuer.example.invalid',
  subject: 'finance-001',
  audience: ['gaoq-erp'],
  resource: ['gaoq-erp'],
  tenantId: 'tenant-001',
  actorId: 'finance-001',
  actorType: 'user',
  clientId: 'erp-web',
  roleCodes: ['finance_owner'],
  scopes: ['erp:treasury:disbursement:approve'],
  departmentIds: [],
  sessionId: 'session-001',
  expiresAt: 1_800_000_000,
};
const request = (token: VerifiedAccessToken | null = TOKEN): ErpRequest =>
  ({ verifiedAccessToken: token ?? undefined }) as ErpRequest;

const preparedBatch = {
  id: 'batch-001',
  payrollPeriodId: 'period-001',
  payrollRunId: 'run-001',
  status: 'prepared',
  version: 1,
  lineCount: 12,
  totalMinor: 1_000_000,
  fileHash: null,
  objectEvidenceId: null,
  bankSubmissionId: null,
  bankSubmissionEvidenceId: null,
};
const submittedBatch = {
  ...preparedBatch,
  status: 'submitted',
  version: 3,
  fileHash: 'file-hash',
  objectEvidenceId: 'worm-file-001',
  bankSubmissionId: 'bank-submission-001',
  bankSubmissionEvidenceId: 'worm-submission-001',
};
const bankReturn = {
  id: 'return-001',
  batchId: 'batch-001',
  status: 'matched',
  batchVersion: 4,
  returnHash: 'return-hash',
  successfulCount: 11,
  failedCount: 1,
  unknownCount: 0,
  duplicateCount: 0,
  lineAmountMismatchCount: 0,
  successfulMinor: 900_000,
  failedMinor: 100_000,
  freezeReason: null,
};

function fixture() {
  const accounts = {
    attest: vi.fn().mockResolvedValue({
      id: 'account-001',
      ownerType: 'employee',
      ownerId: 'employee-001',
      version: 1,
      status: 'active',
    }),
  };
  const bankReturns = {
    ingest: vi.fn()
      .mockResolvedValueOnce(bankReturn)
      .mockResolvedValue({ ...bankReturn, freezeReason: 'UNKNOWN_LINE' }),
  };
  const disbursements = {
    submit: vi.fn()
      .mockResolvedValueOnce(submittedBatch)
      .mockResolvedValue(preparedBatch),
    approveExport: vi.fn()
      .mockResolvedValueOnce(submittedBatch)
      .mockResolvedValue(preparedBatch),
    prepare: vi.fn().mockResolvedValue(preparedBatch),
  };
  const recovery = {
    create: vi.fn().mockResolvedValue(preparedBatch),
  };
  const reconciliation = {
    reconcile: vi.fn().mockResolvedValue({
      id: 'reconciliation-001',
      periodId: 'period-001',
      payrollRunId: 'run-001',
      batchId: 'batch-001',
      bankReturnId: 'return-001',
      taxFilingId: 'tax-001',
      status: 'matched',
      differences: [{ code: 'ROUNDING' }],
      evidenceHash: 'reconciliation-hash',
      version: 2,
    }),
  };
  const record = vi.fn().mockResolvedValue(undefined);
  const controller = new TreasuryController(
    accounts as unknown as TreasuryBankAccountService,
    bankReturns as unknown as TreasuryBankReturnService,
    disbursements as unknown as TreasuryDisbursementService,
    recovery as unknown as TreasuryRecoveryService,
    reconciliation as unknown as TreasuryReconciliationService,
    { record } as unknown as AuditService,
  );
  return {
    controller,
    record,
    accounts,
    bankReturns,
    disbursements,
    recovery,
    reconciliation,
  };
}

const routeCases = [
  ['reconcileDisbursement', 'disbursements/:id/reconciliation', ['erp:payroll:reconciliation:execute']],
  ['createRecovery', 'disbursements/:id/recovery', ['erp:treasury:recovery:create']],
  ['ingestBankReturn', 'disbursements/:id/returns', ['erp:treasury:return:ingest']],
  ['submitDisbursement', 'disbursements/:id/submission', ['erp:treasury:disbursement:submit']],
  ['approveDisbursementExport', 'disbursements/:id/export-approval', ['erp:treasury:disbursement:approve']],
  ['attestBankAccount', 'bank-accounts/attest', ['erp:treasury:account:attest']],
  ['prepareDisbursement', 'disbursements', ['erp:treasury:disbursement:prepare']],
] as const;

describe('TreasuryController', () => {
  it('固定旧资金控制器边界、全部 POST 路由与最小 Scope', () => {
    expect(Reflect.getMetadata(PATH_METADATA, TreasuryController)).toBe('treasury');
    expect(Reflect.getMetadata(GUARDS_METADATA, TreasuryController))
      .toEqual([LegacyPayrollBoundaryGuard]);
    for (const [name, path, scopes] of routeCases) {
      const handler = Object.getOwnPropertyDescriptor(
        TreasuryController.prototype,
        name,
      )?.value as object;
      expect(Reflect.getMetadata(PATH_METADATA, handler), name).toBe(path);
      expect(Reflect.getMetadata(METHOD_METADATA, handler), name).toBe(RequestMethod.POST);
      expect(Reflect.getMetadata(REQUIRED_SCOPES_KEY, handler), name).toEqual(scopes);
    }
  });

  it('委托对账、恢复、回盘、提交、批准、账户和制备入口', async () => {
    const store = fixture();
    const recoveryBody = {
      expectedVersion: 4,
      strongAuthEvidenceId: 'auth-recovery-001',
    };
    const submitBody = { expectedVersion: 2 };
    const approvalBody = {
      expectedVersion: 1,
      strongAuthEvidenceId: 'auth-export-001',
    };
    const accountBody = { ownerType: 'employee', ownerId: 'employee-001' };
    const prepareBody = { payrollPeriodId: 'period-001', payrollRunId: 'run-001' };

    await store.controller.reconcileDisbursement(
      KEY,
      'batch-001',
      { expectedVersion: 4 },
    );
    await store.controller.createRecovery(KEY, 'batch-001', recoveryBody, request());
    await store.controller.ingestBankReturn(
      KEY,
      'batch-001',
      { expectedVersion: 3 },
    );
    await store.controller.ingestBankReturn(
      KEY,
      'batch-001',
      { expectedVersion: 4 },
    );
    await store.controller.submitDisbursement(KEY, 'batch-001', submitBody);
    await store.controller.submitDisbursement(KEY, 'batch-001', submitBody);
    await store.controller.approveDisbursementExport(
      KEY,
      'batch-001',
      approvalBody,
      request(),
    );
    await store.controller.approveDisbursementExport(
      KEY,
      'batch-001',
      approvalBody,
      request(),
    );
    await store.controller.attestBankAccount(KEY, accountBody as never);
    await store.controller.prepareDisbursement(KEY, prepareBody as never);

    expect(store.reconciliation.reconcile).toHaveBeenCalledWith(KEY, 'batch-001', 4);
    expect(store.recovery.create).toHaveBeenCalledWith(KEY, 'batch-001', recoveryBody, TOKEN);
    expect(store.bankReturns.ingest).toHaveBeenNthCalledWith(1, KEY, 'batch-001', 3);
    expect(store.bankReturns.ingest).toHaveBeenNthCalledWith(2, KEY, 'batch-001', 4);
    expect(store.disbursements.submit).toHaveBeenCalledTimes(2);
    expect(store.disbursements.submit).toHaveBeenNthCalledWith(
      1,
      KEY,
      'batch-001',
      submitBody,
    );
    expect(store.disbursements.approveExport).toHaveBeenCalledTimes(2);
    expect(store.disbursements.approveExport).toHaveBeenNthCalledWith(
      1,
      KEY,
      'batch-001',
      approvalBody,
      TOKEN,
    );
    expect(store.accounts.attest).toHaveBeenCalledWith(KEY, accountBody);
    expect(store.disbursements.prepare).toHaveBeenCalledWith(KEY, prepareBody);
  });

  it.each([
    ['失败代发恢复', (controller: TreasuryController) => controller.createRecovery(
      KEY,
      'batch-001',
      { expectedVersion: 4, strongAuthEvidenceId: 'auth-001' },
      request(null),
    )],
    ['代发导出批准', (controller: TreasuryController) => controller.approveDisbursementExport(
      KEY,
      'batch-001',
      { expectedVersion: 1, strongAuthEvidenceId: 'auth-001' },
      request(null),
    )],
  ])('%s 缺少已验证人员令牌时在业务调用前失败关闭', async (_name, operation) => {
    const store = fixture();

    await expect(operation(store.controller)).rejects.toBeInstanceOf(BadRequestException);

    expect(store.recovery.create).not.toHaveBeenCalled();
    expect(store.disbursements.approveExport).not.toHaveBeenCalled();
    expect(store.record).not.toHaveBeenCalled();
  });

  it.each([undefined, ''])('写入口拒绝缺失幂等键 %s', async (key) => {
    const store = fixture();

    await expect(store.controller.prepareDisbursement(key, {} as never))
      .rejects.toMatchObject({ response: { code: 'IDEMPOTENCY_KEY_REQUIRED' } });

    expect(store.disbursements.prepare).not.toHaveBeenCalled();
    expect(store.record).not.toHaveBeenCalled();
  });

  it('银行或业务提交后的审计故障不反向暴露失败并只记录稳定告警', async () => {
    const store = fixture();
    store.record.mockRejectedValue(new Error('audit unavailable'));
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    await store.controller.reconcileDisbursement(
      KEY,
      'batch-001',
      { expectedVersion: 4 },
    );
    await store.controller.createRecovery(
      KEY,
      'batch-001',
      { expectedVersion: 4, strongAuthEvidenceId: 'auth-recovery-001' },
      request(),
    );
    await store.controller.ingestBankReturn(KEY, 'batch-001', { expectedVersion: 3 });
    await store.controller.submitDisbursement(
      KEY,
      'batch-001',
      { expectedVersion: 2 },
    );
    await store.controller.approveDisbursementExport(
      KEY,
      'batch-001',
      { expectedVersion: 1, strongAuthEvidenceId: 'auth-export-001' },
      request(),
    );
    await store.controller.attestBankAccount(KEY, {} as never);
    await store.controller.prepareDisbursement(
      KEY,
      { payrollPeriodId: 'period-001', payrollRunId: 'run-001' } as never,
    );

    expect(error).toHaveBeenCalledTimes(7);
    expect(error).toHaveBeenCalledWith({
      code: 'TREASURY_AUDIT_AFTER_COMMIT_FAILED',
      action: 'treasury.disbursement.prepare',
      resourceType: 'treasury_disbursement_batch',
      resourceId: 'batch-001',
      riskLevel: 'R2',
    });
    expect(error).toHaveBeenCalledWith({
      code: 'TREASURY_AUDIT_AFTER_COMMIT_FAILED',
      action: 'payroll.reconciliation.execute',
      resourceType: 'payroll_reconciliation',
      resourceId: 'reconciliation-001',
      riskLevel: 'R3',
    });
    expect(JSON.stringify(error.mock.calls)).not.toContain('audit unavailable');
    error.mockRestore();
  });
});
