import type { Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../../core/audit/audit.service.js';
import { REQUIRED_SCOPES_KEY } from '../identity/auth.decorators.js';
import type { RecruitmentOfferService } from './application/recruitment-offer.service.js';
import { RecruitmentOfferController } from './recruitment-offer.controller.js';

const APPLICATION_ID = '01J8ZQK7V0A2M4N6P8R0T2W4Y7';
const OFFER_ID = '01J8ZQK7V0A2M4N6P8R0T2W4X3';
const offer = {
  id: OFFER_ID, applicationId: APPLICATION_ID, positionId: '01J8ZQK7V0A2M4N6P8R0T2W4Y8',
  completedInterviewId: '01J8ZQK7V0A2M4N6P8R0T2W4X1', status: 'draft' as const,
  expiresAt: '2027-08-01T00:00:00.000Z', approvalInstanceId: null,
  sendRequestId: null, sentEvidenceId: null, acceptanceEvidenceId: null,
  esignFlowId: null, signedEvidenceId: null, version: 1,
};
const body = {
  completedInterviewId: offer.completedInterviewId,
  terms: {
    currency: 'CNY' as const, monthlyBaseSalaryMinor: 3_000_000, salaryMonths: 13,
    annualVariableTargetMinor: 6_000_000, signingBonusMinor: 1_000_000,
    proposedStartDate: '2026-08-15', probationMonths: 3,
    employmentType: 'full_time', workLocation: '上海', benefitsSummary: '标准福利计划',
  },
  expiresAt: offer.expiresAt,
  retentionExpiresAt: '2033-08-01T00:00:00.000Z',
};

function fixture() {
  const offers = {
    create: vi.fn().mockResolvedValue({ offer }),
    get: vi.fn().mockResolvedValue(offer),
    submit: vi.fn().mockResolvedValue({ offer: {
      ...offer, status: 'pending_approval', approvalInstanceId: 'approval-001', version: 2,
    } }),
    syncApproval: vi.fn().mockResolvedValue({ offer: {
      ...offer, status: 'approved', approvalInstanceId: 'approval-001', version: 3,
    } }),
    requestSend: vi.fn().mockResolvedValue({ offer: {
      ...offer, status: 'sending', approvalInstanceId: 'approval-001',
      sendRequestId: 'send-request-001', version: 4,
    } }),
  };
  const record = vi.fn().mockResolvedValue(undefined);
  const headers = new Map<string, string>();
  const response = {
    setHeader: vi.fn((name: string, value: string) => headers.set(name, value)),
  } as unknown as Response;
  const controller = new RecruitmentOfferController(
    offers as unknown as RecruitmentOfferService,
    { record } as unknown as AuditService,
  );
  const errorLog = vi.spyOn(
    (controller as unknown as { logger: { error: (value: unknown) => void } }).logger,
    'error',
  ).mockImplementation(() => undefined);
  return { controller, offers, record, headers, response, errorLog };
}

describe('RecruitmentOfferController', () => {
  it('五个管理端点使用独立最小 Scope', () => {
    const expected: Readonly<Record<MethodName, string>> = {
      create: 'erp:recruitment:offer:create',
      get: 'erp:recruitment:offer:read',
      submit: 'erp:recruitment:offer:submit',
      syncApproval: 'erp:recruitment:offer:sync_approval',
      requestSend: 'erp:recruitment:offer:send',
    };
    for (const [name, scope] of Object.entries(expected) as [MethodName, string][]) {
      expect(Reflect.getMetadata(REQUIRED_SCOPES_KEY, method(name))).toEqual([scope]);
    }
  });

  it('创建强制申请 If-Match 和幂等键，响应与审计不复制 L4 条款', async () => {
    const store = fixture();
    await expect(store.controller.create(
      APPLICATION_ID, '3', 'offer-create-key-001', body, store.response,
    )).rejects.toMatchObject({ response: { code: 'RECRUITMENT_IF_MATCH_REQUIRED' } });
    const result = await store.controller.create(
      APPLICATION_ID, '"3"', 'offer-create-key-001', body, store.response,
    );
    expect(store.offers.create).toHaveBeenCalledWith(
      APPLICATION_ID, 3, 'offer-create-key-001', body,
    );
    expect(store.headers.get('ETag')).toBe('"1"');
    expect(result.offer).not.toHaveProperty('terms');
    expect(JSON.stringify(store.record.mock.calls)).not.toMatch(/标准福利计划|3000000|上海/u);
    expect(store.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'recruitment.offer.create', riskLevel: 'R2',
      metadata: { version: 1, status: 'draft' },
    }));
  });

  it('发送端点只请求发送，不接收客户端证据字段', async () => {
    const store = fixture();
    const result = await store.controller.requestSend(
      OFFER_ID, '"3"', 'offer-send-key-001', {}, store.response,
    );
    expect(store.offers.requestSend).toHaveBeenCalledWith(OFFER_ID, 3, 'offer-send-key-001');
    expect(result.offer).toMatchObject({ status: 'sending', sentEvidenceId: null, version: 4 });
    expect(store.headers.get('ETag')).toBe('"4"');
  });

  it('读取、提交与审批同步返回严格摘要和强 ETag', async () => {
    const store = fixture();
    const read = await store.controller.get(OFFER_ID, store.response);
    expect(read).toBe(offer);
    expect(store.offers.get).toHaveBeenCalledWith(OFFER_ID);
    expect(store.headers.get('ETag')).toBe('"1"');

    const submitted = await store.controller.submit(
      OFFER_ID, '"1"', 'offer-submit-key-001', undefined, store.response,
    );
    expect(store.offers.submit).toHaveBeenCalledWith(OFFER_ID, 1, 'offer-submit-key-001');
    expect(submitted.offer).toMatchObject({ status: 'pending_approval', version: 2 });
    expect(store.headers.get('ETag')).toBe('"2"');

    const approved = await store.controller.syncApproval(
      OFFER_ID, '"2"', 'offer-sync-key-001', {}, store.response,
    );
    expect(store.offers.syncApproval).toHaveBeenCalledWith(OFFER_ID, 2, 'offer-sync-key-001');
    expect(approved.offer).toMatchObject({ status: 'approved', version: 3 });
    expect(store.headers.get('ETag')).toBe('"3"');
    expect(store.record.mock.calls.map(
      ([input]) => (input as { readonly action: string }).action,
    )).toEqual([
      'recruitment.offer.submit',
      'recruitment.offer.sync_approval',
    ]);
  });

  it.each([
    ['非字符串', 1],
    ['小写', OFFER_ID.toLowerCase()],
    ['长度错误', OFFER_ID.slice(1)],
    ['非法首位', `8${OFFER_ID.slice(1)}`],
  ])('读取在 %s ID 时失败关闭且不调用应用服务', async (_name, id) => {
    const store = fixture();
    await expect(store.controller.get(id as string, store.response)).rejects.toMatchObject({
      response: { code: 'RECRUITMENT_INVALID_ID' },
    });
    expect(store.offers.get).not.toHaveBeenCalled();
  });

  it.each([
    ['缺失', undefined],
    ['弱 ETag', '3'],
    ['零', '"0"'],
    ['前导零', '"03"'],
    ['负数', '"-1"'],
    ['非安全整数', `"${Number.MAX_SAFE_INTEGER}"`],
    ['超长数字', `"${'9'.repeat(128)}"`],
  ])('写入口拒绝 %s If-Match', async (_name, ifMatch) => {
    const store = fixture();
    await expect(store.controller.requestSend(
      OFFER_ID, ifMatch, 'offer-send-key-001', {}, store.response,
    )).rejects.toMatchObject({ response: { code: 'RECRUITMENT_IF_MATCH_REQUIRED' } });
    expect(store.offers.requestSend).not.toHaveBeenCalled();
  });

  it.each([
    ['缺失', undefined],
    ['空值', ''],
    ['过短', 'short'],
    ['包含空格', 'offer key invalid'],
    ['过长', 'a'.repeat(129)],
    ['非字符串', 7],
  ])('写入口拒绝 %s Idempotency-Key', async (_name, key) => {
    const store = fixture();
    await expect(store.controller.requestSend(
      OFFER_ID, '"1"', key as string, {}, store.response,
    )).rejects.toMatchObject({ response: { code: 'IDEMPOTENCY_KEY_REQUIRED' } });
    expect(store.offers.requestSend).not.toHaveBeenCalled();
  });

  it.each([
    ['额外字段', { sentEvidenceId: 'client-proof' }],
    ['数组', []],
    ['null', null],
    ['字符串', ''],
    ['无原型对象', Object.create(null) as object],
  ])('无正文写入口拒绝%s', async (_name, invalidBody) => {
    const store = fixture();
    await expect(store.controller.submit(
      OFFER_ID, '"1"', 'offer-submit-key-001', invalidBody, store.response,
    )).rejects.toMatchObject({ response: { code: 'RECRUITMENT_OFFER_BODY_FORBIDDEN' } });
    expect(store.offers.submit).not.toHaveBeenCalled();
  });

  it.each([
    ['create', 'recruitment.offer.create', 'recruitment_application', APPLICATION_ID],
    ['submit', 'recruitment.offer.submit', 'recruitment_offer', OFFER_ID],
    ['syncApproval', 'recruitment.offer.sync_approval', 'recruitment_offer', OFFER_ID],
    ['requestSend', 'recruitment.offer.request_send', 'recruitment_offer', OFFER_ID],
  ] as const)('%s 业务失败保留原异常并写低敏失败审计', async (
    methodName,
    action,
    resourceType,
    resourceId,
  ) => {
    const store = fixture();
    const failure = new Error('business-failure');
    store.offers[methodName].mockRejectedValueOnce(failure);
    const invocation = methodName === 'create'
      ? store.controller.create(
          APPLICATION_ID, '"7"', 'offer-create-key-001', body, store.response,
        )
      : methodName === 'submit'
        ? store.controller.submit(
            OFFER_ID, '"7"', 'offer-submit-key-001', {}, store.response,
          )
        : methodName === 'syncApproval'
          ? store.controller.syncApproval(
              OFFER_ID, '"7"', 'offer-sync-key-001', {}, store.response,
            )
          : store.controller.requestSend(
              OFFER_ID, '"7"', 'offer-send-key-001', {}, store.response,
            );
    await expect(invocation).rejects.toBe(failure);
    expect(store.record).toHaveBeenCalledWith({
      action,
      resourceType,
      resourceId,
      riskLevel: 'R2',
      outcome: 'failure',
      metadata: { expectedVersion: 7 },
    });
    expect(JSON.stringify(store.record.mock.calls)).not.toMatch(
      /offer-(?:create|submit|sync|send)-key|标准福利计划|3000000|上海/u,
    );
  });

  it('失败审计异常不覆盖原业务异常，只记录稳定低敏告警', async () => {
    const store = fixture();
    const failure = new Error('business-failure');
    store.offers.requestSend.mockRejectedValueOnce(failure);
    store.record.mockRejectedValueOnce(new Error('audit-failure'));
    await expect(store.controller.requestSend(
      OFFER_ID, '"4"', 'offer-send-key-001', {}, store.response,
    )).rejects.toBe(failure);
    expect(store.errorLog).toHaveBeenCalledWith({
      code: 'RECRUITMENT_OFFER_FAILURE_AUDIT_FAILED',
      action: 'recruitment.offer.request_send',
      resourceId: OFFER_ID,
    });
    expect(JSON.stringify(store.errorLog.mock.calls)).not.toMatch(
      /audit-failure|business-failure|offer-send-key-001/u,
    );
  });

  it.each([
    ['create', 'recruitment.offer.create'],
    ['submit', 'recruitment.offer.submit'],
    ['syncApproval', 'recruitment.offer.sync_approval'],
    ['requestSend', 'recruitment.offer.request_send'],
  ] as const)('%s 已提交后成功审计异常不改变业务成功终态', async (methodName, action) => {
    const store = fixture();
    store.record.mockRejectedValueOnce(new Error('audit-failure'));
    const result = methodName === 'create'
      ? await store.controller.create(
          APPLICATION_ID, '"3"', 'offer-create-key-001', body, store.response,
        )
      : methodName === 'submit'
        ? await store.controller.submit(
            OFFER_ID, '"1"', 'offer-submit-key-001', {}, store.response,
          )
        : methodName === 'syncApproval'
          ? await store.controller.syncApproval(
              OFFER_ID, '"2"', 'offer-sync-key-001', {}, store.response,
            )
          : await store.controller.requestSend(
              OFFER_ID, '"3"', 'offer-send-key-001', {}, store.response,
            );
    expect(result.offer.id).toBe(OFFER_ID);
    expect(store.errorLog).toHaveBeenCalledWith({
      code: 'RECRUITMENT_OFFER_AUDIT_AFTER_COMMIT_FAILED',
      action,
      resourceId: OFFER_ID,
    });
    expect(JSON.stringify(store.errorLog.mock.calls)).not.toMatch(
      /audit-failure|offer-(?:create|submit|sync|send)-key/u,
    );
  });
});

type MethodName = 'create' | 'get' | 'submit' | 'syncApproval' | 'requestSend';

function method(name: MethodName): object {
  const value: unknown = Object.getOwnPropertyDescriptor(
    RecruitmentOfferController.prototype, name,
  )?.value;
  if (typeof value !== 'function') throw new Error(`控制器方法 ${name} 不存在`);
  return value;
}
