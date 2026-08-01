import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import {
  RecruitmentCandidateRepository,
  RecruitmentOfferRepository,
} from '../persistence/recruitment.repositories.js';

export interface RecruitmentESignSubject {
  readonly offerId: string;
  readonly offerVersion: number;
  readonly candidateId: string;
  readonly signerName: string;
  readonly signerAccount: string;
}

/**
 * eSign 专用招聘投影。
 * 只在受信任 Worker 上下文中解密候选人身份，不向 REST、事件、审计或 MCP 返回。
 */
@Injectable()
export class RecruitmentESignSourceService {
  constructor(
    private readonly context: TenantContextService,
    private readonly offers: RecruitmentOfferRepository,
    private readonly candidates: RecruitmentCandidateRepository,
  ) {}

  async getAcceptedOfferSubject(offerId: string): Promise<RecruitmentESignSubject> {
    this.requireScope();
    const tenantId = this.context.getTenantRequired().tenantId;
    const offer = await this.offers.findById(offerId);
    if (offer === null) throw new NotFoundException({
      code: 'RECRUITMENT_ESIGN_OFFER_NOT_FOUND',
      message: '待签 Offer 不存在',
    });
    if (
      offer.tenantId !== tenantId ||
      offer.id !== offerId ||
      offer.status !== 'accepted' ||
      offer.esignFlowId !== null ||
      offer.signedEvidenceId !== null
    ) throw new ConflictException({
      code: 'RECRUITMENT_ESIGN_OFFER_STATE_INVALID',
      message: '只有未绑定签署流程的已接受 Offer 可发起 eSign',
    });
    const candidate = await this.candidates.findById(offer.candidateId);
    const consentExpiresAt = candidate === null
      ? Number.NaN
      : Date.parse(candidate.consent.expiresAt);
    if (
      candidate === null ||
      candidate.tenantId !== tenantId ||
      candidate.id !== offer.candidateId ||
      candidate.status !== 'active' ||
      typeof candidate.name !== 'string' ||
      candidate.name.length < 1 ||
      !Number.isFinite(consentExpiresAt) ||
      consentExpiresAt <= Date.now()
    ) throw new ConflictException({
      code: 'RECRUITMENT_ESIGN_CANDIDATE_STATE_INVALID',
      message: '候选人身份或有效授权不足以发起签署',
    });
    const signerAccount = candidate.phone ?? candidate.email;
    if (signerAccount === null) throw new ConflictException({
      code: 'RECRUITMENT_ESIGN_SIGNER_ACCOUNT_MISSING',
      message: '候选人缺少可核验签署账号',
    });
    return Object.freeze({
      offerId: offer.id,
      offerVersion: offer.version,
      candidateId: candidate.id,
      signerName: candidate.name,
      signerAccount,
    });
  }

  private requireScope(): void {
    if (
      !this.context.getActorRequired().scopes.includes(
        'erp:integration:esign:create',
      )
    ) throw new ForbiddenException({
      code: 'RECRUITMENT_ESIGN_SOURCE_DENIED',
      message: '必须由受信任 eSign Worker 读取签署主体',
    });
  }
}
