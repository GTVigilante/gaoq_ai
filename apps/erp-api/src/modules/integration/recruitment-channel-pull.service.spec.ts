import type { Queue } from 'bullmq';
import type { Model } from 'mongoose';
import { ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { TenantContextService } from '../../core/tenant/tenant-context.service.js';
import type { RecruitmentDataCryptoService } from '../recruitment/persistence/recruitment-data-crypto.service.js';
import {
  RecruitmentChannelAdapter,
  RecruitmentChannelEvidenceVerifier,
  RecruitmentChannelNormalizer,
  RecruitmentChannelRegistry,
} from './recruitment-channel.adapter.js';
import {
  RecruitmentChannelPullService,
  RecruitmentChannelSecretResolver,
} from './recruitment-channel-pull.service.js';
import {
  RECRUITMENT_CHANNEL_PULL_JOB,
  type RecruitmentChannelJobData,
} from './recruitment-channel.queue.js';
import type {
  RecruitmentChannelBindingDocument,
  RecruitmentChannelInboxDocument,
} from './recruitment-channel.schemas.js';

const BINDING_ID = '01J8ZQK7V0A2M4N6P8R0T2W4C1';
const FINGERPRINT = `blind-key-001.${'A'.repeat(43)}`;

class Adapter extends RecruitmentChannelAdapter {
  readonly channelCode = 'sandbox_ats';
  readonly pullApplications = vi.fn().mockResolvedValue({
    deliveries: [{
      externalEventId: 'event-external-001', occurredAt: '2026-07-21T00:00:00.000Z',
      payload: { candidate: '原始候选人数据' },
    }],
    nextCursor: 'cursor-next-001', hasMore: false,
  });
  publishPosition() { return Promise.reject(new Error('未用')); }
  closePosition() { return Promise.reject(new Error('未用')); }
  acknowledgeStage() { return Promise.reject(new Error('未用')); }
}

class Normalizer extends RecruitmentChannelNormalizer {
  readonly channelCode = 'sandbox_ats';
  readonly schemaVersion = 'v1';
  normalize() { return Promise.reject(new Error('未用')); }
}

class Verifier extends RecruitmentChannelEvidenceVerifier {
  readonly channelCode = 'sandbox_ats';
  verify() { return Promise.reject(new Error('未用')); }
}

function query<T>(value: T) {
  const chain = { lean: vi.fn(() => chain), exec: vi.fn().mockResolvedValue(value) };
  return chain;
}

function fixture() {
  const context = new TenantContextService();
  const binding = {
    id: BINDING_ID, tenantId: 'tenant-001', channelCode: 'sandbox_ats',
    credentialSecretRef: 'GAOQ_RECRUITMENT_CHANNEL_SANDBOX', status: 'active',
    cursorKeyId: null as string | null, cursorIv: null as string | null,
    cursorCiphertext: null as string | null, cursorAuthTag: null as string | null,
  };
  const bindingState = { value: binding as typeof binding | null };
  const dueState = { value: binding as typeof binding | null };
  const bindings = {
    findOne: vi.fn(() => query(bindingState.value)),
    findOneAndUpdate: vi.fn(() => {
      const current = dueState.value;
      dueState.value = null;
      return query(current);
    }),
    updateOne: vi.fn().mockResolvedValue({ matchedCount: 1 }),
  };
  const inboxState = { value: null as Record<string, unknown> | null };
  const inbox = {
    findOne: vi.fn(() => query(inboxState.value)),
    create: vi.fn().mockResolvedValue(undefined),
  };
  const crypto = {
    channelFingerprints: vi.fn().mockReturnValue([FINGERPRINT]),
    protect: vi.fn().mockImplementation((cryptoContext: { resourceType: string }) =>
      cryptoContext.resourceType === 'channel_cursor'
        ? { keyId: 'cursor-key', iv: 'cursor-iv', ciphertext: 'cursor-cipher', authTag: 'cursor-tag' }
        : { keyId: 'payload-key', iv: 'payload-iv', ciphertext: 'payload-cipher', authTag: 'payload-tag' }),
    unprotect: vi.fn().mockReturnValue('cursor-current-001'),
  };
  const queue = {
    add: vi.fn().mockResolvedValue(undefined),
    getJob: vi.fn().mockResolvedValue(undefined),
  };
  const adapter = new Adapter();
  const secrets = { resolve: vi.fn().mockReturnValue('credential-not-logged') };
  const service = new RecruitmentChannelPullService(
    bindings as unknown as Model<RecruitmentChannelBindingDocument>,
    inbox as unknown as Model<RecruitmentChannelInboxDocument>,
    context,
    crypto as unknown as RecruitmentDataCryptoService,
    new RecruitmentChannelRegistry([adapter], [new Normalizer()], [new Verifier()]),
    secrets,
    queue as unknown as Queue<RecruitmentChannelJobData>,
  );
  const trusted = {
    tenant: { tenantId: 'tenant-001', source: 'service_identity' as const },
    actor: {
      actorId: 'system:channel', actorType: 'system_job' as const, tenantId: 'tenant-001',
      roleCodes: [], scopes: ['erp:recruitment:channel:pull'], departmentIds: [],
      traceId: BINDING_ID,
    },
  };
  return {
    service, context, trusted, binding, bindingState, dueState, bindings, inboxState, inbox,
    crypto, queue, adapter, secrets,
  };
}

function pull(store: ReturnType<typeof fixture>) {
  return store.context.run(
    store.trusted,
    () => store.service.pullBinding(BINDING_ID),
  );
}

function duplicateKeyError(): Error & { code: number } {
  return Object.assign(new Error('duplicate key'), { code: 11_000 });
}

function expectUnavailable(operation: () => unknown, code: string): void {
  try {
    operation();
    throw new Error('预期凭据解析失败');
  } catch (error) {
    if (!(error instanceof ServiceUnavailableException)) throw error;
    const response = error.getResponse();
    expect(response).toMatchObject({ code });
  }
}

describe('RecruitmentChannelPullService', () => {
  it('补拉后先以盲指纹去重和加密入箱，再更新加密游标', async () => {
    const context = new TenantContextService();
    const binding = {
      id: BINDING_ID, tenantId: 'tenant-001', channelCode: 'sandbox_ats',
      credentialSecretRef: 'GAOQ_RECRUITMENT_CHANNEL_SANDBOX', status: 'active',
      cursorKeyId: null, cursorIv: null, cursorCiphertext: null, cursorAuthTag: null,
    };
    const bindings = {
      findOne: vi.fn(() => query(binding)),
      updateOne: vi.fn().mockResolvedValue({ matchedCount: 1 }),
    };
    const inbox = {
      findOne: vi.fn(() => query(null)),
      create: vi.fn().mockResolvedValue(undefined),
    };
    const crypto = {
      channelFingerprints: vi.fn().mockReturnValue([FINGERPRINT]),
      protect: vi.fn().mockImplementation((cryptoContext: { resourceType: string }) =>
        cryptoContext.resourceType === 'channel_cursor'
          ? { keyId: 'cursor-key', iv: 'cursor-iv', ciphertext: 'cursor-cipher', authTag: 'cursor-tag' }
          : { keyId: 'payload-key', iv: 'payload-iv', ciphertext: 'payload-cipher', authTag: 'payload-tag' }),
      unprotect: vi.fn(),
    };
    const queue = {
      add: vi.fn().mockResolvedValue(undefined),
      getJob: vi.fn().mockResolvedValue(undefined),
    };
    const adapter = new Adapter();
    const service = new RecruitmentChannelPullService(
      bindings as unknown as Model<RecruitmentChannelBindingDocument>,
      inbox as unknown as Model<RecruitmentChannelInboxDocument>,
      context,
      crypto as unknown as RecruitmentDataCryptoService,
      new RecruitmentChannelRegistry([adapter], [new Normalizer()], [new Verifier()]),
      { resolve: vi.fn().mockReturnValue('credential-not-logged') },
      queue as unknown as Queue<RecruitmentChannelJobData>,
    );
    const trusted = {
      tenant: { tenantId: 'tenant-001', source: 'service_identity' as const },
      actor: {
        actorId: 'system:channel', actorType: 'system_job' as const, tenantId: 'tenant-001',
        roleCodes: [], scopes: ['erp:recruitment:channel:pull'], departmentIds: [], traceId: BINDING_ID,
      },
    };
    await expect(context.run(trusted, () => service.pullBinding(BINDING_ID))).resolves.toBe(1);
    expect(adapter.pullApplications).toHaveBeenCalledWith('credential-not-logged', {
      tenantId: 'tenant-001', cursor: null, limit: 100,
    });
    const inserted = inbox.create.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(inserted).toMatchObject({
      tenantId: 'tenant-001', channelCode: 'sandbox_ats',
      eventBlindIndexes: [FINGERPRINT], payloadCiphertext: 'payload-cipher', status: 'pending',
    });
    expect(JSON.stringify(inserted)).not.toMatch(/event-external-001|原始候选人数据/iu);
    expect(queue.add).toHaveBeenCalledWith(
      'process:recruitment:application',
      expect.objectContaining({ tenantId: 'tenant-001' }),
      expect.objectContaining({ attempts: 12 }),
    );
    const bindingUpdate = bindings.updateOne.mock.calls[0];
    expect(bindingUpdate?.[0]).toMatchObject({ tenantId: 'tenant-001', id: BINDING_ID });
    expect((bindingUpdate?.[1] as { $set?: unknown }).$set).toMatchObject({
      cursorKeyId: 'cursor-key', cursorCiphertext: 'cursor-cipher', lastFailureCode: null,
    });
    expect(bindingUpdate?.[2]).toEqual({ runValidators: true });
  });

  it('同一确定性任务已失败时显式 retry，不能依赖 BullMQ add 静默重放', async () => {
    const failedJob = {
      getState: vi.fn().mockResolvedValue('failed'),
      retry: vi.fn().mockResolvedValue(undefined),
    };
    const queue = {
      add: vi.fn().mockResolvedValue(undefined),
      getJob: vi.fn().mockResolvedValue(failedJob),
    };
    const service = new RecruitmentChannelPullService(
      {} as Model<RecruitmentChannelBindingDocument>,
      {} as Model<RecruitmentChannelInboxDocument>,
      new TenantContextService(),
      {} as RecruitmentDataCryptoService,
      new RecruitmentChannelRegistry([], [], []),
      { resolve: vi.fn() },
      queue as unknown as Queue<RecruitmentChannelJobData>,
    );
    await (service as unknown as {
      enqueueInbox(tenantId: string, inboxId: string): Promise<void>;
    }).enqueueInbox('tenant-001', BINDING_ID);
    expect(failedJob.retry).toHaveBeenCalledOnce();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('凭据解析器只接受受控命名空间和合理长度的环境注入', () => {
    const resolver = new RecruitmentChannelSecretResolver();
    expectUnavailable(
      () => resolver.resolve('OTHER_SECRET'),
      'RECRUITMENT_CHANNEL_SECRET_REF_INVALID',
    );
    expectUnavailable(
      () => resolver.resolve('GAOQ_RECRUITMENT_CHANNEL_MISSING'),
      'RECRUITMENT_CHANNEL_CREDENTIAL_UNAVAILABLE',
    );
    vi.stubEnv('GAOQ_RECRUITMENT_CHANNEL_TEST', 'x'.repeat(16));
    try {
      expect(resolver.resolve('GAOQ_RECRUITMENT_CHANNEL_TEST')).toBe('x'.repeat(16));
      vi.stubEnv('GAOQ_RECRUITMENT_CHANNEL_TEST', 'short');
      expectUnavailable(
        () => resolver.resolve('GAOQ_RECRUITMENT_CHANNEL_TEST'),
        'RECRUITMENT_CHANNEL_CREDENTIAL_UNAVAILABLE',
      );
      vi.stubEnv('GAOQ_RECRUITMENT_CHANNEL_TEST', 'x'.repeat(16_385));
      expectUnavailable(
        () => resolver.resolve('GAOQ_RECRUITMENT_CHANNEL_TEST'),
        'RECRUITMENT_CHANNEL_CREDENTIAL_UNAVAILABLE',
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([-1, 501])('调度批量上限 %s 被安全收敛且任务键稳定', async (limit) => {
    const store = fixture();
    await expect(store.service.enqueueDueBindings(limit)).resolves.toBe(1);
    const call = store.queue.add.mock.calls[0];
    const options = call?.[2] as { jobId?: unknown; attempts?: number } | undefined;
    expect(call?.[0]).toBe(RECRUITMENT_CHANNEL_PULL_JOB);
    expect(call?.[1]).toEqual({ tenantId: 'tenant-001', bindingId: BINDING_ID });
    expect(typeof options?.jobId).toBe('string');
    expect(options?.attempts).toBe(8);
  });

  it('没有到期绑定时调度返回零', async () => {
    const store = fixture();
    store.dueState.value = null;
    await expect(store.service.enqueueDueBindings()).resolves.toBe(0);
    expect(store.queue.add).not.toHaveBeenCalled();
  });

  it('非系统任务身份或缺少拉取 Scope 时失败关闭', async () => {
    const store = fixture();
    const denied = {
      ...store.trusted,
      actor: { ...store.trusted.actor, actorType: 'user' as const, scopes: [] },
    };
    await expect(store.context.run(
      denied,
      () => store.service.pullBinding(BINDING_ID),
    )).rejects.toThrow('RECRUITMENT_CHANNEL_WORKER_REQUIRED');
    expect(store.bindings.findOne).not.toHaveBeenCalled();
  });

  it('绑定不存在时不得解析渠道凭据', async () => {
    const store = fixture();
    store.bindingState.value = null;
    await expect(pull(store)).rejects.toThrow('RECRUITMENT_CHANNEL_BINDING_NOT_FOUND');
    expect(store.secrets.resolve).not.toHaveBeenCalled();
  });

  it('凭据不可用时回写稳定失败码并保留原始异常', async () => {
    const store = fixture();
    const unavailableError = new ServiceUnavailableException({
      code: 'RECRUITMENT_CHANNEL_CREDENTIAL_UNAVAILABLE',
      message: '招聘渠道凭据不可用',
    });
    store.secrets.resolve.mockImplementationOnce(() => {
      throw unavailableError;
    });
    await expect(pull(store)).rejects.toBe(unavailableError);
    const failure = store.bindings.updateOne.mock.calls[0]?.[1] as {
      $set?: { lastFailureCode?: string };
    } | undefined;
    expect(failure?.$set?.lastFailureCode).toBe(
      'RECRUITMENT_CHANNEL_CREDENTIAL_UNAVAILABLE',
    );
  });

  it('完整加密游标只在可信租户上下文中解密', async () => {
    const store = fixture();
    Object.assign(store.binding, {
      cursorKeyId: 'cursor-key', cursorIv: 'cursor-iv',
      cursorCiphertext: 'cursor-cipher', cursorAuthTag: 'cursor-tag',
    });
    await expect(pull(store)).resolves.toBe(1);
    expect(store.adapter.pullApplications).toHaveBeenCalledWith(
      'credential-not-logged',
      expect.objectContaining({ cursor: 'cursor-current-001' }),
    );
  });

  it.each([
    { cursorKeyId: 'cursor-key' },
    { cursorIv: 'cursor-iv' },
    { cursorCiphertext: 'cursor-cipher' },
    { cursorAuthTag: 'cursor-tag' },
  ])('部分游标密文字段必须失败关闭：%j', async (cursor) => {
    const store = fixture();
    Object.assign(store.binding, cursor);
    await expect(pull(store)).rejects.toThrow('RECRUITMENT_CHANNEL_CURSOR_INVALID');
    expect(store.adapter.pullApplications).not.toHaveBeenCalled();
  });

  it.each([undefined, 'x'.repeat(2_049)])('拒绝解密后的非法游标：%s', async (cursor) => {
    const store = fixture();
    Object.assign(store.binding, {
      cursorKeyId: 'cursor-key', cursorIv: 'cursor-iv',
      cursorCiphertext: 'cursor-cipher', cursorAuthTag: 'cursor-tag',
    });
    store.crypto.unprotect.mockReturnValue(cursor);
    await expect(pull(store)).rejects.toThrow('RECRUITMENT_CHANNEL_CURSOR_INVALID');
  });

  it('渠道返回空游标时清除全部游标密文字段', async () => {
    const store = fixture();
    store.adapter.pullApplications.mockResolvedValueOnce({
      deliveries: [], nextCursor: null, hasMore: false,
    });
    await expect(pull(store)).resolves.toBe(0);
    const update = store.bindings.updateOne.mock.calls[0]?.[1] as {
      $set?: Record<string, unknown>;
    } | undefined;
    expect(update?.$set).toMatchObject({
      cursorKeyId: null, cursorIv: null,
      cursorCiphertext: null, cursorAuthTag: null,
    });
  });

  it.each(['', 'x'.repeat(2_049)])('拒绝渠道返回的非法下一游标：%s', async (cursor) => {
    const store = fixture();
    store.adapter.pullApplications.mockResolvedValueOnce({
      deliveries: [], nextCursor: cursor, hasMore: false,
    });
    await expect(pull(store)).rejects.toThrow('RECRUITMENT_CHANNEL_CURSOR_INVALID');
  });

  it('有更多数据时必须同时返回下一游标', async () => {
    const store = fixture();
    store.adapter.pullApplications.mockResolvedValueOnce({
      deliveries: [], nextCursor: null, hasMore: true,
    });
    await expect(pull(store)).rejects.toThrow('RECRUITMENT_CHANNEL_PULL_RESULT_INVALID');
  });

  it('单次渠道投递数量不得超过协议上限', async () => {
    const store = fixture();
    const delivery = {
      externalEventId: 'event-001', occurredAt: '2026-07-21T00:00:00.000Z', payload: {},
    };
    store.adapter.pullApplications.mockResolvedValueOnce({
      deliveries: Array.from({ length: 101 }, () => delivery),
      nextCursor: 'cursor-next', hasMore: false,
    });
    await expect(pull(store)).rejects.toThrow('RECRUITMENT_CHANNEL_PULL_RESULT_INVALID');
  });

  it.each([
    { externalEventId: '', occurredAt: '2026-07-21T00:00:00.000Z' },
    { externalEventId: 'x'.repeat(257), occurredAt: '2026-07-21T00:00:00.000Z' },
    { externalEventId: 'event-001', occurredAt: 'invalid-date' },
    {
      externalEventId: 'event-001',
      occurredAt: new Date(Date.now() + 6 * 60 * 1_000).toISOString(),
    },
  ])('拒绝非法渠道投递元数据：%j', async (delivery) => {
    const store = fixture();
    store.adapter.pullApplications.mockResolvedValueOnce({
      deliveries: [{ ...delivery, payload: {} }],
      nextCursor: 'cursor-next', hasMore: false,
    });
    await expect(pull(store)).rejects.toThrow('RECRUITMENT_CHANNEL_DELIVERY_INVALID');
  });

  it('已入箱事件只恢复确定性处理任务，不重复保存密文', async () => {
    const store = fixture();
    store.inboxState.value = {
      id: 'inbox-existing', tenantId: 'tenant-001', status: 'pending',
    };
    await expect(pull(store)).resolves.toBe(1);
    expect(store.inbox.create).not.toHaveBeenCalled();
    expect(store.queue.add).toHaveBeenCalledWith(
      'process:recruitment:application',
      { tenantId: 'tenant-001', inboxId: 'inbox-existing' },
      expect.any(Object),
    );
  });

  it('已有未失败处理任务时不重复入队或重试', async () => {
    const store = fixture();
    store.inboxState.value = {
      id: 'inbox-existing', tenantId: 'tenant-001', status: 'pending',
    };
    const existingJob = {
      getState: vi.fn().mockResolvedValue('waiting'),
      retry: vi.fn().mockResolvedValue(undefined),
    };
    store.queue.getJob.mockResolvedValueOnce(existingJob);
    await expect(pull(store)).resolves.toBe(1);
    expect(existingJob.retry).not.toHaveBeenCalled();
    expect(store.queue.add).not.toHaveBeenCalled();
  });

  it('入箱唯一键竞态后复用胜出记录', async () => {
    const store = fixture();
    store.inbox.create.mockImplementationOnce(() => {
      store.inboxState.value = {
        id: 'inbox-raced', tenantId: 'tenant-001', status: 'pending',
      };
      return Promise.reject(duplicateKeyError());
    });
    await expect(pull(store)).resolves.toBe(1);
    expect(store.queue.add).toHaveBeenCalledWith(
      'process:recruitment:application',
      { tenantId: 'tenant-001', inboxId: 'inbox-raced' },
      expect.any(Object),
    );
  });

  it.each([
    new Error('database unavailable'),
    duplicateKeyError(),
  ])('入箱异常无法收敛时原样失败关闭：%s', async (error) => {
    const store = fixture();
    store.inbox.create.mockRejectedValueOnce(error);
    await expect(pull(store)).rejects.toBe(error);
  });

  it('成功游标更新租约丢失时记录稳定失败码', async () => {
    const store = fixture();
    store.bindings.updateOne
      .mockResolvedValueOnce({ matchedCount: 0 })
      .mockResolvedValueOnce({ matchedCount: 1 });
    await expect(pull(store)).rejects.toThrow('RECRUITMENT_CHANNEL_BINDING_LEASE_LOST');
    const failure = store.bindings.updateOne.mock.calls[1]?.[1] as {
      $set?: { lastFailureCode?: string };
    } | undefined;
    expect(failure?.$set?.lastFailureCode).toBe('RECRUITMENT_CHANNEL_BINDING_LEASE_LOST');
  });

  it('失败状态租约丢失时以独立错误失败关闭', async () => {
    const store = fixture();
    store.adapter.pullApplications.mockRejectedValueOnce(new Error('UPSTREAM_TIMEOUT'));
    store.bindings.updateOne.mockResolvedValueOnce({ matchedCount: 0 });
    await expect(pull(store)).rejects.toThrow(
      'RECRUITMENT_CHANNEL_BINDING_FAILURE_LEASE_LOST',
    );
  });

  it('供应商响应错误码优先进入失败状态', async () => {
    const store = fixture();
    store.adapter.pullApplications.mockRejectedValueOnce({
      response: { code: 'CHANNEL_TEMPORARILY_UNAVAILABLE' },
    });
    await expect(pull(store)).rejects.toBeDefined();
    const failure = store.bindings.updateOne.mock.calls[0]?.[1] as {
      $set?: { lastFailureCode?: string };
    } | undefined;
    expect(failure?.$set?.lastFailureCode).toBe('CHANNEL_TEMPORARILY_UNAVAILABLE');
  });

  it('不稳定异常消息统一归类为通用失败码', async () => {
    const store = fixture();
    store.adapter.pullApplications.mockRejectedValueOnce(new Error('temporary failure'));
    await expect(pull(store)).rejects.toThrow('temporary failure');
    const failure = store.bindings.updateOne.mock.calls[0]?.[1] as {
      $set?: { lastFailureCode?: string };
    } | undefined;
    expect(failure?.$set?.lastFailureCode).toBe('RECRUITMENT_CHANNEL_PULL_FAILED');
  });
});
