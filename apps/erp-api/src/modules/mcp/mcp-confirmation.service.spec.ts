import { createHash } from 'node:crypto';

import { ConfigService } from '@nestjs/config';
import {
  ConflictException,
  ForbiddenException,
  GoneException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
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

  it('拒绝非法幂等键，并透传非重复键数据库故障', async () => {
    const create = vi.fn();
    await expect(service({ create }).prepare(
      identity,
      '短',
      { operation: 'approval.submit', instanceId: INSTANCE_ID, expectedVersion: 1 },
      'R1',
    )).rejects.toThrow('MCP 准备幂等键非法');
    expect(create).not.toHaveBeenCalled();

    const databaseFailure = new Error('数据库不可用');
    create.mockRejectedValueOnce(databaseFailure);
    await expect(service({ create }).prepare(
      identity,
      'prepare-key-002',
      { operation: 'approval.submit', instanceId: INSTANCE_ID, expectedVersion: 1 },
      'R1',
    )).rejects.toBe(databaseFailure);
  });

  it('重复幂等键仅在命令摘要相同时返回首次准备结果', async () => {
    let stored: Record<string, unknown> | undefined;
    const captureCreate = vi.fn().mockImplementation((record: Record<string, unknown>) => {
      stored = record;
      return Promise.resolve();
    });
    const first = await service({ create: captureCreate }).prepare(
      identity,
      'prepare-key-003',
      { operation: 'approval.submit', instanceId: INSTANCE_ID, expectedVersion: 1 },
      'R1',
    );
    expect(stored).toBeDefined();

    const duplicate = Object.assign(new Error('重复键'), { code: 11000 });
    const replay = await service({
      create: vi.fn().mockRejectedValue(duplicate),
      findOne: vi.fn().mockReturnValue(query(stored)),
    }).prepare(
      identity,
      'prepare-key-003',
      { operation: 'approval.submit', instanceId: INSTANCE_ID, expectedVersion: 1 },
      'R1',
    );
    expect(replay).toEqual(first);

    await expect(service({
      create: vi.fn().mockRejectedValue(duplicate),
      findOne: vi.fn().mockReturnValue(query({ ...stored, digest: 'b'.repeat(43) })),
    }).prepare(
      identity,
      'prepare-key-003',
      { operation: 'approval.submit', instanceId: INSTANCE_ID, expectedVersion: 1 },
      'R1',
    )).rejects.toBeInstanceOf(ConflictException);

    await expect(service({
      create: vi.fn().mockRejectedValue(duplicate),
      findOne: vi.fn().mockReturnValue(query(null)),
    }).prepare(
      identity,
      'prepare-key-003',
      { operation: 'approval.submit', instanceId: INSTANCE_ID, expectedVersion: 1 },
      'R1',
    )).rejects.toBeInstanceOf(ConflictException);
  });

  it.each([
    {
      prepareKey: 'approval-decide-001',
      riskLevel: 'R2' as const,
      command: {
        operation: 'approval.decide' as const,
        instanceId: INSTANCE_ID,
        expectedVersion: 2,
        principalApproverId: 'approver-001',
        outcome: 'approved' as const,
      },
    },
    {
      prepareKey: 'requisition-submit-001',
      riskLevel: 'R2' as const,
      command: {
        operation: 'recruitment.requisition.submit' as const,
        requisitionId: INSTANCE_ID,
        expectedVersion: 1,
      },
    },
    {
      prepareKey: 'position-transition-001',
      riskLevel: 'R1' as const,
      command: {
        operation: 'recruitment.position.transition' as const,
        positionId: INSTANCE_ID,
        expectedVersion: 3,
        targetStatus: 'paused' as const,
      },
    },
    {
      prepareKey: 'approval-withdraw-001',
      riskLevel: 'R1' as const,
      command: {
        operation: 'approval.withdraw' as const,
        instanceId: INSTANCE_ID,
        expectedVersion: 4,
      },
    },
    {
      prepareKey: 'offer-display-001',
      riskLevel: 'R2' as const,
      command: {
        operation: 'recruitment.offer.request_send' as const,
        offerId: INSTANCE_ID,
        expectedVersion: 2,
      },
    },
    {
      prepareKey: 'attendance-display-001',
      riskLevel: 'R1' as const,
      command: {
        operation: 'attendance.correction.request' as const,
        sourceFactId: INSTANCE_ID,
        expectedVersion: 1 as const,
        workedMinutes: 480,
        leaveMinutes: 0,
        overtimeMinutes: 30,
        absentMinutes: 0,
        reasonCode: 'MISSED_PUNCH',
      },
    },
    {
      prepareKey: 'analytics-display-001',
      riskLevel: 'R2' as const,
      command: {
        operation: 'analytics.management_dashboard.export' as const,
        asOf: '2026-07-27',
        format: 'json' as const,
        expectedVersion: 1 as const,
      },
    },
  ])('规范化并可安全展示 $command.operation 命令', async ({ prepareKey, riskLevel, command }) => {
    let stored: Record<string, unknown> | undefined;
    const create = vi.fn().mockImplementation((record: Record<string, unknown>) => {
      stored = record;
      return Promise.resolve();
    });
    await service({ create }).prepare(identity, prepareKey, command, riskLevel);
    const findOne = vi.fn().mockReturnValue(query(stored));
    const result = await service({ findOne }).describe(OPERATION_ID, browserIdentity);
    expect(result).toMatchObject({
      operation: command.operation,
      riskLevel,
      impact: command,
    });
  });

  it('浏览器读取拒绝非法标识、缺失记录与损坏命令', async () => {
    await expect(service({ findOne: vi.fn() }).describe('invalid', browserIdentity))
      .rejects.toBeInstanceOf(NotFoundException);

    await expect(service({
      findOne: vi.fn().mockReturnValue(query(null)),
    }).describe(OPERATION_ID, browserIdentity)).rejects.toBeInstanceOf(NotFoundException);

    await expect(service({
      findOne: vi.fn().mockReturnValue(query({ ...pending(), commandJson: 'null' })),
    }).describe(OPERATION_ID, browserIdentity)).rejects.toThrow('MCP 确认命令损坏');

    await expect(service({
      findOne: vi.fn().mockReturnValue(query({
        ...pending(),
        commandJson: JSON.stringify({
          operation: 'approval.submit',
          instanceId: INSTANCE_ID,
          expectedVersion: 0,
        }),
      })),
    }).describe(OPERATION_ID, browserIdentity)).rejects.toThrow('MCP 确认命令非法');
  });

  it.each([
    { operation: 'approval.submit', instanceId: 'invalid', expectedVersion: 1 },
    {
      operation: 'approval.decide',
      instanceId: INSTANCE_ID,
      expectedVersion: 1,
      principalApproverId: '非法 空格',
      outcome: 'approved',
    },
    { operation: 'recruitment.requisition.submit', requisitionId: 'invalid', expectedVersion: 1 },
    {
      operation: 'recruitment.position.transition',
      positionId: INSTANCE_ID,
      expectedVersion: 1,
      targetStatus: 'deleted',
    },
    { operation: 'recruitment.offer.request_send', offerId: 'invalid', expectedVersion: 1 },
    {
      operation: 'attendance.correction.request',
      sourceFactId: INSTANCE_ID,
      expectedVersion: 1,
      workedMinutes: 44_641,
      leaveMinutes: 0,
      overtimeMinutes: 0,
      absentMinutes: 0,
      reasonCode: 'MISSED_PUNCH',
    },
    {
      operation: 'analytics.management_dashboard.export',
      asOf: '2026-07-27',
      format: 'csv',
      expectedVersion: 1,
    },
    { operation: 'unknown.operation', expectedVersion: 1 },
  ])('拒绝无法恢复为受控命令的持久化载荷 %#', async (command) => {
    await expect(service({
      findOne: vi.fn().mockReturnValue(query({
        ...pending(),
        commandJson: JSON.stringify(command),
      })),
    }).describe(OPERATION_ID, browserIdentity)).rejects.toThrow('MCP 确认命令');
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

  it('分析导出固定为 R2 且命令只包含口径日与固定格式', async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    await service({ create }).prepare(identity, 'analytics-export-001', {
      operation: 'analytics.management_dashboard.export',
      asOf: '2026-07-22', format: 'json', expectedVersion: 1,
    }, 'R2');
    const stored = create.mock.calls[0]?.[0] as unknown as {
      readonly operation: string; readonly commandJson: string;
    };
    expect(stored.operation).toBe('analytics.management_dashboard.export');
    expect(JSON.parse(stored.commandJson)).toEqual({
      asOf: '2026-07-22', expectedVersion: 1, format: 'json',
      operation: 'analytics.management_dashboard.export',
    });
    await expect(service({ create: vi.fn() }).prepare(identity, 'analytics-export-002', {
      operation: 'analytics.management_dashboard.export',
      asOf: '2026-07-22', format: 'json', expectedVersion: 1,
    }, 'R1')).rejects.toThrow('MCP 操作风险分级错误');
  });

  it('考勤修订 R1 命令规范化固化受控分钟与原因码，并可完整认领', async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    await service({ create }).prepare(identity, 'attendance-prepare-001', {
      operation: 'attendance.correction.request', sourceFactId: INSTANCE_ID,
      expectedVersion: 1, workedMinutes: 420, leaveMinutes: 60,
      overtimeMinutes: 0, absentMinutes: 0, reasonCode: 'MISSED_BREAK',
    }, 'R1');
    const stored = create.mock.calls[0]?.[0] as unknown as {
      readonly operation: string; readonly commandJson: string; readonly digest: string;
    };
    expect(stored.operation).toBe('attendance.correction.request');
    expect(JSON.parse(stored.commandJson)).toEqual({
      absentMinutes: 0, expectedVersion: 1, leaveMinutes: 60,
      operation: 'attendance.correction.request', overtimeMinutes: 0,
      reasonCode: 'MISSED_BREAK', sourceFactId: INSTANCE_ID, workedMinutes: 420,
    });
    const credential = `mcpc_${'d'.repeat(43)}`;
    const current = {
      ...pending(), operation: 'attendance.correction.request', status: 'ready',
      commandJson: stored.commandJson, digest: stored.digest,
      confirmationCredentialHash: createHash('sha256').update(credential).digest('base64url'),
    };
    const findOne = vi.fn().mockReturnValue(query(current));
    const findOneAndUpdate = vi.fn().mockReturnValue(query({
      ...current, status: 'executing', executionLockedAt: new Date(),
    }));
    const result = await service({ findOne, findOneAndUpdate }).claim(
      identity, 'attendance.correction.request', OPERATION_ID, credential,
    );
    expect(result.command).toMatchObject({
      operation: 'attendance.correction.request', sourceFactId: INSTANCE_ID,
      workedMinutes: 420, reasonCode: 'MISSED_BREAK',
    });
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

  it('浏览器确认拒绝过期、已决状态与并发状态变化', async () => {
    await expect(service({
      findOne: vi.fn().mockReturnValue(query({
        ...pending(),
        expiresAt: new Date(Date.now() - 1),
      })),
    }).confirm(OPERATION_ID, browserIdentity)).rejects.toBeInstanceOf(GoneException);

    await expect(service({
      findOne: vi.fn().mockReturnValue(query({ ...pending(), status: 'ready' })),
    }).confirm(OPERATION_ID, browserIdentity)).rejects.toBeInstanceOf(ConflictException);

    await expect(service({
      findOne: vi.fn().mockReturnValue(query(pending())),
      findOneAndUpdate: vi.fn().mockReturnValue(query(null)),
    }).confirm(OPERATION_ID, browserIdentity)).rejects.toMatchObject({
      response: { code: 'MCP_CONFIRMATION_RACE' },
    });
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

  it('R2 拒绝非待确认状态，并识别确认更新竞争', async () => {
    const evidence = {
      evidenceId: '01J8ZQK7V0A2M4N6P8R0T2W4Y8',
      credentialId: 'credential_1234567890',
      tenantId: 'tenant-001',
      actorId: 'actor-001',
      sessionId: 'session-001',
      operationId: OPERATION_ID,
      method: 'webauthn_uv' as const,
      verifiedAt: new Date().toISOString(),
    };
    await expect(service({
      findOne: vi.fn().mockReturnValue(query(pending('R1'))),
    }).confirmR2(OPERATION_ID, browserIdentity, evidence))
      .rejects.toBeInstanceOf(ConflictException);

    await expect(service({
      findOne: vi.fn().mockReturnValue(query(pending('R2'))),
      findOneAndUpdate: vi.fn().mockReturnValue(query(null)),
    }).confirmR2(OPERATION_ID, browserIdentity, evidence)).rejects.toMatchObject({
      response: { code: 'MCP_CONFIRMATION_RACE' },
    });
  });

  it('执行认领拒绝非法输入、记录越权和并发执行', async () => {
    const credential = `mcpc_${'e'.repeat(43)}`;
    await expect(service({ findOne: vi.fn() }).claim(
      identity, 'approval.submit', 'invalid', credential,
    )).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service({ findOne: vi.fn() }).claim(
      identity, 'approval.submit', OPERATION_ID, 'invalid',
    )).rejects.toBeInstanceOf(ForbiddenException);

    await expect(service({
      findOne: vi.fn().mockReturnValue(query(null)),
    }).claim(identity, 'approval.submit', OPERATION_ID, credential))
      .rejects.toBeInstanceOf(NotFoundException);

    await expect(service({
      findOne: vi.fn().mockReturnValue(query({
        ...pending(),
        status: 'ready',
        confirmationCredentialHash: 'wrong',
      })),
    }).claim(identity, 'approval.submit', OPERATION_ID, credential))
      .rejects.toBeInstanceOf(ForbiddenException);

    const commandJson = JSON.stringify({
      expectedVersion: 1,
      instanceId: INSTANCE_ID,
      operation: 'approval.submit',
    });
    const current = {
      ...pending(),
      status: 'ready',
      commandJson,
      digest: createHash('sha256').update(commandJson).digest('base64url'),
      confirmationCredentialHash: createHash('sha256').update(credential).digest('base64url'),
    };
    await expect(service({
      findOne: vi.fn().mockReturnValue(query(current)),
      findOneAndUpdate: vi.fn().mockReturnValue(query(null)),
    }).claim(identity, 'approval.submit', OPERATION_ID, credential))
      .rejects.toMatchObject({ response: { code: 'MCP_OPERATION_IN_PROGRESS' } });
  });

  it('执行认领检测持久化命令摘要篡改', async () => {
    const credential = `mcpc_${'f'.repeat(43)}`;
    const current = {
      ...pending(),
      status: 'ready',
      confirmationCredentialHash: createHash('sha256').update(credential).digest('base64url'),
    };
    await expect(service({
      findOne: vi.fn().mockReturnValue(query(current)),
      findOneAndUpdate: vi.fn().mockReturnValue(query({
        ...current,
        status: 'executing',
        digest: 'tampered',
      })),
    }).claim(identity, 'approval.submit', OPERATION_ID, credential))
      .rejects.toMatchObject({ response: { code: 'MCP_OPERATION_DIGEST_MISMATCH' } });
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

  it('完成和释放执行租约均处理成功与竞争分支', async () => {
    const metrics = { recordMcpConfirmation: vi.fn() };
    const createService = (findOneAndUpdate: ReturnType<typeof vi.fn>) => new McpConfirmationService(
      { findOneAndUpdate } as unknown as Model<McpConfirmationDocument>,
      new ConfigService<AppEnvironment, true>({ WEB_ORIGIN: 'https://erp.example.com' } as AppEnvironment),
      metrics as unknown as MetricsService,
    );

    await createService(vi.fn().mockReturnValue(query({
      ...pending(),
      riskLevel: 'R1',
      status: 'executed',
    }))).complete(OPERATION_ID, { ok: true });
    expect(metrics.recordMcpConfirmation).toHaveBeenCalledWith('execute', 'R1', 'success');

    await expect(createService(
      vi.fn().mockReturnValue(query(null)),
    ).complete(OPERATION_ID, { ok: true })).rejects.toThrow('MCP 确认完成状态冲突');

    await createService(vi.fn().mockReturnValue(query({
      ...pending('R2'),
      status: 'ready',
    }))).release(OPERATION_ID);
    expect(metrics.recordMcpConfirmation).toHaveBeenCalledWith('execute', 'R2', 'failure');

    await expect(createService(
      vi.fn().mockReturnValue(query(null)),
    ).release(OPERATION_ID)).resolves.toBeUndefined();
  });
});
