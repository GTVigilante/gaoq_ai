import { Mongoose } from 'mongoose';
import { describe, expect, it } from 'vitest';

import {
  McpConfirmationRecordSchema,
  type McpConfirmationRecord,
} from './mcp-confirmation.schema.js';

const mongoose = new Mongoose();
const ConfirmationModel = mongoose.model<McpConfirmationRecord>(
  'SpecMcpConfirmation',
  McpConfirmationRecordSchema,
);

function record(): Record<string, unknown> {
  return {
    operationId: '01J8ZQK7V0A2M4N6P8R0T2W4Y6',
    tenantId: 'tenant-001',
    actorId: 'actor-001',
    clientId: 'client-001',
    operation: 'approval.submit',
    riskLevel: 'R1',
    prepareKey: 'prepare-key-001',
    commandJson: '{"expectedVersion":1,"instanceId":"01J8ZQK7V0A2M4N6P8R0T2W4Y7","operation":"approval.submit"}',
    digest: 'a'.repeat(43),
    status: 'pending_confirmation',
    confirmationCredentialHash: null,
    confirmedAt: null,
    executionLockedAt: null,
    executionResult: null,
    expiresAt: new Date('2026-07-21T00:10:00.000Z'),
  };
}

describe('McpConfirmationRecordSchema', () => {
  it('确认记录不包含表单、明文确认凭据或访问令牌字段', async () => {
    await new ConfirmationModel(record()).validate();
    expect(McpConfirmationRecordSchema.path('formData')).toBeUndefined();
    expect(McpConfirmationRecordSchema.path('confirmationCredential')).toBeUndefined();
    expect(McpConfirmationRecordSchema.path('accessToken')).toBeUndefined();
  });

  it('ready/executing/executed 状态强制各自安全不变量', async () => {
    await expect(new ConfirmationModel({ ...record(), status: 'ready' }).validate())
      .rejects.toThrow('待执行确认必须包含凭据摘要');
    await new ConfirmationModel({
      ...record(), status: 'ready', confirmationCredentialHash: 'b'.repeat(43),
    }).validate();
    await expect(new ConfirmationModel({
      ...record(), status: 'executing', confirmationCredentialHash: 'b'.repeat(43),
    }).validate()).rejects.toThrow('执行中确认必须包含凭据摘要和租约');
    await expect(new ConfirmationModel({ ...record(), status: 'executed' }).validate())
      .rejects.toThrow('已执行确认必须包含结果快照');
  });

  it('准备幂等唯一键包含可信租户、主体、客户端和操作', () => {
    const index = McpConfirmationRecordSchema.indexes().find(([spec]) =>
      spec.tenantId === 1 && spec.actorId === 1 && spec.clientId === 1 &&
      spec.operation === 1 && spec.prepareKey === 1,
    );
    expect(index?.[1]?.unique).toBe(true);
  });
});
