import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../../core/audit/audit.service.js';
import { REQUIRED_SCOPES_KEY } from '../identity/auth.decorators.js';
import type { CareApplicationService } from './application/care-application.service.js';
import type { CareAlumniCleanupApplicationService } from './application/care-alumni-cleanup-application.service.js';
import { CareController } from './care.controller.js';

const ID = '01J8ZQK7V0A2M4N6P8R0T2W4Y6';

function fixture() {
  const service = { recordTaskEvidence: vi.fn() };
  const alumniCleanup = { getStatus: vi.fn() };
  const audit = { record: vi.fn() };
  const controller = new CareController(
    service as unknown as CareApplicationService,
    alumniCleanup as unknown as CareAlumniCleanupApplicationService,
    audit as unknown as AuditService,
  );
  return { controller, service, alumniCleanup, audit, response: { setHeader: vi.fn() } };
}

describe('CareController', () => {
  it('声明精确读写 Scope，且不暴露 R3 execute 路由', () => {
    expect(scope('create')).toEqual(['erp:care:case:create', 'erp:care:employment:read']);
    expect(scope('get')).toEqual(['erp:care:case:read', 'erp:care:employment:read']);
    expect(scope('submit')).toEqual(['erp:care:case:submit', 'erp:care:employment:read']);
    expect(scope('recordTaskEvidence')).toEqual(['erp:care:task:record']);
    expect(scope('schedule')).toEqual(['erp:care:case:schedule', 'erp:care:employment:read']);
    expect(scope('createAlumniConsent')).toEqual([
      'erp:care:alumni:consent:attest', 'erp:care:employment:read',
    ]);
    expect(scope('withdrawAlumniConsent')).toEqual(['erp:care:alumni:consent:withdraw']);
    expect(scope('getAlumniCleanupStatus')).toEqual(['erp:care:alumni:cleanup:read']);
    expect(Object.hasOwn(CareController.prototype, 'execute')).toBe(false);
  });

  it('任务证据入口拒绝未知任务和弱版本条件', async () => {
    const store = fixture();
    await expect(store.controller.recordTaskEvidence(
      ID, 'self_reported_done', '"1"', 'care-task-001', { evidenceId: ID },
      store.response as never,
    )).rejects.toBeInstanceOf(BadRequestException);
    await expect(store.controller.recordTaskEvidence(
      ID, 'assets_cleared', '1', 'care-task-001', { evidenceId: ID },
      store.response as never,
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(store.service.recordTaskEvidence).not.toHaveBeenCalled();
  });

  it('下游清理状态只返回脱敏控制面并写 R1 审计', async () => {
    const store = fixture();
    store.alumniCleanup.getStatus.mockResolvedValue({
      consentStatus: 'withdrawn',
      cleanupStatus: 'pending',
      counts: { pending: 2, dispatching: 0, completed: 0, dead: 0 },
      targets: [],
    });
    await expect(store.controller.getAlumniCleanupStatus(ID)).resolves.toMatchObject({
      cleanupStatus: 'pending',
    });
    expect(store.audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'care.alumni_cleanup.read',
      riskLevel: 'R1',
    }));
    expect(JSON.stringify(store.audit.record.mock.calls[0]?.[0])).not.toMatch(
      /personId|proofDigest/iu,
    );
  });
});

function scope(name: keyof CareController): unknown {
  const method = Object.getOwnPropertyDescriptor(CareController.prototype, name)?.value as object;
  return Reflect.getMetadata(REQUIRED_SCOPES_KEY, method) as unknown;
}
