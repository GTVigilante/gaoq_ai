import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { ClientSession } from 'mongoose';

import { IdempotencyService } from '../../../core/idempotency/idempotency.service.js';
import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import {
  buildCandidateApplicationStageEvent,
  transitionCandidateApplication,
  type CandidateApplication,
  type RecruitmentOffer,
} from '../domain/index.js';
import { RecruitmentOutboxWriter } from '../persistence/recruitment-outbox.writer.js';
import {
  CandidateApplicationRepository,
  CandidateApplicationStageRepository,
  RecruitmentCandidateRepository,
  RecruitmentOfferRepository,
  RecruitmentPositionRepository,
} from '../persistence/recruitment.repositories.js';

export interface RecruitmentOnboardingSource {
  readonly offerId: string;
  readonly applicationId: string;
  readonly candidateId: string;
  readonly candidateDisplayName: string;
  readonly acceptanceEvidenceId: string;
  readonly signedEvidenceId: string | null;
  readonly proposedStartDate: string;
  readonly departmentId: string;
  readonly jobLevelId: string;
}

/** Recruitment 与 Onboarding 的窄应用服务边界，禁止跨模块直接访问招聘集合。 */
@Injectable()
export class RecruitmentOnboardingBridgeService {
  constructor(
    private readonly idempotency: IdempotencyService,
    private readonly context: TenantContextService,
    private readonly candidates: RecruitmentCandidateRepository,
    private readonly applications: CandidateApplicationRepository,
    private readonly stages: CandidateApplicationStageRepository,
    private readonly positions: RecruitmentPositionRepository,
    private readonly offers: RecruitmentOfferRepository,
    private readonly outbox: RecruitmentOutboxWriter,
  ) {}

  /** 返回入职所需的最小投影，不返回薪资、福利、联系方式或合同正文。 */
  async getOnboardingSource(offerId: string): Promise<RecruitmentOnboardingSource> {
    this.assertScope('erp:onboarding:recruitment:read');
    const offer = await this.offers.findById(offerId);
    if (offer === null) throw this.notFound('Offer');
    this.assertOfferReference(offer, offerId);
    if (offer.status !== 'accepted' && offer.status !== 'signed') throw new ConflictException({
      code: 'RECRUITMENT_ONBOARDING_OFFER_NOT_ACCEPTED',
      message: '只有候选人已接受的 Offer 可以创建入职实例',
    });
    if (offer.acceptanceEvidenceId === null) throw new ConflictException({
      code: 'RECRUITMENT_ONBOARDING_ACCEPTANCE_EVIDENCE_REQUIRED',
      message: 'Offer 缺少候选人接受证据',
    });
    if (offer.status === 'signed' && offer.signedEvidenceId === null) {
      throw this.sourceReferenceInvalid();
    }
    const [application, candidate, position] = await Promise.all([
      this.applications.findById(offer.applicationId),
      this.candidates.findById(offer.candidateId),
      this.positions.findById(offer.positionId),
    ]);
    if (
      application === null ||
      !['offer_accepted', 'preboarding', 'hired'].includes(application.stage)
    ) throw new ConflictException({
      code: 'RECRUITMENT_ONBOARDING_APPLICATION_INVALID',
      message: '候选申请与 Offer 状态不一致',
    });
    this.assertApplicationReference(application, offer);
    if (
      candidate === null ||
      candidate.tenantId !== this.context.getTenantRequired().tenantId ||
      candidate.id !== offer.candidateId ||
      candidate.name === null ||
      (application.stage === 'offer_accepted' && candidate.status !== 'active')
    ) {
      throw new ConflictException({
        code: 'RECRUITMENT_ONBOARDING_CANDIDATE_INVALID',
        message: '候选人不可用于入职处理',
      });
    }
    if (position === null) throw this.notFound('招聘职位');
    if (
      position.tenantId !== this.context.getTenantRequired().tenantId ||
      position.id !== offer.positionId
    ) {
      throw this.sourceReferenceInvalid();
    }
    return Object.freeze({
      offerId: offer.id, applicationId: application.id, candidateId: candidate.id,
      candidateDisplayName: candidate.name,
      acceptanceEvidenceId: offer.acceptanceEvidenceId,
      signedEvidenceId: offer.signedEvidenceId,
      proposedStartDate: offer.terms.proposedStartDate,
      departmentId: position.departmentId, jobLevelId: position.jobLevelId,
    });
  }

  /** 由已落库的 Onboarding 实例推进申请；重复调用必须返回相同阶段。 */
  async markPreboarding(
    key: string,
    input: { readonly offerId: string; readonly onboardingInstanceId: string },
  ): Promise<{ readonly applicationId: string; readonly stage: 'preboarding' | 'hired' }> {
    this.assertScope('erp:onboarding:recruitment:advance');
    return this.idempotency.execute(
      'recruitment.onboarding.mark_preboarding', key, input,
      async (session) => {
        const application = await this.requireApplicationForOffer(
          input.offerId,
          ['accepted', 'signed'],
          session,
        );
        if (application.stage === 'preboarding' || application.stage === 'hired') {
          if (application.onboardingInstanceId !== input.onboardingInstanceId) {
            throw this.onboardingMismatch();
          }
          return { applicationId: application.id, stage: application.stage };
        }
        if (application.stage !== 'offer_accepted') throw new ConflictException({
          code: 'RECRUITMENT_PREBOARDING_TRANSITION_INVALID',
          message: '候选申请不处于可进入预入职的阶段',
        });
        const transition = this.transition(application, 'preboarding', input.onboardingInstanceId);
        await this.persist(application, transition, session);
        return { applicationId: transition.application.id, stage: 'preboarding' };
      },
    );
  }

  /** 只有 Onboarding 完成并取得 Employment 后才能把申请推进到 hired。 */
  async markHired(
    key: string,
    input: {
      readonly offerId: string;
      readonly onboardingInstanceId: string;
      readonly onboardingCompletionEvidenceId: string;
      readonly employmentId: string;
    },
  ): Promise<{ readonly applicationId: string; readonly stage: 'hired' }> {
    this.assertScope('erp:onboarding:recruitment:advance');
    return this.idempotency.execute(
      'recruitment.onboarding.mark_hired', key, input,
      async (session) => {
        const application = await this.requireApplicationForOffer(
          input.offerId,
          ['signed'],
          session,
        );
        if (application.onboardingInstanceId !== input.onboardingInstanceId) {
          throw this.onboardingMismatch();
        }
        if (application.stage === 'hired') {
          if (application.employmentId !== input.employmentId) throw new ConflictException({
            code: 'RECRUITMENT_EMPLOYMENT_MISMATCH', message: '候选申请已绑定不同劳动关系',
          });
          return { applicationId: application.id, stage: 'hired' };
        }
        if (application.stage !== 'preboarding') throw new ConflictException({
          code: 'RECRUITMENT_HIRED_TRANSITION_INVALID', message: '候选申请不处于预入职阶段',
        });
        const transition = this.transition(
          application,
          'hired',
          input.onboardingCompletionEvidenceId,
          input.employmentId,
        );
        await this.persist(application, transition, session);
        return { applicationId: transition.application.id, stage: 'hired' };
      },
    );
  }

  private async requireApplicationForOffer(
    offerId: string,
    allowedOfferStatuses: readonly RecruitmentOffer['status'][],
    session: ClientSession,
  ): Promise<CandidateApplication> {
    const offer = await this.offers.findById(offerId, session);
    if (offer === null) throw new ConflictException({
      code: 'RECRUITMENT_ONBOARDING_OFFER_INVALID', message: 'Offer 不存在或未被接受',
    });
    this.assertOfferReference(offer, offerId);
    if (!allowedOfferStatuses.includes(offer.status)) throw new ConflictException({
      code: 'RECRUITMENT_ONBOARDING_OFFER_INVALID', message: 'Offer 不存在或未被接受',
    });
    if (offer.acceptanceEvidenceId === null) throw this.sourceReferenceInvalid();
    if (offer.status === 'signed' && offer.signedEvidenceId === null) {
      throw this.sourceReferenceInvalid();
    }
    const application = await this.applications.findById(offer.applicationId, session);
    if (application === null) throw new ConflictException({
      code: 'RECRUITMENT_ONBOARDING_APPLICATION_INVALID', message: '候选申请与 Offer 不匹配',
    });
    this.assertApplicationReference(application, offer);
    return application;
  }

  private transition(
    application: CandidateApplication,
    targetStage: 'preboarding' | 'hired',
    evidenceId: string,
    employmentId?: string,
  ) {
    return transitionCandidateApplication(application, {
      tenantId: this.context.getTenantRequired().tenantId,
      expectedVersion: application.version,
      actorId: this.context.getActorRequired().actorId,
      targetStage,
      evidenceId,
      ...(employmentId === undefined ? {} : { employmentId }),
    }, new Date());
  }

  private async persist(
    previous: CandidateApplication,
    transition: ReturnType<typeof transitionCandidateApplication>,
    session: ClientSession,
  ): Promise<void> {
    await this.applications.replace(transition.application, previous.version, session);
    await this.stages.append(transition.event, session);
    await this.outbox.append(buildCandidateApplicationStageEvent(transition.event), session);
  }

  private assertScope(scope: string): void {
    if (!this.context.getActorRequired().scopes.includes(scope)) throw new ForbiddenException({
      code: 'RECRUITMENT_ONBOARDING_TRUSTED_WORKFLOW_REQUIRED',
      message: '必须由受信任的入职工作流调用',
    });
  }

  private notFound(resource: string): NotFoundException {
    return new NotFoundException({
      code: 'RECRUITMENT_ONBOARDING_SOURCE_NOT_FOUND', message: `${resource}不存在`,
    });
  }

  private onboardingMismatch(): ConflictException {
    return new ConflictException({
      code: 'RECRUITMENT_ONBOARDING_INSTANCE_MISMATCH',
      message: '候选申请已绑定不同入职实例',
    });
  }

  private assertOfferReference(offer: RecruitmentOffer, offerId: string): void {
    if (
      offer.tenantId !== this.context.getTenantRequired().tenantId ||
      offer.id !== offerId
    ) {
      throw this.sourceReferenceInvalid();
    }
  }

  private assertApplicationReference(
    application: CandidateApplication,
    offer: RecruitmentOffer,
  ): void {
    if (
      application.tenantId !== this.context.getTenantRequired().tenantId ||
      application.id !== offer.applicationId ||
      application.offerId !== offer.id ||
      application.candidateId !== offer.candidateId ||
      application.positionId !== offer.positionId ||
      application.completedInterviewId !== offer.completedInterviewId ||
      application.acceptanceEvidenceId !== offer.acceptanceEvidenceId
    ) {
      throw this.sourceReferenceInvalid();
    }
  }

  private sourceReferenceInvalid(): ConflictException {
    return new ConflictException({
      code: 'RECRUITMENT_ONBOARDING_SOURCE_REFERENCE_INVALID',
      message: '招聘与入职来源引用不一致，必须人工复核',
    });
  }
}
