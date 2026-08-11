import { describe, expect, it } from 'vitest';

import {
  buildDingTalkProvisioningInput,
  canProvisionDingTalk,
  canReadDingTalkBindings,
  parseDingTalkBindings,
  parseProvisioningResult,
} from './contacts-contract';

const EMPLOYEE_ID = '01K00000000000000000000000';

describe('通讯录钉钉契约', () => {
  it('按精确 Scope 决定绑定状态和开户入口', () => {
    expect(canReadDingTalkBindings(['erp:integration:org_provisioning:read'])).toBe(true);
    expect(canReadDingTalkBindings(['org_provisioning:read'])).toBe(false);
    expect(canProvisionDingTalk(['erp:integration:org_provisioning:write'])).toBe(true);
    expect(canProvisionDingTalk([])).toBe(false);
  });

  it('严格解析去重后的绑定员工标识', () => {
    expect(parseDingTalkBindings({ channel: 'dingtalk', boundEmployeeIds: [EMPLOYEE_ID] }))
      .toEqual({ channel: 'dingtalk', boundEmployeeIds: [EMPLOYEE_ID] });
    expect(() => parseDingTalkBindings({
      channel: 'dingtalk', boundEmployeeIds: [EMPLOYEE_ID, EMPLOYEE_ID],
    })).toThrow('DINGTALK_BINDINGS_INVALID');
    expect(() => parseDingTalkBindings({
      channel: 'dingtalk', boundEmployeeIds: [], tenantId: 'tenant-001',
    })).toThrow('DINGTALK_BINDINGS_INVALID');
  });

  it('构造钉钉私密开户请求并规范邮箱', () => {
    expect(buildDingTalkProvisioningInput(EMPLOYEE_ID, {
      countryCode: '+86', subscriberNumber: '13800138000', email: ' Person@Example.com ',
    })).toEqual({
      employeeId: EMPLOYEE_ID,
      channel: 'dingtalk',
      contact: {
        mobile: { countryCode: '+86', subscriberNumber: '13800138000' },
        email: 'person@example.com',
      },
    });
    expect(() => buildDingTalkProvisioningInput(EMPLOYEE_ID, {
      countryCode: '+86', subscriberNumber: '000',
    })).toThrow('DINGTALK_PROVISIONING_INPUT_INVALID');
  });

  it('开户响应禁止携带联系方式或外部身份', () => {
    const result = {
      requestId: '01K00000000000000000000001',
      status: 'pending',
      sensitiveExpiresAt: '2026-08-10T12:00:00.000Z',
    };
    expect(parseProvisioningResult(result)).toEqual(result);
    expect(() => parseProvisioningResult({ ...result, mobile: '13800138000' }))
      .toThrow('DINGTALK_PROVISIONING_RESULT_INVALID');
  });
});
