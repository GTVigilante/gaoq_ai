import type { Queue } from 'bullmq';
import type { Model } from 'mongoose';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TenantContextService } from '../../core/tenant/tenant-context.service.js';
import type { AttendanceDataCryptoService } from '../attendance/persistence/attendance-data-crypto.service.js';
import type {
  AttendanceProviderRawEvent,
  AttendanceProviderPullInput,
  AttendanceProviderRegistry,
} from './attendance-provider.adapter.js';
import { AttendanceProviderPullService } from './attendance-provider-pull.service.js';
import {
  ATTENDANCE_PROVIDER_PROCESS_JOB,
  ATTENDANCE_PROVIDER_PULL_JOB,
  type AttendanceProviderJobData,
} from './attendance-provider.queue.js';
import type {
  AttendanceProviderEmployeeMappingDocument,
  AttendanceProviderInboxDocument,
  AttendanceProviderStateDocument,
} from './attendance-provider.schemas.js';

const STATE_ID = '01J8ZQK7V0A2M4N6P8R0T2W4C1';
const MAPPING_ID = '01J8ZQK7V0A2M4N6P8R0T2W4C2';

function query(value: unknown) {
  return { lean: () => ({ exec: () => Promise.resolve(value) }) };
}

function fluentQuery<T>(resolve: () => T | Promise<T>) {
  const value = {
    sort: vi.fn(), limit: vi.fn(), lean: vi.fn(),
    exec: vi.fn(async () => resolve()),
  };
  value.sort.mockReturnValue(value);
  value.limit.mockReturnValue(value);
  value.lean.mockReturnValue(value);
  return value;
}

const stateFixture = {
  id: STATE_ID, tenantId: 'tenant-001', providerCode: 'feishu' as const,
  timeZone: 'Asia/Shanghai', status: 'active' as const,
  cursorKeyId: null, cursorIv: null, cursorCiphertext: null, cursorAuthTag: null,
  nextPollAt: new Date('2026-07-22T02:00:00.000Z'),
};

const mappingFixture = {
  id: MAPPING_ID, tenantId: 'tenant-001', providerCode: 'feishu' as const,
  employeeId: 'employee-001', status: 'active' as const,
  externalIdKeyId: 'key-001', externalIdIv: 'A'.repeat(16),
  externalIdCiphertext: 'A'.repeat(32), externalIdAuthTag: 'A'.repeat(22),
};

const eventFixture: AttendanceProviderRawEvent = {
  externalEventId: 'external-event-001',
  occurredAt: '2026-07-21T01:00:00.000Z',
  transportRequestId: 'transport-request-001',
  payload: {
    providerCode: 'feishu', pulledAt: '2026-07-22T03:00:00.000Z',
    values: [null, true, 'text', 1],
  },
};

function existingInbox(
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    id: '01J8ZQK7V0A2M4N6P8R0T2W4C3',
    tenantId: 'tenant-001',
    providerCode: 'feishu',
    providerOccurredAt: new Date(eventFixture.occurredAt),
    payloadKeyId: 'key-001',
    payloadIv: 'A'.repeat(16),
    payloadCiphertext: 'A'.repeat(32),
    payloadAuthTag: 'A'.repeat(22),
    ...overrides,
  };
}

function assemble() {
  let state: Record<string, unknown> | null = { ...stateFixture };
  let mappings: readonly Record<string, unknown>[] = [{ ...mappingFixture }];
  let inboxRecords: readonly (Record<string, unknown> | null)[] = [null];
  let inboxRead = 0;
  let cursorValue: unknown = null;
  let externalEmployeeId: unknown = 'external-user-001';
  let inboxPayload: unknown = {
    payload: eventFixture.payload, transportRequestId: eventFixture.transportRequestId,
  };
  const states = {
    findOneAndUpdate: vi.fn().mockImplementation(() => fluentQuery(() => state)),
    updateOne: vi.fn().mockResolvedValue({ matchedCount: 1 }),
  };
  const mappingModel = {
    find: vi.fn().mockImplementation(() => fluentQuery(() => mappings)),
  };
  const inbox = {
    findOne: vi.fn().mockImplementation(() => fluentQuery(
      () => inboxRecords[Math.min(inboxRead++, inboxRecords.length - 1)] ?? null,
    )),
    create: vi.fn().mockResolvedValue(undefined),
  };
  const crypto = {
    providerFingerprints: vi.fn().mockReturnValue(['blind-key.event-fingerprint']),
    protect: vi.fn().mockReturnValue({
      keyId: 'key-001', iv: 'A'.repeat(16),
      ciphertext: 'A'.repeat(32), authTag: 'A'.repeat(22),
    }),
    unprotect: vi.fn().mockImplementation((
      cryptoContext: { readonly resourceType: string },
    ) => {
      if (cryptoContext.resourceType === 'provider_cursor') return cursorValue;
      if (cryptoContext.resourceType === 'provider_inbox') return inboxPayload;
      return externalEmployeeId;
    }),
  };
  const pullBatch = vi.fn().mockResolvedValue([]);
  const registry = {
    adapter: vi.fn().mockReturnValue({ pullBatch }),
  };
  const queue = {
    getJob: vi.fn().mockResolvedValue(undefined),
    add: vi.fn().mockResolvedValue({}),
  };
  const context = new TenantContextService();
  const service = new AttendanceProviderPullService(
    states as unknown as Model<AttendanceProviderStateDocument>,
    mappingModel as unknown as Model<AttendanceProviderEmployeeMappingDocument>,
    inbox as unknown as Model<AttendanceProviderInboxDocument>,
    context,
    crypto as unknown as AttendanceDataCryptoService,
    registry as unknown as AttendanceProviderRegistry,
    queue as unknown as Queue<AttendanceProviderJobData>,
  );
  return {
    context, states, mappingModel, inbox, crypto, registry, pullBatch, queue, service,
    setState: (value: Record<string, unknown> | null) => { state = value; },
    setMappings: (value: readonly Record<string, unknown>[]) => { mappings = value; },
    setInboxRecords: (value: readonly (Record<string, unknown> | null)[]) => {
      inboxRecords = value;
      inboxRead = 0;
    },
    setCursorValue: (value: unknown) => { cursorValue = value; },
    setExternalEmployeeId: (value: unknown) => { externalEmployeeId = value; },
    setInboxPayload: (value: unknown) => { inboxPayload = value; },
  };
}

function trustedRun<T>(
  store: ReturnType<typeof assemble>,
  operation: () => Promise<T>,
  actorType: 'system_job' | 'service' | 'user' = 'system_job',
  scopes: readonly string[] = ['erp:attendance:provider:pull'],
): Promise<T> {
  return store.context.run({
    tenant: { tenantId: 'tenant-001', source: 'service_identity' },
    actor: {
      tenantId: 'tenant-001', actorId: 'system:test', actorType,
      roleCodes: [], scopes, departmentIds: [], traceId: 'trace-001',
    },
  }, operation);
}

afterEach(() => vi.useRealTimers());

describe('AttendanceProviderPullService', () => {
  it('扫描任务 ID 绑定 nextPollAt，完成任务不会阻断下一轮轮询', async () => {
    const firstDueAt = new Date('2026-07-22T00:00:00.000Z');
    const states = {
      find: vi.fn().mockReturnValue({
        sort: () => ({ limit: () => query([{
          tenantId: 'tenant-001', id: STATE_ID, nextPollAt: firstDueAt,
        }]) }),
      }),
    };
    const queue = { getJob: vi.fn().mockResolvedValue(undefined), add: vi.fn().mockResolvedValue({}) };
    const service = new AttendanceProviderPullService(
      states as unknown as Model<AttendanceProviderStateDocument>,
      {} as Model<AttendanceProviderEmployeeMappingDocument>,
      {} as Model<AttendanceProviderInboxDocument>,
      new TenantContextService(), {} as AttendanceDataCryptoService,
      {} as AttendanceProviderRegistry,
      queue as unknown as Queue<AttendanceProviderJobData>,
    );

    await expect(service.enqueueDueStates()).resolves.toBe(1);

    expect(queue.add.mock.calls[0]?.[0]).toBe(ATTENDANCE_PROVIDER_PULL_JOB);
    expect(queue.add.mock.calls[0]?.[1]).toEqual({ tenantId: 'tenant-001', stateId: STATE_ID });
    const options = queue.add.mock.calls[0]?.[2] as { readonly jobId: string };
    expect(options.jobId).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('按员工页和 20 人小批补拉，未完成员工页时不推进日期水位', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-22T03:00:00.000Z'));
    const state = {
      id: STATE_ID, tenantId: 'tenant-001', providerCode: 'feishu' as const,
      timeZone: 'Asia/Shanghai', status: 'active' as const,
      cursorKeyId: null, cursorIv: null, cursorCiphertext: null, cursorAuthTag: null,
      nextPollAt: new Date('2026-07-22T02:00:00.000Z'),
    };
    const findOneAndUpdate = vi.fn().mockReturnValue(query(state));
    const updateOne = vi.fn().mockResolvedValue({ matchedCount: 1 });
    const mappings = Array.from({ length: 101 }, () => ({
      id: MAPPING_ID, tenantId: 'tenant-001', providerCode: 'feishu', employeeId: 'employee-001',
      externalIdKeyId: 'key-001', externalIdIv: 'A'.repeat(16),
      externalIdCiphertext: 'A'.repeat(32), externalIdAuthTag: 'A'.repeat(22),
    }));
    const mappingModel = {
      find: vi.fn().mockReturnValue({
        sort: () => ({ limit: () => query(mappings) }),
      }),
    };
    const pullBatch = vi.fn().mockResolvedValue([]);
    const protect = vi.fn().mockReturnValue({
      keyId: 'key-001', iv: 'A'.repeat(16), ciphertext: 'A'.repeat(32), authTag: 'A'.repeat(22),
    });
    const context = new TenantContextService();
    const service = new AttendanceProviderPullService(
      { findOneAndUpdate, updateOne } as unknown as Model<AttendanceProviderStateDocument>,
      mappingModel as unknown as Model<AttendanceProviderEmployeeMappingDocument>,
      {} as Model<AttendanceProviderInboxDocument>,
      context,
      {
        unprotect: vi.fn().mockReturnValue('external-user-001'), protect,
      } as unknown as AttendanceDataCryptoService,
      { adapter: vi.fn().mockReturnValue({ pullBatch }) } as unknown as AttendanceProviderRegistry,
      {} as Queue<AttendanceProviderJobData>,
    );

    const count = await context.run({
      tenant: { tenantId: 'tenant-001', source: 'service_identity' },
      actor: {
        tenantId: 'tenant-001', actorId: 'system:test', actorType: 'system_job',
        roleCodes: [], scopes: ['erp:attendance:provider:pull'], departmentIds: [], traceId: 'trace-001',
      },
    }, () => service.pullState(STATE_ID));

    expect(count).toBe(0);
    expect(pullBatch).toHaveBeenCalledTimes(5);
    const firstPull = pullBatch.mock.calls[0]?.[0] as AttendanceProviderPullInput;
    expect(firstPull.fromDate).toBe('2026-07-21');
    expect(firstPull.toDate).toBe('2026-07-22');
    expect(firstPull.externalEmployeeIds).toContain('external-user-001');
    const cursor = protect.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(cursor).toEqual({
      throughDate: '2026-07-21', windowToDate: '2026-07-22', employeeAfterId: MAPPING_ID,
    });
    const finalUpdate = updateOne.mock.calls[0]?.[1] as {
      readonly $set: { readonly nextPollAt: Date };
    };
    expect(finalUpdate.$set.nextPollAt.toISOString()).toBe('2026-07-22T03:00:01.000Z');
  });

  it('扫描时只重试失败的既有任务，不重复创建已存在任务', async () => {
    const retry = vi.fn().mockResolvedValue(undefined);
    const states = {
      find: vi.fn().mockReturnValue(fluentQuery(() => [
        { tenantId: 'tenant-001', id: STATE_ID, nextPollAt: new Date('2026-07-22T00:00:00Z') },
        { tenantId: 'tenant-001', id: MAPPING_ID, nextPollAt: new Date('2026-07-22T00:01:00Z') },
      ])),
    };
    const queue = {
      getJob: vi.fn()
        .mockResolvedValueOnce({ getState: vi.fn().mockResolvedValue('failed'), retry })
        .mockResolvedValueOnce({ getState: vi.fn().mockResolvedValue('completed'), retry: vi.fn() }),
      add: vi.fn(),
    };
    const service = new AttendanceProviderPullService(
      states as unknown as Model<AttendanceProviderStateDocument>,
      {} as Model<AttendanceProviderEmployeeMappingDocument>,
      {} as Model<AttendanceProviderInboxDocument>,
      new TenantContextService(),
      {} as AttendanceDataCryptoService,
      {} as AttendanceProviderRegistry,
      queue as unknown as Queue<AttendanceProviderJobData>,
    );

    await expect(service.enqueueDueStates(2)).resolves.toBe(2);
    expect(retry).toHaveBeenCalledOnce();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it.each([
    ['service', ['erp:attendance:provider:pull']],
    ['system_job', []],
  ] as const)('拒绝非系统任务或缺失权限的拉取主体：%s', async (actorType, scopes) => {
    const store = assemble();
    await expect(trustedRun(store, () => store.service.pullState(STATE_ID), actorType, scopes))
      .rejects.toThrow('ATTENDANCE_PROVIDER_WORKER_REQUIRED');
    expect(store.states.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('没有可获取租约的状态时安全返回零', async () => {
    const store = assemble();
    store.setState(null);
    await expect(trustedRun(store, () => store.service.pullState(STATE_ID))).resolves.toBe(0);
    expect(store.mappingModel.find).not.toHaveBeenCalled();
  });

  it('拉取新事件后保存密文 Inbox、推进游标并创建处理任务', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-22T03:00:00.000Z'));
    const store = assemble();
    store.pullBatch.mockResolvedValue([eventFixture]);

    await expect(trustedRun(store, () => store.service.pullState(STATE_ID))).resolves.toBe(1);

    expect(store.inbox.create).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-001',
      stateId: STATE_ID,
      providerCode: 'feishu',
      status: 'pending',
      payloadKeyId: 'key-001',
    }));
    expect(store.queue.add).toHaveBeenCalledWith(
      ATTENDANCE_PROVIDER_PROCESS_JOB,
      expect.objectContaining({ tenantId: 'tenant-001' }),
      expect.objectContaining({ attempts: 12 }),
    );
    expect(store.states.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-001', id: STATE_ID }),
      { $set: expect.objectContaining({ lastFailureCode: null }) as unknown },
      { runValidators: true },
    );
  });

  it('既有相同事件忽略 pulledAt 与对象键顺序，并重试失败处理任务', async () => {
    const store = assemble();
    store.pullBatch.mockResolvedValue([{
      ...eventFixture,
      payload: {
        values: [null, true, 'text', 1],
        pulledAt: '2099-01-01T00:00:00.000Z',
        providerCode: 'feishu',
      },
    }]);
    store.setInboxRecords([existingInbox()]);
    const retry = vi.fn().mockResolvedValue(undefined);
    store.queue.getJob.mockResolvedValue({
      getState: vi.fn().mockResolvedValue('failed'),
      retry,
    });

    await expect(trustedRun(store, () => store.service.pullState(STATE_ID))).resolves.toBe(1);
    expect(store.inbox.create).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledOnce();
    expect(store.queue.add).not.toHaveBeenCalled();
  });

  it('既有非失败处理任务不重复入队', async () => {
    const store = assemble();
    store.pullBatch.mockResolvedValue([eventFixture]);
    store.setInboxRecords([existingInbox()]);
    store.queue.getJob.mockResolvedValue({
      getState: vi.fn().mockResolvedValue('completed'),
      retry: vi.fn(),
    });

    await expect(trustedRun(store, () => store.service.pullState(STATE_ID))).resolves.toBe(1);
    expect(store.queue.add).not.toHaveBeenCalled();
  });

  it.each([
    [existingInbox({ providerOccurredAt: new Date('2026-07-20T01:00:00.000Z') }), eventFixture],
    [existingInbox(), { ...eventFixture, payload: { providerCode: 'dingtalk' } }],
  ] as const)('相同外部事件标识出现时间或载荷碰撞时失败关闭', async (existing, incoming) => {
    const store = assemble();
    store.pullBatch.mockResolvedValue([incoming]);
    store.setInboxRecords([existing]);
    await expect(trustedRun(store, () => store.service.pullState(STATE_ID)))
      .rejects.toThrow('ATTENDANCE_PROVIDER_EVENT_PAYLOAD_COLLISION');
    expect(store.states.updateOne).toHaveBeenLastCalledWith(
      expect.any(Object),
      { $set: expect.objectContaining({
        lastFailureCode: 'ATTENDANCE_PROVIDER_EVENT_PAYLOAD_COLLISION',
      }) as unknown },
      { runValidators: true },
    );
  });

  it('唯一键竞争后读取胜者并使用同一稳定任务键入队', async () => {
    const store = assemble();
    store.pullBatch.mockResolvedValue([eventFixture]);
    store.setInboxRecords([null, existingInbox()]);
    store.inbox.create.mockRejectedValue({ code: 11_000 });

    await expect(trustedRun(store, () => store.service.pullState(STATE_ID))).resolves.toBe(1);
    expect(store.inbox.findOne).toHaveBeenCalledTimes(2);
    expect(store.queue.add).toHaveBeenCalledOnce();
  });

  it.each([
    [new Error('DATABASE_UNAVAILABLE'), [null]],
    [{ code: 11_000 }, [null, null]],
  ] as const)('非可恢复 Inbox 写入失败保持原错误：%j', async (failure, records) => {
    const store = assemble();
    store.pullBatch.mockResolvedValue([eventFixture]);
    store.setInboxRecords(records);
    store.inbox.create.mockRejectedValue(failure);
    await expect(trustedRun(store, () => store.service.pullState(STATE_ID))).rejects.toBe(failure);
    expect(store.queue.add).not.toHaveBeenCalled();
  });

  it('完整旧版日期游标可解密使用，完整结构化游标可继续员工分页', async () => {
    const legacy = assemble();
    legacy.setState({
      ...stateFixture,
      cursorKeyId: 'key-001',
      cursorIv: 'A'.repeat(16),
      cursorCiphertext: 'A'.repeat(32),
      cursorAuthTag: 'A'.repeat(22),
    });
    legacy.setCursorValue('2026-07-01');
    await trustedRun(legacy, () => legacy.service.pullState(STATE_ID));
    expect(legacy.pullBatch).toHaveBeenCalledWith(expect.objectContaining({
      fromDate: '2026-07-01',
    }));

    const structured = assemble();
    structured.setState({
      ...stateFixture,
      cursorKeyId: 'key-001',
      cursorIv: 'A'.repeat(16),
      cursorCiphertext: 'A'.repeat(32),
      cursorAuthTag: 'A'.repeat(22),
    });
    structured.setCursorValue({
      throughDate: '2026-07-01',
      windowToDate: '2026-07-07',
      employeeAfterId: MAPPING_ID,
    });
    await trustedRun(structured, () => structured.service.pullState(STATE_ID));
    expect(structured.mappingModel.find).toHaveBeenCalledWith(expect.objectContaining({
      id: { $gt: MAPPING_ID },
    }));
  });

  it.each([
    [{ ...stateFixture, cursorKeyId: 'key-001' }, null],
    [{
      ...stateFixture,
      cursorKeyId: 'key-001',
      cursorIv: 'A'.repeat(16),
      cursorCiphertext: 'A'.repeat(32),
      cursorAuthTag: 'A'.repeat(22),
    }, 'not-a-date'],
    [{
      ...stateFixture,
      cursorKeyId: 'key-001',
      cursorIv: 'A'.repeat(16),
      cursorCiphertext: 'A'.repeat(32),
      cursorAuthTag: 'A'.repeat(22),
    }, {
      throughDate: '2026-07-01',
      windowToDate: '2026-07-07',
      employeeAfterId: null,
    }],
  ] as const)('部分密文字段或非法游标均失败关闭', async (state, cursorValue) => {
    const store = assemble();
    store.setState(state);
    store.setCursorValue(cursorValue);
    await expect(trustedRun(store, () => store.service.pullState(STATE_ID)))
      .rejects.toThrow('ATTENDANCE_PROVIDER_CURSOR_INVALID');
    expect(store.states.updateOne).toHaveBeenCalledWith(
      expect.any(Object),
      { $set: expect.objectContaining({
        lastFailureCode: 'ATTENDANCE_PROVIDER_CURSOR_INVALID',
      }) as unknown },
      { runValidators: true },
    );
  });

  it('缺失员工映射和非法外部员工标识均失败关闭', async () => {
    const missing = assemble();
    missing.setMappings([]);
    await expect(trustedRun(missing, () => missing.service.pullState(STATE_ID)))
      .rejects.toThrow('ATTENDANCE_PROVIDER_EMPLOYEE_MAPPING_MISSING');

    const invalid = assemble();
    invalid.setExternalEmployeeId('');
    await expect(trustedRun(invalid, () => invalid.service.pullState(STATE_ID)))
      .rejects.toThrow();
    expect(invalid.states.updateOne).toHaveBeenLastCalledWith(
      expect.any(Object),
      { $set: expect.objectContaining({
        lastFailureCode: 'ATTENDANCE_PROVIDER_PULL_FAILED',
      }) as unknown },
      { runValidators: true },
    );
  });

  it('成功提交游标时丢失租约，故障状态仍可记录后返回原领域错误', async () => {
    const store = assemble();
    store.states.updateOne
      .mockResolvedValueOnce({ matchedCount: 0 })
      .mockResolvedValueOnce({ matchedCount: 1 });
    await expect(trustedRun(store, () => store.service.pullState(STATE_ID)))
      .rejects.toThrow('ATTENDANCE_PROVIDER_STATE_LEASE_LOST');
    expect(store.states.updateOne).toHaveBeenCalledTimes(2);
  });

  it('故障状态回写也丢失租约时，以租约错误封装原始原因', async () => {
    const store = assemble();
    store.setMappings([]);
    store.states.updateOne.mockResolvedValue({ matchedCount: 0 });
    try {
      await trustedRun(store, () => store.service.pullState(STATE_ID));
      throw new Error('预期拉取失败');
    } catch (error) {
      expect(error).toMatchObject({
        message: 'ATTENDANCE_PROVIDER_STATE_LEASE_LOST',
        cause: expect.objectContaining({
          message: 'ATTENDANCE_PROVIDER_EMPLOYEE_MAPPING_MISSING',
        }) as unknown,
      });
    }
  });

  it.each([
    [Number.NaN, 'ATTENDANCE_PROVIDER_PAYLOAD_INVALID'],
    [undefined, 'ATTENDANCE_PROVIDER_PAYLOAD_INVALID'],
    [Array.from({ length: 10_001 }, () => null), 'ATTENDANCE_PROVIDER_PAYLOAD_TOO_LARGE'],
    [Array.from({ length: 22 }, () => 0).reduce<unknown>(
      (value) => ({ nested: value }),
      null,
    ), 'ATTENDANCE_PROVIDER_PAYLOAD_TOO_DEEP'],
  ] as const)('拒绝不可规范化或超限的提供商载荷：%s', async (payload, code) => {
    const store = assemble();
    store.pullBatch.mockResolvedValue([{ ...eventFixture, payload }]);
    store.setInboxRecords([existingInbox()]);
    await expect(trustedRun(store, () => store.service.pullState(STATE_ID)))
      .rejects.toThrow(code);
  });
});

describe('AttendanceProviderPullService 失败关闭与幂等边界', () => {
  it('已有失败轮询任务只重试一次，非失败任务不重复入队', async () => {
    const failed = { getState: vi.fn().mockResolvedValue('failed'), retry: vi.fn() };
    const completed = { getState: vi.fn().mockResolvedValue('completed'), retry: vi.fn() };
    const states = {
      find: vi.fn().mockReturnValue({
        sort: () => ({ limit: () => query([
          { tenantId: 'tenant-001', id: STATE_ID, nextPollAt: new Date('2026-07-22T00:00:00Z') },
          { tenantId: 'tenant-002', id: STATE_ID, nextPollAt: new Date('2026-07-22T00:01:00Z') },
        ]) }),
      }),
    };
    const queue = {
      getJob: vi.fn().mockResolvedValueOnce(failed).mockResolvedValueOnce(completed),
      add: vi.fn(),
    };
    const service = new AttendanceProviderPullService(
      states as unknown as Model<AttendanceProviderStateDocument>,
      {} as Model<AttendanceProviderEmployeeMappingDocument>,
      {} as Model<AttendanceProviderInboxDocument>,
      new TenantContextService(), {} as AttendanceDataCryptoService,
      {} as AttendanceProviderRegistry,
      queue as unknown as Queue<AttendanceProviderJobData>,
    );
    await expect(service.enqueueDueStates(2)).resolves.toBe(2);
    expect(failed.retry).toHaveBeenCalledOnce();
    expect(completed.retry).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it.each([
    ['服务身份', 'service' as const, ['erp:attendance:provider:pull']],
    ['交互用户', 'user' as const, ['erp:attendance:provider:pull']],
    ['缺少权限', 'system_job' as const, []],
  ])('拒绝%s直接执行供应商拉取', async (_label, actorType, scopes) => {
    const store = assemble();
    await expect(trustedRun(
      store, () => store.service.pullState(STATE_ID), actorType, scopes,
    )).rejects.toThrow('ATTENDANCE_PROVIDER_WORKER_REQUIRED');
    expect(store.states.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('未取得到期状态租约时幂等返回零', async () => {
    const store = assemble();
    store.setState(null);
    await expect(trustedRun(store, () => store.service.pullState(STATE_ID)))
      .resolves.toBe(0);
    expect(store.mappingModel.find).not.toHaveBeenCalled();
  });

  it('新事件加密写入 Inbox 并以租户和 Inbox 标识入处理队列', async () => {
    const store = assemble();
    store.pullBatch.mockResolvedValue([eventFixture]);
    await expect(trustedRun(store, () => store.service.pullState(STATE_ID)))
      .resolves.toBe(1);
    expect(store.crypto.providerFingerprints).toHaveBeenCalledWith(
      'tenant-001', 'event', 'feishu', eventFixture.externalEventId,
    );
    expect(store.inbox.create).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-001', stateId: STATE_ID, providerCode: 'feishu',
      eventBlindIndexes: ['blind-key.event-fingerprint'],
      transportRequestIdFingerprint:
        expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) as unknown,
      payloadKeyId: 'key-001', status: 'pending',
    }));
    expect(store.queue.add).toHaveBeenCalledWith(
      ATTENDANCE_PROVIDER_PROCESS_JOB,
      expect.objectContaining({ tenantId: 'tenant-001' }),
      expect.objectContaining({ attempts: 12 }),
    );
  });

  it.each([
    ['旧日期游标', '2026-07-01'],
    ['结构非法', { throughDate: 'bad', windowToDate: null, employeeAfterId: null }],
    ['分页字段不成对', {
      throughDate: '2026-07-01', windowToDate: null, employeeAfterId: MAPPING_ID,
    }],
  ])('%s按游标契约处理', async (_label, cursor) => {
    const store = assemble();
    store.setState({
      ...stateFixture,
      cursorKeyId: 'key-001', cursorIv: 'A'.repeat(16),
      cursorCiphertext: 'A'.repeat(32), cursorAuthTag: 'A'.repeat(22),
    });
    store.setCursorValue(cursor);
    const result = trustedRun(store, () => store.service.pullState(STATE_ID));
    if (_label === '旧日期游标') {
      await expect(result).resolves.toBe(0);
      expect(store.pullBatch).toHaveBeenCalledWith(expect.objectContaining({
        fromDate: '2026-07-01', toDate: '2026-07-07',
      }));
    } else {
      await expect(result).rejects.toThrow('ATTENDANCE_PROVIDER_CURSOR_INVALID');
      expect(store.pullBatch).not.toHaveBeenCalled();
    }
  });

  it('结构化分页游标绑定员工游标且允许末页为空', async () => {
    const store = assemble();
    store.setState({
      ...stateFixture,
      cursorKeyId: 'key-001', cursorIv: 'A'.repeat(16),
      cursorCiphertext: 'A'.repeat(32), cursorAuthTag: 'A'.repeat(22),
    });
    store.setCursorValue({
      throughDate: '2026-07-01', windowToDate: '2026-07-07', employeeAfterId: MAPPING_ID,
    });
    store.setMappings([]);
    await expect(trustedRun(store, () => store.service.pullState(STATE_ID)))
      .resolves.toBe(0);
    expect(store.mappingModel.find).toHaveBeenCalledWith(expect.objectContaining({
      id: { $gt: MAPPING_ID },
    }));
  });

  it('部分游标密文视为损坏数据而非初始游标', async () => {
    const store = assemble();
    store.setState({ ...stateFixture, cursorKeyId: 'key-001' });
    await expect(trustedRun(store, () => store.service.pullState(STATE_ID)))
      .rejects.toThrow('ATTENDANCE_PROVIDER_CURSOR_INVALID');
    expect(store.crypto.unprotect).not.toHaveBeenCalled();
    expect(store.states.updateOne).toHaveBeenCalledWith(
      expect.any(Object),
      { $set: expect.objectContaining({
        lastFailureCode: 'ATTENDANCE_PROVIDER_CURSOR_INVALID',
      }) as unknown },
      { runValidators: true },
    );
  });

  it('首次拉取缺少员工映射时记录稳定失败码并延迟重试', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-22T03:00:00.000Z'));
    const store = assemble();
    store.setMappings([]);
    await expect(trustedRun(store, () => store.service.pullState(STATE_ID)))
      .rejects.toThrow('ATTENDANCE_PROVIDER_EMPLOYEE_MAPPING_MISSING');
    expect(store.states.updateOne).toHaveBeenCalledWith(
      expect.any(Object),
      { $set: expect.objectContaining({
        lastFailureCode: 'ATTENDANCE_PROVIDER_EMPLOYEE_MAPPING_MISSING',
        nextPollAt: new Date('2026-07-22T03:01:00.000Z'),
      }) as unknown },
      { runValidators: true },
    );
  });

  it('外部员工密文非法时不把内部校验细节写入状态', async () => {
    const store = assemble();
    store.setExternalEmployeeId({});
    await expect(trustedRun(store, () => store.service.pullState(STATE_ID))).rejects.toBeDefined();
    expect(store.states.updateOne).toHaveBeenCalledWith(
      expect.any(Object),
      { $set: expect.objectContaining({
        lastFailureCode: 'ATTENDANCE_PROVIDER_PULL_FAILED',
      }) as unknown },
      { runValidators: true },
    );
  });

  it.each([
    ['成功提交丢失租约', [{ matchedCount: 0 }, { matchedCount: 1 }]],
    ['失败回写也丢失租约', [{ matchedCount: 0 }]],
  ])('%s时统一报告租约丢失', async (_label, results) => {
    const store = assemble();
    if (_label === '失败回写也丢失租约') store.setMappings([]);
    store.states.updateOne.mockReset();
    for (const result of results) store.states.updateOne.mockResolvedValueOnce(result);
    await expect(trustedRun(store, () => store.service.pullState(STATE_ID)))
      .rejects.toThrow('ATTENDANCE_PROVIDER_STATE_LEASE_LOST');
  });

  it('已存在的同一事件忽略 pulledAt 与对象键序并复用失败处理任务', async () => {
    const store = assemble();
    const retry = vi.fn();
    store.queue.getJob.mockResolvedValue({
      getState: vi.fn().mockResolvedValue('failed'), retry,
    });
    store.setInboxRecords([{
      id: '01J8ZQK7V0A2M4N6P8R0T2W4C3', tenantId: 'tenant-001',
      providerCode: 'feishu', providerOccurredAt: new Date(eventFixture.occurredAt),
      payloadKeyId: 'key-001', payloadIv: 'A'.repeat(16),
      payloadCiphertext: 'A'.repeat(32), payloadAuthTag: 'A'.repeat(22),
    }]);
    store.setInboxPayload({
      transportRequestId: eventFixture.transportRequestId,
      payload: {
        values: [null, true, 'text', 1],
        pulledAt: '2026-07-20T00:00:00.000Z', providerCode: 'feishu',
      },
    });
    store.pullBatch.mockResolvedValue([eventFixture]);
    await expect(trustedRun(store, () => store.service.pullState(STATE_ID)))
      .resolves.toBe(1);
    expect(store.inbox.create).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledOnce();
    expect(store.queue.add).not.toHaveBeenCalled();
  });

  it('既有事件的时间或规范化载荷漂移时拒绝覆盖', async () => {
    const store = assemble();
    store.setInboxRecords([{
      id: '01J8ZQK7V0A2M4N6P8R0T2W4C3', tenantId: 'tenant-001',
      providerCode: 'feishu', providerOccurredAt: new Date('2026-07-20T01:00:00.000Z'),
      payloadKeyId: 'key-001', payloadIv: 'A'.repeat(16),
      payloadCiphertext: 'A'.repeat(32), payloadAuthTag: 'A'.repeat(22),
    }]);
    store.pullBatch.mockResolvedValue([eventFixture]);
    await expect(trustedRun(store, () => store.service.pullState(STATE_ID)))
      .rejects.toThrow('ATTENDANCE_PROVIDER_EVENT_PAYLOAD_COLLISION');
    expect(store.inbox.create).not.toHaveBeenCalled();
  });

  it.each([
    ['并发插入后找到同一事件', { code: 11_000 }, true],
    ['并发插入后仍不存在', { code: 11_000 }, false],
    ['非唯一索引错误', new Error('DATABASE_UNAVAILABLE'), false],
  ])('%s时保持 Inbox 幂等', async (_label, creationError, raced) => {
    const store = assemble();
    const racedRecord = {
      id: '01J8ZQK7V0A2M4N6P8R0T2W4C3', tenantId: 'tenant-001',
      providerCode: 'feishu',
    };
    store.setInboxRecords([null, raced ? racedRecord : null]);
    store.inbox.create.mockRejectedValue(creationError);
    store.pullBatch.mockResolvedValue([eventFixture]);
    const operation = trustedRun(store, () => store.service.pullState(STATE_ID));
    if (raced) {
      await expect(operation).resolves.toBe(1);
      expect(store.queue.add).toHaveBeenCalledWith(
        ATTENDANCE_PROVIDER_PROCESS_JOB,
        { tenantId: 'tenant-001', inboxId: racedRecord.id },
        expect.any(Object),
      );
    } else {
      await expect(operation).rejects.toBe(creationError);
    }
  });

  it('已有非失败处理任务不重复入队', async () => {
    const store = assemble();
    store.queue.getJob.mockResolvedValue({
      getState: vi.fn().mockResolvedValue('completed'), retry: vi.fn(),
    });
    store.setInboxRecords([{
      id: '01J8ZQK7V0A2M4N6P8R0T2W4C3', tenantId: 'tenant-001',
      providerCode: 'feishu', providerOccurredAt: new Date(eventFixture.occurredAt),
      payloadKeyId: 'key-001', payloadIv: 'A'.repeat(16),
      payloadCiphertext: 'A'.repeat(32), payloadAuthTag: 'A'.repeat(22),
    }]);
    store.pullBatch.mockResolvedValue([eventFixture]);
    await expect(trustedRun(store, () => store.service.pullState(STATE_ID))).resolves.toBe(1);
    expect(store.queue.add).not.toHaveBeenCalled();
  });

  it.each([
    ['非有限数字', Number.NaN, 'ATTENDANCE_PROVIDER_PAYLOAD_INVALID'],
    ['超大数组', Array.from({ length: 10_001 }, () => null),
      'ATTENDANCE_PROVIDER_PAYLOAD_TOO_LARGE'],
    ['函数值', () => undefined, 'ATTENDANCE_PROVIDER_PAYLOAD_INVALID'],
  ])('既有事件包含%s时拒绝比较', async (_label, payload, code) => {
    const store = assemble();
    store.setInboxRecords([{
      id: '01J8ZQK7V0A2M4N6P8R0T2W4C3', tenantId: 'tenant-001',
      providerCode: 'feishu', providerOccurredAt: new Date(eventFixture.occurredAt),
      payloadKeyId: 'key-001', payloadIv: 'A'.repeat(16),
      payloadCiphertext: 'A'.repeat(32), payloadAuthTag: 'A'.repeat(22),
    }]);
    store.setInboxPayload({
      payload, transportRequestId: eventFixture.transportRequestId,
    });
    store.pullBatch.mockResolvedValue([{ ...eventFixture, payload }]);
    await expect(trustedRun(store, () => store.service.pullState(STATE_ID)))
      .rejects.toThrow(code);
  });

  it('既有事件载荷嵌套超过二十层时拒绝比较', async () => {
    let payload: unknown = 'leaf';
    for (let depth = 0; depth < 22; depth += 1) payload = [payload];
    const store = assemble();
    store.setInboxRecords([{
      id: '01J8ZQK7V0A2M4N6P8R0T2W4C3', tenantId: 'tenant-001',
      providerCode: 'feishu', providerOccurredAt: new Date(eventFixture.occurredAt),
      payloadKeyId: 'key-001', payloadIv: 'A'.repeat(16),
      payloadCiphertext: 'A'.repeat(32), payloadAuthTag: 'A'.repeat(22),
    }]);
    store.setInboxPayload({
      payload, transportRequestId: eventFixture.transportRequestId,
    });
    store.pullBatch.mockResolvedValue([{ ...eventFixture, payload }]);
    await expect(trustedRun(store, () => store.service.pullState(STATE_ID)))
      .rejects.toThrow('ATTENDANCE_PROVIDER_PAYLOAD_TOO_DEEP');
  });
});
