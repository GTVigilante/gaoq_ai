import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createEventId } from '@gaoq/shared-utils';

import { IdempotencyService } from '../../../core/idempotency/idempotency.service.js';
import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import {
  CareTalentSourceService,
  type CareTalentSnapshot,
} from '../../care/application/care-talent-source.service.js';
import {
  OnboardingTalentSourceService,
  type OnboardingTalentSnapshot,
} from '../../onboarding/application/onboarding-talent-source.service.js';
import {
  OrgTalentSourceService,
  type OrgTalentSnapshot,
} from '../../org/application/org-talent-source.service.js';
import {
  RecruitmentTalentSourceService,
  type RecruitmentTalentCandidate,
} from '../../recruitment/application/recruitment-talent-source.service.js';
import {
  closeTalentTouchpoint,
  createTalentTouchpoint,
  type TalentLifecycleStage,
  type TalentTouchpoint,
} from '../domain/index.js';
import { TalentLifecycleOutboxWriter } from '../persistence/talent-lifecycle-outbox.writer.js';
import {
  TalentTouchpointRepository,
  TalentTouchpointWriteConflictError,
} from '../persistence/talent-lifecycle.repository.js';
import type {
  CloseTalentTouchpointDto,
  CreateTalentTouchpointDto,
  ListTalentLifecycleDto,
} from './talent-lifecycle.dto.js';

export interface TalentTimelineEntry extends Record<string, unknown> {
  readonly id: string;
  readonly domain: 'recruitment' | 'onboarding' | 'org' | 'care' | 'alumni' | 'service';
  readonly eventType: string;
  readonly title: string;
  readonly occurredAt: string;
  readonly referenceType: string;
  readonly referenceId: string;
}

export interface TalentTouchpointMutationView extends Record<string, unknown> {
  readonly id: string;
  readonly candidateId: string;
  readonly kind: TalentTouchpoint['kind'];
  readonly channel: TalentTouchpoint['channel'];
  readonly direction: TalentTouchpoint['direction'];
  readonly outcome: TalentTouchpoint['outcome'];
  readonly ownerActorId: string;
  readonly occurredAt: string;
  readonly nextActionAt: string | null;
  readonly status: TalentTouchpoint['status'];
  readonly version: number;
}

export interface TalentTouchpointView extends TalentTouchpointMutationView {
  readonly note: string | null;
}

export interface TalentLifecycleSummary extends Record<string, unknown> {
  readonly candidateId: string;
  readonly displayName: string | null;
  readonly stage: TalentLifecycleStage;
  readonly candidateStatus: RecruitmentTalentCandidate['candidateStatus'];
  readonly currentApplicationStage: string | null;
  readonly currentPositionTitle: string | null;
  readonly employeeStatus: string | null;
  readonly activeCareStatus: string | null;
  readonly alumniConsentStatus: string | null;
  readonly openFollowUpCount: number;
  readonly nextActionAt: string | null;
  readonly updatedAt: string;
}

export interface TalentLifecycleDetail extends TalentLifecycleSummary {
  readonly personId: string | null;
  readonly candidateContactConsentExpiresAt: string;
  readonly candidateRetentionExpiresAt: string;
  readonly applications: RecruitmentTalentCandidate['applications'];
  readonly onboarding: readonly OnboardingTalentSnapshot[];
  readonly employments: NonNullable<OrgTalentSnapshot>['employments'];
  readonly care: CareTalentSnapshot;
  readonly touchpoints: readonly TalentTouchpointView[];
  readonly timeline: readonly TalentTimelineEntry[];
}

export type TalentLifecycleMcpView = Pick<
  TalentLifecycleSummary,
  | 'candidateId'
  | 'stage'
  | 'currentApplicationStage'
  | 'employeeStatus'
  | 'openFollowUpCount'
  | 'nextActionAt'
  | 'updatedAt'
>;

/** 人才全周期应用服务：跨域只读组装，服务触点在本模块内独立持久化。 */
@Injectable()
export class TalentLifecycleService {
  constructor(
    private readonly context: TenantContextService,
    private readonly idempotency: IdempotencyService,
    private readonly recruitment: RecruitmentTalentSourceService,
    private readonly onboarding: OnboardingTalentSourceService,
    private readonly organization: OrgTalentSourceService,
    private readonly care: CareTalentSourceService,
    private readonly touchpoints: TalentTouchpointRepository,
    private readonly outbox: TalentLifecycleOutboxWriter,
  ) {}

  async list(input: ListTalentLifecycleDto): Promise<{
    readonly items: readonly TalentLifecycleSummary[];
  }> {
    this.assertReadScope();
    const search = input.search?.normalize('NFKC').trim().toLocaleLowerCase('zh-CN') ?? '';
    const candidates = (await this.recruitment.listRecent(200)).filter((candidate) =>
      search.length === 0 ||
      candidate.candidateId.toLowerCase().includes(search) ||
      candidate.displayName?.toLocaleLowerCase('zh-CN').includes(search) === true ||
      candidate.applications.some((application) =>
        application.positionTitle.toLocaleLowerCase('zh-CN').includes(search),
      ),
    );
    const scan = input.stage === undefined ? candidates.slice(0, input.limit) : candidates;
    const values = await Promise.all(scan.map(async (candidate) =>
      this.compose(candidate),
    ));
    const filtered = input.stage === undefined
      ? values
      : values.filter((value) => value.stage === input.stage).slice(0, input.limit);
    return Object.freeze({
      items: Object.freeze(filtered.map((value) => summary(value))),
    });
  }

  async get(candidateId: string): Promise<TalentLifecycleDetail> {
    this.assertReadScope();
    const candidate = await this.recruitment.get(candidateId);
    return this.compose(candidate);
  }

  async getForMcp(candidateId: string): Promise<TalentLifecycleMcpView> {
    const value = await this.get(candidateId);
    return Object.freeze({
      candidateId: value.candidateId,
      stage: value.stage,
      currentApplicationStage: value.currentApplicationStage,
      employeeStatus: value.employeeStatus,
      openFollowUpCount: value.openFollowUpCount,
      nextActionAt: value.nextActionAt,
      updatedAt: value.updatedAt,
    });
  }

  async createTouchpoint(
    candidateId: string,
    key: string,
    input: CreateTalentTouchpointDto,
  ): Promise<{ readonly touchpoint: TalentTouchpointMutationView }> {
    this.assertWriteScope();
    const lifecycle = await this.get(candidateId);
    this.assertContactAllowed(lifecycle, input);
    return this.run(async () => this.idempotency.execute(
      'talent_lifecycle.touchpoint.create',
      key,
      { candidateId, ...input },
      async (session) => {
        const now = new Date();
        const touchpoint = createTalentTouchpoint({
          id: createEventId(now),
          tenantId: this.context.getTenantRequired().tenantId,
          candidateId,
          kind: input.kind,
          channel: input.channel,
          direction: input.direction,
          outcome: input.outcome,
          ownerActorId: this.context.getActorRequired().actorId,
          occurredAt: requiredIso(input.occurredAt),
          nextActionAt: input.nextActionAt === undefined
            ? null
            : requiredIso(input.nextActionAt),
          note: input.note ?? null,
        }, now);
        await this.touchpoints.insert(touchpoint, session);
        await this.outbox.append(touchpoint, 'created', session);
        return { touchpoint: touchpointMutationView(touchpoint) };
      },
    ));
  }

  async closeTouchpoint(
    id: string,
    expectedVersion: number,
    key: string,
    input: CloseTalentTouchpointDto,
  ): Promise<{ readonly touchpoint: TalentTouchpointMutationView }> {
    this.assertWriteScope();
    const route = await this.requireTouchpointRoute(id);
    await this.recruitment.get(route.candidateId);
    const actor = this.context.getActorRequired();
    if (
      route.ownerActorId !== actor.actorId &&
      !actor.scopes.includes('erp:talent-lifecycle:touchpoint:write_all')
    ) throw new ForbiddenException({
      code: 'TALENT_TOUCHPOINT_OWNER_DENIED',
      message: '只能关闭本人负责的跟进行动',
    });
    return this.run(async () => this.idempotency.execute(
      'talent_lifecycle.touchpoint.close',
      key,
      { id, expectedVersion, status: input.status },
      async (session) => {
        const fresh = await this.requireTouchpoint(id, session);
        const closed = closeTalentTouchpoint(fresh, {
          tenantId: this.context.getTenantRequired().tenantId,
          expectedVersion,
          status: input.status,
        }, new Date());
        await this.touchpoints.replace(closed, expectedVersion, session);
        await this.outbox.append(closed, input.status, session);
        return { touchpoint: touchpointMutationView(closed) };
      },
    ));
  }

  private async compose(
    candidate: RecruitmentTalentCandidate,
  ): Promise<TalentLifecycleDetail> {
    const [onboarding, organization, candidateTouchpoints] = await Promise.all([
      this.onboarding.getByCandidateId(candidate.candidateId),
      this.organization.getByCandidateId(candidate.candidateId),
      this.touchpoints.findByCandidateId(candidate.candidateId),
    ]);
    const actor = this.context.getActorRequired();
    const touchpoints = actor.scopes.includes('erp:talent-lifecycle:read_all')
      ? candidateTouchpoints
      : candidateTouchpoints.filter((touchpoint) =>
          touchpoint.ownerActorId === actor.actorId,
        );
    const employments = organization?.employments ?? [];
    const care = await this.care.getByEmploymentIds(
      employments.map((employment) => employment.id),
    );
    const stage = deriveStage(candidate, onboarding, organization, care);
    const currentApplication = selectCurrentApplication(candidate);
    const currentEmployment =
      employments.find((employment) => employment.effectiveTo === null) ??
      employments[0] ??
      null;
    const activeCase = care.cases.find(
      (careCase) => !['completed', 'cancelled'].includes(careCase.status),
    ) ?? null;
    const activeConsent = care.alumniConsents.find(
      (consent) => consent.status === 'active' && Date.parse(consent.expiresAt) > Date.now(),
    ) ?? care.alumniConsents[0] ?? null;
    const openTouchpoints = touchpoints.filter((touchpoint) => touchpoint.status === 'open');
    const nextActionAt = openTouchpoints
      .map((touchpoint) => touchpoint.nextActionAt)
      .filter((value): value is string => value !== null)
      .sort()[0] ?? null;
    const timeline = buildTimeline(candidate, onboarding, employments, care, touchpoints);
    const updatedAt = [
      candidate.updatedAt,
      ...candidate.applications.map((application) => application.updatedAt),
      ...onboarding.map((item) => item.updatedAt),
      ...employments.map((employment) => employment.updatedAt),
      ...care.cases.map((careCase) => careCase.updatedAt),
      ...care.alumniConsents.map((consent) => consent.withdrawnAt ?? consent.grantedAt),
      ...touchpoints.map((touchpoint) => touchpoint.updatedAt),
    ].sort().at(-1) ?? candidate.updatedAt;
    return Object.freeze({
      candidateId: candidate.candidateId,
      displayName: candidate.displayName,
      stage,
      candidateStatus: candidate.candidateStatus,
      currentApplicationStage: currentApplication?.stage ?? null,
      currentPositionTitle: currentApplication?.positionTitle ?? null,
      employeeStatus: currentEmployment?.employeeStatus ?? null,
      activeCareStatus: activeCase?.status ?? null,
      alumniConsentStatus: activeConsent?.status ?? null,
      openFollowUpCount: openTouchpoints.length,
      nextActionAt,
      updatedAt,
      personId: organization?.personId ?? null,
      candidateContactConsentExpiresAt: candidate.contactConsentExpiresAt,
      candidateRetentionExpiresAt: candidate.retentionExpiresAt,
      applications: candidate.applications,
      onboarding,
      employments,
      care,
      touchpoints: Object.freeze(touchpoints.map((touchpoint) => touchpointView(touchpoint))),
      timeline,
    });
  }

  private async requireTouchpoint(
    id: string,
    session?: Parameters<TalentTouchpointRepository['findById']>[1],
  ): Promise<TalentTouchpoint> {
    const touchpoint = await this.touchpoints.findById(id, session);
    if (touchpoint === null) throw new NotFoundException({
      code: 'TALENT_TOUCHPOINT_NOT_FOUND',
      message: '人才服务触点不存在',
    });
    return touchpoint;
  }

  private async requireTouchpointRoute(
    id: string,
  ): Promise<{ readonly candidateId: string; readonly ownerActorId: string }> {
    const route = await this.touchpoints.findAuthorizationRoute(id);
    if (route === null) throw new NotFoundException({
      code: 'TALENT_TOUCHPOINT_NOT_FOUND',
      message: '人才服务触点不存在',
    });
    return route;
  }

  private assertReadScope(): void {
    if (!this.context.getActorRequired().scopes.includes('erp:talent-lifecycle:read')) {
      throw new ForbiddenException({
        code: 'TALENT_LIFECYCLE_SCOPE_DENIED',
        message: '缺少人才全周期读取权限',
      });
    }
  }

  private assertWriteScope(): void {
    const actor = this.context.getActorRequired();
    if (!actor.scopes.includes('erp:talent-lifecycle:touchpoint:write')) {
      throw new ForbiddenException({
        code: 'TALENT_TOUCHPOINT_SCOPE_DENIED',
        message: '缺少人才服务触点写入权限',
      });
    }
  }

  private assertContactAllowed(
    lifecycle: TalentLifecycleDetail,
    input: CreateTalentTouchpointDto,
  ): void {
    if (input.outcome === 'consent_withdrawn' && input.channel === 'internal') return;
    if (['alumni_engagement', 'rehire_contact'].includes(input.kind)) {
      const allowedPurposes = input.kind === 'rehire_contact'
        ? ['rehire_contact']
        : ['alumni_network', 'alumni_events'];
      const consent = lifecycle.care.alumniConsents.find((value) =>
        value.status === 'active' &&
        Date.parse(value.expiresAt) > Date.now() &&
        allowedPurposes.includes(value.purpose) &&
        (!['email', 'phone', 'wechat'].includes(input.channel) ||
          value.channels.includes(input.channel as 'email' | 'phone' | 'wechat')),
      );
      if (consent === undefined) throw new ForbiddenException({
        code: 'TALENT_ALUMNI_CONTACT_CONSENT_REQUIRED',
        message: '缺少与用途、渠道匹配的有效校友联系授权',
      });
      return;
    }
    if (
      ['candidate_outreach', 'interview_support', 'offer_support', 'onboarding_support']
        .includes(input.kind) &&
      (
        lifecycle.candidateStatus !== 'active' ||
        Date.parse(lifecycle.candidateContactConsentExpiresAt) <= Date.now() ||
        Date.parse(lifecycle.candidateRetentionExpiresAt) <= Date.now()
      )
    ) throw new ForbiddenException({
      code: 'TALENT_CANDIDATE_CONTACT_CONSENT_REQUIRED',
      message: '候选人授权无效，禁止继续招聘联系',
    });
  }

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (
        error instanceof TalentTouchpointWriteConflictError ||
        (error instanceof Error && [
          'TALENT_TOUCHPOINT_VERSION_CONFLICT',
          'TALENT_TOUCHPOINT_ALREADY_CLOSED',
        ].includes(error.message))
      ) throw new ConflictException({
        code: 'TALENT_TOUCHPOINT_VERSION_CONFLICT',
        message: '服务触点已变化，请刷新后重试',
      });
      if (error instanceof Error && error.message.startsWith('TALENT_TOUCHPOINT_')) {
        throw new BadRequestException({
          code: error.message,
          message: '服务触点时间或内容不符合约束',
        });
      }
      throw error;
    }
  }
}

function deriveStage(
  candidate: RecruitmentTalentCandidate,
  onboarding: readonly OnboardingTalentSnapshot[],
  organization: OrgTalentSnapshot | null,
  care: CareTalentSnapshot,
): TalentLifecycleStage {
  const now = Date.now();
  if (care.cases.some(
    (careCase) => !['completed', 'cancelled'].includes(careCase.status),
  )) return 'offboarding';
  if (organization?.employments.some((employment) => employment.effectiveTo === null)) {
    return 'employed';
  }
  if (onboarding.some((instance) =>
    ['in_progress', 'ready', 'provisioning'].includes(instance.status),
  )) return 'onboarding';
  const stage = selectCurrentApplication(candidate)?.stage;
  if (stage === 'offer_approval' || stage === 'offer_sent' || stage === 'offer_accepted') {
    return 'offer';
  }
  if (stage === 'applied' || stage === 'screening' || stage === 'interview') return 'recruiting';
  if (care.alumniConsents.some(
    (consent) => consent.status === 'active' && Date.parse(consent.expiresAt) > now,
  )) return 'alumni';
  if (care.cases.some((careCase) => careCase.status === 'completed')) return 'former_employee';
  if (candidate.candidateStatus !== 'active') return 'inactive';
  return 'talent_pool';
}

function selectCurrentApplication(
  candidate: RecruitmentTalentCandidate,
): RecruitmentTalentCandidate['applications'][number] | null {
  return candidate.applications.find((application) =>
    !['hired', 'rejected', 'withdrawn'].includes(application.stage),
  ) ?? candidate.applications[0] ?? null;
}

function buildTimeline(
  candidate: RecruitmentTalentCandidate,
  onboarding: readonly OnboardingTalentSnapshot[],
  employments: NonNullable<OrgTalentSnapshot>['employments'],
  care: CareTalentSnapshot,
  touchpoints: readonly TalentTouchpoint[],
): readonly TalentTimelineEntry[] {
  const entries: TalentTimelineEntry[] = [];
  for (const application of candidate.applications) {
    entries.push(entry(
      `recruitment:${application.id}:applied`,
      'recruitment',
      'application.applied',
      `投递职位：${application.positionTitle}`,
      application.appliedAt,
      'application',
      application.id,
    ));
    for (const stage of application.stageHistory) {
      entries.push(entry(
        `recruitment:${application.id}:${stage.occurredAt}:${stage.to}`,
        'recruitment',
        'application.stage_changed',
        `招聘阶段：${stage.from} → ${stage.to}`,
        stage.occurredAt,
        'application',
        application.id,
      ));
    }
  }
  for (const instance of onboarding) {
    entries.push(entry(
      `onboarding:${instance.id}:created`,
      'onboarding',
      'onboarding.created',
      '进入入职办理',
      instance.createdAt,
      'onboarding',
      instance.id,
    ));
    if (instance.updatedAt !== instance.createdAt) {
      entries.push(entry(
        `onboarding:${instance.id}:${instance.status}`,
        'onboarding',
        'onboarding.status',
        `入职状态：${instance.status}`,
        instance.updatedAt,
        'onboarding',
        instance.id,
      ));
    }
  }
  for (const employment of employments) {
    entries.push(entry(
      `org:${employment.id}:established`,
      'org',
      'employment.established',
      `建立劳动关系：${employment.employeeNo}`,
      employment.createdAt,
      'employment',
      employment.id,
    ));
    if (employment.effectiveTo !== null) {
      entries.push(entry(
        `org:${employment.id}:terminated`,
        'org',
        'employment.terminated',
        '劳动关系结束',
        employment.updatedAt,
        'employment',
        employment.id,
      ));
    }
  }
  for (const careCase of care.cases) {
    entries.push(entry(
      `care:${careCase.id}:created`,
      'care',
      'care.case.created',
      '发起离职服务',
      careCase.createdAt,
      'care_case',
      careCase.id,
    ));
    if (careCase.updatedAt !== careCase.createdAt) {
      entries.push(entry(
        `care:${careCase.id}:${careCase.status}`,
        'care',
        'care.case.status',
        `离职服务状态：${careCase.status}`,
        careCase.updatedAt,
        'care_case',
        careCase.id,
      ));
    }
  }
  for (const consent of care.alumniConsents) {
    entries.push(entry(
      `alumni:${consent.id}:granted`,
      'alumni',
      'alumni.consent.granted',
      `校友联系授权：${consent.purpose}`,
      consent.grantedAt,
      'alumni_consent',
      consent.id,
    ));
    if (consent.withdrawnAt !== null) {
      entries.push(entry(
        `alumni:${consent.id}:withdrawn`,
        'alumni',
        'alumni.consent.withdrawn',
        '校友联系授权已撤回',
        consent.withdrawnAt,
        'alumni_consent',
        consent.id,
      ));
    }
  }
  for (const touchpoint of touchpoints) {
    entries.push(entry(
      `service:${touchpoint.id}`,
      'service',
      `touchpoint.${touchpoint.status}`,
      `服务跟进：${touchpoint.kind} / ${touchpoint.outcome}`,
      touchpoint.occurredAt,
      'touchpoint',
      touchpoint.id,
    ));
  }
  return Object.freeze(entries.sort((left, right) =>
    right.occurredAt.localeCompare(left.occurredAt) || left.id.localeCompare(right.id),
  ));
}

function entry(
  id: string,
  domain: TalentTimelineEntry['domain'],
  eventType: string,
  title: string,
  occurredAt: string,
  referenceType: string,
  referenceId: string,
): TalentTimelineEntry {
  return Object.freeze({
    id, domain, eventType, title, occurredAt, referenceType, referenceId,
  });
}

function summary(value: TalentLifecycleDetail): TalentLifecycleSummary {
  return Object.freeze({
    candidateId: value.candidateId,
    displayName: value.displayName,
    stage: value.stage,
    candidateStatus: value.candidateStatus,
    currentApplicationStage: value.currentApplicationStage,
    currentPositionTitle: value.currentPositionTitle,
    employeeStatus: value.employeeStatus,
    activeCareStatus: value.activeCareStatus,
    alumniConsentStatus: value.alumniConsentStatus,
    openFollowUpCount: value.openFollowUpCount,
    nextActionAt: value.nextActionAt,
    updatedAt: value.updatedAt,
  });
}

function touchpointMutationView(
  touchpoint: TalentTouchpoint,
): TalentTouchpointMutationView {
  return Object.freeze({
    id: touchpoint.id,
    candidateId: touchpoint.candidateId,
    kind: touchpoint.kind,
    channel: touchpoint.channel,
    direction: touchpoint.direction,
    outcome: touchpoint.outcome,
    ownerActorId: touchpoint.ownerActorId,
    occurredAt: touchpoint.occurredAt,
    nextActionAt: touchpoint.nextActionAt,
    status: touchpoint.status,
    version: touchpoint.version,
  });
}

function touchpointView(touchpoint: TalentTouchpoint): TalentTouchpointView {
  return Object.freeze({
    ...touchpointMutationView(touchpoint),
    note: touchpoint.note,
  });
}

function requiredIso(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestException({
      code: 'TALENT_TOUCHPOINT_INPUT_INVALID',
      message: '服务触点时间格式无效',
    });
  }
  return parsed.toISOString();
}
