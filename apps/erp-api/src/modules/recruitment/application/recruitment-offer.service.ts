import { createHash } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createEventId } from '@gaoq/shared-utils';
import type { ClientSession } from 'mongoose';

import { IdempotencyService } from '../../../core/idempotency/idempotency.service.js';
import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { ApprovalApplicationService } from '../../approval/application/approval-application.service.js';
import {
  applyRecruitmentOfferApprovalOutcome,
  buildCandidateApplicationStageEvent,
  buildRecruitmentOfferEvent,
  createRecruitmentOfferEvidence,
  createRecruitmentOffer,
  recordRecruitmentOfferDecision,
  recordRecruitmentOfferSent,
  recordRecruitmentOfferSigned,
  requestRecruitmentOfferSend,
  submitRecruitmentOffer,
  transitionCandidateApplication,
  RecruitmentDomainError,
  type CandidateApplication,
  type RecruitmentOffer,
  type RecruitmentOfferTerms,
} from '../domain/index.js';
import { RecruitmentOutboxWriter } from '../persistence/recruitment-outbox.writer.js';
import {
  CandidateApplicationRepository,
  CandidateApplicationStageRepository,
  RecruitmentInterviewRepository,
  RecruitmentOfferRepository,
  RecruitmentOfferEvidenceRepository,
  RecruitmentPositionRepository,
  RecruitmentWriteConflictError,
} from '../persistence/recruitment.repositories.js';

const OFFER_APPROVAL_TEMPLATE_CODE = 'recruitment_offer';

export interface RecruitmentOfferSummary extends Record<string, unknown> {
  readonly id: string;
  readonly applicationId: string;
  readonly positionId: string;
  readonly completedInterviewId: string;
  readonly status: RecruitmentOffer['status'];
  readonly expiresAt: string;
  readonly approvalInstanceId: string | null;
  readonly sendRequestId: string | null;
  readonly sentEvidenceId: string | null;
  readonly acceptanceEvidenceId: string | null;
  readonly esignFlowId: string | null;
  readonly signedEvidenceId: string | null;
  readonly version: number;
}

/** Offer 应用服务；REST、Worker 与 MCP 复用同一门禁，L4 条款不进入响应或事件。 */
@Injectable()
export class RecruitmentOfferService {
  constructor(
    private readonly idempotency: IdempotencyService,
    private readonly context: TenantContextService,
    private readonly approvals: ApprovalApplicationService,
    private readonly applications: CandidateApplicationRepository,
    private readonly stages: CandidateApplicationStageRepository,
    private readonly positions: RecruitmentPositionRepository,
    private readonly interviews: RecruitmentInterviewRepository,
    private readonly offers: RecruitmentOfferRepository,
    private readonly evidence: RecruitmentOfferEvidenceRepository,
    private readonly outbox: RecruitmentOutboxWriter,
  ) {}

  async create(
    applicationId: string,
    expectedApplicationVersion: number,
    key: string,
    input: {
      readonly completedInterviewId: string;
      readonly terms: RecruitmentOfferTerms;
      readonly expiresAt: string;
      readonly retentionExpiresAt: string;
    },
  ): Promise<{ readonly offer: RecruitmentOfferSummary }> {
    return this.run(async () => this.idempotency.execute(
      'recruitment.offer.create', key,
      { applicationId, expectedApplicationVersion, ...input }, async (session) => {
        const application = await this.requireApplication(applicationId, session);
        if (application.version !== expectedApplicationVersion) throw versionConflict();
        if (application.stage !== 'interview') throw new ConflictException({
          code: 'RECRUITMENT_OFFER_APPLICATION_STAGE_INVALID',
          message: '只有处于面试阶段的申请可以形成 Offer',
        });
        const interview = await this.interviews.findById(input.completedInterviewId, session);
        if (
          interview === null || interview.applicationId !== application.id ||
          interview.status !== 'completed'
        ) throw new ConflictException({
          code: 'RECRUITMENT_OFFER_INTERVIEW_EVIDENCE_INVALID',
          message: 'Offer 必须引用该申请已完成的面试',
        });
        const position = await this.requirePosition(application.positionId, session);
        this.assertDepartmentWrite(position.departmentId);
        const trusted = this.context.getRequired();
        const now = new Date();
        const offer = createRecruitmentOffer({
          id: createEventId(now), tenantId: trusted.tenant.tenantId,
          applicationId: application.id, candidateId: application.candidateId,
          positionId: application.positionId, completedInterviewId: interview.id,
          terms: input.terms, expiresAt: requiredDate(input.expiresAt),
          retentionExpiresAt: requiredDate(input.retentionExpiresAt),
          actorId: trusted.actor.actorId,
        }, now);
        await this.offers.insert(offer, session);
        await this.outbox.append(buildRecruitmentOfferEvent(offer, 'created'), session);
        return { offer: offerSummary(offer) };
      },
    ));
  }

  /** 审批创建、提交和招聘绑定均由根幂等键派生，崩溃后可恢复到同一实例。 */
  async submit(
    id: string,
    expectedVersion: number,
    key: string,
  ): Promise<{ readonly offer: RecruitmentOfferSummary }> {
    return this.run(async () => {
      const current = await this.requireOffer(id);
      if (current.status === 'pending_approval' && current.approvalInstanceId !== null) {
        return this.linkApproval(id, expectedVersion, key, current.approvalInstanceId);
      }
      submitRecruitmentOffer(current, {
        tenantId: this.context.getTenantRequired().tenantId, expectedVersion,
        actorId: this.context.getActorRequired().actorId,
        approvalInstanceId: '00000000000000000000000000',
      }, new Date());
      const position = await this.requirePosition(current.positionId);
      this.assertDepartmentWrite(position.departmentId);
      const created = await this.approvals.createInstance(deriveKey(key, 'approval-create'), {
        templateCode: OFFER_APPROVAL_TEMPLATE_CODE,
        title: `Offer审批：${current.id}`,
        formData: {
          offer_id: current.id,
          application_id: current.applicationId,
          department_id: position.departmentId,
          currency: current.terms.currency,
          monthly_base_salary_minor: current.terms.monthlyBaseSalaryMinor,
          salary_months: current.terms.salaryMonths,
          annual_variable_target_minor: current.terms.annualVariableTargetMinor,
          signing_bonus_minor: current.terms.signingBonusMinor,
          proposed_start_date: current.terms.proposedStartDate,
          probation_months: current.terms.probationMonths,
          employment_type: current.terms.employmentType,
          work_location: current.terms.workLocation,
          benefits_summary: current.terms.benefitsSummary,
        },
      });
      const submitted = await this.approvals.submitInstance(
        created.instance.id, created.instance.version, deriveKey(key, 'approval-submit'),
      );
      if (submitted.instance.status !== 'running' && submitted.instance.status !== 'approved') {
        throw new ConflictException({
          code: 'RECRUITMENT_OFFER_APPROVAL_SUBMIT_INVALID',
          message: 'Offer 审批未进入可处理状态',
        });
      }
      return this.linkApproval(id, expectedVersion, key, created.instance.id);
    });
  }

  async syncApproval(
    id: string,
    expectedVersion: number,
    key: string,
  ): Promise<{ readonly offer: RecruitmentOfferSummary }> {
    return this.run(async () => {
      const current = await this.requireOffer(id);
      if (current.status === 'approved' || current.status === 'rejected') {
        if (current.approvalInstanceId === null) throw new Error('RECRUITMENT_OFFER_APPROVAL_INVALID');
        return this.applyApproval(
          id, expectedVersion, key, current.approvalInstanceId, current.status,
        );
      }
      if (current.status !== 'pending_approval' || current.approvalInstanceId === null) {
        throw new ConflictException({
          code: 'RECRUITMENT_OFFER_APPROVAL_SYNC_INVALID',
          message: '当前 Offer 状态不可同步审批',
        });
      }
      const approval = await this.approvals.getInstanceStatusForRecruitmentOffer(
        current.approvalInstanceId,
      );
      if (approval.status !== 'approved' && approval.status !== 'rejected') {
        throw new ConflictException({
          code: 'RECRUITMENT_OFFER_APPROVAL_NOT_TERMINAL', message: '审批尚未形成可信终态',
        });
      }
      if (approval.templateCode !== OFFER_APPROVAL_TEMPLATE_CODE) throw new ForbiddenException({
        code: 'RECRUITMENT_OFFER_APPROVAL_TEMPLATE_MISMATCH',
        message: 'Offer 审批模板引用不匹配',
      });
      return this.applyApproval(id, expectedVersion, key, approval.id, approval.status);
    });
  }

  /** R2 发送只创建意图，Integration 投递成功前不推进申请阶段。 */
  async requestSend(
    id: string,
    expectedVersion: number,
    key: string,
  ): Promise<{ readonly offer: RecruitmentOfferSummary }> {
    return this.run(async () => this.idempotency.execute(
      'recruitment.offer.request_send', key, { id, expectedVersion }, async (session) => {
        const current = await this.requireOffer(id, session);
        const position = await this.requirePosition(current.positionId, session);
        this.assertDepartmentWrite(position.departmentId);
        const now = new Date();
        const offer = requestRecruitmentOfferSend(current, {
          tenantId: this.context.getTenantRequired().tenantId,
          expectedVersion, sendRequestId: createEventId(now),
        }, now);
        await this.offers.replace(offer, expectedVersion, session);
        await this.outbox.append(buildRecruitmentOfferEvent(offer, 'send_requested'), session);
        return { offer: offerSummary(offer) };
      },
    ));
  }

  /** Integration Worker 专用：只有可信投递回执可以推进 Offer 与申请。 */
  async recordSentForIntegration(
    id: string,
    expectedVersion: number,
    key: string,
    input: {
      readonly sendRequestId: string;
      readonly proofHash: string;
      readonly deliveredAt: string;
    },
  ): Promise<{ readonly offer: RecruitmentOfferSummary }> {
    this.assertTrustedScope('erp:integration:offer:deliver');
    return this.run(async () => this.idempotency.execute(
      'recruitment.offer.record_sent', key, { id, expectedVersion, ...input },
      async (session) => {
        const current = await this.requireOffer(id, session);
        const now = new Date();
        const occurredAt = requiredDate(input.deliveredAt);
        if (occurredAt.getTime() < Date.parse(current.updatedAt)) throw new RecruitmentDomainError(
          'RECRUITMENT_OFFER_EVIDENCE_TIME_INVALID',
          '投递证据时间不能早于发送请求',
        );
        const sentEvidence = createRecruitmentOfferEvidence({
          id: createEventId(now), tenantId: current.tenantId, offerId: current.id,
          kind: 'sent', sendRequestId: input.sendRequestId, proofHash: input.proofHash,
          occurredAt, actorId: this.context.getActorRequired().actorId,
        }, now);
        const offer = recordRecruitmentOfferSent(current, {
          tenantId: this.context.getTenantRequired().tenantId, expectedVersion,
          sendRequestId: input.sendRequestId, sentEvidenceId: sentEvidence.id,
          deliveryVerified: true,
        }, now);
        const application = await this.requireApplication(current.applicationId, session);
        const transition = this.transitionApplication(
          application, 'offer_sent', offer.id, this.context.getActorRequired().actorId,
        );
        await this.evidence.append(sentEvidence, session);
        await this.offers.replace(offer, expectedVersion, session);
        await this.persistApplicationTransition(application, transition, session);
        await this.outbox.append(buildRecruitmentOfferEvent(offer, 'sent'), session);
        return { offer: offerSummary(offer) };
      },
    ));
  }

  /** 候选人门户专用：actor 必须是已验证的候选人主体，不能由管理端代报。 */
  async recordCandidateDecision(
    id: string,
    expectedVersion: number,
    key: string,
    input: {
      readonly decision: 'accepted' | 'declined';
      readonly candidateId: string;
      readonly authenticationEvidenceId: string;
      readonly proofHash: string;
      readonly decidedAt: string;
    },
  ): Promise<{ readonly offer: RecruitmentOfferSummary }> {
    this.assertTrustedScope('erp:recruitment:offer:candidate_decide');
    return this.run(async () => this.idempotency.execute(
      'recruitment.offer.candidate_decide', key, { id, expectedVersion, ...input },
      async (session) => {
        const current = await this.requireOffer(id, session);
        if (input.candidateId !== current.candidateId) throw new ForbiddenException({
          code: 'RECRUITMENT_OFFER_CANDIDATE_MISMATCH',
          message: '候选人身份与 Offer 不匹配',
        });
        const now = new Date();
        const occurredAt = requiredDate(input.decidedAt);
        if (occurredAt.getTime() < Date.parse(current.updatedAt)) throw new RecruitmentDomainError(
          'RECRUITMENT_OFFER_EVIDENCE_TIME_INVALID',
          '候选人决定时间不能早于 Offer 送达',
        );
        const decisionEvidence = createRecruitmentOfferEvidence({
          id: createEventId(now), tenantId: current.tenantId, offerId: current.id,
          kind: input.decision, subjectCandidateId: input.candidateId,
          authenticationEvidenceId: input.authenticationEvidenceId,
          proofHash: input.proofHash, occurredAt,
          actorId: this.context.getActorRequired().actorId,
        }, now);
        const offer = recordRecruitmentOfferDecision(current, {
          tenantId: this.context.getTenantRequired().tenantId, expectedVersion,
          decision: input.decision, acceptanceEvidenceId: decisionEvidence.id,
          candidateEvidenceVerified: true,
        }, now);
        const application = await this.requireApplication(current.applicationId, session);
        const transition = this.transitionApplication(
          application, input.decision === 'accepted' ? 'offer_accepted' : 'withdrawn',
          decisionEvidence.id, this.context.getActorRequired().actorId,
          input.decision === 'declined' ? 'offer_declined' : undefined,
        );
        await this.evidence.append(decisionEvidence, session);
        await this.persistApplicationTransition(application, transition, session);
        await this.offers.replace(offer, expectedVersion, session);
        await this.outbox.append(buildRecruitmentOfferEvent(offer, input.decision), session);
        return { offer: offerSummary(offer) };
      },
    ));
  }

  /** eSign Worker 专用：验签、租户映射和证据归档完成后才能调用。 */
  async recordSignedForIntegration(
    id: string,
    expectedVersion: number,
    key: string,
    input: { readonly esignFlowId: string; readonly signedEvidenceId: string },
  ): Promise<{ readonly offer: RecruitmentOfferSummary }> {
    this.assertTrustedScope('erp:integration:esign:apply');
    return this.run(async () => this.idempotency.execute(
      'recruitment.offer.record_signed', key, { id, expectedVersion, ...input },
      async (session) => {
        const current = await this.requireOffer(id, session);
        const offer = recordRecruitmentOfferSigned(current, {
          tenantId: this.context.getTenantRequired().tenantId, expectedVersion,
          ...input, esignEvidenceVerified: true,
        }, new Date());
        await this.offers.replace(offer, expectedVersion, session);
        await this.outbox.append(buildRecruitmentOfferEvent(offer, 'signed'), session);
        return { offer: offerSummary(offer) };
      },
    ));
  }

  async get(id: string): Promise<RecruitmentOfferSummary> {
    const offer = await this.requireOffer(id);
    const position = await this.requirePosition(offer.positionId);
    const actor = this.context.getActorRequired();
    if (
      !actor.scopes.includes('erp:recruitment:offer:read_all') &&
      !actor.departmentIds.includes(position.departmentId)
    ) throw new ForbiddenException({
      code: 'RECRUITMENT_OFFER_READ_DENIED', message: '无权读取该 Offer',
    });
    return offerSummary(offer);
  }

  private async linkApproval(
    id: string,
    expectedVersion: number,
    key: string,
    approvalInstanceId: string,
  ): Promise<{ readonly offer: RecruitmentOfferSummary }> {
    return this.idempotency.execute(
      'recruitment.offer.submit', key, { id, expectedVersion, approvalInstanceId },
      async (session) => {
        const current = await this.requireOffer(id, session);
        const offer = submitRecruitmentOffer(current, {
          tenantId: this.context.getTenantRequired().tenantId, expectedVersion,
          actorId: this.context.getActorRequired().actorId, approvalInstanceId,
        }, new Date());
        const application = await this.requireApplication(current.applicationId, session);
        const transition = this.transitionApplication(
          application, 'offer_approval', current.completedInterviewId,
          this.context.getActorRequired().actorId,
        );
        await this.offers.replace(offer, expectedVersion, session);
        await this.persistApplicationTransition(application, transition, session);
        await this.outbox.append(buildRecruitmentOfferEvent(offer, 'submitted'), session);
        return { offer: offerSummary(offer) };
      },
    );
  }

  private async applyApproval(
    id: string,
    expectedVersion: number,
    key: string,
    approvalInstanceId: string,
    outcome: 'approved' | 'rejected',
  ): Promise<{ readonly offer: RecruitmentOfferSummary }> {
    return this.idempotency.execute(
      'recruitment.offer.sync_approval', key,
      { id, expectedVersion, approvalInstanceId, outcome }, async (session) => {
        const current = await this.requireOffer(id, session);
        const offer = applyRecruitmentOfferApprovalOutcome(current, {
          tenantId: this.context.getTenantRequired().tenantId, expectedVersion,
          approvalInstanceId, outcome, approvalVerified: true,
        }, new Date());
        await this.offers.replace(offer, expectedVersion, session);
        if (outcome === 'rejected') {
          const application = await this.requireApplication(current.applicationId, session);
          const transition = this.transitionApplication(
            application, 'rejected', approvalInstanceId,
            this.context.getActorRequired().actorId, 'offer_approval_rejected',
          );
          await this.persistApplicationTransition(application, transition, session);
        }
        await this.outbox.append(buildRecruitmentOfferEvent(offer, outcome), session);
        return { offer: offerSummary(offer) };
      },
    );
  }

  private transitionApplication(
    application: CandidateApplication,
    targetStage:
      | 'offer_approval'
      | 'offer_sent'
      | 'offer_accepted'
      | 'rejected'
      | 'withdrawn',
    evidenceId: string,
    actorId: string,
    reasonCode?: string,
  ) {
    return transitionCandidateApplication(application, {
      tenantId: this.context.getTenantRequired().tenantId,
      expectedVersion: application.version, actorId, targetStage, evidenceId,
      ...(reasonCode === undefined ? {} : { reasonCode }),
    }, new Date());
  }

  private async persistApplicationTransition(
    previous: CandidateApplication,
    transition: ReturnType<typeof transitionCandidateApplication>,
    session: ClientSession,
  ): Promise<void> {
    await this.applications.replace(transition.application, previous.version, session);
    await this.stages.append(transition.event, session);
    await this.outbox.append(buildCandidateApplicationStageEvent(transition.event), session);
  }

  private async requireApplication(
    id: string,
    session?: ClientSession,
  ): Promise<CandidateApplication> {
    const application = await this.applications.findById(id, session);
    if (application === null) throw new NotFoundException({
      code: 'RECRUITMENT_APPLICATION_NOT_FOUND', message: '候选申请不存在',
    });
    return application;
  }

  private async requireOffer(id: string, session?: ClientSession): Promise<RecruitmentOffer> {
    const offer = await this.offers.findById(id, session);
    if (offer === null) throw new NotFoundException({
      code: 'RECRUITMENT_OFFER_NOT_FOUND', message: 'Offer 不存在',
    });
    return offer;
  }

  private async requirePosition(id: string, session?: ClientSession) {
    const position = await this.positions.findById(id, session);
    if (position === null) throw new Error('RECRUITMENT_POSITION_REFERENCE_INVALID');
    return position;
  }

  private assertDepartmentWrite(departmentId: string): void {
    const actor = this.context.getActorRequired();
    if (
      !actor.scopes.includes('erp:recruitment:offer:write_all') &&
      !actor.departmentIds.includes(departmentId)
    ) throw new ForbiddenException({
      code: 'RECRUITMENT_OFFER_WRITE_DENIED', message: '无权修改该部门 Offer',
    });
  }

  private assertTrustedScope(scope: string): void {
    if (!this.context.getActorRequired().scopes.includes(scope)) throw new ForbiddenException({
      code: 'RECRUITMENT_OFFER_TRUSTED_WORKFLOW_REQUIRED', message: '必须由受信任工作流执行',
    });
  }

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof RecruitmentWriteConflictError) throw new ConflictException({
        code: 'RECRUITMENT_VERSION_CONFLICT', message: error.message,
      });
      if (error instanceof RecruitmentDomainError) {
        if (error.code.includes('TENANT') || error.code.includes('DENIED')) {
          throw new ForbiddenException({ code: error.code, message: error.message });
        }
        if (
          error.code.includes('VERSION') || error.code.includes('EVIDENCE') ||
          error.code.includes('TRANSITION') || error.code.includes('EXPIRED')
        ) throw new ConflictException({ code: error.code, message: error.message });
        throw new BadRequestException({ code: error.code, message: error.message });
      }
      if (isDuplicateKeyError(error)) throw new ConflictException({
        code: 'RECRUITMENT_OFFER_ALREADY_EXISTS', message: '该申请已存在 Offer',
      });
      throw error;
    }
  }
}

function deriveKey(root: string, stage: string): string {
  const digest = createHash('sha256').update(JSON.stringify([root, stage]), 'utf8').digest('base64url');
  return `recruitment:${digest}`;
}

function offerSummary(offer: RecruitmentOffer): RecruitmentOfferSummary {
  return Object.freeze({
    id: offer.id, applicationId: offer.applicationId, positionId: offer.positionId,
    completedInterviewId: offer.completedInterviewId, status: offer.status,
    expiresAt: offer.expiresAt, approvalInstanceId: offer.approvalInstanceId,
    sendRequestId: offer.sendRequestId, sentEvidenceId: offer.sentEvidenceId,
    acceptanceEvidenceId: offer.acceptanceEvidenceId, esignFlowId: offer.esignFlowId,
    signedEvidenceId: offer.signedEvidenceId, version: offer.version,
  });
}

function requiredDate(value: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new RecruitmentDomainError(
    'RECRUITMENT_INVALID_DATE', '时间格式无效',
  );
  return date;
}

function versionConflict(): RecruitmentDomainError {
  return new RecruitmentDomainError('RECRUITMENT_VERSION_CONFLICT', '候选申请版本冲突');
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11_000;
}
