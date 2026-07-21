import { createHash } from 'node:crypto';

import { ConfigService } from '@nestjs/config';
import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import type { Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { AppEnvironment } from '../../config/environment.js';
import type { BrowserOAuthIdentity } from '../identity/token-grant.service.js';
import type { McpIdentity } from './mcp-auth-context.js';
import type { McpConfirmationDocument } from './mcp-confirmation.schema.js';
import { McpConfirmationService } from './mcp-confirmation.service.js';
import type { MetricsService } from '../../core/observability/metrics.service.js';

const OPERATION_ID = '01J8ZQK7V0A2M4N6P8R0T2W4Y6';
const INSTANCE_ID = '01J8ZQK7V0A2M4N6P8R0T2W4Y7';
const EXPIRES = new Date(Date.now() + 10 * 60 * 1_000);

const identity: McpIdentity = {
  tenantId: 'tenant-001', actorId: 'actor-001', actorType: 'user',
  roleCodes: [], scopes: [], departmentIds: [], traceId: 'trace-001', clientId: 'client-001',
};
const browserIdentity: BrowserOAuthIdentity = {
  refreshToken: 'redacted', tenantId: 'tenant-001', actorId: 'actor-001',
  sessionId: 'session-001', roleCodes: [], scopes: [], departmentIds: [],
};

function query<T>(value: T) {
  return { lean: () => ({ exec: () => Promise.resolve(value) }) };
}

function service(model: Record<string, unknown>): McpConfirmationService {
  return new McpConfirmationService(
    model as unknown as Model<McpConfirmationDocument>,
    new ConfigService<AppEnvironment, true>({ WEB_ORIGIN: 'https://erp.example.com' } as AppEnvironment),
    { recordMcpConfirmation: vi.fn() } as unknown as MetricsService,
  );
}

function pending(riskLevel: 'R1' | 'R2' = 'R1') {
  return {
    operationId: OPERATION_ID,
    tenantId: 'tenant-001',
    actorId: 'actor-001',
    clientId: 'client-001',
    operation: riskLevel === 'R2' ? 'approval.decide' as const : 'approval.submit' as const,
    riskLevel,
    prepareKey: 'prepare-key-001',
    commandJson: riskLevel === 'R2'
      ? JSON.stringify({
          expectedVersion: 2, instanceId: INSTANCE_ID, operation: 'approval.decide',
          outcome: 'approved', principalApproverId: 'approver-001',
        })
      : JSON.stringify({ expectedVersion: 1, instanceId: INSTANCE_ID, operation: 'approval.submit' }),
    digest: 'a'.repeat(43),
    status: 'pending_confirmation' as const,
    confirmationCredentialHash: null,
    strongAuthMethod: null,
    strongAuthEvidenceId: null,
    executionResult: null,
    executionLockedAt: null,
    expiresAt: EXPIRES,
  };
}

describe('McpConfirmationService', () => {
  it('准备操作只返回摘要与确认 URL，命令不进入响应', async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    const result = await service({ create }).prepare(
      identity,
      'prepare-key-001',
      { operation: 'approval.submit', instanceId: INSTANCE_ID, expectedVersion: 1 },
      'R1',
    );
    expect(result).toMatchObject({ riskLevel: 'R1' });
    expect(result.confirmationUrl).toContain('/mcp/confirm?operation_id=');
    expect(result).not.toHaveProperty('command');
    expect(JSON.stringify(result)).not.toContain(INSTANCE_ID);
    expect(create).toHaveBeenCalledOnce();
  });

  it('招聘 R2 确认只持久化无敏感正文的 Offer 标识与版本', async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    const result = await service({ create }).prepare(
      identity,
      'offer-prepare-001',
      {
        operation: 'recruitment.offer.request_send',
        offerId: INSTANCE_ID,
        expectedVersion: 3,
      },
      'R2',
    );
    expect(result).toMatchObject({ riskLevel: 'R2' });
    const stored = create.mock.calls[0]?.[0] as unknown as {
      readonly operation: string;
      readonly commandJson: string;
    };
    expect(stored.operation).toBe('recruitment.offer.request_send');
    expect(JSON.parse(stored.commandJson)).toEqual({
      expectedVersion: 3,
      offerId: INSTANCE_ID,
      operation: 'recruitment.offer.request_send',
    });
    expect(stored.commandJson).not.toMatch(/terms|salary|benefit|candidate/iu);
  });

  it('R1 浏览器确认只持久化凭据摘要，明文仅返回一次', async () => {
    const findOne = vi.fn().mockReturnValue(query(pending()));
    const findOneAndUpdate = vi.fn().mockImplementation(
      (_filter: unknown, update: { $set: { confirmationCredentialHash: string } }) =>
        query({ ...pending(), ...update.$set, status: 'ready', expiresAt: EXPIRES }),
    );
    const result = await service({ findOne, findOneAndUpdate }).confirm(OPERATION_ID, browserIdentity);
    expect(result.confirmationCredential).toMatch(/^mcpc_[A-Za-z0-9_-]{43}$/);
    const update = findOneAndUpdate.mock.calls[0]?.[1] as unknown as {
      $set: { confirmationCredentialHash: string };
    };
    expect(update.$set.confirmationCredentialHash).toHaveLength(43);
    expect(update.$set.confirmationCredentialHash).not.toContain(result.confirmationCredential);
  });

  it('R2 在没有强认证签发器时失败关闭且不生成凭据', async () => {
    const findOne = vi.fn().mockReturnValue(query(pending('R2')));
    const findOneAndUpdate = vi.fn();
    await expect(service({ findOne, findOneAndUpdate }).confirm(OPERATION_ID, browserIdentity))
      .rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('R2 仅接受新鲜 WebAuthn UV 证据并绑定证据标识', async () => {
    const findOne = vi.fn().mockReturnValue(query(pending('R2')));
    const findOneAndUpdate = vi.fn().mockImplementation(
      (_filter: unknown, update: { $set: Record<string, unknown> }) =>
        query({ ...pending('R2'), ...update.$set, status: 'ready', expiresAt: EXPIRES }),
    );
    const result = await service({ findOne, findOneAndUpdate }).confirmR2(
      OPERATION_ID,
      browserIdentity,
      {
        evidenceId: '01J8ZQK7V0A2M4N6P8R0T2W4Y8',
        credentialId: 'credential_1234567890',
        tenantId: 'tenant-001',
        actorId: 'actor-001',
        sessionId: 'session-001',
        operationId: OPERATION_ID,
        method: 'webauthn_uv',
        verifiedAt: new Date().toISOString(),
      },
    );
    const update = findOneAndUpdate.mock.calls[0]?.[1] as unknown as { $set: Record<string, unknown> };
    expect(result.confirmationCredential).toMatch(/^mcpc_[A-Za-z0-9_-]{43}$/);
    expect(update.$set).toMatchObject({
      strongAuthMethod: 'webauthn_uv',
      strongAuthEvidenceId: '01J8ZQK7V0A2M4N6P8R0T2W4Y8',
    });
    expect(update.$set.confirmationCredentialHash).not.toBe(result.confirmationCredential);
  });

  it('R2 拒绝超过一分钟的强认证证据', async () => {
    const findOne = vi.fn().mockReturnValue(query(pending('R2')));
    const findOneAndUpdate = vi.fn();
    await expect(service({ findOne, findOneAndUpdate }).confirmR2(
      OPERATION_ID,
      browserIdentity,
      {
        evidenceId: '01J8ZQK7V0A2M4N6P8R0T2W4Y8',
        credentialId: 'credential_1234567890',
        tenantId: 'tenant-001',
        actorId: 'actor-001',
        sessionId: 'session-001',
        operationId: OPERATION_ID,
        method: 'webauthn_uv',
        verifiedAt: new Date(Date.now() - 60_001).toISOString(),
      },
    )).rejects.toBeInstanceOf(ForbiddenException);
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('R2 拒绝属于其他操作的强认证证据', async () => {
    const findOne = vi.fn().mockReturnValue(query(pending('R2')));
    const findOneAndUpdate = vi.fn();
    await expect(service({ findOne, findOneAndUpdate }).confirmR2(
      OPERATION_ID,
      browserIdentity,
      {
        evidenceId: '01J8ZQK7V0A2M4N6P8R0T2W4Y8',
        credentialId: 'credential_1234567890',
        tenantId: 'tenant-001',
        actorId: 'actor-001',
        sessionId: 'session-001',
        operationId: '01J8ZQK7V0A2M4N6P8R0T2W4Y9',
        method: 'webauthn_uv',
        verifiedAt: new Date().toISOString(),
      },
    )).rejects.toBeInstanceOf(ForbiddenException);
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('执行认领校验命令摘要并持有崩溃恢复租约', async () => {
    const credential = `mcpc_${'b'.repeat(43)}`;
    const commandJson = JSON.stringify({
      expectedVersion: 1, instanceId: INSTANCE_ID, operation: 'approval.submit',
    });
    const current = {
      ...pending(),
      status: 'ready',
      commandJson,
      digest: createHash('sha256').update(commandJson).digest('base64url'),
      confirmationCredentialHash: createHash('sha256').update(credential).digest('base64url'),
    };
    const findOne = vi.fn().mockReturnValue(query(current));
    const findOneAndUpdate = vi.fn().mockReturnValue(query({
      ...current, status: 'executing', executionLockedAt: new Date(),
    }));
    const result = await service({ findOne, findOneAndUpdate }).claim(
      identity, 'approval.submit', OPERATION_ID, credential,
    );
    expect(result).toEqual({
      operationId: OPERATION_ID,
      command: { operation: 'approval.submit', instanceId: INSTANCE_ID, expectedVersion: 1 },
      replayResult: null,
    });
    const filter = findOneAndUpdate.mock.calls[0]?.[0] as unknown as {
      tenantId: string; actorId: string; clientId: string; $or: readonly unknown[];
    };
    expect(filter).toMatchObject({
      tenantId: 'tenant-001', actorId: 'actor-001', clientId: 'client-001',
    });
    expect(filter.$or).toHaveLength(2);
  });

  it('已执行操作重复调用返回同一结果且不再次认领', async () => {
    const findOne = vi.fn().mockReturnValue(query({
      ...pending(),
      status: 'executed',
      executionResult: { instance: { id: INSTANCE_ID, status: 'running', version: 2 } },
    }));
    const findOneAndUpdate = vi.fn();
    const result = await service({ findOne, findOneAndUpdate }).claim(
      identity, 'approval.submit', OPERATION_ID, `mcpc_${'c'.repeat(43)}`,
    );
    expect(result.replayResult).toMatchObject({ instance: { status: 'running' } });
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });
});
