import type { Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type {
  OrgDeliveryDocument,
  OrgExternalVersionStateDocument,
} from './org-delivery.schemas.js';
import { OrgDeliveryService } from './org-delivery.service.js';
import {
  OrgPushAdapter,
  OrgPushAdapterRegistry,
  OrgPushError,
  type ChangeEmployeeStatusCommand,
  type ExternalOrgSnapshot,
  type OrgPushChannel,
  type OrgPushResult,
  type PushDepartmentCommand,
  type PushEmployeeCommand,
} from './org-push.adapter.js';

const EVENT_ID = '01K00000000000000000000000';

function query(result: unknown) {
  return { lean: () => ({ exec: () => Promise.resolve(result) }) };
}

function departmentDelivery() {
  return {
    eventId: EVENT_ID,
    tenantId: 'tenant-001',
    channel: 'dingtalk' as const,
    aggregateType: 'org.department' as const,
    aggregateId: 'department-child',
    aggregateVersion: 2,
    eventType: 'cn.gaoq.erp.department.updated.v1',
    attempts: 0,
    envelope: {
      idempotencyKey: 'tenant-001:department-child:2',
      data: {
        tenantId: 'tenant-001',
        aggregateId: 'department-child',
        version: 2,
        code: 'FIN',
        name: '财务部',
        status: 'active',
        parentId: 'department-root',
        managerId: null,
        sortOrder: 10,
      },
    },
  };
}

class FakeAdapter extends OrgPushAdapter {
  readonly pushDepartmentMock = vi.fn<
    (command: PushDepartmentCommand) => Promise<OrgPushResult>
  >().mockResolvedValue({ externalId: 'dt-department-child' });
  readonly pushEmployeeMock = vi.fn<
    (command: PushEmployeeCommand) => Promise<OrgPushResult>
  >().mockResolvedValue({ externalId: 'dt-employee' });
  readonly changeStatusMock = vi.fn<
    (command: ChangeEmployeeStatusCommand) => Promise<OrgPushResult>
  >().mockImplementation((command) => Promise.resolve({ externalId: command.externalId }));

  constructor(readonly channel: OrgPushChannel) {
    super();
  }

  pushDepartment(command: PushDepartmentCommand): Promise<OrgPushResult> {
    return this.pushDepartmentMock(command);
  }

  pushEmployee(command: PushEmployeeCommand): Promise<OrgPushResult> {
    return this.pushEmployeeMock(command);
  }

  changeEmployeeStatus(command: ChangeEmployeeStatusCommand): Promise<OrgPushResult> {
    return this.changeStatusMock(command);
  }

  fetchSnapshot(tenantId: string): Promise<ExternalOrgSnapshot> {
    void tenantId;
    return Promise.resolve({ departments: new Map(), employees: new Map() });
  }
}

function assemble(delivery: unknown = departmentDelivery()) {
  const dingtalk = new FakeAdapter('dingtalk');
  const feishu = new FakeAdapter('feishu');
  const deliveryFindOneAndUpdate = vi.fn<
    (filter: unknown, update: unknown, options: unknown) => unknown
  >().mockReturnValueOnce(query(delivery)).mockReturnValue(query(null));
  const deliveryExists = vi.fn<(filter: unknown) => Promise<unknown>>().mockResolvedValue(null);
  const deliveryUpdateOne = vi.fn<
    (filter: unknown, update: unknown, options?: unknown) => Promise<{ matchedCount: number }>
  >().mockResolvedValue({ matchedCount: 1 });
  const versionUpdateOne = vi.fn<
    (filter: unknown, update: unknown, options?: unknown) => Promise<{ matchedCount: number }>
  >().mockResolvedValue({ matchedCount: 1 });
  const versionFindOne = vi.fn<(filter: unknown) => unknown>().mockImplementation((filter) => {
    const aggregateId = (filter as { aggregateId?: unknown }).aggregateId;
    if (aggregateId === 'department-root') {
      return query({ appliedVersion: 1, externalId: 'dt-department-root' });
    }
    return query({ appliedVersion: 0, externalId: null });
  });
  const versionFindOneAndUpdate = vi.fn<
    (filter: unknown, update: unknown, options: unknown) => unknown
  >().mockReturnValue(query({ appliedVersion: 0, externalId: null }));
  const service = new OrgDeliveryService(
    {
      findOneAndUpdate: deliveryFindOneAndUpdate,
      exists: deliveryExists,
      updateOne: deliveryUpdateOne,
    } as unknown as Model<OrgDeliveryDocument>,
    {
      updateOne: versionUpdateOne,
      findOne: versionFindOne,
      findOneAndUpdate: versionFindOneAndUpdate,
    } as unknown as Model<OrgExternalVersionStateDocument>,
    new OrgPushAdapterRegistry(dingtalk, feishu),
    { findBoundExternalUserId: vi.fn().mockResolvedValue(null) } as never,
  );
  return {
    service,
    dingtalk,
    deliveryExists,
    deliveryUpdateOne,
    versionUpdateOne,
    versionFindOne,
    versionFindOneAndUpdate,
  };
}

describe('OrgDeliveryService', () => {
  it('严格等待同聚合低版本完成，不允许高版本越序调用平台', async () => {
    const store = assemble();
    store.deliveryExists.mockResolvedValue({ _id: 'earlier' });

    const count = await store.service.processBatch('dingtalk', 'worker-001', 1);

    expect(count).toBe(0);
    expect(store.dingtalk.pushDepartmentMock).not.toHaveBeenCalled();
    const release = store.deliveryUpdateOne.mock.calls.at(-1)?.[1] as {
      $set?: Record<string, unknown>;
    } | undefined;
    expect(release?.$set).toMatchObject({
      status: 'pending',
      lastErrorCode: 'ORG_VERSION_BUSY',
      lastErrorCategory: 'retryable',
    });
  });

  it('原子预留版本后解析父部门映射、调用适配器并提交最高版本', async () => {
    const store = assemble();

    const count = await store.service.processBatch('dingtalk', 'worker-001', 1);

    expect(count).toBe(1);
    expect(store.dingtalk.pushDepartmentMock).toHaveBeenCalledOnce();
    const command = store.dingtalk.pushDepartmentMock.mock.calls[0]?.[0];
    expect(command).toMatchObject({
      tenantId: 'tenant-001',
      departmentId: 'department-child',
      version: 2,
      parentExternalId: 'dt-department-root',
      currentExternalId: null,
    });
    const versionWrites = store.versionUpdateOne.mock.calls;
    const committed = versionWrites.at(-1)?.[1] as { $set?: Record<string, unknown> } | undefined;
    expect(committed?.$set).toMatchObject({
      appliedVersion: 2,
      externalId: 'dt-department-child',
      lastEventId: EVENT_ID,
      processingVersion: null,
    });
    const deliveryWrite = store.deliveryUpdateOne.mock.calls.at(-1)?.[1] as {
      $set?: Record<string, unknown>;
    } | undefined;
    expect(deliveryWrite?.$set).toMatchObject({
      status: 'succeeded',
      externalId: 'dt-department-child',
    });
  });

  it('可重试错误进入指数退避，且释放版本租约', async () => {
    const store = assemble();
    store.dingtalk.pushDepartmentMock.mockRejectedValueOnce(
      new OrgPushError('DINGTALK_RATE_LIMITED', 'retryable', '平台限流', 429),
    );

    const count = await store.service.processBatch('dingtalk', 'worker-001', 1);

    expect(count).toBe(0);
    const deliveryWrite = store.deliveryUpdateOne.mock.calls.at(-1)?.[1] as {
      $set?: Record<string, unknown>;
    } | undefined;
    expect(deliveryWrite?.$set).toMatchObject({
      status: 'pending',
      attempts: 1,
      lastErrorCode: 'DINGTALK_RATE_LIMITED',
      lastErrorCategory: 'retryable',
    });
    expect(deliveryWrite?.$set?.['nextAttemptAt']).toBeInstanceOf(Date);
    const released = store.versionUpdateOne.mock.calls.at(-1)?.[1] as {
      $set?: Record<string, unknown>;
    } | undefined;
    expect(released?.$set).toMatchObject({ processingVersion: null, lockedBy: null });
  });

  it('事件身份被篡改时进入人工队列，不重试外部写入', async () => {
    const tampered = departmentDelivery();
    tampered.envelope.data.tenantId = 'attacker-tenant';
    const store = assemble(tampered);

    await store.service.processBatch('dingtalk', 'worker-001', 1);

    expect(store.dingtalk.pushDepartmentMock).not.toHaveBeenCalled();
    const deliveryWrite = store.deliveryUpdateOne.mock.calls.at(-1)?.[1] as {
      $set?: Record<string, unknown>;
    } | undefined;
    expect(deliveryWrite?.$set).toMatchObject({
      status: 'manual_review',
      lastErrorCode: 'ORG_EVENT_IDENTITY_MISMATCH',
      lastErrorCategory: 'conflict',
    });
  });

  it('事件已应用时不重复调用平台，并保留既有外部映射', async () => {
    const store = assemble();
    store.versionFindOne.mockReturnValueOnce(query({
      appliedVersion: 2,
      externalId: 'dt-department-existing',
    }));

    const count = await store.service.processBatch('dingtalk', 'worker-001', 1);

    expect(count).toBe(1);
    expect(store.dingtalk.pushDepartmentMock).not.toHaveBeenCalled();
    const deliveryWrite = store.deliveryUpdateOne.mock.calls.at(-1)?.[1] as {
      $set?: Record<string, unknown>;
    } | undefined;
    expect(deliveryWrite?.$set).toMatchObject({
      status: 'succeeded',
      externalId: 'dt-department-existing',
    });
  });

  it('版本预留前数据库异常也会释放投递锁并进入退避', async () => {
    const store = assemble();
    store.versionFindOne.mockReturnValueOnce({
      lean: () => ({ exec: () => Promise.reject(new Error('database unavailable')) }),
    });

    const count = await store.service.processBatch('dingtalk', 'worker-001', 1);

    expect(count).toBe(0);
    expect(store.dingtalk.pushDepartmentMock).not.toHaveBeenCalled();
    const deliveryWrite = store.deliveryUpdateOne.mock.calls.at(-1)?.[1] as {
      $set?: Record<string, unknown>;
    } | undefined;
    expect(deliveryWrite?.$set).toMatchObject({
      status: 'pending',
      attempts: 1,
      lastErrorCode: 'ORG_PUSH_UNEXPECTED',
      lastErrorCategory: 'retryable',
    });
  });

  it('跨聚合依赖未就绪不消耗六次业务重试预算', async () => {
    const delivery = departmentDelivery();
    delivery.envelope.data.parentId = 'department-not-ready';
    const store = assemble(delivery);

    await store.service.processBatch('dingtalk', 'worker-001', 1);

    const deliveryWrite = store.deliveryUpdateOne.mock.calls.at(-1)?.[1] as {
      $set?: Record<string, unknown>;
    } | undefined;
    expect(deliveryWrite?.$set).toMatchObject({
      status: 'pending',
      lastErrorCode: 'ORG_DEPENDENCY_NOT_READY',
      lastErrorCategory: 'retryable',
    });
    expect(deliveryWrite?.$set).not.toHaveProperty('attempts');
  });
});
