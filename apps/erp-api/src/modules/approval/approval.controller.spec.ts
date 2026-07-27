import { Logger } from '@nestjs/common';
import type { Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../../core/audit/audit.service.js';
import { REQUIRED_SCOPES_KEY } from '../identity/auth.decorators.js';
import type { ApprovalApplicationService } from './application/approval-application.service.js';
import { ApprovalController } from './approval.controller.js';

const ID = '01K00000000000000000000000';
const VERSION = 2;

const template = Object.freeze({
  id: ID,
  code: 'EXPENSE',
  name: '费用审批',
  revision: 1,
  status: 'draft',
  riskLevel: 'R2',
  version: VERSION,
});
const instance = Object.freeze({
  id: ID,
  status: 'running',
  templateCode: 'EXPENSE',
  templateRevision: 1,
  riskLevel: 'R2',
  version: VERSION,
  submittedAt: '2026-07-21T00:00:00.000Z',
  completedAt: null,
});
const delegation = Object.freeze({
  id: ID,
  principalApproverId: 'manager-001',
  delegateId: 'manager-002',
  validFrom: '2026-07-22T00:00:00.000Z',
  validUntil: '2026-08-01T00:00:00.000Z',
  status: 'active',
  version: VERSION,
});
const publishedForms = Object.freeze([{ id: ID, code: 'EXPENSE', fields: [] }]);
const timeline = Object.freeze([{ actionId: ID, actionType: 'instance.submitted' }]);

function fixture() {
  const approvals = {
    listPublishedTemplateForms: vi.fn().mockResolvedValue(publishedForms),
    listMyDelegations: vi.fn().mockResolvedValue([delegation]),
    createDelegation: vi.fn().mockResolvedValue({ delegation }),
    revokeDelegation: vi.fn().mockResolvedValue({
      delegation: { ...delegation, status: 'revoked', version: 3 },
    }),
    createTemplate: vi.fn().mockResolvedValue({ template }),
    publishTemplate: vi.fn().mockResolvedValue({
      template: { ...template, status: 'published', version: 3 },
    }),
    createInstance: vi.fn().mockResolvedValue({ instance }),
    getInbox: vi.fn().mockResolvedValue([instance]),
    getInstance: vi.fn().mockResolvedValue(instance),
    getTimeline: vi.fn().mockResolvedValue(timeline),
    submitInstance: vi.fn().mockResolvedValue({ instance }),
    decideInteractiveInstance: vi.fn().mockResolvedValue({ instance }),
    transferTask: vi.fn().mockResolvedValue({ instance }),
    addSigner: vi.fn().mockResolvedValue({ instance }),
    withdrawInstance: vi.fn().mockResolvedValue({ instance }),
    archiveInstance: vi.fn().mockResolvedValue({ instance }),
  };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const setHeader = vi.fn();
  const response = { setHeader } as unknown as Response;
  const controller = new ApprovalController(
    approvals as unknown as ApprovalApplicationService,
    audit as unknown as AuditService,
  );
  return { controller, approvals, audit, response, setHeader };
}

describe('ApprovalController', () => {
  it.each([
    ['listPublishedTemplates', 'erp:approval:instance:submit'],
    ['listMyDelegations', 'erp:approval:delegation:read'],
    ['createDelegation', 'erp:approval:delegation:write'],
    ['revokeDelegation', 'erp:approval:delegation:write'],
    ['createTemplate', 'erp:approval:template:write'],
    ['publishTemplate', 'erp:approval:template:publish'],
    ['createInstance', 'erp:approval:instance:submit'],
    ['getInbox', 'erp:approval:instance:read'],
    ['getInstance', 'erp:approval:instance:read'],
    ['getTimeline', 'erp:approval:instance:read'],
    ['submitInstance', 'erp:approval:instance:submit'],
    ['decideInstance', 'erp:approval:task:decide'],
    ['transferTask', 'erp:approval:task:transfer'],
    ['addSigner', 'erp:approval:task:add_signer'],
    ['withdrawInstance', 'erp:approval:instance:submit'],
    ['archiveInstance', 'erp:approval:instance:archive'],
  ] as const)('%s 声明精确 Scope', (name, scope) => {
    expect(Reflect.getMetadata(REQUIRED_SCOPES_KEY, method(name))).toEqual([scope]);
  });

  it('模板目录与委托列表记录最小 R0 读取审计', async () => {
    const store = fixture();

    await expect(store.controller.listPublishedTemplates()).resolves.toBe(publishedForms);
    await expect(store.controller.listMyDelegations()).resolves.toEqual([delegation]);

    expect(store.audit.record).toHaveBeenNthCalledWith(1, {
      action: 'approval.template.catalog.read',
      resourceType: 'approval_template_catalog',
      resourceId: 'published',
      riskLevel: 'R0',
      outcome: 'success',
      metadata: { count: 1 },
    });
    expect(store.audit.record).toHaveBeenNthCalledWith(2, {
      action: 'approval.delegation.list',
      resourceType: 'approval_delegation',
      resourceId: 'mine',
      riskLevel: 'R0',
      outcome: 'success',
      metadata: { count: 1 },
    });
  });

  it('审批收件箱和详情只返回应用服务投影，详情携带强 ETag', async () => {
    const store = fixture();

    await expect(store.controller.getInbox()).resolves.toEqual([instance]);
    await expect(store.controller.getInstance(ID, store.response)).resolves.toBe(instance);

    expect(store.approvals.getInbox).toHaveBeenCalledTimes(1);
    expect(store.approvals.getInstance).toHaveBeenCalledWith(ID);
    expect(store.setHeader).toHaveBeenCalledWith('ETag', `"${VERSION}"`);
    expect(store.audit.record).not.toHaveBeenCalled();
  });

  it('时间线使用严格 ULID 并记录最小 R0 读取审计', async () => {
    const store = fixture();

    await expect(store.controller.getTimeline(ID)).resolves.toBe(timeline);

    expect(store.approvals.getTimeline).toHaveBeenCalledWith(ID);
    expect(store.audit.record).toHaveBeenCalledWith({
      action: 'approval.instance.timeline.read',
      resourceType: 'approval_instance',
      resourceId: ID,
      riskLevel: 'R0',
      outcome: 'success',
      metadata: { count: 1 },
    });
  });

  it('创建和撤销委托使用强版本、ETag 与状态审计', async () => {
    const store = fixture();
    const body = {
      delegateId: 'manager-002',
      validFrom: delegation.validFrom,
      validUntil: delegation.validUntil,
    };

    await expect(store.controller.createDelegation(
      'delegation-create-001',
      body,
      store.response,
    )).resolves.toEqual({ delegation });
    await expect(store.controller.revokeDelegation(
      ID,
      '"2"',
      'delegation-revoke-001',
      store.response,
    )).resolves.toMatchObject({ delegation: { status: 'revoked', version: 3 } });

    expect(store.approvals.createDelegation).toHaveBeenCalledWith(
      'delegation-create-001',
      body,
    );
    expect(store.approvals.revokeDelegation).toHaveBeenCalledWith(
      ID,
      2,
      'delegation-revoke-001',
    );
    expect(store.audit.record).toHaveBeenNthCalledWith(1, {
      action: 'approval.delegation.create',
      resourceType: 'approval_delegation',
      resourceId: ID,
      riskLevel: 'R1',
      outcome: 'success',
      metadata: { version: VERSION, status: 'active' },
    });
    expect(store.audit.record).toHaveBeenNthCalledWith(2, {
      action: 'approval.delegation.revoke',
      resourceType: 'approval_delegation',
      resourceId: ID,
      riskLevel: 'R1',
      outcome: 'success',
      metadata: { version: 3, status: 'revoked' },
    });
  });

  it('创建和发布模板固化模板风险等级与版本', async () => {
    const store = fixture();
    const body = { code: 'EXPENSE', name: '费用审批' };

    await expect(store.controller.createTemplate(
      'template-create-001',
      body as never,
      store.response,
    )).resolves.toEqual({ template });
    await expect(store.controller.publishTemplate(
      ID,
      '"2"',
      'template-publish-001',
      store.response,
    )).resolves.toMatchObject({ template: { status: 'published', version: 3 } });

    expect(store.approvals.createTemplate).toHaveBeenCalledWith(
      'template-create-001',
      body,
    );
    expect(store.approvals.publishTemplate).toHaveBeenCalledWith(
      ID,
      2,
      'template-publish-001',
    );
    expectCommittedAudit(store, 1, 'approval.template.create', 'approval_template', VERSION);
    expectCommittedAudit(store, 2, 'approval.template.publish', 'approval_template', 3);
  });

  it('创建审批实例写入 ETag 与实例风险审计', async () => {
    const store = fixture();
    const body = { templateId: ID, fields: {} };

    await expect(store.controller.createInstance(
      'instance-create-001',
      body as never,
      store.response,
    )).resolves.toEqual({ instance });

    expect(store.approvals.createInstance).toHaveBeenCalledWith(
      'instance-create-001',
      body,
    );
    expect(store.setHeader).toHaveBeenCalledWith('ETag', `"${VERSION}"`);
    expectCommittedAudit(store, 1, 'approval.instance.create', 'approval_instance', VERSION);
  });

  it.each([
    {
      name: '提交',
      action: 'approval.instance.submit',
      service: 'submitInstance',
      invoke: (store: ReturnType<typeof fixture>) => store.controller.submitInstance(
        ID,
        '"1"',
        'instance-submit-001',
        store.response,
      ),
      args: [ID, 1, 'instance-submit-001'],
    },
    {
      name: '决策',
      action: 'approval.instance.decide',
      service: 'decideInteractiveInstance',
      invoke: (store: ReturnType<typeof fixture>) => store.controller.decideInstance(
        ID,
        '"1"',
        'instance-decide-001',
        { principalApproverId: 'manager-001', outcome: 'approved' },
        store.response,
      ),
      args: [ID, 1, 'manager-001', 'approved', 'instance-decide-001'],
    },
    {
      name: '转交',
      action: 'approval.instance.transfer',
      service: 'transferTask',
      invoke: (store: ReturnType<typeof fixture>) => store.controller.transferTask(
        ID,
        '"1"',
        'instance-transfer-001',
        { fromApproverId: 'manager-001', toApproverId: 'manager-002' },
        store.response,
      ),
      args: [ID, 1, 'manager-001', 'manager-002', 'instance-transfer-001'],
    },
    {
      name: '加签',
      action: 'approval.instance.add_signer',
      service: 'addSigner',
      invoke: (store: ReturnType<typeof fixture>) => store.controller.addSigner(
        ID,
        '"1"',
        'instance-add-signer-001',
        { approverId: 'manager-002' },
        store.response,
      ),
      args: [ID, 1, 'manager-002', 'instance-add-signer-001'],
    },
    {
      name: '撤回',
      action: 'approval.instance.withdraw',
      service: 'withdrawInstance',
      invoke: (store: ReturnType<typeof fixture>) => store.controller.withdrawInstance(
        ID,
        '"1"',
        'instance-withdraw-001',
        store.response,
      ),
      args: [ID, 1, 'instance-withdraw-001'],
    },
    {
      name: '归档',
      action: 'approval.instance.archive',
      service: 'archiveInstance',
      invoke: (store: ReturnType<typeof fixture>) => store.controller.archiveInstance(
        ID,
        '"1"',
        'instance-archive-001',
        store.response,
      ),
      args: [ID, 1, 'instance-archive-001'],
    },
  ] as const)('$name操作统一执行强版本、ETag 与风险审计', async ({
    action,
    service,
    invoke,
    args,
  }) => {
    const store = fixture();

    await expect(invoke(store)).resolves.toEqual({ instance });

    expect(store.approvals[service]).toHaveBeenCalledWith(...args);
    expect(store.setHeader).toHaveBeenCalledWith('ETag', `"${VERSION}"`);
    expectCommittedAudit(store, 1, action, 'approval_instance', VERSION);
  });

  it.each([
    [undefined],
    [''],
  ] as const)('写接口拒绝缺失幂等键：%s', async (key) => {
    const store = fixture();

    await expect(store.controller.createInstance(
      key,
      { templateId: ID, fields: {} } as never,
      store.response,
    )).rejects.toMatchObject({ response: { code: 'IDEMPOTENCY_KEY_REQUIRED' } });

    expect(store.approvals.createInstance).not.toHaveBeenCalled();
  });

  it.each([
    [undefined],
    [''],
    ['1'],
    ['W/"1"'],
    ['"0"'],
    ['"9007199254740992"'],
  ] as const)('写接口拒绝非法 If-Match：%s', async (ifMatch) => {
    const store = fixture();

    await expect(store.controller.submitInstance(
      ID,
      ifMatch,
      'instance-version-invalid',
      store.response,
    )).rejects.toMatchObject({ response: { code: 'APPROVAL_IF_MATCH_REQUIRED' } });

    expect(store.approvals.submitInstance).not.toHaveBeenCalled();
  });

  it('资源读取和写入均拒绝非 ULID 标识', async () => {
    const store = fixture();

    await expect(store.controller.getInstance('instance-001', store.response))
      .rejects.toMatchObject({ response: { code: 'APPROVAL_INVALID_ID' } });
    await expect(store.controller.getTimeline('instance-001'))
      .rejects.toMatchObject({ response: { code: 'APPROVAL_INVALID_ID' } });
    await expect(store.controller.publishTemplate(
      'template-001',
      '"1"',
      'template-id-invalid',
      store.response,
    )).rejects.toMatchObject({ response: { code: 'APPROVAL_INVALID_ID' } });

    expect(store.approvals.getInstance).not.toHaveBeenCalled();
    expect(store.approvals.getTimeline).not.toHaveBeenCalled();
    expect(store.approvals.publishTemplate).not.toHaveBeenCalled();
  });

  it('业务提交后的审计故障只告警，不把成功终态暴露为失败', async () => {
    const store = fixture();
    store.audit.record.mockRejectedValue(new Error('audit unavailable'));
    const logger = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    await expect(store.controller.decideInstance(
      ID,
      '"1"',
      'instance-decide-audit-failed',
      { principalApproverId: 'manager-001', outcome: 'approved' },
      store.response,
    )).resolves.toEqual({ instance });

    expect(store.approvals.decideInteractiveInstance).toHaveBeenCalledTimes(1);
    expect(logger).toHaveBeenCalledWith({
      code: 'APPROVAL_AUDIT_AFTER_COMMIT_FAILED',
      action: 'approval.instance.decide',
      resourceType: 'approval_instance',
      resourceId: ID,
      riskLevel: 'R2',
    });
  });

  it('委托提交后的审计故障同样不覆盖已成功业务终态', async () => {
    const store = fixture();
    store.audit.record.mockRejectedValue(new Error('audit unavailable'));
    const logger = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    await expect(store.controller.createDelegation(
      'delegation-audit-failed',
      {
        delegateId: 'manager-002',
        validFrom: delegation.validFrom,
        validUntil: delegation.validUntil,
      },
      store.response,
    )).resolves.toEqual({ delegation });

    expect(logger).toHaveBeenCalledWith({
      code: 'APPROVAL_AUDIT_AFTER_COMMIT_FAILED',
      action: 'approval.delegation.create',
      resourceType: 'approval_delegation',
      resourceId: ID,
      riskLevel: 'R1',
    });
  });

  it('R0 读取审计不可用时仍失败关闭', async () => {
    const store = fixture();
    const failure = new Error('audit unavailable');
    store.audit.record.mockRejectedValue(failure);

    await expect(store.controller.listPublishedTemplates()).rejects.toBe(failure);
    expect(store.approvals.listPublishedTemplateForms).toHaveBeenCalledTimes(1);
  });

  it('审批业务失败时保留原始异常且不得伪造成功审计', async () => {
    const store = fixture();
    const failure = new Error('approval storage unavailable');
    store.approvals.archiveInstance.mockRejectedValue(failure);

    await expect(store.controller.archiveInstance(
      ID,
      '"1"',
      'instance-archive-failed',
      store.response,
    )).rejects.toBe(failure);

    expect(store.audit.record).not.toHaveBeenCalled();
    expect(store.setHeader).not.toHaveBeenCalled();
  });
});

function expectCommittedAudit(
  store: ReturnType<typeof fixture>,
  order: number,
  action: string,
  resourceType: string,
  version: number,
): void {
  expect(store.audit.record).toHaveBeenNthCalledWith(order, {
    action,
    resourceType,
    resourceId: ID,
    riskLevel: 'R2',
    outcome: 'success',
    metadata: { version },
  });
}

function method(
  name:
  | 'listPublishedTemplates'
  | 'listMyDelegations'
  | 'createDelegation'
  | 'revokeDelegation'
  | 'createTemplate'
  | 'publishTemplate'
  | 'createInstance'
  | 'getInbox'
  | 'getInstance'
  | 'getTimeline'
  | 'submitInstance'
  | 'decideInstance'
  | 'transferTask'
  | 'addSigner'
  | 'withdrawInstance'
  | 'archiveInstance',
): object {
  return Object.getOwnPropertyDescriptor(ApprovalController.prototype, name)?.value as object;
}
