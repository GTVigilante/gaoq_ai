import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  Logger,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';

import { AuditService } from '../../core/audit/audit.service.js';
import type { AuditRecordInput } from '../../core/audit/audit.types.js';
import type { ErpRequest } from '../../core/http/request-context.js';
import { RequiredScopes } from '../identity/auth.decorators.js';
import {
  TreasuryAdjustmentSupplementService,
} from './application/treasury-adjustment-supplement.service.js';
import {
  TreasuryBankAccountService,
  type TreasuryBankAccountSummary,
} from './application/treasury-bank-account.service.js';
import {
  TreasuryBankReturnService,
  type TreasuryBankReturnSummary,
} from './application/treasury-bank-return.service.js';
import {
  TreasuryDisbursementService,
  type TreasuryDisbursementSummary,
} from './application/treasury-disbursement.service.js';
import { TreasuryRecoveryService } from './application/treasury-recovery.service.js';
import { TreasuryReconciliationService } from './application/treasury-reconciliation.service.js';
import {
  AttestTreasuryBankAccountDto,
  ApproveTreasuryExportDto,
  CreateTreasuryRecoveryDto,
  ExecuteTreasuryReconciliationDto,
  IngestTreasuryBankReturnDto,
  PrepareTreasuryDisbursementDto,
  PrepareTreasuryAdjustmentSupplementDto,
  SubmitTreasuryDisbursementDto,
} from './application/treasury.dto.js';
import { LegacyPayrollBoundaryGuard } from '../payroll/legacy-payroll-boundary.guard.js';

@Controller('treasury')
@UseGuards(LegacyPayrollBoundaryGuard)
export class TreasuryController {
  private readonly logger = new Logger(TreasuryController.name);

  constructor(
    private readonly accounts: TreasuryBankAccountService,
    private readonly adjustmentSupplements: TreasuryAdjustmentSupplementService,
    private readonly bankReturns: TreasuryBankReturnService,
    private readonly disbursements: TreasuryDisbursementService,
    private readonly recovery: TreasuryRecoveryService,
    private readonly reconciliation: TreasuryReconciliationService,
    private readonly audit: AuditService,
  ) {}

  /** R3：只从已锁定正向调整派生关联补发子批次；员工、金额和账户均由服务端确定。 */
  @Post('payroll-adjustments/:id/supplement')
  @RequiredScopes(
    'erp:treasury:adjustment:prepare',
    'erp:treasury:adjustment:source:read',
  )
  async prepareAdjustmentSupplement(
    @Headers('idempotency-key') key: string | undefined,
    @Param('id') id: string,
    @Body() body: PrepareTreasuryAdjustmentSupplementDto,
  ): Promise<TreasuryDisbursementSummary> {
    const result = await this.adjustmentSupplements.prepare(this.key(key), id, body);
    await this.audit.record({
      action: 'treasury.adjustment_supplement.prepare',
      resourceType: 'treasury_disbursement_batch',
      resourceId: result.id,
      riskLevel: 'R3',
      outcome: 'success',
      metadata: {
        adjustmentId: id,
        payrollPeriodId: result.payrollPeriodId,
        payrollRunId: result.payrollRunId,
        status: result.status,
        version: result.version,
        lineCount: result.lineCount,
        totalMinor: result.totalMinor,
        objectEvidenceId: result.objectEvidenceId ?? 'none',
      },
    });
    return result;
  }

  /** R3：可信服务聚合锁定工资、银行提交、终态回盘和已提交个税；MCP 不执行。 */
  @Post('disbursements/:id/reconciliation')
  @RequiredScopes('erp:payroll:reconciliation:execute')
  async reconcileDisbursement(
    @Headers('idempotency-key') key: string | undefined,
    @Param('id') id: string,
    @Body() body: ExecuteTreasuryReconciliationDto,
  ) {
    const result = await this.reconciliation.reconcile(this.key(key), id, body.expectedVersion);
    await this.auditAfterCommit({
      action: 'payroll.reconciliation.execute', resourceType: 'payroll_reconciliation',
      resourceId: result.id, riskLevel: 'R3', outcome: 'success', metadata: {
        periodId: result.periodId, payrollRunId: result.payrollRunId, batchId: result.batchId,
        bankReturnId: result.bankReturnId, taxFilingId: result.taxFilingId,
        status: result.status, differenceCount: result.differences.length,
        evidenceHash: result.evidenceHash, version: result.version,
      },
    });
    return result;
  }

  /** R3：只从受保护终态回盘派生失败子批次；父批次、员工与金额不可由客户端选择。 */
  @Post('disbursements/:id/recovery')
  @RequiredScopes('erp:treasury:recovery:create')
  async createRecovery(
    @Headers('idempotency-key') key: string | undefined,
    @Param('id') id: string,
    @Body() body: CreateTreasuryRecoveryDto,
    @Req() request: ErpRequest,
  ): Promise<TreasuryDisbursementSummary> {
    if (request.verifiedAccessToken === undefined) throw new BadRequestException({
      code: 'TREASURY_RECOVERY_TOKEN_REQUIRED', message: '失败代发恢复必须使用已验证人员访问令牌',
    });
    const result = await this.recovery.create(
      this.key(key), id, body, request.verifiedAccessToken,
    );
    await this.auditAfterCommit({
      action: 'treasury.disbursement.recovery_create',
      resourceType: 'treasury_disbursement_batch', resourceId: result.id,
      riskLevel: 'R3', outcome: 'success', metadata: {
        parentBatchId: id, payrollPeriodId: result.payrollPeriodId,
        payrollRunId: result.payrollRunId, status: result.status, version: result.version,
        lineCount: result.lineCount, totalMinor: result.totalMinor,
        objectEvidenceId: result.objectEvidenceId ?? 'none',
        strongAuthEvidenceId: body.strongAuthEvidenceId,
      },
    });
    return result;
  }

  /** R3：只接收 Inbox 规范清单并逐行复核；原始回盘与冻结解除不向 MCP 暴露。 */
  @Post('disbursements/:id/returns')
  @RequiredScopes('erp:treasury:return:ingest')
  async ingestBankReturn(
    @Headers('idempotency-key') key: string | undefined,
    @Param('id') id: string,
    @Body() body: IngestTreasuryBankReturnDto,
  ): Promise<TreasuryBankReturnSummary> {
    const result = await this.bankReturns.ingest(this.key(key), id, body.expectedVersion);
    await this.auditAfterCommit({
      action: 'treasury.bank_return.ingest', resourceType: 'treasury_bank_return',
      resourceId: result.id, riskLevel: 'R3', outcome: 'success', metadata: {
        batchId: result.batchId, status: result.status, batchVersion: result.batchVersion,
        returnHash: result.returnHash, successfulCount: result.successfulCount,
        failedCount: result.failedCount, unknownCount: result.unknownCount,
        duplicateCount: result.duplicateCount,
        lineAmountMismatchCount: result.lineAmountMismatchCount,
        successfulMinor: result.successfulMinor, failedMinor: result.failedMinor,
        freezeReason: result.freezeReason ?? 'none',
      },
    });
    return result;
  }

  /** R3：仅可信提交服务可调用；网关只接收 WORM 引用，MCP 永不注册。 */
  @Post('disbursements/:id/submission')
  @RequiredScopes('erp:treasury:disbursement:submit')
  async submitDisbursement(
    @Headers('idempotency-key') key: string | undefined,
    @Param('id') id: string,
    @Body() body: SubmitTreasuryDisbursementDto,
  ): Promise<TreasuryDisbursementSummary> {
    const result = await this.disbursements.submit(this.key(key), id, body);
    await this.auditAfterCommit({
      action: 'treasury.disbursement.submit', resourceType: 'treasury_disbursement_batch',
      resourceId: result.id, riskLevel: 'R3', outcome: 'success', metadata: {
        payrollPeriodId: result.payrollPeriodId, payrollRunId: result.payrollRunId,
        status: result.status, version: result.version, fileHash: result.fileHash ?? 'none',
        bankSubmissionId: result.bankSubmissionId ?? 'none',
        bankSubmissionEvidenceId: result.bankSubmissionEvidenceId ?? 'none',
      },
    });
    return result;
  }

  /** R3：强认证 operationId 必须绑定批次 ID；批准人必须独立，MCP 永不注册。 */
  @Post('disbursements/:id/export-approval')
  @RequiredScopes('erp:treasury:disbursement:approve')
  async approveDisbursementExport(
    @Headers('idempotency-key') key: string | undefined,
    @Param('id') id: string,
    @Body() body: ApproveTreasuryExportDto,
    @Req() request: ErpRequest,
  ): Promise<TreasuryDisbursementSummary> {
    if (request.verifiedAccessToken === undefined) throw new BadRequestException({
      code: 'TREASURY_EXPORT_APPROVAL_TOKEN_REQUIRED', message: '代发导出批准必须使用已验证人员访问令牌',
    });
    const result = await this.disbursements.approveExport(
      this.key(key), id, body, request.verifiedAccessToken,
    );
    await this.auditAfterCommit({
      action: 'treasury.disbursement.approve_export',
      resourceType: 'treasury_disbursement_batch', resourceId: result.id,
      riskLevel: 'R3', outcome: 'success', metadata: {
        payrollPeriodId: result.payrollPeriodId, payrollRunId: result.payrollRunId,
        status: result.status, version: result.version, fileHash: result.fileHash ?? 'none',
        objectEvidenceId: result.objectEvidenceId ?? 'none',
        strongAuthEvidenceId: body.strongAuthEvidenceId,
      },
    });
    return result;
  }

  /** R3：仅可信账户连接器接收审批后的账户版本；MCP 永不注册此动作。 */
  @Post('bank-accounts/attest')
  @RequiredScopes('erp:treasury:account:attest')
  async attestBankAccount(
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: AttestTreasuryBankAccountDto,
  ): Promise<TreasuryBankAccountSummary> {
    const result = await this.accounts.attest(this.key(key), body);
    await this.auditAfterCommit({
      action: 'treasury.bank_account.attest', resourceType: 'treasury_bank_account',
      resourceId: result.id, riskLevel: 'R3', outcome: 'success', metadata: {
        ownerType: result.ownerType, ownerId: result.ownerId,
        version: result.version, status: result.status,
      },
    });
    return result;
  }

  /** 制备只产生 WORM 证据与密文支付指令，不导出或提交银行；MCP 永不注册。 */
  @Post('disbursements')
  @RequiredScopes('erp:treasury:disbursement:prepare')
  async prepareDisbursement(
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: PrepareTreasuryDisbursementDto,
  ): Promise<TreasuryDisbursementSummary> {
    const result = await this.disbursements.prepare(this.key(key), body);
    await this.auditAfterCommit({
      action: 'treasury.disbursement.prepare', resourceType: 'treasury_disbursement_batch',
      resourceId: result.id, riskLevel: 'R2', outcome: 'success', metadata: {
        payrollPeriodId: result.payrollPeriodId, payrollRunId: result.payrollRunId,
        status: result.status, version: result.version,
        lineCount: result.lineCount, totalMinor: result.totalMinor,
        fileHash: result.fileHash ?? 'none',
        objectEvidenceId: result.objectEvidenceId ?? 'none',
      },
    });
    return result;
  }

  private key(value: string | undefined): string {
    if (value === undefined || value.length === 0) throw new BadRequestException({
      code: 'IDEMPOTENCY_KEY_REQUIRED', message: '写接口必须提供 Idempotency-Key',
    });
    return value;
  }

  /** 银行、WORM 或业务事务已提交后，审计故障不得把成功终态反向暴露为失败。 */
  private async auditAfterCommit(input: AuditRecordInput): Promise<void> {
    try {
      await this.audit.record(input);
    } catch {
      this.logger.error({
        code: 'TREASURY_AUDIT_AFTER_COMMIT_FAILED',
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        riskLevel: input.riskLevel,
      });
    }
  }
}
