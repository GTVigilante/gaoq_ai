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
import { MetricsService } from '../../core/observability/metrics.service.js';
import type { BrowserOAuthIdentity } from '../identity/token-grant.service.js';
import type { VerifiedStrongAuthEvidence } from '../identity/strong-auth/webauthn.service.js';
import type { McpIdentity } from './mcp-auth-context.js';
import {
  McpConfirmationRecord,
  type McpOperation,
  type McpConfirmationDocument,
} from './mcp-confirmation.schema.js';

const PREPARE_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const OPERATION_ID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const CREDENTIAL_PATTERN = /^mcpc_[A-Za-z0-9_-]{43}$/;
const CONFIRMATION_TTL_MS = 10 * 60 * 1_000;
const EXECUTION_LEASE_MS = 2 * 60 * 1_000;

export type McpCommand =
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
    }
  | {
      readonly operation: 'recruitment.requisition.submit';
      readonly requisitionId: string;
      readonly expectedVersion: number;
    }
  | {
      readonly operation: 'recruitment.position.transition';
      readonly positionId: string;
      readonly expectedVersion: number;
      readonly targetStatus: 'open' | 'paused' | 'closed';
    }
  | {
      readonly operation: 'recruitment.offer.request_send';
      readonly offerId: string;
      readonly expectedVersion: number;
    }
  | {
      readonly operation: 'attendance.correction.request';
      readonly sourceFactId: string;
      readonly expectedVersion: 1;
      readonly workedMinutes: number;
      readonly leaveMinutes: number;
      readonly overtimeMinutes: number;
      readonly absentMinutes: number;
      readonly reasonCode: string;
    }
  | {
      readonly operation: 'analytics.management_dashboard.export';
      readonly asOf: string;
      readonly format: 'json';
      readonly expectedVersion: 1;
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
  readonly command: McpCommand;
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
    private readonly metrics: MetricsService,
  ) {
    this.webOrigin = config.get('WEB_ORIGIN', { infer: true });
  }

  async prepare(
    identity: McpIdentity,
    prepareKey: string,
    command: McpCommand,
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
      strongAuthMethod: null,
      strongAuthEvidenceId: null,
      executionLockedAt: null,
      executionResult: null,
      expiresAt: new Date(now.getTime() + CONFIRMATION_TTL_MS),
    };
    try {
      await this.records.create(record);
      this.metrics.recordMcpConfirmation('prepare', riskLevel, 'success');
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
      this.metrics.recordMcpConfirmation('prepare', riskLevel, 'success');
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
    if (record.riskLevel === 'R2') {
      this.metrics.recordMcpConfirmation('confirm', 'R2', 'denied');
      throw new ServiceUnavailableException({
        code: 'MCP_R2_STRONG_AUTH_UNAVAILABLE',
        message: 'R2 操作必须通过 WebAuthn 强认证端点确认，禁止使用普通确认路径',
      });
    }
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
    this.metrics.recordMcpConfirmation('confirm', record.riskLevel, 'success');
    return Object.freeze({ operationId, confirmationCredential: credential, expiresAt: updated.expiresAt.toISOString() });
  }

  async claim(
    identity: McpIdentity,
    operation: McpOperation,
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

  async confirmR2(
    operationId: string,
    identity: BrowserOAuthIdentity,
    evidence: VerifiedStrongAuthEvidence,
  ): Promise<{
    readonly operationId: string;
    readonly confirmationCredential: string;
    readonly expiresAt: string;
  }> {
    const record = await this.requireBrowserRecord(operationId, identity);
    this.assertNotExpired(record.expiresAt);
    if (record.riskLevel !== 'R2' || record.status !== 'pending_confirmation') {
      throw new ConflictException({
        code: 'MCP_R2_CONFIRMATION_STATE_INVALID', message: 'R2 确认状态无效',
      });
    }
    const verifiedAt = new Date(evidence.verifiedAt);
    if (
      evidence.method !== 'webauthn_uv' ||
      evidence.tenantId !== identity.tenantId ||
      evidence.actorId !== identity.actorId ||
      evidence.sessionId !== identity.sessionId ||
      evidence.operationId !== operationId ||
      Number.isNaN(verifiedAt.getTime()) ||
      Date.now() - verifiedAt.getTime() > 60_000 ||
      verifiedAt.getTime() > Date.now() + 5_000
    ) throw new ForbiddenException({
      code: 'MCP_R2_EVIDENCE_INVALID', message: '强认证证据无效或不够新鲜',
    });
    const credential = `mcpc_${randomBytes(32).toString('base64url')}`;
    const updated = await this.records.findOneAndUpdate(
      {
        operationId,
        tenantId: identity.tenantId,
        actorId: identity.actorId,
        riskLevel: 'R2',
        status: 'pending_confirmation',
        expiresAt: { $gt: new Date() },
      },
      {
        $set: {
          status: 'ready',
          confirmationCredentialHash: sha256(credential),
          confirmedAt: verifiedAt,
          strongAuthMethod: evidence.method,
          strongAuthEvidenceId: evidence.evidenceId,
        },
      },
      { returnDocument: 'after', runValidators: true },
    ).lean().exec();
    if (updated === null) throw new ConflictException({
      code: 'MCP_CONFIRMATION_RACE', message: '确认状态已变化，请刷新页面',
    });
    this.metrics.recordMcpConfirmation('confirm', 'R2', 'success');
    return Object.freeze({
      operationId,
      confirmationCredential: credential,
      expiresAt: updated.expiresAt.toISOString(),
    });
  }

  async complete(operationId: string, result: Record<string, unknown>): Promise<void> {
    const updated = await this.records.findOneAndUpdate(
      { operationId, status: 'executing' },
      {
        $set: {
          status: 'executed', executionResult: structuredClone(result),
          confirmationCredentialHash: null, executionLockedAt: null,
        },
      },
      { returnDocument: 'after', runValidators: true },
    ).lean().exec();
    if (updated === null) throw new Error('MCP 确认完成状态冲突');
    this.metrics.recordMcpConfirmation('execute', updated.riskLevel, 'success');
  }

  async release(operationId: string): Promise<void> {
    const updated = await this.records.findOneAndUpdate(
      { operationId, status: 'executing' },
      { $set: { status: 'ready', executionLockedAt: null } },
      { returnDocument: 'after', runValidators: true },
    ).lean().exec();
    if (updated !== null) {
      this.metrics.recordMcpConfirmation('execute', updated.riskLevel, 'failure');
    }
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

function assertCommandRisk(operation: McpOperation, riskLevel: 'R1' | 'R2'): void {
  const expected = [
    'approval.decide', 'recruitment.requisition.submit', 'recruitment.offer.request_send',
    'analytics.management_dashboard.export',
  ].includes(operation) ? 'R2' : 'R1';
  if (riskLevel !== expected) throw new Error('MCP 操作风险分级错误');
}

function canonicalCommand(command: McpCommand): string {
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
    case 'recruitment.requisition.submit':
      return JSON.stringify({
        expectedVersion: command.expectedVersion,
        operation: command.operation,
        requisitionId: command.requisitionId,
      });
    case 'recruitment.position.transition':
      return JSON.stringify({
        expectedVersion: command.expectedVersion,
        operation: command.operation,
        positionId: command.positionId,
        targetStatus: command.targetStatus,
      });
    case 'recruitment.offer.request_send':
      return JSON.stringify({
        expectedVersion: command.expectedVersion,
        offerId: command.offerId,
        operation: command.operation,
      });
    case 'attendance.correction.request':
      return JSON.stringify({
        absentMinutes: command.absentMinutes,
        expectedVersion: command.expectedVersion,
        leaveMinutes: command.leaveMinutes,
        operation: command.operation,
        overtimeMinutes: command.overtimeMinutes,
        reasonCode: command.reasonCode,
        sourceFactId: command.sourceFactId,
        workedMinutes: command.workedMinutes,
      });
    case 'analytics.management_dashboard.export':
      return JSON.stringify({
        asOf: command.asOf,
        expectedVersion: command.expectedVersion,
        format: command.format,
        operation: command.operation,
      });
  }
}

function parseCommand(value: string): McpCommand {
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== 'object' || parsed === null) throw new Error('MCP 确认命令损坏');
  const command = parsed as Partial<McpCommand> & Readonly<Record<string, unknown>>;
  if (!Number.isSafeInteger(command.expectedVersion) || Number(command.expectedVersion) < 1) {
    throw new Error('MCP 确认命令非法');
  }
  if (command.operation === 'approval.submit' || command.operation === 'approval.withdraw') {
    if (!OPERATION_ID_PATTERN.test(String(command.instanceId ?? ''))) {
      throw new Error('MCP 确认命令非法');
    }
    return {
      operation: command.operation,
      instanceId: String(command.instanceId),
      expectedVersion: Number(command.expectedVersion),
    };
  }
  if (
    command.operation === 'approval.decide' &&
    OPERATION_ID_PATTERN.test(String(command.instanceId ?? '')) &&
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
  if (
    command.operation === 'recruitment.requisition.submit' &&
    OPERATION_ID_PATTERN.test(String(command.requisitionId ?? ''))
  ) return {
    operation: command.operation,
    requisitionId: String(command.requisitionId),
    expectedVersion: Number(command.expectedVersion),
  };
  if (
    command.operation === 'recruitment.position.transition' &&
    OPERATION_ID_PATTERN.test(String(command.positionId ?? '')) &&
    ['open', 'paused', 'closed'].includes(String(command.targetStatus))
  ) return {
    operation: command.operation,
    positionId: String(command.positionId),
    expectedVersion: Number(command.expectedVersion),
    targetStatus: command.targetStatus as 'open' | 'paused' | 'closed',
  };
  if (
    command.operation === 'recruitment.offer.request_send' &&
    OPERATION_ID_PATTERN.test(String(command.offerId ?? ''))
  ) return {
    operation: command.operation,
    offerId: String(command.offerId),
    expectedVersion: Number(command.expectedVersion),
  };
  if (
    command.operation === 'attendance.correction.request' &&
    Number(command.expectedVersion) === 1 &&
    OPERATION_ID_PATTERN.test(String(command.sourceFactId ?? '')) &&
    typeof command.reasonCode === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(command.reasonCode) &&
    validMinutes(command.workedMinutes) && validMinutes(command.leaveMinutes) &&
    validMinutes(command.overtimeMinutes) && validMinutes(command.absentMinutes)
  ) return {
    operation: command.operation,
    sourceFactId: String(command.sourceFactId),
    expectedVersion: 1,
    workedMinutes: Number(command.workedMinutes),
    leaveMinutes: Number(command.leaveMinutes),
    overtimeMinutes: Number(command.overtimeMinutes),
    absentMinutes: Number(command.absentMinutes),
    reasonCode: command.reasonCode,
  };
  if (
    command.operation === 'analytics.management_dashboard.export' &&
    Number(command.expectedVersion) === 1 &&
    typeof command.asOf === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(command.asOf) &&
    command.format === 'json'
  ) return {
    operation: command.operation,
    asOf: command.asOf,
    format: command.format,
    expectedVersion: 1,
  };
  throw new Error('MCP 确认命令类型非法');
}

function safeImpact(command: McpCommand): Readonly<Record<string, unknown>> {
  return Object.freeze({ ...command });
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64url');
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000;
}

function validMinutes(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 44_640;
}
