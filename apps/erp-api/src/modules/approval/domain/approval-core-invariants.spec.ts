import { describe, expect, it } from 'vitest';

import {
  buildApprovalDelegationEvent,
  buildApprovalInstanceMigratedEvent,
  buildApprovalTemplateEvent,
} from './approval-events.js';
import type { ApprovalInstance } from './instance.js';
import type { ApprovalTemplate } from './template.js';
import {
  assertApprovalCode,
  assertApprovalId,
  assertFieldKey,
  assertLabel,
  assertPositiveVersion,
  assertSameTenant,
  assertUnique,
  toApprovalIso,
} from './approval.validation.js';

describe('审批领域公共不变量', () => {
  it('拒绝所有公共标识、版本、租户、唯一性和时间旁路', () => {
    const failures: Array<() => unknown> = [
      () => assertApprovalId('<invalid>', 'id'),
      () => assertApprovalCode('', 'code'),
      () => assertFieldKey('BadField', 'field'),
      () => assertLabel('  ', 'label'),
      () => assertLabel('x'.repeat(3), 'label', 2),
      () => assertPositiveVersion(0),
      () => assertPositiveVersion(1.5),
      () => assertSameTenant('tenant-001', 'tenant-002'),
      () => assertUnique(['same', 'same'], 'actors'),
      () => toApprovalIso(new Date('invalid')),
    ];
    for (const invoke of failures) expect(invoke).toThrow();
    expect(toApprovalIso(new Date('2026-07-22T00:00:00.000Z')))
      .toBe('2026-07-22T00:00:00.000Z');
  });

  it('事件构造器拒绝缺失撤销人、发布人和非法迁移终态', () => {
    const common = {
      id: 'entity-001', tenantId: 'tenant-001', version: 1,
      createdAt: '2026-07-22T00:00:00.000Z', updatedAt: '2026-07-22T00:00:00.000Z',
    };
    expect(() => buildApprovalDelegationEvent({
      ...common, principalApproverId: 'manager-001', delegateId: 'manager-002',
      validFrom: common.createdAt, validUntil: '2026-07-23T00:00:00.000Z',
      status: 'revoked', createdBy: 'manager-001', revokedBy: null,
    }, 'revoked')).toThrow(/缺少撤销主体/u);
    expect(() => buildApprovalTemplateEvent({
      ...common, code: 'EXPENSE', revision: 1, riskLevel: 'R1',
      definitionHash: 'a'.repeat(43), approvedBy: null,
    } as ApprovalTemplate, 'published')).toThrow(/缺少审批人/u);
    expect(() => buildApprovalInstanceMigratedEvent({
      ...common, status: 'approved',
    } as ApprovalInstance, 1, 'a'.repeat(43))).toThrow(/只允许草稿或运行中/u);
  });
});
