import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { CandidateApplicationStage } from '../domain/index.js';
import {
  CandidateApplicationRepository,
  CandidateApplicationStageRepository,
  RecruitmentCandidateRepository,
  RecruitmentPositionRepository,
} from '../persistence/recruitment.repositories.js';

export interface RecruitmentTalentApplication {
  readonly id: string;
  readonly positionId: string;
  readonly positionTitle: string;
  readonly departmentId: string;
  readonly location: string;
  readonly stage: CandidateApplicationStage;
  readonly sourceChannel: string;
  readonly offerId: string | null;
  readonly onboardingInstanceId: string | null;
  readonly employmentId: string | null;
  readonly appliedAt: string;
  readonly endedAt: string | null;
  readonly updatedAt: string;
  readonly stageHistory: readonly {
    readonly from: CandidateApplicationStage;
    readonly to: CandidateApplicationStage;
    readonly reasonCode: string | null;
    readonly occurredAt: string;
  }[];
}

export interface RecruitmentTalentCandidate {
  readonly candidateId: string;
  readonly displayName: string | null;
  readonly candidateStatus: 'active' | 'consent_withdrawn' | 'anonymized';
  readonly contactConsentExpiresAt: string;
  readonly retentionExpiresAt: string;
  readonly updatedAt: string;
  readonly applications: readonly RecruitmentTalentApplication[];
}

/** 人才全景的招聘域窄查询口；不返回联系方式、评价、Offer 条款或证据原文。 */
@Injectable()
export class RecruitmentTalentSourceService {
  constructor(
    private readonly context: TenantContextService,
    private readonly candidates: RecruitmentCandidateRepository,
    private readonly applications: CandidateApplicationRepository,
    private readonly stages: CandidateApplicationStageRepository,
    private readonly positions: RecruitmentPositionRepository,
  ) {}

  async listRecent(limit: number): Promise<readonly RecruitmentTalentCandidate[]> {
    this.assertScope();
    const candidates = await this.candidates.findRecent(limit);
    const values = await Promise.all(candidates.map(async (candidate) =>
      this.compose(candidate.id, false),
    ));
    return Object.freeze(values.filter(
      (value): value is RecruitmentTalentCandidate => value !== null,
    ));
  }

  async get(candidateId: string): Promise<RecruitmentTalentCandidate> {
    this.assertScope();
    const value = await this.compose(candidateId, true);
    if (value === null) throw new ForbiddenException({
      code: 'TALENT_LIFECYCLE_CANDIDATE_READ_DENIED',
      message: '无权读取该候选人的人才全景',
    });
    return value;
  }

  private async compose(
    candidateId: string,
    failIfMissing: boolean,
  ): Promise<RecruitmentTalentCandidate | null> {
    const candidate = await this.candidates.findById(candidateId);
    if (candidate === null) {
      if (failIfMissing) throw new NotFoundException({
        code: 'TALENT_LIFECYCLE_CANDIDATE_NOT_FOUND',
        message: '候选人不存在',
      });
      return null;
    }
    const applications = await this.applications.findByCandidateId(candidate.id);
    const composed = await Promise.all(applications.map(async (application) => {
      const [position, stageHistory] = await Promise.all([
        this.positions.findById(application.positionId),
        this.stages.findByApplicationId(application.id),
      ]);
      if (position === null) throw new Error('TALENT_LIFECYCLE_POSITION_REFERENCE_INVALID');
      return Object.freeze({
        id: application.id,
        positionId: position.id,
        positionTitle: position.title,
        departmentId: position.departmentId,
        location: position.location,
        stage: application.stage,
        sourceChannel: application.sourceChannel,
        offerId: application.offerId,
        onboardingInstanceId: application.onboardingInstanceId,
        employmentId: application.employmentId,
        appliedAt: application.appliedAt,
        endedAt: application.endedAt,
        updatedAt: application.updatedAt,
        stageHistory: Object.freeze(stageHistory.map((event) => Object.freeze({
          from: event.from,
          to: event.to,
          reasonCode: event.reasonCode,
          occurredAt: event.occurredAt,
        }))),
      });
    }));
    const actor = this.context.getActorRequired();
    const visibleApplications = actor.scopes.includes('erp:talent-lifecycle:read_all')
      ? composed
      : composed.filter((application) =>
          actor.departmentIds.includes(application.departmentId),
        );
    if (visibleApplications.length === 0) return null;
    return Object.freeze({
      candidateId: candidate.id,
      displayName: candidate.name,
      candidateStatus: candidate.status,
      contactConsentExpiresAt: candidate.consent.expiresAt,
      retentionExpiresAt: candidate.retentionExpiresAt,
      updatedAt: candidate.updatedAt,
      applications: Object.freeze(visibleApplications),
    });
  }

  private assertScope(): void {
    if (!this.context.getActorRequired().scopes.includes('erp:talent-lifecycle:read')) {
      throw new ForbiddenException({
        code: 'TALENT_LIFECYCLE_SCOPE_DENIED',
        message: '缺少人才全周期读取权限',
      });
    }
  }

}
