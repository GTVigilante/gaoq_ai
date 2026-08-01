import { Logger, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../../core/audit/audit.service.js';
import { REQUIRED_SCOPES_KEY } from '../identity/auth.decorators.js';
import { AttendanceProviderCoverageController } from './attendance-provider-coverage.controller.js';
import type { AttendanceProviderCoverageService } from './attendance-provider-coverage.service.js';

const result = {
  stateId: '01J8ZQK7V0A2M4N6P8R0T2W4S1',
  providerCode: 'dingtalk' as const,
  month: '2026-04',
  throughBusinessDate: '2026-04-30',
  sourceCutoffAt: '2026-05-01T00:00:00.000Z',
  attestedCount: 2,
  nextAfterMappingId: null,
  complete: true,
};

function fixture() {
  const coverages = { reconcile: vi.fn().mockResolvedValue(result) };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const controller = new AttendanceProviderCoverageController(
    coverages as unknown as AttendanceProviderCoverageService,
    audit as unknown as AuditService,
  );
  return { controller, coverages, audit };
}

describe('AttendanceProviderCoverageController', () => {
  it('固定覆盖对账路由、POST 和双 Scope', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AttendanceProviderCoverageController))
      .toBe('integrations/attendance-provider-coverages');
    const handler = Object.getOwnPropertyDescriptor(
      AttendanceProviderCoverageController.prototype,
      'reconcile',
    )?.value as object;
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('reconcile');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata(REQUIRED_SCOPES_KEY, handler)).toEqual([
      'erp:attendance:provider:reconcile',
      'erp:attendance:coverage:attest',
    ]);
  });

  it('委托对账并只审计低基数脱敏摘要', async () => {
    const store = fixture();
    const body = {
      stateId: result.stateId,
      month: '2026-04',
      encryptedCursor: 'must-not-audit',
    };
    await expect(store.controller.reconcile('coverage-key-001', body as never))
      .resolves.toBe(result);
    expect(store.coverages.reconcile).toHaveBeenCalledWith('coverage-key-001', body);
    expect(store.audit.record).toHaveBeenCalledWith({
      action: 'integration.attendance_provider.coverage.reconcile',
      resourceType: 'attendance_provider_state',
      resourceId: result.stateId,
      riskLevel: 'R2',
      outcome: 'success',
      metadata: {
        providerCode: 'dingtalk',
        month: '2026-04',
        throughBusinessDate: '2026-04-30',
        attestedCount: 2,
        complete: true,
      },
    });
    expect(JSON.stringify(store.audit.record.mock.calls)).not.toContain('must-not-audit');
  });

  it.each([undefined, '', 'short', 'invalid key'])(
    '拒绝非法幂等键 %s',
    async (key) => {
      const store = fixture();
      await expect(store.controller.reconcile(key, {} as never))
        .rejects.toMatchObject({ response: { code: 'IDEMPOTENCY_KEY_REQUIRED' } });
      expect(store.coverages.reconcile).not.toHaveBeenCalled();
    },
  );

  it('覆盖证明已提交后的审计异常只记录稳定告警', async () => {
    const store = fixture();
    store.audit.record.mockRejectedValue(new Error('audit raw failure'));
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await expect(store.controller.reconcile('coverage-key-001', {} as never))
      .resolves.toBe(result);
    expect(error).toHaveBeenCalledWith({
      code: 'ATTENDANCE_PROVIDER_COVERAGE_AUDIT_AFTER_COMMIT_FAILED',
      stateId: result.stateId,
      month: result.month,
    });
    expect(JSON.stringify(error.mock.calls)).not.toContain('audit raw failure');
    error.mockRestore();
  });
});
