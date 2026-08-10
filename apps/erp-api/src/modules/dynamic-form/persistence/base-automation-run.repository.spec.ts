import type { ClientSession, Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { AutomationExecutionPlan } from '../domain/base-automation-interpreter.js';
import { BaseAutomationRunRepository } from './base-automation-run.repository.js';
import type { BaseAutomationRunDocument } from './base-automation-run.schema.js';

const BASE_ID = '01K00000000000000000000001';
const AUTOMATION_ID = '01K00000000000000000000002';
const TABLE_ID = '01K00000000000000000000003';
const RECORD_ID = '01K00000000000000000000004';
const RUN_ID = '01K00000000000000000000005';
const RESULT_ID = '01K00000000000000000000006';
const PLAN_HASH = 'a'.repeat(43);
const SESSION = { id: 'session-001' } as unknown as ClientSession;

function query(resolve: () => unknown) {
  const value = {
    select: vi.fn(), session: vi.fn(), sort: vi.fn(), limit: vi.fn(), lean: vi.fn(),
    exec: vi.fn(() => Promise.resolve(resolve())),
  };
  value.select.mockReturnValue(value);
  value.session.mockReturnValue(value);
  value.sort.mockReturnValue(value);
  value.limit.mockReturnValue(value);
  value.lean.mockReturnValue(value);
  return value;
}

function harness() {
  let one: unknown = null;
  let many: readonly unknown[] = [];
  const queries: ReturnType<typeof query>[] = [];
  const model = {
    updateOne: vi.fn().mockResolvedValue({ matchedCount: 1 }),
    findOne: vi.fn().mockImplementation(() => {
      const current = query(() => one);
      queries.push(current);
      return current;
    }),
    find: vi.fn().mockImplementation(() => {
      const current = query(() => many);
      queries.push(current);
      return current;
    }),
  };
  const context = {
    getTenantRequired: vi.fn().mockReturnValue({ tenantId: 'tenant-001' }),
  } as unknown as TenantContextService;
  return {
    model, queries,
    setOne: (value: unknown) => { one = value; },
    setMany: (value: readonly unknown[]) => { many = value; },
    repository: new BaseAutomationRunRepository(
      context,
      model as unknown as Model<BaseAutomationRunDocument>,
    ),
  };
}

function plan(overrides: Partial<AutomationExecutionPlan> = {}): AutomationExecutionPlan {
  return Object.freeze({
    baseId: BASE_ID, baseVersion: 2,
    automationId: AUTOMATION_ID, automationName: '自动发起审批',
    sourceTableId: TABLE_ID, sourceRecordId: RECORD_ID, sourceRecordVersion: 3,
    triggerType: 'record_updated', actions: Object.freeze([{ type: 'start_approval' as const }]),
    planHash: PLAN_HASH, occurredAt: '2026-08-10T00:00:00.000Z',
    ...overrides,
  });
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID, tenantId: 'tenant-001', baseId: BASE_ID, baseVersion: 2,
    automationId: AUTOMATION_ID, automationName: '自动发起审批',
    sourceTableId: TABLE_ID, sourceRecordId: RECORD_ID, sourceRecordVersion: 3,
    triggerType: 'record_updated', actions: [{ type: 'start_approval' }], planHash: PLAN_HASH,
    status: 'pending', nextActionIndex: 0, actionResults: [], failureCode: null,
    ...overrides,
  };
}

describe('BaseAutomationRunRepository', () => {
  it('在活动事务中幂等调度计划并复核不可变摘要', async () => {
    const store = harness();
    store.setOne({ planHash: PLAN_HASH });

    await expect(store.repository.schedule(plan(), SESSION)).resolves.toBeUndefined();

    expect(store.model.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-001', baseId: BASE_ID, automationId: AUTOMATION_ID }),
      expect.any(Object),
      expect.objectContaining({ upsert: true, session: SESSION, setDefaultsOnInsert: true }),
    );
    const update = store.model.updateOne.mock.calls[0]?.[1] as
      | { readonly $setOnInsert?: { readonly planHash?: unknown; readonly status?: unknown } }
      | undefined;
    expect(update?.$setOnInsert).toMatchObject({ planHash: PLAN_HASH, status: 'pending' });
    expect(store.queries[0]?.session).toHaveBeenCalledWith(SESSION);
  });

  it('拒绝同一来源版本被改写为不同自动化计划', async () => {
    const store = harness();
    store.setOne({ planHash: 'b'.repeat(43) });
    await expect(store.repository.schedule(plan(), SESSION)).rejects.toThrow('同一来源版本的自动化计划不可改写');
  });

  it('只返回租户闭合且状态组合合法的运行投影', async () => {
    const store = harness();
    store.setOne(row());
    const result = await store.repository.find(RUN_ID);
    expect(result).toMatchObject({ id: RUN_ID, tenantId: 'tenant-001', status: 'pending' });
    expect(Object.isFrozen(result)).toBe(true);
    expect(store.model.findOne).toHaveBeenCalledWith({ tenantId: 'tenant-001', id: RUN_ID });
  });

  it('发现动作回执与解释计划不一致时整体失败关闭', async () => {
    const store = harness();
    store.setOne(row({
      status: 'completed', nextActionIndex: 1,
      actionResults: [{ index: 0, type: 'start_approval', resourceType: 'dynamic_form_record', resourceId: RESULT_ID, version: 1 }],
    }));
    await expect(store.repository.find(RUN_ID)).rejects.toThrow('BASE_AUTOMATION_RUN_STATE_INVALID');
  });

  it('按当前动作下标乐观锁推进并在最后一步收敛终态', async () => {
    const store = harness();
    store.setOne(row({ status: 'processing' }));
    await store.repository.advance(RUN_ID, 0, {
      index: 0, type: 'start_approval', resourceType: 'approval_instance', resourceId: RESULT_ID, version: 1,
    });
    expect(store.model.updateOne).toHaveBeenCalledWith(
      { tenantId: 'tenant-001', id: RUN_ID, status: 'processing', nextActionIndex: 0 },
      expect.objectContaining({ $set: { nextActionIndex: 1, status: 'completed' } }),
    );
  });

  it('只接受稳定人工复核错误码', async () => {
    const store = harness();
    await expect(store.repository.manualReview(RUN_ID, 'contains-secret')).rejects.toThrow('BASE_AUTOMATION_FAILURE_CODE_INVALID');
    expect(store.model.updateOne).not.toHaveBeenCalled();
  });

  it('全局中继仅扫描待执行或超时中间态的最小投影', async () => {
    const store = harness();
    store.setMany([{ id: RUN_ID, tenantId: 'tenant-001' }]);
    const now = new Date('2026-08-10T01:00:00.000Z');
    await expect(store.repository.listRelayableGlobal(now, 10)).resolves.toEqual([{ id: RUN_ID, tenantId: 'tenant-001' }]);
    expect(store.model.find).toHaveBeenCalledWith({ $or: [
      { status: 'pending' },
      { status: 'processing', updatedAt: { $lte: new Date('2026-08-10T00:55:00.000Z') } },
    ] });
    expect(store.queries[0]?.limit).toHaveBeenCalledWith(10);
  });
});
