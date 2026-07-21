import { BadRequestException, Body, Controller, Headers, Post } from '@nestjs/common';

import { AuditService } from '../../core/audit/audit.service.js';
import { RequiredScopes } from '../identity/auth.decorators.js';
import {
  TreasuryBankAccountService,
  type TreasuryBankAccountSummary,
} from './application/treasury-bank-account.service.js';
import { AttestTreasuryBankAccountDto } from './application/treasury.dto.js';

@Controller('treasury')
export class TreasuryController {
  constructor(
    private readonly accounts: TreasuryBankAccountService,
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

  private key(value: string | undefined): string {
    if (value === undefined || value.length === 0) throw new BadRequestException({
      code: 'IDEMPOTENCY_KEY_REQUIRED', message: '写接口必须提供 Idempotency-Key',
    });
    return value;
  }
}
