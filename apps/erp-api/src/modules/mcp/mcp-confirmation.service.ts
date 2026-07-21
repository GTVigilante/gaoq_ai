import { createHash, randomBytes } from 'node:crypto';

import {
  ConflictException,
  ForbiddenException,
  GoneException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { createEventId } from '@gaoq/shared-utils';
import type { Model } from 'mongoose';

import type { AppEnvironment } from '../../config/environment.js';
import type { BrowserOAuthIdentity } from '../identity/token-grant.service.js';
import type { McpIdentity } from './mcp-auth-context.js';
import {
  McpConfirmationRecord,
  type McpApprovalOperation,
  type McpConfirmationDocument,
} from './mcp-confirmation.schema.js';

const PREPARE_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const OPERATION_ID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const CREDENTIAL_PATTERN = /^mcpc_[A-Za-z0-9_-]{43}$/;
const CONFIRMATION_TTL_MS = 10 * 60 * 1_000;
const EXECUTION_LEASE_MS = 2 * 60 * 1_000;

export type ApprovalMcpCommand =
  | {
      readonly operation: 'approval.submit';
      readonly instanceId: string;
      readonly expectedVersion: number;
    }
  | {
      readonly operation: 'approval.withdraw';
      readonly instanceId: string;
      readonly expectedVersion: number;
    }
  | {
      readonly operation: 'approval.decide';
      readonly instanceId: string;
      readonly expectedVersion: number;
      readonly principalApproverId: string;
      readonly outcome: 'approved' | 'rejected';
    };

export interface McpPreparedOperation {
  readonly operationId: string;
  readonly digest: string;
  readonly riskLevel: 'R1' | 'R2';
  readonly expiresAt: string;
  readonly confirmationUrl: string;
}

export interface ClaimedMcpOperation {
  readonly operationId: string;
  readonly command: ApprovalMcpCommand;
  readonly replayResult: Record<string, unknown> | null;
}

/** 服务端确认应用服务：准备、浏览器确认、一次性凭据和崩溃恢复执行租约。 */
@Injectable()
export class McpConfirmationService {
  private readonly webOrigin: string;

  constructor(
    @InjectModel(McpConfirmationRecord.name)
    private readonly records: Model<McpConfirmationDocument>,
    config: ConfigService<AppEnvironment, true>,
  ) {
    this.webOrigin = config.get('WEB_ORIGIN', { infer: true });
  }

  async prepare(
    identity: McpIdentity,
    prepareKey: string,
    command: ApprovalMcpCommand,
    riskLevel: 'R1' | 'R2',
  ): Promise<McpPreparedOperation> {
    if (!PREPARE_KEY_PATTERN.test(prepareKey)) throw new Error('MCP 准备幂等键非法');
    assertCommandRisk(command.operation, riskLevel);
    const now = new Date();
    const commandJson = canonicalCommand(command);
    const digest = sha256(commandJson);
    const record = {
      operationId: createEventId(now),
      tenantId: identity.tenantId,
      actorId: identity.actorId,
      clientId: identity.clientId,
      operation: command.operation,
      riskLevel,
      prepareKey,
      commandJson,
      digest,
      status: 'pending_confirmation' as const,
      confirmationCredentialHash: null,
      confirmedAt: null,
      executionLockedAt: null,
      executionResult: null,
      expiresAt: new Date(now.getTime() + CONFIRMATION_TTL_MS),
    };
    try {
      await this.records.create(record);
      return this.prepared(record);
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      const existing = await this.records.findOne({
        tenantId: identity.tenantId,
        actorId: identity.actorId,
        clientId: identity.clientId,
        operation: command.operation,
        prepareKey,
      }).lean().exec();
      if (existing === null || existing.digest !== digest) throw new ConflictException({
        code: 'MCP_PREPARE_KEY_REUSED', message: '准备幂等键已被不同操作占用',
      });
      return this.prepared(existing);
    }
  }

  async describe(operationId: string, identity: BrowserOAuthIdentity) {
    const record = await this.requireBrowserRecord(operationId, identity);
    return Object.freeze({
      operationId: record.operationId,
      operation: record.operation,
      riskLevel: record.riskLevel,
      digest: record.digest,
      expiresAt: record.expiresAt.toISOString(),
      status: record.status,
      impact: safeImpact(parseCommand(record.commandJson)),
    });
  }

  async confirm(operationId: string, identity: BrowserOAuthIdentity): Promise<{
    readonly operationId: string;
    readonly confirmationCredential: string;
    readonly expiresAt: string;
  }> {
    const record = await this.requireBrowserRecord(operationId, identity);
    this.assertNotExpired(record.expiresAt);
    if (record.riskLevel === 'R2') throw new ServiceUnavailableException({
      code: 'MCP_R2_STRONG_AUTH_UNAVAILABLE',
      message: 'R2 操作必须完成已验证的强认证；当前未配置强认证签发器',
    });
    if (record.status !== 'pending_confirmation') throw new ConflictException({
      code: 'MCP_CONFIRMATION_ALREADY_DECIDED', message: '该操作已确认或不可再次确认',
    });
    const credential = `mcpc_${randomBytes(32).toString('base64url')}`;
    const now = new Date();
    const updated = await this.records.findOneAndUpdate(
      {
        operationId,
        tenantId: identity.tenantId,
        actorId: identity.actorId,
        status: 'pending_confirmation',
        expiresAt: { $gt: now },
      },
      {
        $set: {
          status: 'ready',
          confirmationCredentialHash: sha256(credential),
          confirmedAt: now,
        },
      },
      { returnDocument: 'after', runValidators: true },
    ).lean().exec();
    if (updated === null) throw new ConflictException({
      code: 'MCP_CONFIRMATION_RACE', message: '确认状态已变化，请刷新页面',
    });
    return Object.freeze({ operationId, confirmationCredential: credential, expiresAt: updated.expiresAt.toISOString() });
  }

  async claim(
    identity: McpIdentity,
    operation: McpApprovalOperation,
    operationId: string,
    credential: string,
  ): Promise<ClaimedMcpOperation> {
    if (!OPERATION_ID_PATTERN.test(operationId) || !CREDENTIAL_PATTERN.test(credential)) {
      throw new ForbiddenException({ code: 'MCP_CONFIRMATION_INVALID', message: '确认凭据无效' });
    }
    const current = await this.records.findOne({
      operationId,
      tenantId: identity.tenantId,
      actorId: identity.actorId,
      clientId: identity.clientId,
      operation,
    }).lean().exec();
    if (current === null) throw new NotFoundException({
      code: 'MCP_CONFIRMATION_NOT_FOUND', message: '确认记录不存在',
    });
    if (current.status === 'executed' && current.executionResult !== null) {
      return { operationId, command: parseCommand(current.commandJson), replayResult: structuredClone(current.executionResult) };
    }
    this.assertNotExpired(current.expiresAt);
    if (current.confirmationCredentialHash !== sha256(credential)) throw new ForbiddenException({
      code: 'MCP_CONFIRMATION_INVALID', message: '确认凭据无效',
    });
    const now = new Date();
    const staleBefore = new Date(now.getTime() - EXECUTION_LEASE_MS);
    const claimed = await this.records.findOneAndUpdate(
      {
        operationId,
        tenantId: identity.tenantId,
        actorId: identity.actorId,
        clientId: identity.clientId,
        operation,
        confirmationCredentialHash: sha256(credential),
        expiresAt: { $gt: now },
        $or: [
          { status: 'ready' },
          { status: 'executing', executionLockedAt: { $lt: staleBefore } },
        ],
      },
      { $set: { status: 'executing', executionLockedAt: now } },
      { returnDocument: 'after', runValidators: true },
    ).lean().exec();
    if (claimed === null) throw new ConflictException({
      code: 'MCP_OPERATION_IN_PROGRESS', message: '操作正在执行，请稍后使用相同参数重试',
    });
    const command = parseCommand(claimed.commandJson);
    if (claimed.digest !== sha256(canonicalCommand(command))) throw new ForbiddenException({
      code: 'MCP_OPERATION_DIGEST_MISMATCH', message: '操作摘要校验失败',
    });
    return { operationId, command, replayResult: null };
  }

  async complete(operationId: string, result: Record<string, unknown>): Promise<void> {
    const updated = await this.records.updateOne(
      { operationId, status: 'executing' },
      {
        $set: {
          status: 'executed', executionResult: structuredClone(result),
          confirmationCredentialHash: null, executionLockedAt: null,
        },
      },
      { runValidators: true },
    );
    if (updated.modifiedCount !== 1) throw new Error('MCP 确认完成状态冲突');
  }

  async release(operationId: string): Promise<void> {
    await this.records.updateOne(
      { operationId, status: 'executing' },
      { $set: { status: 'ready', executionLockedAt: null } },
      { runValidators: true },
    );
  }

  private async requireBrowserRecord(operationId: string, identity: BrowserOAuthIdentity) {
    if (!OPERATION_ID_PATTERN.test(operationId)) throw new NotFoundException();
    const record = await this.records.findOne({
      operationId,
      tenantId: identity.tenantId,
      actorId: identity.actorId,
    }).lean().exec();
    if (record === null) throw new NotFoundException({
      code: 'MCP_CONFIRMATION_NOT_FOUND', message: '确认记录不存在',
    });
    return record;
  }

  private assertNotExpired(expiresAt: Date): void {
    if (expiresAt.getTime() <= Date.now()) throw new GoneException({
      code: 'MCP_CONFIRMATION_EXPIRED', message: '确认记录已过期，请重新准备操作',
    });
  }

  private prepared(record: Pick<
    McpConfirmationRecord,
    'operationId' | 'digest' | 'riskLevel' | 'expiresAt'
  >): McpPreparedOperation {
    const url = new URL('/mcp/confirm', this.webOrigin);
    url.searchParams.set('operation_id', record.operationId);
    return Object.freeze({
      operationId: record.operationId,
      digest: record.digest,
      riskLevel: record.riskLevel,
      expiresAt: record.expiresAt.toISOString(),
      confirmationUrl: url.toString(),
    });
  }
}

function assertCommandRisk(operation: McpApprovalOperation, riskLevel: 'R1' | 'R2'): void {
  const expected = operation === 'approval.decide' ? 'R2' : 'R1';
  if (riskLevel !== expected) throw new Error('MCP 操作风险分级错误');
}

function canonicalCommand(command: ApprovalMcpCommand): string {
  switch (command.operation) {
    case 'approval.submit':
    case 'approval.withdraw':
      return JSON.stringify({
        expectedVersion: command.expectedVersion,
        instanceId: command.instanceId,
        operation: command.operation,
      });
    case 'approval.decide':
      return JSON.stringify({
        expectedVersion: command.expectedVersion,
        instanceId: command.instanceId,
        operation: command.operation,
        outcome: command.outcome,
        principalApproverId: command.principalApproverId,
      });
  }
}

function parseCommand(value: string): ApprovalMcpCommand {
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== 'object' || parsed === null) throw new Error('MCP 确认命令损坏');
  const command = parsed as Partial<ApprovalMcpCommand>;
  if (
    !OPERATION_ID_PATTERN.test(String(command.instanceId ?? '')) ||
    !Number.isSafeInteger(command.expectedVersion) || Number(command.expectedVersion) < 1
  ) throw new Error('MCP 确认命令非法');
  if (command.operation === 'approval.submit' || command.operation === 'approval.withdraw') {
    return {
      operation: command.operation,
      instanceId: String(command.instanceId),
      expectedVersion: Number(command.expectedVersion),
    };
  }
  if (
    command.operation === 'approval.decide' &&
    typeof command.principalApproverId === 'string' &&
    /^[A-Za-z0-9._:-]{1,128}$/.test(command.principalApproverId) &&
    ['approved', 'rejected'].includes(String(command.outcome))
  ) return {
    operation: command.operation,
    instanceId: String(command.instanceId),
    expectedVersion: Number(command.expectedVersion),
    principalApproverId: command.principalApproverId,
    outcome: command.outcome as 'approved' | 'rejected',
  };
  throw new Error('MCP 确认命令类型非法');
}

function safeImpact(command: ApprovalMcpCommand): Readonly<Record<string, unknown>> {
  return Object.freeze({ ...command });
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64url');
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000;
}
