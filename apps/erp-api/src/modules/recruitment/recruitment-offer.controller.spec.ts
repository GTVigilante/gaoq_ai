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
  return { controller, offers, record, headers, response };
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
    const body = {
      completedInterviewId: offer.completedInterviewId,
      terms: {
        currency: 'CNY' as const, monthlyBaseSalaryMinor: 3_000_000, salaryMonths: 13,
        annualVariableTargetMinor: 6_000_000, signingBonusMinor: 1_000_000,
        proposedStartDate: '2026-08-15', probationMonths: 3,
        employmentType: 'full_time', workLocation: '上海', benefitsSummary: '标准福利计划',
      },
      expiresAt: offer.expiresAt, retentionExpiresAt: '2033-08-01T00:00:00.000Z',
    };
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
      OFFER_ID, '"3"', 'offer-send-key-001', store.response,
    );
    expect(store.offers.requestSend).toHaveBeenCalledWith(OFFER_ID, 3, 'offer-send-key-001');
    expect(result.offer).toMatchObject({ status: 'sending', sentEvidenceId: null, version: 4 });
    expect(store.headers.get('ETag')).toBe('"4"');
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
