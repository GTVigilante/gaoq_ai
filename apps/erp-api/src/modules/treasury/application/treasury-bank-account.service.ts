import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createEventId } from '@gaoq/shared-utils';
import type { ClientSession, Model } from 'mongoose';

import { IdempotencyService } from '../../../core/idempotency/idempotency.service.js';
import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { ApprovalApplicationService } from '../../approval/application/approval-application.service.js';
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
const HASH_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MIGRATION_EVIDENCE_REF_PATTERN =
  /^erp:\/\/data-migrations\/runs\/[0-7][0-9A-HJKMNP-TV-Z]{25}\/attachments\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface TreasuryBankAccountSummary extends Record<string, unknown> {
  readonly id: string;
  readonly ownerType: 'organization' | 'employee';
  readonly ownerId: string;
  readonly version: number;
  readonly status: 'active' | 'revoked';
}

export interface ImportTreasuryBankAccountFromMigrationInput {
  readonly targetId: string | null;
  readonly ownerType: 'organization' | 'employee';
  readonly ownerId: string;
  readonly accountName: string;
  readonly account: string;
  readonly clearingCode: string;
  readonly currency: 'CNY';
  readonly version: number;
  readonly status: 'active' | 'revoked';
  readonly approvalHistoryId: string;
  readonly approvalEvidenceChecksum: string;
  readonly createdAt: string;
  readonly revokedAt: string | null;
  readonly migrationEvidenceRef: string;
  readonly evidenceChecksum: string;
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
    @Inject(ApprovalApplicationService)
    private readonly approvals?: ApprovalApplicationService,
  ) {}

  /** 迁移专用：按版本恢复已审批账户，不伪造在线鉴证事件。 */
  async importFromMigration(
    key: string,
    input: ImportTreasuryBankAccountFromMigrationInput,
  ): Promise<TreasuryBankAccountSummary> {
    this.assertMigrationWriter();
    assertMigrationInput(input);
    const approvals = this.approvals;
    if (approvals === undefined) throw new Error('资金账户迁移审批依赖未装配');
    const data = this.normalize(input);
    return this.run(() => this.idempotency.execute(
      'treasury.bank_account.import_from_migration', key, input, async (session) => {
        const [approval] = await Promise.all([
          approvals.verifyTreasuryMigrationReference(
            input.approvalHistoryId, 'treasury_bank_account_attestation', session,
          ),
          this.assertMigrationOwner(input.ownerType, input.ownerId, input.status, session),
        ]);
        if (approval.evidenceChecksum !== input.approvalEvidenceChecksum ||
          Date.parse(approval.completedAt) > Date.parse(input.createdAt)) {
          throw new ConflictException({
            code: 'TREASURY_ACCOUNT_MIGRATION_APPROVAL_INVALID',
            message: '资金账户审批证据摘要或时间线不一致',
          });
        }
        const accountBlindIndexes = [
          ...this.crypto.accountFingerprints(this.tenantId(), data.account),
        ];
        if (input.targetId !== null) return this.verifyMigrationReplay(
          input, data, accountBlindIndexes, session,
        );
        const latest = await this.accounts.findOne({
          tenantId: this.tenantId(), ownerType: input.ownerType, ownerId: input.ownerId,
        }).sort({ version: -1 }).session(session).lean().exec();
        if ((latest?.version ?? 0) + 1 !== input.version ||
          (latest !== null &&
            (latest.status !== 'revoked' || latest.supersededById !== null))) {
          throw new ConflictException({
            code: 'TREASURY_ACCOUNT_MIGRATION_VERSION_INVALID',
            message: '资金账户迁移版本不连续或前序版本状态非法',
          });
        }
        if (input.status === 'active') await this.assertNoActiveDuplicate(
          input, accountBlindIndexes, session,
        );
        const createdAt = strictMigrationInstant(input.createdAt);
        const revokedAt = input.revokedAt === null ? null : strictMigrationInstant(input.revokedAt);
        const id = createEventId(createdAt);
        const protectedData = this.crypto.protect({
          tenantId: this.tenantId(), resourceType: 'bank_account',
          resourceId: id, version: input.version,
        }, data);
        if (latest !== null) {
          const linked = await this.accounts.updateOne({
            tenantId: this.tenantId(), id: latest.id, status: 'revoked',
            supersededById: null,
          }, { $set: { supersededById: id } }, { session, timestamps: false });
          if (linked.modifiedCount !== 1) throw new ConflictException({
            code: 'TREASURY_ACCOUNT_MIGRATION_VERSION_CONFLICT',
            message: '资金账户前序版本关联发生并发冲突',
          });
        }
        const record = {
          id, tenantId: this.tenantId(), ownerType: input.ownerType,
          ownerId: input.ownerId, version: input.version, accountBlindIndexes,
          approvalEvidenceId: approval.id, approvalReferenceType: 'legacy_history' as const,
          status: input.status, supersededById: null, revokedAt,
          migrationEvidenceRef: input.migrationEvidenceRef,
          migrationEvidenceChecksum: input.evidenceChecksum,
          dataKeyId: protectedData.keyId, dataIv: protectedData.iv,
          dataCiphertext: protectedData.ciphertext, dataAuthTag: protectedData.authTag,
          createdAt, updatedAt: revokedAt ?? createdAt,
        };
        await this.accounts.create([record], { session });
        await this.outbox.append({
          type: 'treasury.bank_account.migrated', tenantId: this.tenantId(),
          aggregateId: id, version: input.version,
          occurredAt: (revokedAt ?? createdAt).toISOString(),
          data: { ownerType: input.ownerType, version: input.version, status: input.status },
        }, session);
        return summary(record);
      },
    ));
  }

  async attest(
    key: string,
    input: AttestTreasuryBankAccountDto,
  ): Promise<TreasuryBankAccountSummary> {
    this.assertTrustedService();
    if (!ULID_PATTERN.test(input.approvalEvidenceId)) throw new BadRequestException({
      code: 'TREASURY_BANK_ACCOUNT_INVALID', message: '银行账户数据或审批引用非法',
    });
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
          approvalEvidenceId: input.approvalEvidenceId,
          approvalReferenceType: 'approval_instance', status: 'active',
          supersededById: null, revokedAt: null,
          migrationEvidenceRef: null, migrationEvidenceChecksum: null,
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

  private normalize(input: Pick<AttestTreasuryBankAccountDto,
    'ownerType' | 'ownerId' | 'accountName' | 'account' | 'clearingCode' | 'currency'>) {
    const accountName = input.accountName.normalize('NFKC').trim();
    if (
      !['organization', 'employee'].includes(input.ownerType) ||
      !ID_PATTERN.test(input.ownerId) ||
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

  private async assertMigrationOwner(
    ownerType: 'organization' | 'employee',
    ownerId: string,
    status: 'active' | 'revoked',
    session: ClientSession,
  ): Promise<void> {
    if (ownerType === 'organization') {
      if (ownerId !== this.tenantId()) throw new BadRequestException({
        code: 'TREASURY_ORGANIZATION_OWNER_INVALID',
        message: '组织付款账户必须绑定当前租户主体',
      });
      return;
    }
    const employee = await this.employees.findById(ownerId, session);
    if (employee === null || (status === 'active' && employee.status === 'terminated')) {
      throw new NotFoundException({
        code: 'TREASURY_ACCOUNT_MIGRATION_OWNER_INVALID',
        message: '资金账户迁移主体不存在或活动账户绑定离职员工',
      });
    }
  }

  private async assertNoActiveDuplicate(
    input: ImportTreasuryBankAccountFromMigrationInput,
    accountBlindIndexes: readonly string[],
    session: ClientSession,
  ): Promise<void> {
    const duplicate = await this.accounts.findOne({
      tenantId: this.tenantId(), status: 'active',
      accountBlindIndexes: { $in: [...accountBlindIndexes] },
    }).session(session).lean().exec();
    if (duplicate !== null) throw new ConflictException({
      code: 'TREASURY_ACCOUNT_MIGRATION_ACTIVE_DUPLICATE',
      message: '迁移活动银行账号已绑定其他账户版本',
    });
    const current = await this.accounts.findOne({
      tenantId: this.tenantId(), ownerType: input.ownerType,
      ownerId: input.ownerId, status: 'active',
    }).session(session).lean().exec();
    if (current !== null) throw new ConflictException({
      code: 'TREASURY_ACCOUNT_MIGRATION_ACTIVE_CONFLICT',
      message: '迁移主体已存在活动银行账户',
    });
  }

  private async verifyMigrationReplay(
    input: ImportTreasuryBankAccountFromMigrationInput,
    expectedData: { readonly accountName: string; readonly account: string;
      readonly clearingCode: string; readonly currency: 'CNY' },
    expectedBlindIndexes: readonly string[],
    session: ClientSession,
  ): Promise<TreasuryBankAccountSummary> {
    const record = await this.accounts.findOne({
      tenantId: this.tenantId(), id: input.targetId,
    }).session(session).lean().exec();
    if (record === null) throw accountMigrationImmutable();
    const data = this.crypto.unprotect({
      tenantId: this.tenantId(), resourceType: 'bank_account',
      resourceId: record.id, version: record.version,
    }, {
      keyId: record.dataKeyId, iv: record.dataIv,
      ciphertext: record.dataCiphertext, authTag: record.dataAuthTag,
    });
    const expectedRevokedAt = input.revokedAt === null ? null : strictMigrationInstant(
      input.revokedAt,
    ).toISOString();
    if (record.ownerType !== input.ownerType || record.ownerId !== input.ownerId ||
      record.version !== input.version || record.status !== input.status ||
      record.approvalEvidenceId !== input.approvalHistoryId ||
      record.approvalReferenceType !== 'legacy_history' ||
      record.migrationEvidenceRef !== input.migrationEvidenceRef ||
      record.migrationEvidenceChecksum !== input.evidenceChecksum ||
      [...record.accountBlindIndexes].sort().join('|') !==
        [...expectedBlindIndexes].sort().join('|') ||
      JSON.stringify(data) !== JSON.stringify(expectedData) ||
      record.createdAt.toISOString() !== input.createdAt ||
      (record.revokedAt?.toISOString() ?? null) !== expectedRevokedAt ||
      record.updatedAt.toISOString() !== (expectedRevokedAt ?? input.createdAt)) {
      throw accountMigrationImmutable();
    }
    return summary(record);
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

  private assertMigrationWriter(): void {
    const actor = this.context.getActorRequired();
    if (!['service', 'system_job'].includes(actor.actorType) ||
      !actor.scopes.includes('erp:migration:execute') ||
      !actor.scopes.includes('erp:treasury:migration:write')) {
      throw new ForbiddenException({
        code: 'TREASURY_ACCOUNT_MIGRATION_WRITER_DENIED',
        message: '资金账户迁移必须由受信任服务身份执行',
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

function assertMigrationInput(input: ImportTreasuryBankAccountFromMigrationInput): void {
  if (Object.keys(input).sort().join(',') !==
      'account,accountName,approvalEvidenceChecksum,approvalHistoryId,clearingCode,createdAt,currency,evidenceChecksum,migrationEvidenceRef,ownerId,ownerType,revokedAt,status,targetId,version' ||
    (input.targetId !== null && !ULID_PATTERN.test(input.targetId)) ||
    !['organization', 'employee'].includes(input.ownerType) ||
    !ID_PATTERN.test(input.ownerId) || !ULID_PATTERN.test(input.approvalHistoryId) ||
    !HASH_PATTERN.test(input.approvalEvidenceChecksum) ||
    !MIGRATION_EVIDENCE_REF_PATTERN.test(input.migrationEvidenceRef) ||
    !HASH_PATTERN.test(input.evidenceChecksum) ||
    !Number.isSafeInteger(input.version) || input.version < 1 || input.version > 1_000 ||
    !['active', 'revoked'].includes(input.status) ||
    (input.status === 'active' && input.revokedAt !== null) ||
    (input.status === 'revoked' && input.revokedAt === null)) {
    throw new BadRequestException({
      code: 'TREASURY_ACCOUNT_MIGRATION_INPUT_INVALID',
      message: '资金账户迁移控制信息非法',
    });
  }
  const createdAt = strictMigrationInstant(input.createdAt);
  if (input.revokedAt !== null &&
    strictMigrationInstant(input.revokedAt).getTime() < createdAt.getTime()) {
    throw new BadRequestException({
      code: 'TREASURY_ACCOUNT_MIGRATION_TIME_INVALID',
      message: '资金账户撤销时间早于创建时间',
    });
  }
}

function strictMigrationInstant(value: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value ||
    parsed.getTime() > Date.now() + 5 * 60_000) {
    throw new BadRequestException({
      code: 'TREASURY_ACCOUNT_MIGRATION_TIME_INVALID',
      message: '资金账户迁移时间必须为历史 UTC 毫秒时间',
    });
  }
  return parsed;
}

function accountMigrationImmutable(): ConflictException {
  return new ConflictException({
    code: 'TREASURY_ACCOUNT_MIGRATION_IMMUTABLE',
    message: '既有资金账户或迁移证据不一致，禁止覆盖',
  });
}

function summary(record: {
  readonly id: string;
  readonly ownerType: 'organization' | 'employee';
  readonly ownerId: string;
  readonly version: number;
  readonly status: 'active' | 'revoked';
}): TreasuryBankAccountSummary {
  return Object.freeze({
    id: record.id, ownerType: record.ownerType, ownerId: record.ownerId,
    version: record.version, status: record.status,
  });
}
