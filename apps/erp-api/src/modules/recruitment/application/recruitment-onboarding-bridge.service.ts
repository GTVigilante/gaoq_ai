import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { ClientSession } from 'mongoose';

import { IdempotencyService } from '../../../core/idempotency/idempotency.service.js';
import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import {
  buildCandidateApplicationStageEvent,
  transitionCandidateApplication,
  type CandidateApplication,
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
    if (offer.status !== 'accepted' && offer.status !== 'signed') throw new ConflictException({
      code: 'RECRUITMENT_ONBOARDING_OFFER_NOT_ACCEPTED',
      message: '只有候选人已接受的 Offer 可以创建入职实例',
    });
    if (offer.acceptanceEvidenceId === null) throw new ConflictException({
      code: 'RECRUITMENT_ONBOARDING_ACCEPTANCE_EVIDENCE_REQUIRED',
      message: 'Offer 缺少候选人接受证据',
    });
    const [application, candidate, position] = await Promise.all([
      this.applications.findById(offer.applicationId),
      this.candidates.findById(offer.candidateId),
      this.positions.findById(offer.positionId),
    ]);
    if (
      application === null || application.offerId !== offer.id ||
      application.candidateId !== offer.candidateId ||
      !['offer_accepted', 'preboarding', 'hired'].includes(application.stage)
    ) throw new ConflictException({
      code: 'RECRUITMENT_ONBOARDING_APPLICATION_INVALID',
      message: '候选申请与 Offer 状态不一致',
    });
    if (
      candidate === null || candidate.name === null ||
      (application.stage === 'offer_accepted' && candidate.status !== 'active')
    ) {
      throw new ConflictException({
        code: 'RECRUITMENT_ONBOARDING_CANDIDATE_INVALID',
        message: '候选人不可用于入职处理',
      });
    }
    if (position === null) throw this.notFound('招聘职位');
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
        const application = await this.requireApplicationForOffer(input.offerId, session);
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
        const application = await this.requireApplicationForOffer(input.offerId, session);
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
        const transition = this.transition(application, 'hired', input.employmentId);
        await this.persist(application, transition, session);
        return { applicationId: transition.application.id, stage: 'hired' };
      },
    );
  }

  private async requireApplicationForOffer(
    offerId: string,
    session: ClientSession,
  ): Promise<CandidateApplication> {
    const offer = await this.offers.findById(offerId, session);
    if (offer === null || !['accepted', 'signed'].includes(offer.status)) throw new ConflictException({
      code: 'RECRUITMENT_ONBOARDING_OFFER_INVALID', message: 'Offer 不存在或未被接受',
    });
    const application = await this.applications.findById(offer.applicationId, session);
    if (application === null || application.offerId !== offer.id) throw new ConflictException({
      code: 'RECRUITMENT_ONBOARDING_APPLICATION_INVALID', message: '候选申请与 Offer 不匹配',
    });
    return application;
  }

  private transition(
    application: CandidateApplication,
    targetStage: 'preboarding' | 'hired',
    evidenceId: string,
  ) {
    return transitionCandidateApplication(application, {
      tenantId: this.context.getTenantRequired().tenantId,
      expectedVersion: application.version,
      actorId: this.context.getActorRequired().actorId,
      targetStage,
      evidenceId,
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
}
