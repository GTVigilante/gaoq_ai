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
import { AccessProfileRepository } from '../../identity/access-profile.repository.js';
import {
  applyRecruitmentOfferApprovalOutcome,
  buildCandidateApplicationStageEvent,
  buildRecruitmentOfferEvent,
  buildRecruitmentOfferMigratedEvent,
  buildCandidateApplicationMigratedEvent,
  createRecruitmentOfferEvidence,
  createRecruitmentOffer,
  recordRecruitmentOfferDecision,
  recordRecruitmentOfferSent,
  recordRecruitmentOfferSigned,
  restoreCandidateApplicationOfferStagesFromMigration,
  restoreRecruitmentOfferEvidenceFromMigration,
  restoreRecruitmentOfferFromMigration,
  requestRecruitmentOfferSend,
  submitRecruitmentOffer,
  transitionCandidateApplication,
  RecruitmentDomainError,
  type CandidateApplication,
  type RecruitmentOffer,
  type RecruitmentOfferTerms,
  type CandidateApplicationOfferMigrationAction,
  type RecruitmentOfferEvidence,
  type RecruitmentOfferStatus,
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
  readonly approvalHistoryId: string | null;
  readonly sendRequestId: string | null;
  readonly sentEvidenceId: string | null;
  readonly acceptanceEvidenceId: string | null;
  readonly esignFlowId: string | null;
  readonly signedEvidenceId: string | null;
  readonly version: number;
}

export interface ImportRecruitmentOfferFromMigrationInput {
  readonly targetId: string | null;
  readonly applicationId: string;
  readonly completedInterviewId: string;
  readonly createdByEmployeeId: string;
  readonly terms: RecruitmentOfferTerms;
  readonly expiresAt: string;
  readonly retentionExpiresAt: string;
  readonly status: RecruitmentOfferStatus;
  readonly approvalReferenceType: 'approval_instance' | 'legacy_history' | null;
  readonly approvalReferenceId: string | null;
  readonly sendRequested: boolean;
  readonly sentProof: { readonly proofHash: string; readonly occurredAt: string } | null;
  readonly decisionProof: {
    readonly decision: 'accepted' | 'declined';
    readonly proofHash: string;
    readonly occurredAt: string;
  } | null;
  readonly signedProof: { readonly proofHash: string; readonly occurredAt: string } | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly applicationBaselineVersion: number;
  readonly applicationBaselineUpdatedAt: string;
  readonly applicationActions: readonly Omit<
    CandidateApplicationOfferMigrationAction,
    'evidenceId'
  >[];
  readonly expectedApplicationStage: CandidateApplication['stage'];
  readonly expectedApplicationVersion: number;
  readonly applicationEndedAt: string | null;
  readonly applicationUpdatedAt: string;
  readonly migrationEvidenceRef: string;
  readonly evidenceChecksum: string;
}

/** Offer 应用服务；REST、Worker 与 MCP 复用同一门禁，L4 条款不进入响应或事件。 */
@Injectable()
export class RecruitmentOfferService {
  constructor(
    private readonly idempotency: IdempotencyService,
    private readonly context: TenantContextService,
    private readonly approvals: ApprovalApplicationService,
    private readonly profiles: AccessProfileRepository,
    private readonly applications: CandidateApplicationRepository,
    private readonly stages: CandidateApplicationStageRepository,
    private readonly positions: RecruitmentPositionRepository,
    private readonly interviews: RecruitmentInterviewRepository,
    private readonly offers: RecruitmentOfferRepository,
    private readonly evidence: RecruitmentOfferEvidenceRepository,
    private readonly outbox: RecruitmentOutboxWriter,
  ) {}

  /** 数据迁移专用：L4 条款和外部事实只进入加密仓储与摘要证据账本。 */
  async importOfferFromMigration(
    key: string,
    input: ImportRecruitmentOfferFromMigrationInput,
  ): Promise<{ readonly offer: RecruitmentOfferSummary }> {
    this.assertMigrationWriter();
    assertOfferMigrationEvidence(input.migrationEvidenceRef, input.evidenceChecksum);
    this.assertMigrationApplicationControl(input);
    return this.run(async () => this.idempotency.execute(
      'recruitment.offer.import_from_migration', key, input, async (session) => {
        const tenantId = this.context.getTenantRequired().tenantId;
        const [application, interview] = await Promise.all([
          this.requireApplication(input.applicationId, session),
          this.interviews.findById(input.completedInterviewId, session),
        ]);
        if (interview === null || interview.applicationId !== application.id ||
          interview.status !== 'completed') throw new BadRequestException({
          code: 'RECRUITMENT_MIGRATION_OFFER_INTERVIEW_INVALID',
          message: 'Offer 迁移必须引用该申请已完成的面试',
        });
        const position = await this.positions.findById(application.positionId, session);
        if (position === null) throw new BadRequestException({
          code: 'RECRUITMENT_MIGRATION_OFFER_POSITION_INVALID',
          message: 'Offer 迁移申请引用的职位不存在',
        });
        const createdByActorId = await this.profiles.findActorIdByEmployee(
          tenantId, input.createdByEmployeeId, session,
        );
        if (createdByActorId === null) throw new BadRequestException({
          code: 'RECRUITMENT_MIGRATION_OFFER_CREATOR_INVALID',
          message: 'Offer 创建员工缺少 ERP 身份映射',
        });
        const approval = await this.verifyMigrationApproval(input, session);
        const migrationActorId = this.context.getActorRequired().actorId;
        const existing = input.targetId === null
          ? null
          : await this.offers.findById(input.targetId, session);
        const offerId = input.targetId ?? createEventId(new Date(input.createdAt));
        const sendRequestId = input.sendRequested
          ? existing?.sendRequestId ?? createEventId(new Date(input.createdAt))
          : null;
        const existingEvidence = input.targetId === null
          ? []
          : await this.evidence.findByOffer(offerId, session);
        const evidenceByKind = new Map(existingEvidence.map((item) => [item.kind, item] as const));
        const migratedEvidence = this.restoreMigrationOfferEvidence(
          input, offerId, application.candidateId, migrationActorId, sendRequestId, evidenceByKind,
        );
        const sentEvidence = migratedEvidence.find((item) => item.kind === 'sent') ?? null;
        const decisionEvidence = migratedEvidence.find((item) =>
          item.kind === 'accepted' || item.kind === 'declined') ?? null;
        const signedEvidence = migratedEvidence.find((item) => item.kind === 'signed') ?? null;
        const offer = restoreRecruitmentOfferFromMigration({
          id: offerId, tenantId, applicationId: application.id,
          candidateId: application.candidateId, positionId: application.positionId,
          completedInterviewId: interview.id, terms: input.terms,
          expiresAt: input.expiresAt, retentionExpiresAt: input.retentionExpiresAt,
          status: input.status,
          approvalInstanceId: approval.type === 'approval_instance' ? approval.id : null,
          approvalHistoryId: approval.type === 'legacy_history' ? approval.id : null,
          sendRequestId,
          sentEvidenceId: sentEvidence?.id ?? null,
          acceptanceEvidenceId: decisionEvidence?.id ?? null,
          esignFlowId: signedEvidence?.esignFlowId ?? null,
          signedEvidenceId: signedEvidence?.id ?? null,
          version: input.version, createdBy: createdByActorId,
          createdAt: input.createdAt, updatedAt: input.updatedAt,
        }, new Date());
        const baseline = migrationApplicationBaseline(application, input);
        const migratedApplication = restoreCandidateApplicationOfferStagesFromMigration(
          baseline,
          {
            actorId: migrationActorId,
            actions: input.applicationActions.map((action) => ({
              ...action,
              evidenceId: offerApplicationEvidenceId(
                action.targetStage, offer, decisionEvidence,
              ),
            })),
            expectedStage: input.expectedApplicationStage,
            expectedVersion: input.expectedApplicationVersion,
            endedAt: input.applicationEndedAt,
            updatedAt: input.applicationUpdatedAt,
          },
          new Date(),
        );
        if (existing !== null) {
          const migrationEvidence = await this.offers.findMigrationEvidenceById(offerId, session);
          if (migrationEvidence === null || !sameMigratedOffer(existing, offer) ||
            !sameOfferEvidence(existingEvidence, migratedEvidence) ||
            !sameMigratedApplication(application, migratedApplication) ||
            migrationEvidence.migrationEvidenceRef !== input.migrationEvidenceRef ||
            migrationEvidence.migrationEvidenceChecksum !== input.evidenceChecksum) {
            throw new ConflictException({
              code: 'RECRUITMENT_MIGRATION_OFFER_IMMUTABLE',
              message: '既有 Offer、申请、外部证据或 WORM 档案不一致，禁止覆盖',
            });
          }
          return { offer: offerSummary(existing) };
        }
        if (application.version !== input.applicationBaselineVersion ||
          application.stage !== 'interview' ||
          application.updatedAt !== input.applicationBaselineUpdatedAt) {
          throw new ConflictException({
          code: 'RECRUITMENT_MIGRATION_OFFER_APPLICATION_BASELINE_CONFLICT',
          message: '申请已偏离声明的面试基线',
        });
        }
        await this.offers.insertMigrated(
          offer, input.migrationEvidenceRef, input.evidenceChecksum, session,
        );
        for (const item of migratedEvidence) await this.evidence.append(item, session);
        await this.applications.replace(
          migratedApplication, input.applicationBaselineVersion, session,
        );
        await this.outbox.append(buildRecruitmentOfferMigratedEvent(offer), session);
        await this.outbox.append(
          buildCandidateApplicationMigratedEvent(migratedApplication), session,
        );
        return { offer: offerSummary(offer) };
      },
    ));
  }

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
        if (current.version !== expectedVersion) throw versionConflict();
        return { offer: offerSummary(current) };
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
        if (current.version !== expectedVersion) throw versionConflict();
        return { offer: offerSummary(current) };
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

  private async verifyMigrationApproval(
    input: ImportRecruitmentOfferFromMigrationInput,
    session: ClientSession,
  ): Promise<
    | { readonly type: 'approval_instance'; readonly id: string }
    | { readonly type: 'legacy_history'; readonly id: string }
    | { readonly type: null; readonly id: null }
  > {
    if (input.status === 'draft') {
      if (input.approvalReferenceType === null && input.approvalReferenceId === null) {
        return { type: null, id: null };
      }
      throw invalidOfferMigrationApproval();
    }
    const expectedType = input.status === 'pending_approval'
      ? 'approval_instance' as const
      : 'legacy_history' as const;
    if (input.approvalReferenceType !== expectedType || input.approvalReferenceId === null) {
      throw invalidOfferMigrationApproval();
    }
    const reference = await this.approvals.verifyRecruitmentMigrationReference(
      expectedType, input.approvalReferenceId, session,
    );
    const expectedOutcome = input.status === 'pending_approval'
      ? 'running'
      : input.status === 'rejected'
        ? 'rejected'
        : 'approved';
    if (reference.templateCode !== OFFER_APPROVAL_TEMPLATE_CODE ||
      reference.outcome !== expectedOutcome || reference.id !== input.approvalReferenceId) {
      throw invalidOfferMigrationApproval();
    }
    return { type: expectedType, id: reference.id };
  }

  private restoreMigrationOfferEvidence(
    input: ImportRecruitmentOfferFromMigrationInput,
    offerId: string,
    candidateId: string,
    actorId: string,
    sendRequestId: string | null,
    existing: ReadonlyMap<RecruitmentOfferEvidence['kind'], RecruitmentOfferEvidence>,
  ): readonly RecruitmentOfferEvidence[] {
    const values: RecruitmentOfferEvidence[] = [];
    const append = (
      kind: RecruitmentOfferEvidence['kind'],
      proof: { readonly proofHash: string; readonly occurredAt: string },
      extra: {
        readonly subjectCandidateId: string | null;
        readonly sendRequestId: string | null;
        readonly esignFlowId: string | null;
      },
    ): void => {
      if (Date.parse(proof.occurredAt) > Date.parse(input.updatedAt)) {
        throw new RecruitmentDomainError(
          'RECRUITMENT_MIGRATION_OFFER_EVIDENCE_TIME_INVALID',
          'Offer 外部事实时间不能晚于最终更新时间',
        );
      }
      values.push(restoreRecruitmentOfferEvidenceFromMigration({
        id: existing.get(kind)?.id ?? createEventId(new Date(proof.occurredAt)),
        tenantId: this.context.getTenantRequired().tenantId,
        offerId, kind, actorId,
        subjectCandidateId: extra.subjectCandidateId,
        sendRequestId: extra.sendRequestId,
        esignFlowId: extra.esignFlowId,
        proofHash: proof.proofHash,
        occurredAt: proof.occurredAt,
        migrationEvidenceRef: input.migrationEvidenceRef,
        evidenceChecksum: input.evidenceChecksum,
      }));
    };
    if (input.sentProof !== null) append('sent', input.sentProof, {
      subjectCandidateId: null, sendRequestId, esignFlowId: null,
    });
    if (input.decisionProof !== null) append(input.decisionProof.decision, input.decisionProof, {
      subjectCandidateId: candidateId, sendRequestId: null, esignFlowId: null,
    });
    if (input.signedProof !== null) append('signed', input.signedProof, {
      subjectCandidateId: null,
      sendRequestId: null,
      esignFlowId: existing.get('signed')?.esignFlowId ??
        createEventId(new Date(input.signedProof.occurredAt)),
    });
    return Object.freeze(values);
  }

  private assertMigrationApplicationControl(
    input: ImportRecruitmentOfferFromMigrationInput,
  ): void {
    const expectedStage = expectedApplicationStageForMigratedOffer(input);
    const expectedDecision = ['accepted', 'signed'].includes(input.status)
      ? 'accepted'
      : input.status === 'declined'
        ? 'declined'
        : null;
    const expectedActions = expectedApplicationActionsForMigratedOffer(input);
    const actualActions = input.applicationActions.map((action) => ({
      targetStage: action.targetStage, reasonCode: action.reasonCode,
    }));
    if (input.expectedApplicationStage !== expectedStage ||
      (input.decisionProof?.decision ?? null) !== expectedDecision ||
      JSON.stringify(actualActions) !== JSON.stringify(expectedActions)) {
      throw new BadRequestException({
        code: 'RECRUITMENT_MIGRATION_OFFER_APPLICATION_CONTROL_INVALID',
        message: 'Offer 状态、候选人决定与申请最终阶段不一致',
      });
    }
    const createdAt = Date.parse(input.createdAt);
    const updatedAt = Date.parse(input.updatedAt);
    const sentAt = input.sentProof === null ? null : Date.parse(input.sentProof.occurredAt);
    const decisionAt = input.decisionProof === null
      ? null
      : Date.parse(input.decisionProof.occurredAt);
    const signedAt = input.signedProof === null ? null : Date.parse(input.signedProof.occurredAt);
    const firstActionAt = input.applicationActions.at(0)?.occurredAt;
    const offerSentActionAt = input.applicationActions.find(
      (action) => action.targetStage === 'offer_sent',
    )?.occurredAt;
    const decisionActionAt = input.applicationActions.find(
      (action) => action.targetStage === 'offer_accepted' || action.targetStage === 'withdrawn',
    )?.occurredAt;
    if ((firstActionAt !== undefined && Date.parse(firstActionAt) < createdAt) ||
      (sentAt !== null && (sentAt < createdAt || sentAt > updatedAt)) ||
      (decisionAt !== null && (sentAt === null || decisionAt < sentAt || decisionAt > updatedAt)) ||
      (signedAt !== null &&
        (decisionAt === null || signedAt < decisionAt || signedAt > updatedAt)) ||
      (sentAt !== null &&
        (offerSentActionAt === undefined || Date.parse(offerSentActionAt) < sentAt)) ||
      (decisionAt !== null &&
        (decisionActionAt === undefined || Date.parse(decisionActionAt) < decisionAt))) {
      throw new BadRequestException({
        code: 'RECRUITMENT_MIGRATION_OFFER_TIMELINE_CONTROL_INVALID',
        message: 'Offer、外部证据与申请动作时间线不一致',
      });
    }
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

  private assertMigrationWriter(): void {
    const actor = this.context.getActorRequired();
    if (!['service', 'system_job'].includes(actor.actorType) ||
      !actor.scopes.includes('erp:migration:execute') ||
      !actor.scopes.includes('erp:recruitment:migration:write')) {
      throw new ForbiddenException({
        code: 'RECRUITMENT_MIGRATION_WRITER_DENIED',
        message: 'Offer 迁移必须由受信任服务身份执行',
      });
    }
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
    approvalHistoryId: offer.approvalHistoryId,
    sendRequestId: offer.sendRequestId, sentEvidenceId: offer.sentEvidenceId,
    acceptanceEvidenceId: offer.acceptanceEvidenceId, esignFlowId: offer.esignFlowId,
    signedEvidenceId: offer.signedEvidenceId, version: offer.version,
  });
}

function migrationApplicationBaseline(
  application: CandidateApplication,
  input: ImportRecruitmentOfferFromMigrationInput,
): CandidateApplication {
  return Object.freeze({
    ...application,
    stage: 'interview' as const,
    completedInterviewId: null,
    offerId: null,
    acceptanceEvidenceId: null,
    onboardingInstanceId: null,
    employmentId: null,
    version: input.applicationBaselineVersion,
    endedAt: null,
    updatedAt: input.applicationBaselineUpdatedAt,
  });
}

function offerApplicationEvidenceId(
  stage: CandidateApplicationOfferMigrationAction['targetStage'],
  offer: RecruitmentOffer,
  decision: RecruitmentOfferEvidence | null,
): string {
  if (stage === 'offer_approval') return offer.completedInterviewId;
  if (stage === 'offer_sent') return offer.id;
  if (stage === 'offer_accepted' || stage === 'withdrawn') {
    if (decision === null) throw new RecruitmentDomainError(
      'RECRUITMENT_MIGRATION_OFFER_DECISION_EVIDENCE_INVALID',
      '申请阶段缺少候选人决定证据',
    );
    return decision.id;
  }
  if (offer.approvalHistoryId === null) throw invalidOfferMigrationApproval();
  return offer.approvalHistoryId;
}

function sameMigratedOffer(left: RecruitmentOffer, right: RecruitmentOffer): boolean {
  return left.id === right.id && left.tenantId === right.tenantId &&
    left.applicationId === right.applicationId && left.candidateId === right.candidateId &&
    left.positionId === right.positionId &&
    left.completedInterviewId === right.completedInterviewId &&
    JSON.stringify(left.terms) === JSON.stringify(right.terms) &&
    left.expiresAt === right.expiresAt &&
    left.retentionExpiresAt === right.retentionExpiresAt && left.status === right.status &&
    left.approvalInstanceId === right.approvalInstanceId &&
    left.approvalHistoryId === right.approvalHistoryId &&
    left.sendRequestId === right.sendRequestId && left.sentEvidenceId === right.sentEvidenceId &&
    left.acceptanceEvidenceId === right.acceptanceEvidenceId &&
    left.esignFlowId === right.esignFlowId && left.signedEvidenceId === right.signedEvidenceId &&
    left.version === right.version && left.createdBy === right.createdBy &&
    left.createdAt === right.createdAt && left.updatedAt === right.updatedAt;
}

function sameOfferEvidence(
  left: readonly RecruitmentOfferEvidence[],
  right: readonly RecruitmentOfferEvidence[],
): boolean {
  const candidates = new Map(right.map((item) => [item.kind, item] as const));
  return left.length === right.length && left.every((item) => {
    const candidate = candidates.get(item.kind);
    return candidate !== undefined && JSON.stringify(item) === JSON.stringify(candidate);
  });
}

function sameMigratedApplication(
  left: CandidateApplication,
  right: CandidateApplication,
): boolean {
  return left.id === right.id && left.tenantId === right.tenantId &&
    left.candidateId === right.candidateId && left.positionId === right.positionId &&
    left.consentEvidenceId === right.consentEvidenceId &&
    left.sourceChannel === right.sourceChannel && left.stage === right.stage &&
    left.completedInterviewId === right.completedInterviewId && left.offerId === right.offerId &&
    left.acceptanceEvidenceId === right.acceptanceEvidenceId &&
    left.onboardingInstanceId === right.onboardingInstanceId &&
    left.employmentId === right.employmentId && left.version === right.version &&
    left.appliedAt === right.appliedAt && left.endedAt === right.endedAt &&
    left.updatedAt === right.updatedAt;
}

function assertOfferMigrationEvidence(reference: string, checksum: string): void {
  if (!MIGRATION_EVIDENCE_REF_PATTERN.test(reference) || !HASH_PATTERN.test(checksum)) {
    throw new BadRequestException({
      code: 'RECRUITMENT_MIGRATION_OFFER_EVIDENCE_INVALID',
      message: 'Offer 迁移必须精确引用迁移账本 WORM 证据与校验和',
    });
  }
}

function invalidOfferMigrationApproval(): BadRequestException {
  return new BadRequestException({
    code: 'RECRUITMENT_MIGRATION_OFFER_APPROVAL_INVALID',
    message: 'Offer 状态、审批模板、结果或迁移引用不一致',
  });
}

function expectedApplicationStageForMigratedOffer(
  input: ImportRecruitmentOfferFromMigrationInput,
): CandidateApplication['stage'] {
  switch (input.status) {
    case 'draft': return 'interview';
    case 'pending_approval':
    case 'approved':
    case 'sending': return 'offer_approval';
    case 'rejected': return 'rejected';
    case 'sent': return 'offer_sent';
    case 'accepted':
    case 'signed': return 'offer_accepted';
    case 'declined': return 'withdrawn';
    case 'expired':
    case 'cancelled': return input.sentProof === null ? 'offer_approval' : 'offer_sent';
  }
}

function expectedApplicationActionsForMigratedOffer(
  input: ImportRecruitmentOfferFromMigrationInput,
): readonly {
  readonly targetStage: CandidateApplicationOfferMigrationAction['targetStage'];
  readonly reasonCode: string | null;
}[] {
  const stage = expectedApplicationStageForMigratedOffer(input);
  if (stage === 'interview') return Object.freeze([]);
  const actions: {
    targetStage: CandidateApplicationOfferMigrationAction['targetStage'];
    reasonCode: string | null;
  }[] = [{ targetStage: 'offer_approval', reasonCode: null }];
  if (stage === 'rejected') {
    actions.push({ targetStage: 'rejected', reasonCode: 'offer_approval_rejected' });
  } else if (stage === 'offer_sent' || stage === 'offer_accepted' || stage === 'withdrawn') {
    actions.push({ targetStage: 'offer_sent', reasonCode: null });
    if (stage === 'offer_accepted') {
      actions.push({ targetStage: 'offer_accepted', reasonCode: null });
    } else if (stage === 'withdrawn') {
      actions.push({ targetStage: 'withdrawn', reasonCode: 'offer_declined' });
    }
  }
  return Object.freeze(actions);
}

function requiredDate(value: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== value) {
    throw new RecruitmentDomainError(
      'RECRUITMENT_INVALID_DATE',
      '时间必须为规范毫秒级 UTC ISO',
    );
  }
  return date;
}

function versionConflict(): RecruitmentDomainError {
  return new RecruitmentDomainError('RECRUITMENT_VERSION_CONFLICT', '候选申请版本冲突');
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11_000;
}

const HASH_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MIGRATION_EVIDENCE_REF_PATTERN =
  /^erp:\/\/data-migrations\/runs\/[0-7][0-9A-HJKMNP-TV-Z]{25}\/attachments\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
