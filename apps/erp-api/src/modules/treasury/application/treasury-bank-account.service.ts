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

import { IdempotencyService } from '../../../core/idempotency/idempotency.service.js';
import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { EmployeeRepository } from '../../org/persistence/org.repositories.js';
import { TreasuryDataCryptoService } from '../persistence/treasury-data-crypto.service.js';
import { TreasuryOutboxWriter } from '../persistence/treasury-outbox.writer.js';
import {
  TreasuryBankAccountRecord,
  type TreasuryBankAccountDocument,
} from '../persistence/treasury.schemas.js';
import type { AttestTreasuryBankAccountDto } from './treasury.dto.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const ACCOUNT_PATTERN = /^[0-9]{8,32}$/;
const CLEARING_CODE_PATTERN = /^[0-9A-Z]{8,12}$/;

export interface TreasuryBankAccountSummary extends Record<string, unknown> {
  readonly id: string;
  readonly ownerType: 'organization' | 'employee';
  readonly ownerId: string;
  readonly version: number;
  readonly status: 'active';
}

/** 仅接收已审批的可信账户版本；账号明文只在校验与加密期间短暂存在。 */
@Injectable()
export class TreasuryBankAccountService {
  constructor(
    private readonly idempotency: IdempotencyService,
    private readonly context: TenantContextService,
    private readonly employees: EmployeeRepository,
    private readonly crypto: TreasuryDataCryptoService,
    private readonly outbox: TreasuryOutboxWriter,
    @InjectModel(TreasuryBankAccountRecord.name)
    private readonly accounts: Model<TreasuryBankAccountDocument>,
  ) {}

  async attest(
    key: string,
    input: AttestTreasuryBankAccountDto,
  ): Promise<TreasuryBankAccountSummary> {
    this.assertTrustedService();
    const data = this.normalize(input);
    return this.run(() => this.idempotency.execute(
      'treasury.bank_account.attest', key, input, async (session) => {
        await this.assertOwner(input.ownerType, input.ownerId, session);
        const accountBlindIndexes = this.crypto.accountFingerprints(this.tenantId(), data.account);
        const duplicate = await this.accounts.findOne({
          tenantId: this.tenantId(), status: 'active',
          accountBlindIndexes: { $in: [...accountBlindIndexes] },
        }).session(session).lean().exec();
        if (
          duplicate !== null &&
          (duplicate.ownerType !== input.ownerType || duplicate.ownerId !== input.ownerId)
        ) throw new ConflictException({
          code: 'TREASURY_ACTIVE_ACCOUNT_DUPLICATE', message: '该银行账号已绑定其他活动主体',
        });
        const current = await this.accounts.findOne({
          tenantId: this.tenantId(), ownerType: input.ownerType,
          ownerId: input.ownerId, status: 'active',
        }).session(session).lean().exec();
        const latest = await this.accounts.findOne({
          tenantId: this.tenantId(), ownerType: input.ownerType, ownerId: input.ownerId,
        }).sort({ version: -1 }).session(session).lean().exec();
        const now = new Date();
        const id = createEventId(now);
        const version = (latest?.version ?? 0) + 1;
        const protectedData = this.crypto.protect({
          tenantId: this.tenantId(), resourceType: 'bank_account', resourceId: id, version,
        }, data);
        if (current !== null) {
          const revoked = await this.accounts.updateOne({
            tenantId: this.tenantId(), id: current.id, status: 'active',
          }, { $set: { status: 'revoked', supersededById: id, revokedAt: now } }, { session });
          if (revoked.modifiedCount !== 1) throw new ConflictException({
            code: 'TREASURY_ACCOUNT_VERSION_CONFLICT', message: '银行账户版本发生并发冲突',
          });
        }
        await this.accounts.create([{
          id, tenantId: this.tenantId(), ownerType: input.ownerType, ownerId: input.ownerId,
          version, accountBlindIndexes: [...accountBlindIndexes],
          approvalEvidenceId: input.approvalEvidenceId, status: 'active',
          supersededById: null, revokedAt: null,
          dataKeyId: protectedData.keyId, dataIv: protectedData.iv,
          dataCiphertext: protectedData.ciphertext, dataAuthTag: protectedData.authTag,
        }], { session });
        await this.outbox.append({
          type: 'treasury.bank_account.attested', tenantId: this.tenantId(),
          aggregateId: id, version, occurredAt: now.toISOString(), data: {
            ownerType: input.ownerType, ownerId: input.ownerId, version, status: 'active',
          },
        }, session);
        return Object.freeze({
          id, ownerType: input.ownerType, ownerId: input.ownerId, version, status: 'active',
        });
      },
    ));
  }

  private normalize(input: AttestTreasuryBankAccountDto) {
    const accountName = input.accountName.normalize('NFKC').trim();
    if (
      !['organization', 'employee'].includes(input.ownerType) ||
      !ID_PATTERN.test(input.ownerId) || !ULID_PATTERN.test(input.approvalEvidenceId) ||
      accountName.length < 1 || accountName.length > 140 || /[\p{Cc}\p{Cf}]/u.test(accountName) ||
      !ACCOUNT_PATTERN.test(input.account) || !CLEARING_CODE_PATTERN.test(input.clearingCode) ||
      input.currency !== 'CNY'
    ) throw new BadRequestException({
      code: 'TREASURY_BANK_ACCOUNT_INVALID', message: '银行账户数据或审批引用非法',
    });
    return Object.freeze({
      accountName, account: input.account,
      clearingCode: input.clearingCode, currency: input.currency,
    });
  }

  private async assertOwner(
    ownerType: 'organization' | 'employee',
    ownerId: string,
    session: Parameters<EmployeeRepository['findById']>[1],
  ): Promise<void> {
    if (ownerType === 'organization') {
      if (ownerId !== this.tenantId()) throw new BadRequestException({
        code: 'TREASURY_ORGANIZATION_OWNER_INVALID', message: '组织付款账户必须绑定当前租户主体',
      });
      return;
    }
    const employee = await this.employees.findById(ownerId, session);
    if (employee === null || employee.status === 'terminated') throw new NotFoundException({
      code: 'TREASURY_EMPLOYEE_NOT_ACTIVE', message: 'ERP 活动员工主数据不存在',
    });
  }

  private assertTrustedService(): void {
    const actor = this.context.getActorRequired();
    if (!actor.scopes.includes('erp:treasury:account:attest')) throw new ForbiddenException({
      code: 'AUTH_SCOPE_DENIED', message: '缺少资金账户登记权限',
    });
    if (actor.actorType !== 'service' && actor.actorType !== 'system_job') {
      throw new ForbiddenException({
        code: 'TREASURY_ACCOUNT_SERVICE_REQUIRED', message: '仅受信任连接器可登记银行账户',
      });
    }
  }

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); } catch (error) {
      if (isDuplicateKeyError(error)) throw new ConflictException({
        code: 'TREASURY_ACCOUNT_UNIQUE_CONFLICT', message: '银行账户活动版本发生唯一性冲突',
      });
      throw error;
    }
  }

  private tenantId(): string { return this.context.getTenantRequired().tenantId; }
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11_000;
}
