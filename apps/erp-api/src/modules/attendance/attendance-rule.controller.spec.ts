import { Logger, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../../core/audit/audit.service.js';
import { REQUIRED_SCOPES_KEY } from '../identity/auth.decorators.js';
import type { AttendanceRuleApplicationService } from './application/attendance-rule-application.service.js';
import { AttendanceRuleController } from './attendance-rule.controller.js';

function fixture() {
  const rules = {
    attestRule: vi.fn().mockResolvedValue({
      rule: {
        id: 'shift-rule-001',
        rulesetVersion: 'attendance-cn-v1',
        shiftCode: 'DAY_SHIFT',
        effectiveFrom: '2026-01-01',
        effectiveTo: null,
      },
    }),
    attestAssignment: vi.fn().mockResolvedValue({
      assignment: {
        id: 'assignment-001',
        employeeId: 'employee-001',
        shiftRuleId: 'shift-rule-001',
        providerCode: 'dingtalk',
        effectiveFrom: '2026-04-01',
        effectiveTo: '2026-04-30',
      },
    }),
  };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const controller = new AttendanceRuleController(
    rules as unknown as AttendanceRuleApplicationService,
    audit as unknown as AuditService,
  );
  return { controller, rules, audit };
}

describe('AttendanceRuleController', () => {
  it('固定规则与排班证明路由、方法和最小 Scope', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AttendanceRuleController)).toBe('attendance');
    const cases = [
      ['attestRule', 'shift-rules/attest', ['erp:attendance:rule:attest']],
      [
        'attestAssignment',
        'shift-assignments/attest',
        ['erp:attendance:shift_assignment:attest'],
      ],
    ] as const;
    for (const [name, path, scopes] of cases) {
      const handler = Object.getOwnPropertyDescriptor(
        AttendanceRuleController.prototype,
        name,
      )?.value as object;
      expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(path);
      expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.POST);
      expect(Reflect.getMetadata(REQUIRED_SCOPES_KEY, handler)).toEqual(scopes);
    }
  });

  it('委托服务并仅审计脱敏规则与排班摘要', async () => {
    const store = fixture();
    const ruleBody = {
      rulesetVersion: 'attendance-cn-v1',
      rawPolicy: 'sensitive-policy',
    };
    const assignmentBody = {
      employeeId: 'employee-001',
      externalEmployeeId: 'sensitive-external-id',
    };
    const ruleResult = await store.controller.attestRule('rule-key-001', ruleBody as never);
    expect(ruleResult.rule.id).toBe('shift-rule-001');
    const assignmentResult = await store.controller.attestAssignment(
      'assignment-key-001',
      assignmentBody as never,
    );
    expect(assignmentResult.assignment.id).toBe('assignment-001');
    expect(store.rules.attestRule).toHaveBeenCalledWith('rule-key-001', ruleBody);
    expect(store.rules.attestAssignment).toHaveBeenCalledWith(
      'assignment-key-001',
      assignmentBody,
    );
    expect(store.audit.record).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(store.audit.record.mock.calls)).not.toContain('sensitive-policy');
    expect(JSON.stringify(store.audit.record.mock.calls)).not.toContain('sensitive-external-id');
  });

  it.each([undefined, '', 'short', 'bad key with space'])(
    '拒绝非法幂等键 %s',
    async (key) => {
      const store = fixture();
      await expect(store.controller.attestRule(key, {} as never))
        .rejects.toMatchObject({ response: { code: 'IDEMPOTENCY_KEY_REQUIRED' } });
      expect(store.rules.attestRule).not.toHaveBeenCalled();
    },
  );

  it('提交后审计异常只记录稳定告警且不反向暴露失败', async () => {
    const store = fixture();
    store.audit.record.mockRejectedValue(new Error('audit raw failure'));
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await expect(store.controller.attestRule('rule-key-001', {} as never))
      .resolves.toBeDefined();
    await expect(store.controller.attestAssignment('assignment-key-001', {} as never))
      .resolves.toBeDefined();
    expect(error).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(error.mock.calls)).toContain('ATTENDANCE_RULE_AUDIT_AFTER_COMMIT_FAILED');
    expect(JSON.stringify(error.mock.calls)).not.toContain('audit raw failure');
    error.mockRestore();
  });
});
