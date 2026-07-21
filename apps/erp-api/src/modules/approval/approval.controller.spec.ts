import { BadRequestException } from '@nestjs/common';
import type { Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../../core/audit/audit.service.js';
import { REQUIRED_SCOPES_KEY } from '../identity/auth.decorators.js';
import type { ApprovalApplicationService } from './application/approval-application.service.js';
import { ApprovalController } from './approval.controller.js';

const INSTANCE_ID = '01K00000000000000000000000';

function summary() {
  return {
    id: INSTANCE_ID,
    status: 'running' as const,
    templateCode: 'EXPENSE',
    templateRevision: 1,
    riskLevel: 'R2' as const,
    version: 2,
    submittedAt: '2026-07-21T00:00:00.000Z',
    completedAt: null,
  };
}

describe('ApprovalController', () => {
  it('提交强制 If-Match/幂等键，响应 ETag 并写最小审计', async () => {
    const submitInstance = vi.fn().mockResolvedValue({ instance: summary() });
    const record = vi.fn().mockResolvedValue(undefined);
    const controller = new ApprovalController(
      { submitInstance } as unknown as ApprovalApplicationService,
      { record } as unknown as AuditService,
    );
    const setHeader = vi.fn();
    const result = await controller.submitInstance(
      INSTANCE_ID, '"1"', 'submit-key-001', { setHeader } as unknown as Response,
    );
    expect(submitInstance).toHaveBeenCalledWith(INSTANCE_ID, 1, 'submit-key-001');
    expect(setHeader).toHaveBeenCalledWith('ETag', '"2"');
    expect(result).toEqual({ instance: summary() });
    expect(record).toHaveBeenCalledWith({
      action: 'approval.instance.submit',
      resourceType: 'approval_instance',
      resourceId: INSTANCE_ID,
      riskLevel: 'R2',
      outcome: 'success',
      metadata: { version: 2 },
    });
  });

  it('缺少强版本或幂等键时在调用应用服务前拒绝', async () => {
    const submitInstance = vi.fn();
    const controller = new ApprovalController(
      { submitInstance } as unknown as ApprovalApplicationService,
      { record: vi.fn() } as unknown as AuditService,
    );
    const response = { setHeader: vi.fn() } as unknown as Response;
    await expect(controller.submitInstance(INSTANCE_ID, undefined, 'submit-key-001', response))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.submitInstance(INSTANCE_ID, '"1"', undefined, response))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(submitInstance).not.toHaveBeenCalled();
  });

  it('端点声明细粒度 OAuth scope', () => {
    const decide = Object.getOwnPropertyDescriptor(
      ApprovalController.prototype, 'decideInstance',
    )?.value as object;
    const read = Object.getOwnPropertyDescriptor(
      ApprovalController.prototype, 'getInstance',
    )?.value as object;
    expect(Reflect.getMetadata(
      REQUIRED_SCOPES_KEY,
      decide,
    )).toEqual(['erp:approval:task:decide']);
    expect(Reflect.getMetadata(
      REQUIRED_SCOPES_KEY,
      read,
    )).toEqual(['erp:approval:instance:read']);
  });
});
