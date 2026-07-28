import type { Queue } from 'bullmq';
import type { Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../../core/audit/audit.service.js';
import type { IdempotencyService } from '../../core/idempotency/idempotency.service.js';
import type { TenantContextService } from '../../core/tenant/tenant-context.service.js';
import type { RecruitmentOfferService } from '../recruitment/application/recruitment-offer.service.js';
import type {
  RecruitmentESignSourceService,
} from '../recruitment/application/recruitment-esign-source.service.js';
import type { ESignAdapter } from './esign.adapter.js';
import type { ESignBindingDocument } from './esign-binding.schema.js';
import type { ESignFlowService } from './esign-flow.service.js';
import type { ESignIssuanceRequestDocument } from './esign-issuance.schema.js';
import { ESignIssuanceService } from './esign-issuance.service.js';
import type { ESignWebhookCryptoService } from './esign-webhook-crypto.service.js';
import {
  ESIGN_ISSUE_FLOW_JOB,
  createESignIssuanceJobId,
  type ESignQueueJobData,
} from './esign-webhook.queue.js';

const REQUEST_ID = '01J8ZQK7V0A2M4N6P8R0T2W4D1';
const OFFER_ID = '01J8ZQK7V0A2M4N6P8R0T2W4D2';
const FLOW_ID = '01J8ZQK7V0A2M4N6P8R0T2W4D3';
const TENANT_ID = 'tenant-001';

function query<T>(value: T) {
  return { lean: () => ({ exec: () => Promise.resolve(value) }) };
}

function listQuery<T>(value: T) {
  return {
    sort: () => ({
      limit: () => ({ lean: () => ({ exec: () => Promise.resolve(value) }) }),
    }),
  };
}

function protectedValue(prefix: string) {
  return {
    externalIdKeyId: `${prefix}-key-001`,
    externalIdIv: 'A'.repeat(16),
    externalIdCiphertext: 'B'.repeat(32),
    externalIdAuthTag: 'C'.repeat(22),
  };
}

function pendingRecord() {
  return {
    id: REQUEST_ID,
    tenantId: TENANT_ID,
    offerId: OFFER_ID,
    offerVersion: 6,
    providerFileKeyId: 'provider-key-001',
    providerFileIv: 'A'.repeat(16),
    providerFileCiphertext: 'B'.repeat(32),
    providerFileAuthTag: 'C'.repeat(22),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000),
    signaturePage: 1,
    signatureX: 100,
    signatureY: 200,
    status: 'pending',
    attempts: 0,
    nextAttemptAt: new Date(0),
    lockedAt: null,
    lockedBy: null,
    failureCode: null,
    externalFlowKeyId: null,
    externalFlowIv: null,
    externalFlowCiphertext: null,
    externalFlowAuthTag: null,
    flowId: null,
    createdByActorId: 'actor-001',
    operatorResolutionCount: 0,
    operatorResolvedAt: null,
    succeededAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function fixture(scopes: readonly string[] = [
  'erp:integration:esign:initiate',
  'erp:integration:esign:operate',
  'erp:integration:esign:create',
  'erp:recruitment:offer:read_all',
]) {
  const context = {
    getTenantRequired: () => ({ tenantId: TENANT_ID }),
    getActorRequired: () => ({ actorId: 'actor-001', scopes, departmentIds: [] }),
  };
  const idempotency = {
    execute: vi.fn().mockImplementation(
      async (
        _operation: string,
        _key: string,
        _input: unknown,
        callback: (session: unknown) => Promise<unknown>,
      ) =>
        callback({ id: 'session-001' }),
    ),
  };
  const offers = {
    get: vi.fn().mockResolvedValue({
      id: OFFER_ID,
      status: 'accepted',
      esignFlowId: null,
      version: 6,
    }),
  };
  const source = {
    getAcceptedOfferSubject: vi.fn().mockResolvedValue({
      offerId: OFFER_ID,
      offerVersion: 6,
      candidateId: '01J8ZQK7V0A2M4N6P8R0T2W4D4',
      signerName: '张三',
      signerAccount: '+8613800138000',
    }),
  };
  const adapter = { createFlow: vi.fn().mockResolvedValue('external-flow-001') };
  const bindings = {
    findOne: vi.fn().mockReturnValue(query({
      id: '01J8ZQK7V0A2M4N6P8R0T2W4D5',
      tenantId: TENANT_ID,
      provider: 'esign_cn',
      appId: 'app12345',
      credentialSecretRef: 'GAOQ_ESIGN_APP_TEST',
      status: 'active',
    })),
  };
  const requests = {
    create: vi.fn().mockImplementation(
      (records: readonly Record<string, unknown>[]) => Promise.resolve([{
        toObject: () => ({
          ...records[0],
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      }]),
    ),
    findOneAndUpdate: vi.fn().mockImplementation(
      (_filter: unknown, update: {
        readonly $set?: Readonly<Record<string, unknown>>;
        readonly $inc?: { readonly attempts?: number };
      }) => {
        const base = pendingRecord();
        return query({
          ...base,
          ...update.$set,
          attempts: base.attempts + (update.$inc?.attempts ?? 0),
          updatedAt: new Date(),
        });
      },
    ),
    find: vi.fn().mockReturnValue(listQuery([])),
    updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
    updateMany: vi.fn().mockResolvedValue({ modifiedCount: 0 }),
  };
  const crypto = {
    protectExternalId: vi.fn().mockImplementation(
      (_tenantId: string, _id: string, value: string) =>
        protectedValue(value.startsWith('provider') ? 'provider' : 'flow'),
    ),
    unprotectExternalId: vi.fn().mockImplementation(
      (_tenantId: string, _id: string, value: { externalIdKeyId: string }) =>
        value.externalIdKeyId.startsWith('provider')
          ? 'provider-file-001'
          : 'external-flow-001',
    ),
  };
  const flows = {
    registerForOffer: vi.fn().mockResolvedValue({ id: FLOW_ID }),
  };
  const audit = { recordSystem: vi.fn().mockResolvedValue(undefined) };
  const queue = { add: vi.fn().mockResolvedValue({ id: 'job-001' }) };
  const service = new ESignIssuanceService(
    requests as unknown as Model<ESignIssuanceRequestDocument>,
    bindings as unknown as Model<ESignBindingDocument>,
    context as unknown as TenantContextService,
    idempotency as unknown as IdempotencyService,
    offers as unknown as RecruitmentOfferService,
    source as unknown as RecruitmentESignSourceService,
    adapter as unknown as ESignAdapter,
    { resolve: () => 'test-only-app-secret' },
    crypto as unknown as ESignWebhookCryptoService,
    flows as unknown as ESignFlowService,
    audit as unknown as AuditService,
    queue as unknown as Queue<ESignQueueJobData>,
  );
  return {
    service,
    context,
    idempotency,
    offers,
    source,
    adapter,
    bindings,
    requests,
    crypto,
    flows,
    audit,
    queue,
  };
}

function requestInput() {
  return {
    offerId: OFFER_ID,
    providerFileId: 'provider-file-001',
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString(),
    signaturePosition: { page: 1, x: 100, y: 200 },
    idempotencyKey: 'esign-request-key-001',
  };
}

function claimWith(
  store: ReturnType<typeof fixture>,
  patch: Readonly<Record<string, unknown>>,
) {
  const base = pendingRecord();
  store.requests.findOneAndUpdate.mockImplementationOnce(
    (_filter: unknown, update: {
      readonly $set: Readonly<Record<string, unknown>>;
      readonly $inc: { readonly attempts: number };
    }) => query({
      ...base,
      ...update.$set,
      attempts: base.attempts + update.$inc.attempts,
      ...patch,
    }),
  );
}

describe('ESignIssuanceService', () => {
  it('先持久化加密发起意图，再以确定性无敏感载荷任务入队', async () => {
    const store = fixture();
    const result = await store.service.request(requestInput());
    expect(result.request).toMatchObject({
      offerId: OFFER_ID,
      offerVersion: 6,
      status: 'pending',
      attempts: 0,
    });
    const record = (store.requests.create.mock.calls[0]?.[0] as Record<string, unknown>[])[0];
    expect(record).not.toHaveProperty('providerFileId');
    expect(JSON.stringify(record)).not.toMatch(/张三|13800138000/u);
    expect(record).toMatchObject({
      providerFileKeyId: 'provider-key-001',
      createdByActorId: 'actor-001',
    });
    expect(store.queue.add).toHaveBeenCalledWith(
      ESIGN_ISSUE_FLOW_JOB,
      { requestId: result.request.id, tenantId: TENANT_ID },
      expect.objectContaining({
        jobId: createESignIssuanceJobId(TENANT_ID, result.request.id),
        removeOnComplete: true,
        removeOnFail: true,
      }),
    );
  });

  it('无发起 Scope、Offer 非 accepted 或请求非法时在持久化前拒绝', async () => {
    const denied = fixture([]);
    await expect(denied.service.request(requestInput()))
      .rejects.toMatchObject({ response: { code: 'ESIGN_ISSUANCE_SCOPE_DENIED' } });
    expect(denied.offers.get).not.toHaveBeenCalled();

    const invalidOffer = fixture();
    invalidOffer.offers.get.mockResolvedValueOnce({
      status: 'sent',
      esignFlowId: null,
      version: 5,
    });
    await expect(invalidOffer.service.request(requestInput()))
      .rejects.toMatchObject({ response: { code: 'ESIGN_ISSUANCE_OFFER_STATE_INVALID' } });

    const invalidInput = fixture();
    await expect(invalidInput.service.request({
      ...requestInput(),
      providerFileId: '../file',
    })).rejects.toMatchObject({ response: { code: 'ESIGN_ISSUANCE_REQUEST_INVALID' } });
    expect(invalidInput.offers.get).not.toHaveBeenCalled();
  });

  it('拒绝已有签署流程的 Offer 和非法发起主体', async () => {
    const linked = fixture();
    linked.offers.get.mockResolvedValueOnce({
      id: OFFER_ID,
      status: 'accepted',
      esignFlowId: FLOW_ID,
      version: 6,
    });
    await expect(linked.service.request(requestInput())).rejects.toMatchObject({
      response: { code: 'ESIGN_ISSUANCE_OFFER_STATE_INVALID' },
    });

    const actor = fixture();
    actor.context.getActorRequired = () => ({
      actorId: '../actor',
      scopes: ['erp:integration:esign:initiate'],
      departmentIds: [],
    });
    await expect(actor.service.request(requestInput())).rejects.toMatchObject({
      response: { code: 'ESIGN_ISSUANCE_ACTOR_INVALID' },
    });
    expect(actor.requests.create).not.toHaveBeenCalled();
  });

  it.each([
    ['Offer 标识', () => ({ offerId: 'bad-offer' })],
    ['非 ISO 到期时间', () => ({ expiresAt: 'not-a-date' })],
    ['非规范 ISO 到期时间', () => ({ expiresAt: '2026-08-01T00:00:00Z' })],
    ['到期时间过近', () => ({
      expiresAt: new Date(Date.now() + 10 * 60 * 1_000).toISOString(),
    })],
    ['到期时间过远', () => ({
      expiresAt: new Date(Date.now() + 91 * 24 * 60 * 60 * 1_000).toISOString(),
    })],
    ['页码非整数', () => ({ signaturePosition: { page: 1.5, x: 100, y: 200 } })],
    ['页码过小', () => ({ signaturePosition: { page: 0, x: 100, y: 200 } })],
    ['页码过大', () => ({ signaturePosition: { page: 10_001, x: 100, y: 200 } })],
    ['横坐标非有限数', () => ({
      signaturePosition: { page: 1, x: Number.NaN, y: 200 },
    })],
    ['横坐标过小', () => ({ signaturePosition: { page: 1, x: -1, y: 200 } })],
    ['横坐标过大', () => ({
      signaturePosition: { page: 1, x: 100_001, y: 200 },
    })],
    ['纵坐标非有限数', () => ({
      signaturePosition: { page: 1, x: 100, y: Number.POSITIVE_INFINITY },
    })],
    ['纵坐标过小', () => ({ signaturePosition: { page: 1, x: 100, y: -1 } })],
    ['纵坐标过大', () => ({
      signaturePosition: { page: 1, x: 100, y: 100_001 },
    })],
  ])('拒绝非法发起参数：%s', async (_label, patch) => {
    const store = fixture();
    await expect(store.service.request({
      ...requestInput(),
      ...patch(),
    })).rejects.toMatchObject({
      response: { code: 'ESIGN_ISSUANCE_REQUEST_INVALID' },
    });
    expect(store.offers.get).not.toHaveBeenCalled();
  });

  it('空创建结果、非唯一键故障和 Offer 唯一冲突均失败关闭', async () => {
    const empty = fixture();
    empty.requests.create.mockResolvedValueOnce([]);
    await expect(empty.service.request(requestInput()))
      .rejects.toThrow('ESIGN_ISSUANCE_CREATE_EMPTY');

    const database = fixture();
    database.requests.create.mockRejectedValueOnce(new Error('MONGO_UNAVAILABLE'));
    await expect(database.service.request(requestInput()))
      .rejects.toThrow('MONGO_UNAVAILABLE');

    const duplicate = fixture();
    duplicate.requests.create.mockRejectedValueOnce({ code: 11_000 });
    await expect(duplicate.service.request(requestInput())).rejects.toMatchObject({
      response: { code: 'ESIGN_ISSUANCE_OFFER_ALREADY_REQUESTED' },
    });
  });

  it('队列暂不可用时保留已提交请求并要求相同幂等键恢复', async () => {
    const store = fixture();
    store.queue.add.mockRejectedValueOnce(new Error('REDIS_UNAVAILABLE'));
    await expect(store.service.request(requestInput())).rejects.toMatchObject({
      response: { code: 'ESIGN_ISSUANCE_QUEUE_UNAVAILABLE' },
    });
    expect(store.requests.create).toHaveBeenCalledOnce();
  });

  it('Worker 闭合绑定、Offer 版本、候选人身份并成功登记流程', async () => {
    const store = fixture();
    await expect(store.service.process(REQUEST_ID)).resolves.toBe(1);
    const adapterCredentials: unknown = store.adapter.createFlow.mock.calls[0]?.[0];
    const adapterInput: unknown = store.adapter.createFlow.mock.calls[0]?.[1];
    expect(adapterCredentials).toEqual({
      appId: 'app12345',
      appSecret: 'test-only-app-secret',
    });
    expect(adapterInput).toMatchObject({
      providerFileId: 'provider-file-001',
      signerAccount: '+8613800138000',
      signerName: '张三',
      signaturePosition: { page: 1, x: 100, y: 200 },
    });
    expect(typeof (adapterInput as { expiresAtEpochMs?: unknown }).expiresAtEpochMs)
      .toBe('number');
    expect(store.flows.registerForOffer).toHaveBeenCalledWith(
      OFFER_ID,
      'external-flow-001',
    );
    expect(store.requests.updateOne).toHaveBeenCalledTimes(2);
    const finishUpdate = store.requests.updateOne.mock.calls[1]?.[1] as {
      readonly $set: Readonly<Record<string, unknown>>;
    };
    expect(finishUpdate.$set).toMatchObject({
      status: 'succeeded',
      flowId: FLOW_ID,
      failureCode: null,
    });
  });

  it('未分类外呼异常进入人工核验且不抛给 BullMQ 自动重放', async () => {
    const store = fixture();
    store.adapter.createFlow.mockRejectedValueOnce(new Error('NETWORK_TIMEOUT'));
    await expect(store.service.process(REQUEST_ID)).resolves.toBe(0);
    const update = store.requests.updateOne.mock.calls[0]?.[1] as {
      readonly $set: Readonly<Record<string, unknown>>;
    };
    expect(update.$set).toMatchObject({
      status: 'manual_review',
      failureCode: 'ESIGN_ISSUANCE_OUTCOME_UNKNOWN',
      lockedAt: null,
      lockedBy: null,
    });
    expect(store.flows.registerForOffer).not.toHaveBeenCalled();
  });

  it('供应商成功后的本地绑定故障只重试本地终结', async () => {
    const store = fixture();
    store.flows.registerForOffer.mockRejectedValueOnce(new Error('MONGO_UNAVAILABLE'));
    await expect(store.service.process(REQUEST_ID)).rejects.toThrow('MONGO_UNAVAILABLE');
    expect(store.adapter.createFlow).toHaveBeenCalledOnce();
    const release = store.requests.updateOne.mock.calls[1]?.[1] as {
      readonly $set: Readonly<Record<string, unknown>>;
    };
    expect(release.$set.status).toBe('local_finalize');

    const resumed = fixture();
    const base = pendingRecord();
    // 使用默认认领实现重新写入私有 workerId，避免测试伪造租约。
    resumed.requests.findOneAndUpdate.mockImplementationOnce(
      (_filter: unknown, update: {
        readonly $set: Readonly<Record<string, unknown>>;
        readonly $inc: { readonly attempts: number };
      }) => query({
        ...base,
        ...update.$set,
        attempts: 2,
        externalFlowKeyId: 'flow-key-001',
        externalFlowIv: 'A'.repeat(16),
        externalFlowCiphertext: 'B'.repeat(32),
        externalFlowAuthTag: 'C'.repeat(22),
      }),
    );
    await expect(resumed.service.process(REQUEST_ID)).resolves.toBe(1);
    expect(resumed.adapter.createFlow).not.toHaveBeenCalled();
    expect(resumed.flows.registerForOffer).toHaveBeenCalledWith(
      OFFER_ID,
      'external-flow-001',
    );
  });

  it('无可认领请求时幂等退出，非法租约记录失败关闭', async () => {
    const empty = fixture();
    empty.requests.findOneAndUpdate.mockReturnValueOnce(query(null));
    await expect(empty.service.process(REQUEST_ID)).resolves.toBe(0);
    expect(empty.bindings.findOne).not.toHaveBeenCalled();

    const invalid = fixture();
    claimWith(invalid, { offerVersion: 0 });
    await expect(invalid.service.process(REQUEST_ID))
      .rejects.toThrow('ESIGN_ISSUANCE_CLAIM_INVALID');
    expect(invalid.bindings.findOne).not.toHaveBeenCalled();
  });

  it.each([
    ['非对象记录', null],
    ['非法请求标识', { id: 'bad-id' }],
    ['非法租户', { tenantId: '../tenant' }],
    ['非法 Offer', { offerId: 'bad-offer' }],
    ['非法版本类型', { offerVersion: 1.5 }],
    ['非法状态', { status: 'pending' }],
    ['非法尝试次数类型', { attempts: 1.5 }],
    ['尝试次数过小', { attempts: 0 }],
    ['尝试次数过大', { attempts: 13 }],
    ['缺少租约时间', { lockedAt: null }],
    ['租约主体不匹配', { lockedBy: 'other-worker' }],
  ])('认领记录字段失败关闭：%s', async (_label, patch) => {
    const store = fixture();
    if (patch === null) {
      store.requests.findOneAndUpdate.mockReturnValueOnce(query(42));
      await expect(store.service.process(REQUEST_ID))
        .rejects.toThrow('ESIGN_ISSUANCE_CLAIM_INVALID');
      return;
    }
    claimWith(store, patch);
    await expect(store.service.process(REQUEST_ID))
      .rejects.toThrow('ESIGN_ISSUANCE_CLAIM_INVALID');
  });

  it('供应商返回非法流程标识时进入人工核验', async () => {
    const store = fixture();
    store.adapter.createFlow.mockResolvedValueOnce('../external');
    await expect(store.service.process(REQUEST_ID)).resolves.toBe(0);
    const review = store.requests.updateOne.mock.calls[0]?.[1] as {
      readonly $set: Readonly<Record<string, unknown>>;
    };
    expect(review.$set).toMatchObject({
      status: 'manual_review',
      failureCode: 'ESIGN_ISSUANCE_RESPONSE_INVALID',
    });
    expect(store.flows.registerForOffer).not.toHaveBeenCalled();
  });

  it('外部 flowId 持久化失败视为结果未知，不执行本地绑定', async () => {
    const store = fixture();
    store.requests.updateOne.mockResolvedValueOnce({ modifiedCount: 0 });
    await expect(store.service.process(REQUEST_ID)).resolves.toBe(0);
    expect(store.requests.updateOne).toHaveBeenCalledTimes(2);
    const review = store.requests.updateOne.mock.calls[1]?.[1] as {
      readonly $set: Readonly<Record<string, unknown>>;
    };
    expect(review.$set).toMatchObject({
      status: 'manual_review',
      failureCode: 'ESIGN_ISSUANCE_RESULT_PERSIST_FAILED',
    });
    expect(store.flows.registerForOffer).not.toHaveBeenCalled();
  });

  it('外呼前绑定或 Offer 版本故障按安全退避重试', async () => {
    const missingBinding = fixture();
    missingBinding.bindings.findOne.mockReturnValueOnce(query(null));
    await expect(missingBinding.service.process(REQUEST_ID))
      .rejects.toThrow('ESIGN_ISSUANCE_BINDING_INVALID');
    const update = missingBinding.requests.updateOne.mock.calls[0]?.[1] as {
      readonly $set: Readonly<Record<string, unknown>>;
    };
    expect(update.$set.status).toBe('pending');
    expect(missingBinding.adapter.createFlow).not.toHaveBeenCalled();

    const version = fixture();
    version.source.getAcceptedOfferSubject.mockResolvedValueOnce({
      offerId: OFFER_ID,
      offerVersion: 7,
      candidateId: '01J8ZQK7V0A2M4N6P8R0T2W4D4',
      signerName: '张三',
      signerAccount: '+8613800138000',
    });
    await expect(version.service.process(REQUEST_ID))
      .rejects.toThrow('ESIGN_ISSUANCE_OFFER_VERSION_MISMATCH');
    expect(version.adapter.createFlow).not.toHaveBeenCalled();
  });

  it.each([
    ['租户不匹配', { tenantId: 'tenant-other' }],
    ['供应商不匹配', { provider: 'other' }],
    ['非激活状态', { status: 'disabled' }],
    ['非法应用标识', { appId: '../app' }],
    ['非法密钥引用', { credentialSecretRef: 'OTHER_SECRET' }],
  ])('绑定字段失败关闭：%s', async (_label, bindingPatch) => {
    const store = fixture();
    store.bindings.findOne.mockReturnValueOnce(query({
      id: '01J8ZQK7V0A2M4N6P8R0T2W4D5',
      tenantId: TENANT_ID,
      provider: 'esign_cn',
      appId: 'app12345',
      credentialSecretRef: 'GAOQ_ESIGN_APP_TEST',
      status: 'active',
      ...bindingPatch,
    }));
    await expect(store.service.process(REQUEST_ID))
      .rejects.toThrow('ESIGN_ISSUANCE_BINDING_INVALID');
    expect(store.adapter.createFlow).not.toHaveBeenCalled();
  });

  it('供应商文件密文解密结果非法时禁止外呼', async () => {
    const store = fixture();
    store.crypto.unprotectExternalId.mockReturnValueOnce('../provider');
    await expect(store.service.process(REQUEST_ID))
      .rejects.toThrow('ESIGN_ISSUANCE_PROVIDER_FILE_INVALID');
    expect(store.adapter.createFlow).not.toHaveBeenCalled();
  });

  it.each([
    ['已过期', { expiresAt: new Date(Date.now() + 60_000) }, undefined],
    ['超过最大期限', {
      expiresAt: new Date(Date.now() + 91 * 24 * 60 * 60 * 1_000),
    }, undefined],
    ['页码非整数', { signaturePage: 1.5 }, undefined],
    ['页码过小', { signaturePage: 0 }, undefined],
    ['页码过大', { signaturePage: 10_001 }, undefined],
    ['横坐标非有限数', { signatureX: Number.NaN }, undefined],
    ['横坐标过小', { signatureX: -1 }, undefined],
    ['横坐标过大', { signatureX: 100_001 }, undefined],
    ['纵坐标非有限数', { signatureY: Number.NaN }, undefined],
    ['纵坐标过小', { signatureY: -1 }, undefined],
    ['纵坐标过大', { signatureY: 100_001 }, undefined],
    ['签署人姓名为空', {}, { signerName: '' }],
    ['签署人账号带控制符', {}, { signerAccount: 'user\u0000@example.com' }],
  ])('Worker 执行参数失败关闭：%s', async (
    _label,
    recordPatch,
    subjectPatch,
  ) => {
    const store = fixture();
    claimWith(store, recordPatch);
    if (subjectPatch !== undefined) {
      store.source.getAcceptedOfferSubject.mockResolvedValueOnce({
        offerId: OFFER_ID,
        offerVersion: 6,
        candidateId: '01J8ZQK7V0A2M4N6P8R0T2W4D4',
        signerName: '张三',
        signerAccount: '+8613800138000',
        ...subjectPatch,
      });
    }
    await expect(store.service.process(REQUEST_ID))
      .rejects.toThrow('ESIGN_ISSUANCE_EXECUTION_INPUT_INVALID');
    expect(store.adapter.createFlow).not.toHaveBeenCalled();
  });

  it('已保存外部流程解密结果非法时只保留本地终结重试', async () => {
    const store = fixture();
    claimWith(store, {
      externalFlowKeyId: 'flow-key-001',
      externalFlowIv: 'A'.repeat(16),
      externalFlowCiphertext: 'B'.repeat(32),
      externalFlowAuthTag: 'C'.repeat(22),
    });
    store.crypto.unprotectExternalId.mockReturnValueOnce('../external');
    await expect(store.service.process(REQUEST_ID))
      .rejects.toThrow('ESIGN_ISSUANCE_EXTERNAL_RESULT_INVALID');
    expect(store.adapter.createFlow).not.toHaveBeenCalled();
    const update = store.requests.updateOne.mock.calls[0]?.[1] as {
      readonly $set: Readonly<Record<string, unknown>>;
    };
    expect(update.$set.status).toBe('local_finalize');
  });

  it('本地终结达到最大次数后进入 dead，且保留业务错误码', async () => {
    const store = fixture();
    claimWith(store, {
      attempts: 12,
      externalFlowKeyId: 'flow-key-001',
      externalFlowIv: 'A'.repeat(16),
      externalFlowCiphertext: 'B'.repeat(32),
      externalFlowAuthTag: 'C'.repeat(22),
    });
    store.flows.registerForOffer.mockRejectedValueOnce({
      response: { code: 'ESIGN_FLOW_OFFER_ALREADY_LINKED' },
    });
    await expect(store.service.process(REQUEST_ID)).rejects.toEqual({
      response: { code: 'ESIGN_FLOW_OFFER_ALREADY_LINKED' },
    });
    const update = store.requests.updateOne.mock.calls[0]?.[1] as {
      readonly $set: Readonly<Record<string, unknown>>;
    };
    expect(update.$set).toMatchObject({
      status: 'dead',
      failureCode: 'ESIGN_FLOW_OFFER_ALREADY_LINKED',
    });
  });

  it('外呼前达到最大尝试次数后进入 dead', async () => {
    const store = fixture();
    claimWith(store, { attempts: 12 });
    store.bindings.findOne.mockReturnValueOnce(query(null));
    await expect(store.service.process(REQUEST_ID))
      .rejects.toThrow('ESIGN_ISSUANCE_BINDING_INVALID');
    const update = store.requests.updateOne.mock.calls[0]?.[1] as {
      readonly $set: Readonly<Record<string, unknown>>;
    };
    expect(update.$set.status).toBe('dead');
  });

  it.each([
    ['完成租约', 'finish'],
    ['人工核验租约', 'manual_review'],
    ['本地终结租约', 'local_finalize'],
    ['外呼前失败租约', 'preflight'],
  ])('%s丢失时失败关闭，禁止伪造终态', async (_label, mode) => {
    const store = fixture();
    if (mode === 'finish') {
      store.requests.updateOne
        .mockResolvedValueOnce({ modifiedCount: 1 })
        .mockResolvedValueOnce({ modifiedCount: 0 });
      await expect(store.service.process(REQUEST_ID))
        .rejects.toThrow('ESIGN_ISSUANCE_FINALIZE_LEASE_LOST');
      return;
    }
    if (mode === 'manual_review') {
      store.adapter.createFlow.mockRejectedValueOnce(new Error('NETWORK_TIMEOUT'));
      store.requests.updateOne.mockResolvedValueOnce({ modifiedCount: 0 });
      await expect(store.service.process(REQUEST_ID))
        .rejects.toThrow('ESIGN_ISSUANCE_MANUAL_REVIEW_LEASE_LOST');
      return;
    }
    if (mode === 'local_finalize') {
      store.flows.registerForOffer.mockRejectedValueOnce(new Error('MONGO_UNAVAILABLE'));
      store.requests.updateOne
        .mockResolvedValueOnce({ modifiedCount: 1 })
        .mockResolvedValueOnce({ modifiedCount: 0 });
      await expect(store.service.process(REQUEST_ID))
        .rejects.toThrow('ESIGN_ISSUANCE_LOCAL_FINALIZE_LEASE_LOST');
      return;
    }
    store.bindings.findOne.mockReturnValueOnce(query(null));
    store.requests.updateOne.mockResolvedValueOnce({ modifiedCount: 0 });
    await expect(store.service.process(REQUEST_ID))
      .rejects.toThrow('ESIGN_ISSUANCE_FAILURE_LEASE_LOST');
  });

  it('过期处理租约按是否已有外部回执分别隔离或仅补本地终态', async () => {
    const store = fixture();
    store.requests.find.mockReturnValueOnce(listQuery([
      { id: REQUEST_ID, tenantId: TENANT_ID },
    ]));
    await expect(store.service.recoverAndEnqueue(
      new Date('2026-07-28T08:00:00.000Z'),
    )).resolves.toBe(1);
    expect(store.requests.updateMany).toHaveBeenCalledTimes(2);
    const unknown = store.requests.updateMany.mock.calls[0]?.[1] as {
      readonly $set: Readonly<Record<string, unknown>>;
    };
    const local = store.requests.updateMany.mock.calls[1]?.[1] as {
      readonly $set: Readonly<Record<string, unknown>>;
    };
    expect(unknown.$set.status).toBe('manual_review');
    expect(local.$set.status).toBe('local_finalize');
    expect(store.queue.add).toHaveBeenCalledWith(
      ESIGN_ISSUE_FLOW_JOB,
      { requestId: REQUEST_ID, tenantId: TENANT_ID },
      expect.any(Object),
    );
  });

  it('恢复扫描拒绝非法批量上限并跳过畸形记录', async () => {
    const store = fixture();
    await expect(store.service.recoverAndEnqueue(new Date(), 0))
      .rejects.toThrow('ESIGN_ISSUANCE_RECOVERY_LIMIT_INVALID');
    await expect(store.service.recoverAndEnqueue(new Date(), 501))
      .rejects.toThrow('ESIGN_ISSUANCE_RECOVERY_LIMIT_INVALID');
    store.requests.find.mockReturnValueOnce(listQuery([
      { id: 'bad-id', tenantId: TENANT_ID },
      { id: REQUEST_ID, tenantId: '../tenant' },
    ]));
    await expect(store.service.recoverAndEnqueue(new Date(), 2)).resolves.toBe(0);
    expect(store.queue.add).not.toHaveBeenCalled();
  });

  it('人工重试必须确认未提交；外部流程绑定只进入本地终结', async () => {
    const retry = fixture();
    retry.requests.findOneAndUpdate.mockReturnValueOnce(query({
      ...pendingRecord(),
      status: 'pending',
      updatedAt: new Date(),
    }));
    await expect(retry.service.resolve({
      requestId: REQUEST_ID,
      decision: 'retry',
      reason: 'approved_exception',
      providerConfirmedNotCommitted: true,
      providerConfirmedMatchesRequest: false,
      idempotencyKey: 'esign-resolution-key-001',
    })).resolves.toMatchObject({ request: { status: 'pending' } });

    const attach = fixture();
    attach.requests.findOneAndUpdate.mockReturnValueOnce(query({
      ...pendingRecord(),
      status: 'local_finalize',
      externalFlowKeyId: 'flow-key-001',
      externalFlowIv: 'A'.repeat(16),
      externalFlowCiphertext: 'B'.repeat(32),
      externalFlowAuthTag: 'C'.repeat(22),
      updatedAt: new Date(),
    }));
    await expect(attach.service.resolve({
      requestId: REQUEST_ID,
      decision: 'attach_external_flow',
      reason: 'provider_recovered',
      providerConfirmedNotCommitted: false,
      providerConfirmedMatchesRequest: true,
      externalFlowId: 'external-flow-001',
      idempotencyKey: 'esign-resolution-key-002',
    })).resolves.toMatchObject({ request: { status: 'local_finalize' } });
    expect(attach.adapter.createFlow).not.toHaveBeenCalled();
  });

  it('拒绝缺少批准确认的人工重放和未经匹配确认的外部绑定', async () => {
    const store = fixture();
    await expect(store.service.resolve({
      requestId: REQUEST_ID,
      decision: 'retry',
      reason: 'provider_recovered',
      providerConfirmedNotCommitted: true,
      providerConfirmedMatchesRequest: false,
      idempotencyKey: 'esign-resolution-key-003',
    })).rejects.toMatchObject({
      response: { code: 'ESIGN_ISSUANCE_RETRY_CONFIRMATION_REQUIRED' },
    });
    await expect(store.service.resolve({
      requestId: REQUEST_ID,
      decision: 'attach_external_flow',
      reason: 'provider_recovered',
      providerConfirmedNotCommitted: false,
      providerConfirmedMatchesRequest: false,
      externalFlowId: 'external-flow-001',
      idempotencyKey: 'esign-resolution-key-004',
    })).rejects.toMatchObject({
      response: { code: 'ESIGN_ISSUANCE_EXTERNAL_FLOW_CONFIRMATION_REQUIRED' },
    });
    expect(store.requests.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('拒绝非法人工处置标识、运行时枚举和布尔类型', async () => {
    const store = fixture();
    const valid = {
      requestId: REQUEST_ID,
      decision: 'retry',
      reason: 'approved_exception',
      providerConfirmedNotCommitted: true,
      providerConfirmedMatchesRequest: false,
      idempotencyKey: 'esign-resolution-key-invalid',
    } as const;
    await expect(store.service.resolve({
      ...valid,
      requestId: 'bad-id',
    })).rejects.toMatchObject({
      response: { code: 'ESIGN_ISSUANCE_REQUEST_ID_INVALID' },
    });
    await expect(store.service.resolve({
      ...valid,
      decision: 'delete',
    } as never)).rejects.toMatchObject({
      response: { code: 'ESIGN_ISSUANCE_RESOLUTION_INVALID' },
    });
    await expect(store.service.resolve({
      ...valid,
      reason: 'other',
    } as never)).rejects.toMatchObject({
      response: { code: 'ESIGN_ISSUANCE_RESOLUTION_INVALID' },
    });
    await expect(store.service.resolve({
      ...valid,
      providerConfirmedNotCommitted: 'yes',
    } as never)).rejects.toMatchObject({
      response: { code: 'ESIGN_ISSUANCE_RESOLUTION_INVALID' },
    });
  });

  it('人工处置目标不存在时返回稳定错误且不入队', async () => {
    const store = fixture();
    store.requests.findOneAndUpdate.mockReturnValueOnce(query(null));
    await expect(store.service.resolve({
      requestId: REQUEST_ID,
      decision: 'retry',
      reason: 'approved_exception',
      providerConfirmedNotCommitted: true,
      providerConfirmedMatchesRequest: false,
      idempotencyKey: 'esign-resolution-key-not-found',
    })).rejects.toMatchObject({
      response: { code: 'ESIGN_ISSUANCE_NOT_RESOLVABLE' },
    });
    expect(store.queue.add).not.toHaveBeenCalled();
  });

  it('终态列表使用可信租户且只返回脱敏摘要', async () => {
    const store = fixture();
    store.requests.find.mockReturnValueOnce(listQuery([
      {
        ...pendingRecord(),
        status: 'manual_review',
        failureCode: 'ESIGN_ISSUANCE_OUTCOME_UNKNOWN',
        updatedAt: new Date('2026-07-28T08:00:00.000Z'),
      },
    ]));
    const result = await store.service.listTerminal({
      status: 'manual_review',
      limit: 50,
    });
    expect(result.items[0]).toEqual({
      id: REQUEST_ID,
      offerId: OFFER_ID,
      offerVersion: 6,
      status: 'manual_review',
      attempts: 0,
      failureCode: 'ESIGN_ISSUANCE_OUTCOME_UNKNOWN',
      flowId: null,
      operatorResolutionCount: 0,
      updatedAt: '2026-07-28T08:00:00.000Z',
    });
    expect(JSON.stringify(result)).not.toMatch(/provider-file|external-flow|张三/u);
  });

  it('终态列表支持租户内游标分页', async () => {
    const store = fixture();
    const records = [pendingRecord(), {
      ...pendingRecord(),
      id: '01J8ZQK7V0A2M4N6P8R0T2W4D0',
    }];
    store.requests.find.mockReturnValueOnce(listQuery(records));
    const result = await store.service.listTerminal({
      status: 'dead',
      beforeId: '01J8ZQK7V0A2M4N6P8R0T2W4D9',
      limit: 1,
    });
    expect(result.items).toHaveLength(1);
    expect(result.nextCursor).toBe(REQUEST_ID);
    expect(store.requests.find).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_ID,
        id: { $lt: '01J8ZQK7V0A2M4N6P8R0T2W4D9' },
      }),
      expect.any(Object),
    );
  });

  it('终态列表在服务层二次拒绝非法状态、上限和游标', async () => {
    const store = fixture();
    await expect(store.service.listTerminal({
      status: 'pending',
      limit: 50,
    } as never)).rejects.toMatchObject({
      response: { code: 'ESIGN_ISSUANCE_LIST_QUERY_INVALID' },
    });
    await expect(store.service.listTerminal({
      status: 'dead',
      limit: 101,
    })).rejects.toMatchObject({
      response: { code: 'ESIGN_ISSUANCE_LIST_QUERY_INVALID' },
    });
    await expect(store.service.listTerminal({
      status: 'dead',
      beforeId: 'bad-id',
      limit: 50,
    })).rejects.toMatchObject({
      response: { code: 'ESIGN_ISSUANCE_LIST_QUERY_INVALID' },
    });
    expect(store.requests.find).not.toHaveBeenCalled();
  });

  it('Worker 服务层拒绝非法请求标识', async () => {
    const store = fixture();
    await expect(store.service.process('bad-id'))
      .rejects.toThrow('ESIGN_ISSUANCE_REQUEST_ID_INVALID');
    expect(store.requests.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('业务状态提交后的审计故障只记录稳定告警', async () => {
    const store = fixture();
    store.audit.recordSystem.mockRejectedValueOnce(new Error('AUDIT_UNAVAILABLE'));
    await expect(store.service.process(REQUEST_ID)).resolves.toBe(1);
    expect(store.requests.updateOne).toHaveBeenCalledTimes(2);
  });
});
