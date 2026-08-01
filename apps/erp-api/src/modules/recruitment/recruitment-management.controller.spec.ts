import type { Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../../core/audit/audit.service.js';
import { REQUIRED_SCOPES_KEY } from '../identity/auth.decorators.js';
import type { RecruitmentManagementService } from './application/recruitment-management.service.js';
import { RecruitmentManagementController } from './recruitment-management.controller.js';

const REQUISITION_ID = '01J8ZQK7V0A2M4N6P8R0T2W4Y9';
const POSITION_ID = '01J8ZQK7V0A2M4N6P8R0T2W4Y8';
const requisition = {
  id: REQUISITION_ID,
  departmentId: 'department-001',
  positionTitle: '小红书经纪人',
  headcount: 2,
  status: 'draft' as const,
  approvalInstanceId: null,
  approvalHistoryId: null,
  version: 1,
};
const position = {
  id: POSITION_ID,
  requisitionId: REQUISITION_ID,
  title: '小红书经纪人',
  departmentId: 'department-001',
  jobLevelId: 'job-level-001',
  location: '上海',
  headcount: 2,
  status: 'draft' as const,
  version: 1,
  publishedAt: null,
  closedAt: null,
};
const requisitionBody = {
  departmentId: 'department-001',
  positionTitle: '小红书经纪人',
  headcount: 2,
  justification: '业务增长需要新增招聘人数',
};
const positionBody = { jobLevelId: 'job-level-001', location: '上海' };

function fixture() {
  const recruitment = {
    createRequisition: vi.fn().mockResolvedValue({ requisition }),
    getRequisition: vi.fn().mockResolvedValue(requisition),
    submitRequisition: vi.fn().mockResolvedValue({
      requisition: { ...requisition, status: 'pending_approval', version: 2 },
    }),
    syncRequisitionApproval: vi.fn().mockResolvedValue({
      requisition: { ...requisition, status: 'approved', version: 3 },
    }),
    createPosition: vi.fn().mockResolvedValue({ position }),
    getPosition: vi.fn().mockResolvedValue(position),
    transitionPosition: vi.fn().mockResolvedValue({
      position: { ...position, status: 'open', version: 2 },
    }),
  };
  const record = vi.fn().mockResolvedValue(undefined);
  const headers = new Map<string, string>();
  const response = {
    setHeader: vi.fn((name: string, value: string) => headers.set(name, value)),
  } as unknown as Response;
  const controller = new RecruitmentManagementController(
    recruitment as unknown as RecruitmentManagementService,
    { record } as unknown as AuditService,
  );
  const errorLog = vi.spyOn(
    (controller as unknown as { logger: { error: (value: unknown) => void } }).logger,
    'error',
  ).mockImplementation(() => undefined);
  return { controller, recruitment, record, headers, response, errorLog };
}

describe('RecruitmentManagementController', () => {
  it('七个端点使用独立最小 Scope', () => {
    const expected: Readonly<Record<MethodName, string>> = {
      createRequisition: 'erp:recruitment:requisition:create',
      getRequisition: 'erp:recruitment:management:read',
      submitRequisition: 'erp:recruitment:requisition:submit',
      syncApproval: 'erp:recruitment:requisition:sync_approval',
      createPosition: 'erp:recruitment:position:create',
      getPosition: 'erp:recruitment:management:read',
      transitionPosition: 'erp:recruitment:position:transition',
    };
    for (const [name, scope] of Object.entries(expected) as [MethodName, string][]) {
      expect(Reflect.getMetadata(REQUIRED_SCOPES_KEY, method(name))).toEqual([scope]);
    }
  });

  it('创建与读取 HC 返回严格摘要、强 ETag 和低敏 R1 审计', async () => {
    const store = fixture();
    const created = await store.controller.createRequisition(
      'requisition-create-key-001',
      requisitionBody,
      store.response,
    );
    expect(store.recruitment.createRequisition).toHaveBeenCalledWith(
      'requisition-create-key-001',
      requisitionBody,
    );
    expect(created).toEqual({ requisition });
    expect(store.headers.get('ETag')).toBe('"1"');
    expect(store.record).toHaveBeenCalledWith({
      action: 'recruitment.requisition.create',
      resourceType: 'recruitment_requisition',
      resourceId: REQUISITION_ID,
      riskLevel: 'R1',
      outcome: 'success',
      metadata: { version: 1, status: 'draft' },
    });

    const read = await store.controller.getRequisition(REQUISITION_ID, store.response);
    expect(read).toBe(requisition);
    expect(store.recruitment.getRequisition).toHaveBeenCalledWith(REQUISITION_ID);
    expect(store.headers.get('ETag')).toBe('"1"');
  });

  it('提交与审批同步仅接收可信版本，不接收客户端审批结果', async () => {
    const store = fixture();
    const submitted = await store.controller.submitRequisition(
      REQUISITION_ID,
      '"1"',
      'requisition-submit-key-001',
      undefined,
      store.response,
    );
    expect(store.recruitment.submitRequisition).toHaveBeenCalledWith(
      REQUISITION_ID,
      1,
      'requisition-submit-key-001',
    );
    expect(submitted.requisition.status).toBe('pending_approval');
    expect(store.headers.get('ETag')).toBe('"2"');

    const approved = await store.controller.syncApproval(
      REQUISITION_ID,
      '"2"',
      'requisition-sync-key-001',
      {},
      store.response,
    );
    expect(store.recruitment.syncRequisitionApproval).toHaveBeenCalledWith(
      REQUISITION_ID,
      2,
      'requisition-sync-key-001',
    );
    expect(approved.requisition.status).toBe('approved');
    expect(store.headers.get('ETag')).toBe('"3"');
    expect(store.record.mock.calls.map(
      ([input]) => (input as { readonly action: string }).action,
    )).toEqual([
      'recruitment.requisition.submit',
      'recruitment.requisition.sync_approval',
    ]);
  });

  it('创建、读取与迁移职位只传递有界控制字段', async () => {
    const store = fixture();
    const created = await store.controller.createPosition(
      REQUISITION_ID,
      '"3"',
      'position-create-key-001',
      positionBody,
      store.response,
    );
    expect(store.recruitment.createPosition).toHaveBeenCalledWith(
      REQUISITION_ID,
      3,
      'position-create-key-001',
      positionBody,
    );
    expect(created.position).toBe(position);
    expect(store.headers.get('ETag')).toBe('"1"');

    const read = await store.controller.getPosition(POSITION_ID, store.response);
    expect(read).toBe(position);
    expect(store.recruitment.getPosition).toHaveBeenCalledWith(POSITION_ID);

    const transitioned = await store.controller.transitionPosition(
      POSITION_ID,
      '"1"',
      'position-transition-key-001',
      { targetStatus: 'open' },
      store.response,
    );
    expect(store.recruitment.transitionPosition).toHaveBeenCalledWith(
      POSITION_ID,
      1,
      'position-transition-key-001',
      'open',
    );
    expect(transitioned.position).toMatchObject({ status: 'open', version: 2 });
    expect(store.headers.get('ETag')).toBe('"2"');
    expect(JSON.stringify(store.record.mock.calls)).not.toMatch(
      /小红书经纪人|业务增长需要新增招聘人数|上海|position-(?:create|transition)-key/u,
    );
  });

  it.each([
    ['非字符串', 1],
    ['小写', REQUISITION_ID.toLowerCase()],
    ['长度错误', REQUISITION_ID.slice(1)],
    ['非法首位', `8${REQUISITION_ID.slice(1)}`],
  ])('读取在 %s ID 时失败关闭且不调用应用服务', async (_name, id) => {
    const store = fixture();
    await expect(store.controller.getRequisition(
      id as string,
      store.response,
    )).rejects.toMatchObject({ response: { code: 'RECRUITMENT_INVALID_ID' } });
    expect(store.recruitment.getRequisition).not.toHaveBeenCalled();
  });

  it.each([
    ['缺失', undefined],
    ['弱 ETag', '3'],
    ['零', '"0"'],
    ['前导零', '"03"'],
    ['负数', '"-1"'],
    ['非字符串', 3],
    ['安全整数上限', `"${Number.MAX_SAFE_INTEGER}"`],
    ['超长数字', `"${'9'.repeat(128)}"`],
  ])('写入口拒绝%s If-Match', async (_name, ifMatch) => {
    const store = fixture();
    await expect(store.controller.transitionPosition(
      POSITION_ID,
      ifMatch as string,
      'position-transition-key-001',
      { targetStatus: 'open' },
      store.response,
    )).rejects.toMatchObject({ response: { code: 'RECRUITMENT_IF_MATCH_REQUIRED' } });
    expect(store.recruitment.transitionPosition).not.toHaveBeenCalled();
  });

  it.each([
    ['缺失', undefined],
    ['空值', ''],
    ['过短', 'short'],
    ['包含空格', 'requisition key invalid'],
    ['过长', 'a'.repeat(129)],
    ['非字符串', 7],
  ])('写入口拒绝%s Idempotency-Key', async (_name, key) => {
    const store = fixture();
    await expect(store.controller.createRequisition(
      key as string,
      requisitionBody,
      store.response,
    )).rejects.toMatchObject({ response: { code: 'IDEMPOTENCY_KEY_REQUIRED' } });
    expect(store.recruitment.createRequisition).not.toHaveBeenCalled();
  });

  it.each([
    ['额外字段', { outcome: 'approved' }],
    ['Symbol 字段', { [Symbol('outcome')]: 'approved' }],
    ['数组', []],
    ['null', null],
    ['字符串', ''],
    ['无原型对象', Object.create(null) as object],
    ['自定义原型', Object.create({ outcome: 'approved' }) as object],
    ['抛错代理', new Proxy({}, {
      getPrototypeOf: () => {
        throw new Error('proxy-failure');
      },
    })],
  ])('无正文 HC 写入口拒绝%s', async (_name, invalidBody) => {
    const store = fixture();
    await expect(store.controller.syncApproval(
      REQUISITION_ID,
      '"2"',
      'requisition-sync-key-001',
      invalidBody,
      store.response,
    )).rejects.toMatchObject({ response: { code: 'RECRUITMENT_MANAGEMENT_BODY_FORBIDDEN' } });
    expect(store.recruitment.syncRequisitionApproval).not.toHaveBeenCalled();
  });

  it.each([
    ['createRequisition', 'recruitment.requisition.create', 'organization_department',
      'department-001', undefined, 'R1'],
    ['submitRequisition', 'recruitment.requisition.submit', 'recruitment_requisition',
      REQUISITION_ID, 7, 'R2'],
    ['syncApproval', 'recruitment.requisition.sync_approval', 'recruitment_requisition',
      REQUISITION_ID, 7, 'R2'],
    ['createPosition', 'recruitment.position.create', 'recruitment_requisition',
      REQUISITION_ID, 7, 'R1'],
    ['transitionPosition', 'recruitment.position.transition', 'recruitment_position',
      POSITION_ID, 7, 'R1'],
  ] as const)('%s 业务失败保留原异常并写低敏失败审计', async (
    methodName,
    action,
    resourceType,
    resourceId,
    expectedVersion,
    riskLevel,
  ) => {
    const store = fixture();
    const failure = new Error('business-failure');
    const serviceMethod = methodName === 'syncApproval'
      ? store.recruitment.syncRequisitionApproval
      : store.recruitment[methodName];
    serviceMethod.mockRejectedValueOnce(failure);
    await expect(invokeWrite(store, methodName, 7)).rejects.toBe(failure);
    expect(store.record).toHaveBeenCalledWith({
      action,
      resourceType,
      resourceId,
      riskLevel,
      outcome: 'failure',
      metadata: expectedVersion === undefined ? {} : { expectedVersion },
    });
    expect(JSON.stringify(store.record.mock.calls)).not.toMatch(
      /business-failure|requisition-(?:create|submit|sync)-key|position-(?:create|transition)-key|业务增长/u,
    );
  });

  it('失败审计异常不覆盖原业务异常，只记录稳定低敏告警', async () => {
    const store = fixture();
    const failure = new Error('business-failure');
    store.recruitment.transitionPosition.mockRejectedValueOnce(failure);
    store.record.mockRejectedValueOnce(new Error('audit-failure'));
    await expect(invokeWrite(store, 'transitionPosition', 4)).rejects.toBe(failure);
    expect(store.errorLog).toHaveBeenCalledWith({
      code: 'RECRUITMENT_MANAGEMENT_FAILURE_AUDIT_FAILED',
      action: 'recruitment.position.transition',
      resourceId: POSITION_ID,
    });
    expect(JSON.stringify(store.errorLog.mock.calls)).not.toMatch(
      /audit-failure|business-failure|position-transition-key/u,
    );
  });

  it.each([
    ['createRequisition', 'recruitment.requisition.create', REQUISITION_ID],
    ['submitRequisition', 'recruitment.requisition.submit', REQUISITION_ID],
    ['syncApproval', 'recruitment.requisition.sync_approval', REQUISITION_ID],
    ['createPosition', 'recruitment.position.create', POSITION_ID],
    ['transitionPosition', 'recruitment.position.transition', POSITION_ID],
  ] as const)('%s 已提交后成功审计异常不改变业务成功终态', async (
    methodName,
    action,
    resourceId,
  ) => {
    const store = fixture();
    store.record.mockRejectedValueOnce(new Error('audit-failure'));
    const result = await invokeWrite(store, methodName, 3);
    expect(result).toBeDefined();
    expect(store.errorLog).toHaveBeenCalledWith({
      code: 'RECRUITMENT_MANAGEMENT_AUDIT_AFTER_COMMIT_FAILED',
      action,
      resourceId,
    });
    expect(JSON.stringify(store.errorLog.mock.calls)).not.toMatch(
      /audit-failure|requisition-(?:create|submit|sync)-key|position-(?:create|transition)-key/u,
    );
  });
});

type MethodName =
  | 'createRequisition'
  | 'getRequisition'
  | 'submitRequisition'
  | 'syncApproval'
  | 'createPosition'
  | 'getPosition'
  | 'transitionPosition';

type WriteMethodName = Exclude<MethodName, 'getRequisition' | 'getPosition'>;

function method(name: MethodName): object {
  const value: unknown = Object.getOwnPropertyDescriptor(
    RecruitmentManagementController.prototype,
    name,
  )?.value;
  if (typeof value !== 'function') throw new Error(`控制器方法 ${name} 不存在`);
  return value;
}

function invokeWrite(
  store: ReturnType<typeof fixture>,
  methodName: WriteMethodName,
  version: number,
): Promise<unknown> {
  if (methodName === 'createRequisition') {
    return store.controller.createRequisition(
      'requisition-create-key-001',
      requisitionBody,
      store.response,
    );
  }
  if (methodName === 'submitRequisition') {
    return store.controller.submitRequisition(
      REQUISITION_ID,
      `"${version}"`,
      'requisition-submit-key-001',
      {},
      store.response,
    );
  }
  if (methodName === 'syncApproval') {
    return store.controller.syncApproval(
      REQUISITION_ID,
      `"${version}"`,
      'requisition-sync-key-001',
      {},
      store.response,
    );
  }
  if (methodName === 'createPosition') {
    return store.controller.createPosition(
      REQUISITION_ID,
      `"${version}"`,
      'position-create-key-001',
      positionBody,
      store.response,
    );
  }
  return store.controller.transitionPosition(
    POSITION_ID,
    `"${version}"`,
    'position-transition-key-001',
    { targetStatus: 'open' },
    store.response,
  );
}
