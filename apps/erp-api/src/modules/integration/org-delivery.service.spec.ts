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
  type ProvisionEmployeeCommand,
  type ProvisionEmployeeResult,
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

function employeeDelivery(statusChanged = false) {
  return {
    eventId: EVENT_ID,
    tenantId: 'tenant-001',
    channel: 'dingtalk' as const,
    aggregateType: 'org.employee' as const,
    aggregateId: 'employee-001',
    aggregateVersion: 3,
    eventType: statusChanged
      ? 'cn.gaoq.erp.employee.status_changed.v1'
      : 'cn.gaoq.erp.employee.updated.v1',
    attempts: 0,
    envelope: {
      idempotencyKey: 'tenant-001:employee-001:3',
      data: statusChanged
        ? {
            tenantId: 'tenant-001',
            aggregateId: 'employee-001',
            version: 3,
            fromStatus: 'active',
            toStatus: 'suspended',
          }
        : {
            tenantId: 'tenant-001',
            aggregateId: 'employee-001',
            version: 3,
            employeeNo: 'E001',
            displayName: '张三',
            status: 'active',
            departmentIds: ['department-root'],
            primaryDepartmentId: 'department-root',
            positionIds: [],
            jobLevelId: null,
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

  provisionEmployee(command: ProvisionEmployeeCommand): Promise<ProvisionEmployeeResult> {
    return Promise.resolve({ externalUserId: command.externalUserId, unionId: 'union-test' });
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
  >()
    .mockReturnValueOnce(query(null))
    .mockReturnValueOnce(query(delivery))
    .mockReturnValue(query(null));
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
  const recordOrgDelivery = vi.fn();
  const findBoundExternalUserId = vi.fn().mockResolvedValue(null);
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
    { findBoundExternalUserId } as never,
    { recordOrgDelivery } as never,
  );
  return {
    service,
    dingtalk,
    deliveryExists,
    deliveryUpdateOne,
    versionUpdateOne,
    versionFindOne,
    versionFindOneAndUpdate,
    deliveryFindOneAndUpdate,
    recordOrgDelivery,
    findBoundExternalUserId,
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

  it('外部平台已受理后本地版本提交故障不得登记为投递失败或释放版本', async () => {
    const store = assemble();
    store.versionUpdateOne
      .mockResolvedValueOnce({ matchedCount: 1 })
      .mockRejectedValueOnce(new Error('MONGO_UNAVAILABLE'));

    await expect(store.service.processBatch('dingtalk', 'worker-001', 1))
      .rejects.toThrow('ORG_DELIVERY_STATE_UNAVAILABLE');

    expect(store.dingtalk.pushDepartmentMock).toHaveBeenCalledOnce();
    expect(store.deliveryUpdateOne).not.toHaveBeenCalled();
    expect(store.versionUpdateOne).toHaveBeenCalledTimes(2);
    expect(store.recordOrgDelivery).toHaveBeenCalledWith(
      'dingtalk',
      'state_unavailable',
      expect.any(Number),
    );
  });

  it('平台网络结果不确定时进入人工核验且不自动重试', async () => {
    const store = assemble();
    store.dingtalk.pushDepartmentMock.mockRejectedValueOnce(
      new OrgPushError('ORG_PLATFORM_NETWORK_ERROR', 'retryable', '网络异常'),
    );

    await expect(store.service.processBatch('dingtalk', 'worker-001', 1)).resolves.toBe(0);

    const deliveryWrite = store.deliveryUpdateOne.mock.calls.at(-1)?.[1] as {
      $set?: Record<string, unknown>;
    } | undefined;
    expect(deliveryWrite?.$set).toMatchObject({
      status: 'manual_review',
      lastErrorCode: 'ORG_DELIVERY_RESULT_INDETERMINATE',
      lastErrorCategory: 'conflict',
    });
    expect(store.recordOrgDelivery).toHaveBeenCalledWith(
      'dingtalk',
      'manual_review',
      expect.any(Number),
    );
  });

  it('过期执行租约仅在版本已提交时补写成功，不重复调用平台', async () => {
    const stale = departmentDelivery();
    const store = assemble(null);
    store.deliveryFindOneAndUpdate
      .mockReset()
      .mockReturnValueOnce(query(stale))
      .mockReturnValue(query(null));
    store.versionFindOne.mockReset().mockReturnValue(query({
      appliedVersion: 2,
      externalId: 'dt-department-existing',
    }));

    await expect(store.service.processBatch('dingtalk', 'worker-001', 1)).resolves.toBe(1);

    expect(store.dingtalk.pushDepartmentMock).not.toHaveBeenCalled();
    expect(store.deliveryUpdateOne.mock.calls.at(-1)?.[1]).toMatchObject({
      $set: { status: 'succeeded', externalId: 'dt-department-existing' },
    });
  });

  it('过期执行租约无已提交版本时隔离到人工核验', async () => {
    const stale = departmentDelivery();
    const store = assemble(null);
    store.deliveryFindOneAndUpdate
      .mockReset()
      .mockReturnValueOnce(query(stale))
      .mockReturnValue(query(null));
    store.versionFindOne.mockReset().mockReturnValue(query({
      appliedVersion: 0,
      externalId: null,
    }));

    await expect(store.service.processBatch('dingtalk', 'worker-001', 1)).resolves.toBe(0);

    expect(store.dingtalk.pushDepartmentMock).not.toHaveBeenCalled();
    expect(store.deliveryUpdateOne.mock.calls.at(-1)?.[1]).toMatchObject({
      $set: {
        status: 'manual_review',
        lastErrorCode: 'ORG_DELIVERY_RESULT_INDETERMINATE',
      },
    });
  });

  it('终态写入丢失投递租约时失败关闭且不覆盖其他 Worker', async () => {
    const store = assemble();
    store.deliveryUpdateOne.mockResolvedValueOnce({ matchedCount: 0 });

    await expect(store.service.processBatch('dingtalk', 'worker-001', 1))
      .rejects.toThrow('ORG_DELIVERY_STATE_UNAVAILABLE');

    const filter = store.deliveryUpdateOne.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(filter).toMatchObject({
      eventId: EVENT_ID,
      channel: 'dingtalk',
      aggregateVersion: 2,
      status: 'processing',
      lockedBy: 'worker-001',
      attempts: 0,
    });
  });

  it('运行时拒绝损坏的投递事实且不访问外部平台', async () => {
    const invalid = departmentDelivery();
    invalid.eventType = 'cn.gaoq.erp.employee.updated.v1';
    const store = assemble(invalid);

    await expect(store.service.processBatch('dingtalk', 'worker-001', 1)).resolves.toBe(0);

    expect(store.dingtalk.pushDepartmentMock).not.toHaveBeenCalled();
    expect(store.deliveryUpdateOne.mock.calls.at(-1)?.[1]).toMatchObject({
      $set: {
        status: 'manual_review',
        lastErrorCode: 'ORG_DELIVERY_RECORD_INVALID',
      },
    });
  });

  it('无到期投递时立即结束，且拒绝非法 Worker 参数', async () => {
    const store = assemble(null);
    await expect(store.service.processBatch('dingtalk', 'worker-001', 1)).resolves.toBe(0);
    await expect(store.service.processBatch('dingtalk', 'worker id', 1))
      .rejects.toThrow('workerId 非法');
    await expect(store.service.processBatch('dingtalk', 'worker-001', 0))
      .rejects.toThrow('batch limit');
    await expect(store.service.processBatch('dingtalk', 'worker-001', 101))
      .rejects.toThrow('batch limit');
    await expect(store.service.processBatch('dingtalk', 'worker-001', 1.5))
      .rejects.toThrow('batch limit');
  });

  it('版本租约被占用时释放投递并等待下轮', async () => {
    const store = assemble();
    store.versionFindOneAndUpdate.mockReturnValueOnce(query(null));

    await expect(store.service.processBatch('dingtalk', 'worker-001', 1)).resolves.toBe(0);

    expect(store.dingtalk.pushDepartmentMock).not.toHaveBeenCalled();
    expect(store.deliveryUpdateOne.mock.calls.at(-1)?.[1]).toMatchObject({
      $set: { status: 'pending', lastErrorCode: 'ORG_VERSION_BUSY' },
    });
  });

  it('员工更新解析外部身份与部门映射后调用标准适配器', async () => {
    const store = assemble(employeeDelivery());
    store.findBoundExternalUserId.mockResolvedValueOnce('dt-user-001');

    await expect(store.service.processBatch('dingtalk', 'worker-001', 1)).resolves.toBe(1);

    expect(store.dingtalk.pushEmployeeMock).toHaveBeenCalledWith(expect.objectContaining({
      employeeId: 'employee-001',
      currentExternalId: 'dt-user-001',
      departmentExternalIds: ['dt-department-root'],
      primaryDepartmentExternalId: 'dt-department-root',
    }));
  });

  it('员工状态事件要求已有外部映射并调用状态变更适配器', async () => {
    const missing = assemble(employeeDelivery(true));
    await expect(missing.service.processBatch('dingtalk', 'worker-001', 1)).resolves.toBe(0);
    expect(missing.dingtalk.changeStatusMock).not.toHaveBeenCalled();
    expect(missing.deliveryUpdateOne.mock.calls.at(-1)?.[1]).toMatchObject({
      $set: { status: 'pending', lastErrorCode: 'ORG_EXTERNAL_MAPPING_MISSING' },
    });

    const bound = assemble(employeeDelivery(true));
    bound.findBoundExternalUserId.mockResolvedValueOnce('dt-user-001');
    await expect(bound.service.processBatch('dingtalk', 'worker-001', 1)).resolves.toBe(1);
    expect(bound.dingtalk.changeStatusMock).toHaveBeenCalledWith(expect.objectContaining({
      externalId: 'dt-user-001',
      status: 'suspended',
    }));
  });

  it('根部门与经理映射均按 canonical command 处理', async () => {
    const base = departmentDelivery();
    const delivery = {
      ...base,
      envelope: {
        ...base.envelope,
        data: {
          ...base.envelope.data,
          parentId: null,
          managerId: 'employee-manager',
        },
      },
    };
    const store = assemble(delivery);
    store.versionFindOne.mockImplementation((filter) => {
      const aggregateId = (filter as { aggregateId?: unknown }).aggregateId;
      if (aggregateId === 'employee-manager') {
        return query({ appliedVersion: 1, externalId: 'dt-manager' });
      }
      return query({ appliedVersion: 0, externalId: null });
    });

    await expect(store.service.processBatch('dingtalk', 'worker-001', 1)).resolves.toBe(1);
    expect(store.dingtalk.pushDepartmentMock).toHaveBeenCalledWith(expect.objectContaining({
      parentExternalId: null,
      managerExternalId: 'dt-manager',
    }));
  });

  it('无效事件载荷进入人工核验，重试耗尽进入死信', async () => {
    const invalidEnvelope = departmentDelivery();
    invalidEnvelope.envelope.data.version = 0;
    const invalid = assemble(invalidEnvelope);
    await invalid.service.processBatch('dingtalk', 'worker-001', 1);
    expect(invalid.deliveryUpdateOne.mock.calls.at(-1)?.[1]).toMatchObject({
      $set: { status: 'manual_review', lastErrorCode: 'ORG_EVENT_INVALID' },
    });

    const exhaustedDelivery = departmentDelivery();
    exhaustedDelivery.attempts = 5;
    const exhausted = assemble(exhaustedDelivery);
    exhausted.dingtalk.pushDepartmentMock.mockRejectedValueOnce(new Error('TEMPORARY'));
    await exhausted.service.processBatch('dingtalk', 'worker-001', 1);
    expect(exhausted.deliveryUpdateOne.mock.calls.at(-1)?.[1]).toMatchObject({
      $set: { status: 'dead', attempts: 6, lastErrorCode: 'ORG_PUSH_UNEXPECTED' },
    });
  });

  it('版本状态首次并发插入冲突可恢复，其他存储异常走受控退避', async () => {
    const duplicate = assemble();
    duplicate.versionUpdateOne
      .mockRejectedValueOnce({ code: 11000 })
      .mockResolvedValue({ matchedCount: 1 });
    await expect(duplicate.service.processBatch('dingtalk', 'worker-001', 1)).resolves.toBe(1);

    const unavailable = assemble();
    unavailable.versionUpdateOne.mockRejectedValueOnce(new Error('MONGO_DOWN'));
    await expect(unavailable.service.processBatch('dingtalk', 'worker-001', 1)).resolves.toBe(0);
    expect(unavailable.deliveryUpdateOne.mock.calls.at(-1)?.[1]).toMatchObject({
      $set: { status: 'pending', lastErrorCode: 'ORG_PUSH_UNEXPECTED' },
    });
  });

  it('失败释放版本时丢失租约必须停止，不能继续覆盖投递状态', async () => {
    const store = assemble();
    store.dingtalk.pushDepartmentMock.mockRejectedValueOnce(new Error('TEMPORARY'));
    store.versionUpdateOne
      .mockResolvedValueOnce({ matchedCount: 1 })
      .mockResolvedValueOnce({ matchedCount: 0 });

    await expect(store.service.processBatch('dingtalk', 'worker-001', 1))
      .rejects.toThrow('ORG_VERSION_RELEASE_LEASE_LOST');
    expect(store.deliveryUpdateOne).not.toHaveBeenCalled();
  });

  it('过期受损记录隔离，恢复状态存储不可用时失败关闭', async () => {
    const invalid = departmentDelivery();
    invalid.eventId = 'invalid-event';
    const quarantined = assemble(null);
    quarantined.deliveryFindOneAndUpdate
      .mockReset()
      .mockReturnValueOnce(query(invalid))
      .mockReturnValue(query(null));
    await expect(quarantined.service.processBatch('dingtalk', 'worker-001', 1)).resolves.toBe(0);
    expect(quarantined.deliveryUpdateOne.mock.calls.at(-1)?.[1]).toMatchObject({
      $set: { status: 'manual_review', lastErrorCode: 'ORG_DELIVERY_RECORD_INVALID' },
    });

    const unavailable = assemble(null);
    unavailable.deliveryFindOneAndUpdate
      .mockReset()
      .mockReturnValueOnce(query(departmentDelivery()));
    unavailable.versionFindOne.mockReset().mockReturnValue({
      lean: () => ({ exec: () => Promise.reject(new Error('MONGO_DOWN')) }),
    });
    await expect(unavailable.service.processBatch('dingtalk', 'worker-001', 1))
      .rejects.toThrow('ORG_DELIVERY_STATE_UNAVAILABLE');
  });
});
