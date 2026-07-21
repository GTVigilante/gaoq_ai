import { BadRequestException, Body, Controller, Headers, Param, Post, Req } from '@nestjs/common';

import { AuditService } from '../../core/audit/audit.service.js';
import type { ErpRequest } from '../../core/http/request-context.js';
import { RequiredScopes } from '../identity/auth.decorators.js';
import {
  TreasuryBankAccountService,
  type TreasuryBankAccountSummary,
} from './application/treasury-bank-account.service.js';
import {
  TreasuryDisbursementService,
  type TreasuryDisbursementSummary,
} from './application/treasury-disbursement.service.js';
import {
  AttestTreasuryBankAccountDto,
  ApproveTreasuryExportDto,
  PrepareTreasuryDisbursementDto,
  SubmitTreasuryDisbursementDto,
} from './application/treasury.dto.js';

@Controller('treasury')
export class TreasuryController {
  constructor(
    private readonly accounts: TreasuryBankAccountService,
    private readonly disbursements: TreasuryDisbursementService,
    private readonly audit: AuditService,
  ) {}

  /** R3：仅可信提交服务可调用；网关只接收 WORM 引用，MCP 永不注册。 */
  @Post('disbursements/:id/submission')
  @RequiredScopes('erp:treasury:disbursement:submit')
  async submitDisbursement(
    @Headers('idempotency-key') key: string | undefined,
    @Param('id') id: string,
    @Body() body: SubmitTreasuryDisbursementDto,
  ): Promise<TreasuryDisbursementSummary> {
    const result = await this.disbursements.submit(this.key(key), id, body);
    await this.audit.record({
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
    await this.audit.record({
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
    await this.audit.record({
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
    await this.audit.record({
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
}
