import { Logger, RequestMethod } from '@nestjs/common';
import {
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants.js';
import type { Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../../core/audit/audit.service.js';
import { REQUIRED_SCOPES_KEY } from '../identity/auth.decorators.js';
import type { AttendanceApplicationService } from './application/attendance-application.service.js';
import type { AttendanceShiftApplicationService } from './application/attendance-shift-application.service.js';
import { AttendanceController } from './attendance.controller.js';

const KEY = 'attendance-key-001';
const fact = {
  id: 'fact-001',
  employeeId: 'employee-001',
  providerCode: 'dingtalk',
  factType: 'punch_in',
  businessDate: '2026-07-28',
};
const correction = {
  id: 'correction-001',
  employeeId: 'employee-001',
  sourceFactId: 'fact-001',
  businessDate: '2026-07-28',
  approvalInstanceId: 'approval-001',
};
const correctionRequest = {
  approvalInstanceId: 'approval-001',
  employeeId: 'employee-001',
  sourceFactId: 'fact-001',
  businessDate: '2026-07-28',
  approvalStatus: 'submitted',
};
const month = {
  id: 'month-001',
  employeeId: 'employee-001',
  month: '2026-07',
  snapshotVersion: 2,
  snapshotHash: 'snapshot-hash',
};
const shiftPlan = {
  id: 'shift-plan-001',
  employeeId: 'employee-001',
  businessDate: '2026-07-28',
  planCode: 'CN-SH-DAY',
  rulesetVersion: 'cn-sh-2026-v1',
};
const evaluation = {
  shiftPlanId: 'shift-plan-001',
  sourceFactId: 'fact-001',
  businessDate: '2026-07-28',
};

function fixture() {
  const attendance = {
    ingest: vi.fn().mockResolvedValue({ fact }),
    registerCorrection: vi.fn().mockResolvedValue({ correction }),
    requestCorrection: vi.fn().mockResolvedValue({ request: correctionRequest }),
    closeMonth: vi.fn().mockResolvedValue({ month }),
    getMyMonth: vi.fn().mockResolvedValue(month),
  };
  const shifts = {
    assign: vi.fn().mockResolvedValue({ shiftPlan }),
    evaluate: vi.fn().mockResolvedValue({ evaluation }),
  };
  const record = vi.fn().mockResolvedValue(undefined);
  const setHeader = vi.fn();
  const response = { setHeader } as unknown as Response;
  const controller = new AttendanceController(
    attendance as unknown as AttendanceApplicationService,
    shifts as unknown as AttendanceShiftApplicationService,
    { record } as unknown as AuditService,
  );
  return { controller, attendance, shifts, record, response, setHeader };
}

const routeCases = [
  ['assignShiftPlan', 'shift-plans', RequestMethod.POST, ['erp:attendance:shift_plan:write']],
  ['evaluateShift', 'shift-plans/:shiftPlanId/evaluate', RequestMethod.POST, ['erp:attendance:shift:evaluate']],
  ['ingest', 'source-facts', RequestMethod.POST, ['erp:attendance:source:ingest']],
  ['registerCorrection', 'corrections', RequestMethod.POST, ['erp:attendance:correction:attest', 'erp:attendance:approval:sync']],
  ['requestCorrection', 'correction-requests', RequestMethod.POST, ['erp:attendance:correction:request', 'erp:approval:instance:submit']],
  ['closeMonth', 'months/close', RequestMethod.POST, ['erp:attendance:month:close']],
  ['getMyMonth', 'months/:month/me', RequestMethod.GET, ['erp:attendance:month:read_self']],
] as const;

describe('AttendanceController', () => {
  it('固定全部考勤路由、HTTP 方法与最小 Scope', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AttendanceController)).toBe('attendance');
    for (const [name, path, method, scopes] of routeCases) {
      const handler = Object.getOwnPropertyDescriptor(
        AttendanceController.prototype,
        name,
      )?.value as object;
      expect(Reflect.getMetadata(PATH_METADATA, handler), name).toBe(path);
      expect(Reflect.getMetadata(METHOD_METADATA, handler), name).toBe(method);
      expect(Reflect.getMetadata(REQUIRED_SCOPES_KEY, handler), name).toEqual(scopes);
    }
  });

  it('委托事实、修订申请、修订登记和月结写入口并设置强 ETag', async () => {
    const store = fixture();
    const factBody = {
      externalEventId: 'external-001',
      sensitivePayload: 'raw-sensitive-payload',
    };
    const requestBody = {
      sourceFactId: 'fact-001',
      replacementMinutes: 480,
      reasonCode: 'MISSED_PUNCH',
    };
    const correctionBody = {
      approvalInstanceId: 'approval-001',
      replacementMinutes: 480,
      reasonCode: 'MISSED_PUNCH',
    };
    const closeBody = { employeeId: 'employee-001', month: '2026-07' };

    await expect(store.controller.ingest(KEY, factBody as never))
      .resolves.toEqual({ fact });
    await expect(store.controller.requestCorrection(KEY, requestBody as never))
      .resolves.toEqual({ request: correctionRequest });
    await expect(store.controller.registerCorrection(KEY, correctionBody as never))
      .resolves.toEqual({ correction });
    await expect(store.controller.closeMonth(KEY, closeBody as never, store.response))
      .resolves.toEqual({ month });

    expect(store.attendance.ingest).toHaveBeenCalledWith(KEY, factBody);
    expect(store.attendance.requestCorrection).toHaveBeenCalledWith(KEY, requestBody);
    expect(store.attendance.registerCorrection).toHaveBeenCalledWith(KEY, correctionBody);
    expect(store.attendance.closeMonth).toHaveBeenCalledWith(KEY, closeBody);
    expect(store.setHeader).toHaveBeenCalledWith('ETag', '"2"');
    expect(JSON.stringify(store.record.mock.calls)).not.toContain('raw-sensitive-payload');
    expect(JSON.stringify(store.record.mock.calls)).not.toContain('MISSED_PUNCH');
    expect(JSON.stringify(store.record.mock.calls)).not.toContain('replacementMinutes');
  });

  it('委托排班分配与确定性班次求值并只审计控制字段', async () => {
    const store = fixture();
    const body = {
      employeeId: 'employee-001',
      providerCode: 'dingtalk',
      planCode: 'CN-SH-DAY',
    };

    await expect(store.controller.assignShiftPlan(KEY, body as never))
      .resolves.toEqual({ shiftPlan });
    await expect(store.controller.evaluateShift(KEY, 'shift-plan-001'))
      .resolves.toEqual({ evaluation });

    expect(store.shifts.assign).toHaveBeenCalledWith(KEY, body);
    expect(store.shifts.evaluate).toHaveBeenCalledWith(KEY, 'shift-plan-001');
    expect(store.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'attendance.shift_plan.assign',
      resourceId: 'shift-plan-001',
      metadata: {
        employeeId: 'employee-001',
        businessDate: '2026-07-28',
        planCode: 'CN-SH-DAY',
        rulesetVersion: 'cn-sh-2026-v1',
      },
    }));
    expect(store.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'attendance.shift.evaluate',
      resourceId: 'shift-plan-001',
      metadata: {
        sourceFactId: 'fact-001',
        businessDate: '2026-07-28',
      },
    }));
  });

  it('只以规范月份读取本人月结、设置 ETag 并执行失败关闭审计', async () => {
    const store = fixture();

    await expect(store.controller.getMyMonth('2026-07', store.response)).resolves.toBe(month);

    expect(store.attendance.getMyMonth).toHaveBeenCalledWith('2026-07');
    expect(store.setHeader).toHaveBeenCalledWith('ETag', '"2"');
    expect(store.record).toHaveBeenCalledWith({
      action: 'attendance.month.read_self',
      resourceType: 'attendance_monthly_snapshot',
      resourceId: 'month-001',
      riskLevel: 'R0',
      outcome: 'success',
      metadata: {
        employeeId: 'employee-001',
        month: '2026-07',
        snapshotVersion: 2,
        snapshotHash: 'snapshot-hash',
      },
    });
  });

  it.each([undefined, ''])('写入口拒绝缺失幂等键 %s', async (key) => {
    const store = fixture();

    await expect(store.controller.ingest(key, {} as never))
      .rejects.toMatchObject({ response: { code: 'IDEMPOTENCY_KEY_REQUIRED' } });

    expect(store.attendance.ingest).not.toHaveBeenCalled();
    expect(store.record).not.toHaveBeenCalled();
  });

  it.each(['', '2026-7', '2026-00', '2026-13', '2026-07-01'])(
    '拒绝非规范月份 %s',
    async (value) => {
      const store = fixture();

      await expect(store.controller.getMyMonth(value, store.response))
        .rejects.toMatchObject({ response: { code: 'ATTENDANCE_MONTH_INVALID' } });

      expect(store.attendance.getMyMonth).not.toHaveBeenCalled();
      expect(store.record).not.toHaveBeenCalled();
    },
  );

  it('考勤写事务提交后的审计故障不反向暴露失败并只记录稳定告警', async () => {
    const store = fixture();
    store.record.mockRejectedValue(new Error('audit unavailable'));
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    await store.controller.ingest(KEY, {} as never);
    await store.controller.assignShiftPlan(KEY, {} as never);
    await store.controller.evaluateShift(KEY, 'shift-plan-001');
    await store.controller.requestCorrection(KEY, {} as never);
    await store.controller.registerCorrection(KEY, {} as never);
    await store.controller.closeMonth(KEY, {} as never, store.response);

    expect(error).toHaveBeenCalledTimes(6);
    expect(error).toHaveBeenCalledWith({
      code: 'ATTENDANCE_AUDIT_AFTER_COMMIT_FAILED',
      action: 'attendance.source_fact.ingest',
      resourceType: 'attendance_source_fact',
      resourceId: 'fact-001',
      riskLevel: 'R1',
    });
    expect(error).toHaveBeenCalledWith({
      code: 'ATTENDANCE_AUDIT_AFTER_COMMIT_FAILED',
      action: 'attendance.month.close',
      resourceType: 'attendance_monthly_snapshot',
      resourceId: 'month-001',
      riskLevel: 'R2',
    });
    expect(JSON.stringify(error.mock.calls)).not.toContain('audit unavailable');
    error.mockRestore();
  });

  it('本人月结敏感读取审计失败时仍失败关闭', async () => {
    const store = fixture();
    const auditFailure = new Error('audit unavailable');
    store.record.mockRejectedValue(auditFailure);

    await expect(store.controller.getMyMonth('2026-07', store.response))
      .rejects.toBe(auditFailure);
  });
});
