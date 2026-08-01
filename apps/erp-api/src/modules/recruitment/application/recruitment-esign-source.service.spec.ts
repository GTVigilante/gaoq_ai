import { describe, expect, it, vi } from 'vitest';

import type { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type {
  RecruitmentCandidateRepository,
  RecruitmentOfferRepository,
} from '../persistence/recruitment.repositories.js';
import { RecruitmentESignSourceService } from './recruitment-esign-source.service.js';

const OFFER_ID = '01J8ZQK7V0A2M4N6P8R0T2W4A1';
const CANDIDATE_ID = '01J8ZQK7V0A2M4N6P8R0T2W4A2';

function fixture(scopes: readonly string[] = ['erp:integration:esign:create']) {
  const context = {
    getTenantRequired: () => ({ tenantId: 'tenant-001' }),
    getActorRequired: () => ({ scopes }),
  };
  const offers = {
    findById: vi.fn().mockResolvedValue({
      id: OFFER_ID,
      tenantId: 'tenant-001',
      candidateId: CANDIDATE_ID,
      status: 'accepted',
      esignFlowId: null,
      signedEvidenceId: null,
      version: 6,
    }),
  };
  const candidates = {
    findById: vi.fn().mockResolvedValue({
      id: CANDIDATE_ID,
      tenantId: 'tenant-001',
      status: 'active',
      name: '张三',
      phone: '+8613800138000',
      email: 'candidate@example.com',
      consent: { expiresAt: '2099-01-01T00:00:00.000Z' },
    }),
  };
  const service = new RecruitmentESignSourceService(
    context as unknown as TenantContextService,
    offers as unknown as RecruitmentOfferRepository,
    candidates as unknown as RecruitmentCandidateRepository,
  );
  return { service, offers, candidates };
}

describe('RecruitmentESignSourceService', () => {
  it('只向受信任 Worker 返回已接受 Offer 的最小签署主体', async () => {
    const store = fixture();
    await expect(store.service.getAcceptedOfferSubject(OFFER_ID)).resolves.toEqual({
      offerId: OFFER_ID,
      offerVersion: 6,
      candidateId: CANDIDATE_ID,
      signerName: '张三',
      signerAccount: '+8613800138000',
    });
    expect(store.candidates.findById).toHaveBeenCalledWith(CANDIDATE_ID);
  });

  it('手机号缺失时使用规范邮箱', async () => {
    const store = fixture();
    store.candidates.findById.mockResolvedValueOnce({
      id: CANDIDATE_ID,
      tenantId: 'tenant-001',
      status: 'active',
      name: '张三',
      phone: null,
      email: 'candidate@example.com',
      consent: { expiresAt: '2099-01-01T00:00:00.000Z' },
    });
    await expect(store.service.getAcceptedOfferSubject(OFFER_ID))
      .resolves.toMatchObject({ signerAccount: 'candidate@example.com' });
  });

  it('无专用 Scope 时不读取 Offer', async () => {
    const store = fixture([]);
    await expect(store.service.getAcceptedOfferSubject(OFFER_ID))
      .rejects.toMatchObject({ response: { code: 'RECRUITMENT_ESIGN_SOURCE_DENIED' } });
    expect(store.offers.findById).not.toHaveBeenCalled();
  });

  it.each([
    ['缺失', null],
    ['跨租户', {
      id: OFFER_ID, tenantId: 'tenant-002', candidateId: CANDIDATE_ID,
      status: 'accepted', esignFlowId: null, signedEvidenceId: null, version: 6,
    }],
    ['非接受状态', {
      id: OFFER_ID, tenantId: 'tenant-001', candidateId: CANDIDATE_ID,
      status: 'sent', esignFlowId: null, signedEvidenceId: null, version: 5,
    }],
    ['已有流程', {
      id: OFFER_ID, tenantId: 'tenant-001', candidateId: CANDIDATE_ID,
      status: 'accepted', esignFlowId: '01J8ZQK7V0A2M4N6P8R0T2W4A3',
      signedEvidenceId: null, version: 6,
    }],
  ])('Offer %s时失败关闭', async (_label, offer) => {
    const store = fixture();
    store.offers.findById.mockResolvedValueOnce(offer);
    await expect(store.service.getAcceptedOfferSubject(OFFER_ID)).rejects.toBeDefined();
    expect(store.candidates.findById).not.toHaveBeenCalled();
  });

  it.each([
    ['缺失', null],
    ['已撤回授权', {
      id: CANDIDATE_ID, tenantId: 'tenant-001', status: 'consent_withdrawn',
      name: '张三', phone: '+8613800138000', email: null,
      consent: { expiresAt: '2099-01-01T00:00:00.000Z' },
    }],
    ['跨租户', {
      id: CANDIDATE_ID, tenantId: 'tenant-002', status: 'active',
      name: '张三', phone: '+8613800138000', email: null,
      consent: { expiresAt: '2099-01-01T00:00:00.000Z' },
    }],
    ['标识错位', {
      id: '01J8ZQK7V0A2M4N6P8R0T2W4A9', tenantId: 'tenant-001', status: 'active',
      name: '张三', phone: '+8613800138000', email: null,
      consent: { expiresAt: '2099-01-01T00:00:00.000Z' },
    }],
    ['姓名缺失', {
      id: CANDIDATE_ID, tenantId: 'tenant-001', status: 'active',
      name: null, phone: '+8613800138000', email: null,
      consent: { expiresAt: '2099-01-01T00:00:00.000Z' },
    }],
    ['授权时间畸形', {
      id: CANDIDATE_ID, tenantId: 'tenant-001', status: 'active',
      name: '张三', phone: '+8613800138000', email: null,
      consent: { expiresAt: 'not-a-date' },
    }],
    ['已过期', {
      id: CANDIDATE_ID, tenantId: 'tenant-001', status: 'active',
      name: '张三', phone: '+8613800138000', email: null,
      consent: { expiresAt: '2020-01-01T00:00:00.000Z' },
    }],
    ['无账号', {
      id: CANDIDATE_ID, tenantId: 'tenant-001', status: 'active',
      name: '张三', phone: null, email: null,
      consent: { expiresAt: '2099-01-01T00:00:00.000Z' },
    }],
  ])('候选人%s时失败关闭', async (_label, candidate) => {
    const store = fixture();
    store.candidates.findById.mockResolvedValueOnce(candidate);
    await expect(store.service.getAcceptedOfferSubject(OFFER_ID)).rejects.toBeDefined();
  });
});
