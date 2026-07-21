import { BadRequestException, Body, Controller, Headers, Post } from '@nestjs/common';

import { AuditService } from '../../core/audit/audit.service.js';
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
  PrepareTreasuryDisbursementDto,
} from './application/treasury.dto.js';

@Controller('treasury')
export class TreasuryController {
  constructor(
    private readonly accounts: TreasuryBankAccountService,
    private readonly disbursements: TreasuryDisbursementService,
    private readonly audit: AuditService,
  ) {}

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
