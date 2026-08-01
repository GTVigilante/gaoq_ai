import type { ActorContext } from '@gaoq/shared-types';
import type { Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { OpApprovalBridgeDocument } from '../persistence/op.schemas.js';
import { OpApprovalBridgeService } from './op-approval-bridge.service.js';

const TENANT_ID = 'tenant-001';
const EXTERNAL_EVENT_ID = 'approval-event-001';
const INSTANCE_ID = '01K00000000000000000000001';
const UPDATED_AT = new Date('2026-07-22T08:05:00.000Z');
const COMPLETED_AT = new Date('2026-07-22T08:04:00.000Z');
const tenant = { tenantId: TENANT_ID, source: 'access_token' as const };

function actor(scopes: readonly string[] = ['erp:op:approval_bridge:read']): ActorContext {
  return {
    actorType: 'user',
    actorId: 'actor-001',
    tenantId: TENANT_ID,
    roleCodes: [],
    scopes,
    departmentIds: [],
    traceId: 'trace-001',
  };
}

function bridge(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    tenantId: TENANT_ID,
    externalEventId: EXTERNAL_EVENT_ID,
    sourceDocumentType: 'purchase_order',
    sourceDocumentId: 'po-001',
    approvalInstanceId: INSTANCE_ID,
    templateCode: 'PURCHASE_ORDER',
    approvalStatus: 'running',
    approvalVersion: 2,
    completedAt: null,
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}

function query(value: unknown, error?: Error) {
  return {
    lean: () => ({
      exec: () => error === undefined ? Promise.resolve(value) : Promise.reject(error),
    }),
  };
}

function setup(value: unknown = bridge(), error?: Error): {
  readonly context: TenantContextService;
  readonly findOne: ReturnType<typeof vi.fn>;
  readonly service: OpApprovalBridgeService;
} {
  const context = new TenantContextService();
  const findOne = vi.fn().mockReturnValue(query(value, error));
  return {
    context,
    findOne,
    service: new OpApprovalBridgeService(
      context,
      { findOne } as unknown as Model<OpApprovalBridgeDocument>,
    ),
  };
}

async function get(
  context: TenantContextService,
  service: OpApprovalBridgeService,
  externalEventId = EXTERNAL_EVENT_ID,
  scopes: readonly string[] = ['erp:op:approval_bridge:read'],
) {
  return context.run(
    { tenant, actor: actor(scopes) },
    () => service.get(externalEventId),
  );
}

describe('OpApprovalBridgeService', () => {
  it.each([
    ['预占', { approvalStatus: 'processing', approvalVersion: 0, completedAt: null }],
    ['运行', { approvalStatus: 'running', approvalVersion: 2, completedAt: null }],
    [
      '通过',
      {
        approvalStatus: 'approved',
        approvalVersion: 3,
        completedAt: COMPLETED_AT,
      },
    ],
    [
      '拒绝',
      {
        approvalStatus: 'rejected',
        approvalVersion: 4,
        completedAt: COMPLETED_AT,
      },
    ],
    [
      '撤回',
      {
        approvalStatus: 'withdrawn',
        approvalVersion: 3,
        completedAt: COMPLETED_AT,
      },
    ],
  ])('返回%s桥接的最小规范投影', async (_label, state) => {
    const { context, findOne, service } = setup(bridge(state));

    const result = await get(context, service);

    expect(result).toEqual({
      externalEventId: EXTERNAL_EVENT_ID,
      sourceDocumentType: 'purchase_order',
      sourceDocumentId: 'po-001',
      approvalInstanceId: INSTANCE_ID,
      templateCode: 'PURCHASE_ORDER',
      approvalStatus: state.approvalStatus,
      approvalVersion: state.approvalVersion,
      completedAt: state.completedAt instanceof Date
        ? state.completedAt.toISOString()
        : null,
      updatedAt: UPDATED_AT.toISOString(),
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(findOne).toHaveBeenCalledWith(
      { tenantId: TENANT_ID, externalEventId: EXTERNAL_EVENT_ID },
      {
        tenantId: 1,
        externalEventId: 1,
        sourceDocumentType: 1,
        sourceDocumentId: 1,
        approvalInstanceId: 1,
        templateCode: 1,
        approvalStatus: 1,
        approvalVersion: 1,
        completedAt: 1,
        updatedAt: 1,
        _id: 0,
      },
    );
    expect(JSON.stringify(result)).not.toMatch(
      /tenantId|clientId|payloadHash|formData|signature|credential/iu,
    );
  });

  it('应用服务二次校验读取 Scope，并在输入检查前失败关闭', async () => {
    const { context, findOne, service } = setup();

    await expect(get(context, service, '../invalid', [])).rejects.toMatchObject({
      status: 403,
      response: { code: 'OP_APPROVAL_BRIDGE_SCOPE_REQUIRED' },
    });
    expect(findOne).not.toHaveBeenCalled();
  });

  it.each([
    ['空值', ''],
    ['长度不足', 'event-1'],
    ['路径字符', 'approval/event-001'],
    ['空白', 'approval event-001'],
    ['超长', `a${'b'.repeat(128)}`],
  ])('拒绝%s外部事件标识', async (_label, externalEventId) => {
    const { context, findOne, service } = setup();

    await expect(get(context, service, externalEventId)).rejects.toMatchObject({
      status: 400,
      response: { code: 'OP_APPROVAL_EVENT_ID_INVALID' },
    });
    expect(findOne).not.toHaveBeenCalled();
  });

  it('固定租户查询无记录时返回不泄漏的不存在错误', async () => {
    const { context, findOne, service } = setup(null);

    await expect(get(context, service)).rejects.toMatchObject({
      status: 404,
      response: { code: 'OP_APPROVAL_BRIDGE_NOT_FOUND' },
    });
    expect(findOne).toHaveBeenCalledOnce();
  });

  it.each([
    ['未知字段', () => bridge({ internalSecret: 'hidden' })],
    ['租户错绑', () => bridge({ tenantId: 'tenant-002' })],
    ['事件错绑', () => bridge({ externalEventId: 'approval-event-002' })],
    ['租户非法', () => bridge({ tenantId: '../tenant' })],
    ['来源类型非法', () => bridge({ sourceDocumentType: 'Purchase Order' })],
    ['来源单据非法', () => bridge({ sourceDocumentId: '../po' })],
    ['审批实例非法', () => bridge({ approvalInstanceId: 'approval-001' })],
    ['模板编码非法', () => bridge({ templateCode: 'PURCHASE ORDER' })],
    ['状态非法', () => bridge({ approvalStatus: 'archived' })],
    ['版本为负数', () => bridge({ approvalVersion: -1 })],
    ['版本为小数', () => bridge({ approvalVersion: 2.5 })],
    ['版本超出安全整数', () => bridge({ approvalVersion: Number.MAX_SAFE_INTEGER + 1 })],
    ['更新时间类型非法', () => bridge({ updatedAt: UPDATED_AT.toISOString() })],
    ['更新时间无效', () => bridge({ updatedAt: new Date('invalid') })],
    ['更新时间在未来', () => bridge({ updatedAt: new Date('2999-01-01T00:00:00.000Z') })],
    [
      '预占状态版本非零',
      () => bridge({ approvalStatus: 'processing', approvalVersion: 1 }),
    ],
    [
      '预占状态包含完成时间',
      () => bridge({ approvalStatus: 'processing', approvalVersion: 0, completedAt: COMPLETED_AT }),
    ],
    ['运行状态版本不足', () => bridge({ approvalStatus: 'running', approvalVersion: 1 })],
    [
      '运行状态包含完成时间',
      () => bridge({ approvalStatus: 'running', approvalVersion: 2, completedAt: COMPLETED_AT }),
    ],
    [
      '终态版本不足',
      () => bridge({
        approvalStatus: 'approved',
        approvalVersion: 2,
        completedAt: COMPLETED_AT,
      }),
    ],
    [
      '终态缺少完成时间',
      () => bridge({ approvalStatus: 'approved', approvalVersion: 3, completedAt: null }),
    ],
    [
      '终态完成时间晚于更新时间',
      () => bridge({
        approvalStatus: 'approved',
        approvalVersion: 3,
        completedAt: new Date('2026-07-22T08:06:00.000Z'),
      }),
    ],
  ])('受损投影：%s时失败关闭', async (_label, fixture) => {
    const { context, findOne, service } = setup(fixture());

    await expect(get(context, service)).rejects.toThrow(
      'OP_APPROVAL_BRIDGE_STATE_INVALID',
    );
    expect(findOne).toHaveBeenCalledOnce();
  });

  it('数据库读取失败原样终止，不降级为不存在或空投影', async () => {
    const { context, findOne, service } = setup(
      bridge(),
      new Error('MONGO_READ_FAILED'),
    );

    await expect(get(context, service)).rejects.toThrow('MONGO_READ_FAILED');
    expect(findOne).toHaveBeenCalledOnce();
  });
});
