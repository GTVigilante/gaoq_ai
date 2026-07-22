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
  it('模板目录使用发起 Scope 并记录最小 R0 审计', async () => {
    const templates = [{ id: INSTANCE_ID, code: 'EXPENSE', fields: [] }];
    const listPublishedTemplateForms = vi.fn().mockResolvedValue(templates);
    const record = vi.fn().mockResolvedValue(undefined);
    const controller = new ApprovalController(
      { listPublishedTemplateForms } as unknown as ApprovalApplicationService,
      { record } as unknown as AuditService,
    );
    await expect(controller.listPublishedTemplates()).resolves.toEqual(templates);
    expect(record).toHaveBeenCalledWith({
      action: 'approval.template.catalog.read', resourceType: 'approval_template_catalog',
      resourceId: 'published', riskLevel: 'R0', outcome: 'success', metadata: { count: 1 },
    });
    const method = Object.getOwnPropertyDescriptor(
      ApprovalController.prototype, 'listPublishedTemplates',
    )?.value as object;
    expect(Reflect.getMetadata(REQUIRED_SCOPES_KEY, method)).toEqual(['erp:approval:instance:submit']);
  });

  it('读取时间线使用严格 ULID、细粒度 Scope 和最小审计', async () => {
    const timeline = [{ actionId: INSTANCE_ID, actionType: 'instance.submitted' }];
    const getTimeline = vi.fn().mockResolvedValue(timeline);
    const record = vi.fn().mockResolvedValue(undefined);
    const controller = new ApprovalController(
      { getTimeline } as unknown as ApprovalApplicationService,
      { record } as unknown as AuditService,
    );
    await expect(controller.getTimeline(INSTANCE_ID)).resolves.toEqual(timeline);
    expect(getTimeline).toHaveBeenCalledWith(INSTANCE_ID);
    expect(record).toHaveBeenCalledWith({
      action: 'approval.instance.timeline.read', resourceType: 'approval_instance',
      resourceId: INSTANCE_ID, riskLevel: 'R0', outcome: 'success', metadata: { count: 1 },
    });
    await expect(controller.getTimeline('invalid')).rejects.toBeInstanceOf(BadRequestException);
    const method = Object.getOwnPropertyDescriptor(ApprovalController.prototype, 'getTimeline')?.value as object;
    expect(Reflect.getMetadata(REQUIRED_SCOPES_KEY, method)).toEqual(['erp:approval:instance:read']);
  });

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

  it('普通决策端点只调用 R1 交互式应用服务边界', async () => {
    const decideInteractiveInstance = vi.fn().mockResolvedValue({ instance: summary() });
    const record = vi.fn().mockResolvedValue(undefined);
    const controller = new ApprovalController(
      { decideInteractiveInstance } as unknown as ApprovalApplicationService,
      { record } as unknown as AuditService,
    );
    await controller.decideInstance(
      INSTANCE_ID,
      '"2"',
      'decision-key-001',
      { principalApproverId: 'manager-001', outcome: 'approved' },
      { setHeader: vi.fn() } as unknown as Response,
    );
    expect(decideInteractiveInstance).toHaveBeenCalledWith(
      INSTANCE_ID, 2, 'manager-001', 'approved', 'decision-key-001',
    );
  });
});
