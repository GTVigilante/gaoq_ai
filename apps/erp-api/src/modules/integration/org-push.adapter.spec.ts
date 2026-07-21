import { describe, expect, it } from 'vitest';

import {
  OrgPushAdapter,
  OrgPushAdapterRegistry,
  type ExternalOrgSnapshot,
  type ChangeEmployeeStatusCommand,
  type OrgPushChannel,
  type OrgPushResult,
  type ProvisionEmployeeCommand,
  type ProvisionEmployeeResult,
  type PushDepartmentCommand,
  type PushEmployeeCommand,
} from './org-push.adapter.js';

class FakeAdapter extends OrgPushAdapter {
  constructor(readonly channel: OrgPushChannel) {
    super();
  }

  pushDepartment(command: PushDepartmentCommand): Promise<OrgPushResult> {
    void command;
    return Promise.resolve({ externalId: `${this.channel}-department` });
  }

  pushEmployee(command: PushEmployeeCommand): Promise<OrgPushResult> {
    void command;
    return Promise.resolve({ externalId: `${this.channel}-employee` });
  }

  provisionEmployee(command: ProvisionEmployeeCommand): Promise<ProvisionEmployeeResult> {
    return Promise.resolve({
      externalUserId: command.externalUserId,
      unionId: `${this.channel}-union`,
    });
  }

  changeEmployeeStatus(command: ChangeEmployeeStatusCommand): Promise<OrgPushResult> {
    return Promise.resolve({ externalId: command.externalId });
  }

  fetchSnapshot(tenantId: string): Promise<ExternalOrgSnapshot> {
    void tenantId;
    return Promise.resolve({ departments: new Map(), employees: new Map() });
  }
}

describe('OrgPushAdapterRegistry', () => {
  it('钉钉、飞书与可选 OP 按正确渠道装配', () => {
    const dingtalk = new FakeAdapter('dingtalk');
    const feishu = new FakeAdapter('feishu');
    const op = new FakeAdapter('op');
    const registry = new OrgPushAdapterRegistry(dingtalk, feishu, op);

    expect(registry.get('dingtalk')).toBe(dingtalk);
    expect(registry.get('feishu')).toBe(feishu);
    expect(registry.get('op')).toBe(op);
  });

  it('渠道错配在启动期失败', () => {
    expect(() => new OrgPushAdapterRegistry(
      new FakeAdapter('feishu'),
      new FakeAdapter('dingtalk'),
    )).toThrow('渠道装配错误');
  });
});
