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
import { AccessProfileRepository } from '../../identity/access-profile.repository.js';
import {
  addApprovalSigner,
  archiveApprovalInstance,
  buildApprovalActionEvent,
  buildApprovalDelegationEvent,
  buildApprovalLegacyHistoryMigratedEvent,
  buildApprovalInstanceCreatedEvent,
  buildApprovalInstanceUpdatedEvent,
  buildApprovalInstanceMigratedEvent,
  buildApprovalTemplateEvent,
  buildApprovalTemplateMigratedEvent,
  createApprovalInstanceDraft,
  createApprovalInstanceDraftFromMigration,
  createApprovalLegacyHistory,
  createApprovalDelegation,
  createApprovalTemplateDraft,
  createNextApprovalTemplateRevision,
  decideApprovalInstance,
  publishApprovalTemplate,
  restoreApprovalTemplateFromMigration,
  retireApprovalTemplate,
  revokeApprovalDelegation,
  submitApprovalInstance,
  transferApprovalTask,
  updateApprovalInstanceDraft,
  updateApprovalTemplateDraft,
  withdrawApprovalInstance,
  currentApprovalNode,
  ApprovalDomainError,
  type ApprovalFormData,
  type ApprovalFormValue,
  type ApprovalInstance,
  type ApprovalLegacyHistory,
  type ApprovalDelegation,
  type ApprovalTemplate,
  type ApprovalTemplateDefinition,
  type ApprovalFormField,
} from '../domain/index.js';
import {
  ApprovalActionRepository,
  type ApprovalActionProjection,
  ApprovalDelegationRepository,
  ApprovalInstanceRepository,
  ApprovalLegacyHistoryRepository,
  ApprovalTemplateRepository,
  ApprovalWriteConflictError,
} from '../persistence/approval.repositories.js';
import { ApprovalOutboxWriter } from '../persistence/approval-outbox.writer.js';
import { ApprovalActorResolverService } from './approval-actor-resolver.service.js';
import { ApprovalNotificationWriter } from '../notification/approval-notification.writer.js';

const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const HASH_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MIGRATION_EVIDENCE_REF_PATTERN =
  /^erp:\/\/data-migrations\/runs\/[0-7][0-9A-HJKMNP-TV-Z]{25}\/attachments\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface ApprovalTemplateSummary extends Record<string, unknown> {
  readonly id: string;
  readonly code: string;
  readonly revision: number;
  readonly status: ApprovalTemplate['status'];
  readonly riskLevel: 'R1' | 'R2';
  readonly definitionHash: string;
  readonly version: number;
}

export interface ApprovalPublishedTemplateFormView {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly revision: number;
  readonly riskLevel: 'R1' | 'R2';
  readonly definitionHash: string;
  readonly fields: readonly ApprovalFormField[];
  readonly version: number;
}

export interface ApprovalDelegationView {
  readonly id: string;
  readonly principalApproverId: string;
  readonly delegateId: string;
  readonly validFrom: string;
  readonly validUntil: string;
  readonly status: 'active' | 'revoked';
  readonly version: number;
}

export interface ApprovalInstanceSummary extends Record<string, unknown> {
  readonly id: string;
  readonly status: ApprovalInstance['status'];
  readonly templateCode: string;
  readonly templateRevision: number;
  readonly riskLevel: 'R1' | 'R2';
  readonly version: number;
  readonly submittedAt: string | null;
  readonly completedAt: string | null;
}

export type ApprovalReadableFormValue = ApprovalFormValue | { readonly redacted: true };

export interface ApprovalInstanceView {
  readonly id: string;
  readonly title: string;
  readonly initiatorId: string;
  readonly status: ApprovalInstance['status'];
  readonly templateCode: string;
  readonly templateRevision: number;
  readonly riskLevel: 'R1' | 'R2';
  readonly formData: Readonly<Record<string, ApprovalReadableFormValue>>;
  readonly currentNodeIndex: number | null;
  readonly version: number;
  readonly submittedAt: string | null;
  readonly completedAt: string | null;
}

export type ApprovalTimelineEntry = ApprovalActionProjection;

export interface AttendanceCorrectionDecision {
  readonly id: string;
  readonly completedAt: string;
  readonly sourceFactId: string;
  readonly employeeId: string;
  readonly businessDate: string;
  readonly replacementImpact: {
    readonly workedMinutes: number;
    readonly leaveMinutes: number;
    readonly overtimeMinutes: number;
    readonly absentMinutes: number;
  };
  readonly reasonCode: string;
  readonly formDataHash: string;
}

export interface AttendanceMonthReopenDecision {
  readonly id: string;
  readonly completedAt: string;
  readonly employeeId: string;
  readonly month: string;
  readonly previousSnapshotId: string;
  readonly formDataHash: string;
}

export interface PayrollPeriodApprovalDecision {
  readonly id: string;
  readonly outcome: 'approved' | 'rejected';
  readonly decidedBy: string;
  readonly completedAt: string;
  readonly periodId: string;
  readonly runId: string;
  readonly inputSnapshotHash: string;
  readonly resultHash: string;
  readonly formDataHash: string;
}

export interface PayrollAdjustmentApprovalDecision {
  readonly id: string;
  readonly outcome: 'approved' | 'rejected';
  readonly decidedBy: string;
  readonly completedAt: string;
  readonly adjustmentId: string;
  readonly adjustmentHash: string;
  readonly period: string;
  readonly adjustmentType: 'supplement' | 'reversal' | 'tax_only';
  readonly reasonCode: string;
  readonly formDataHash: string;
}

export interface OpApprovalSubmissionInput {
  readonly instanceId: string;
  readonly templateCode: string;
  readonly title: string;
  readonly formData: ApprovalFormData;
  readonly initiatorEmployeeId: string;
  readonly sourceDocumentType: string;
  readonly sourceDocumentId: string;
}

export interface ImportApprovalTemplateFromMigrationInput {
  readonly code: string;
  readonly name: string;
  readonly riskLevel: 'R1' | 'R2';
  readonly revision: number;
  readonly status: ApprovalTemplate['status'];
  readonly definition: ApprovalTemplateDefinition;
  readonly createdByEmployeeId: string;
  readonly updatedByEmployeeId: string;
  readonly approvedByEmployeeId: string | null;
  readonly publishedAt: string | null;
  readonly retiredAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ImportApprovalLegacyHistoryFromMigrationInput {
  readonly templateId: string;
  readonly templateCode: string;
  readonly templateRevision: number;
  readonly initiatorEmployeeId: string;
  readonly outcome: ApprovalLegacyHistory['outcome'];
  readonly completedAt: string;
  readonly archivedAt: string | null;
  readonly migrationEvidenceRef: string;
  readonly evidenceChecksum: string;
}

export type ImportApprovalActiveActionFromMigration =
  | {
      readonly type: 'submitted'; readonly actorEmployeeId: string; readonly occurredAt: string;
    }
  | {
      readonly type: 'decided'; readonly actorEmployeeId: string;
      readonly principalApproverEmployeeId: string; readonly outcome: 'approved' | 'rejected';
      readonly occurredAt: string;
    }
  | {
      readonly type: 'approver_transferred'; readonly actorEmployeeId: string;
      readonly fromApproverEmployeeId: string; readonly toApproverEmployeeId: string;
      readonly occurredAt: string;
    }
  | {
      readonly type: 'approver_added'; readonly actorEmployeeId: string;
      readonly approverEmployeeId: string; readonly occurredAt: string;
    };

export interface ImportApprovalActiveInstanceFromMigrationInput {
  readonly templateId: string;
  readonly templateCode: string;
  readonly templateRevision: number;
  readonly title: string;
  readonly initiatorEmployeeId: string;
  readonly formData: ApprovalFormData;
  readonly mappedFormReferenceFields: readonly {
    readonly fieldKey: string; readonly entityType: 'org.employee' | 'org.department';
  }[];
  readonly resolvedNodes: readonly {
    readonly nodeId: string; readonly actorEmployeeIds: readonly string[];
  }[];
  readonly actions: readonly ImportApprovalActiveActionFromMigration[];
  readonly expectedStatus: 'draft' | 'running';
  readonly expectedVersion: number;
  readonly expectedCurrentNodeId: string | null;
  readonly expectedPendingApproverEmployeeIds: readonly string[];
  readonly createdAt: string;
  readonly submittedAt: string | null;
  readonly updatedAt: string;
  readonly migrationEvidenceRef: string;
  readonly evidenceChecksum: string;
}

export interface ApprovalRecruitmentMigrationReference {
  readonly id: string;
  readonly type: 'approval_instance' | 'legacy_history';
  readonly templateCode: string;
  readonly outcome: 'running' | 'approved' | 'rejected' | 'withdrawn';
}

export interface ApprovalAttendanceCorrectionMigrationReference {
  readonly id: string;
  readonly completedAt: string;
  readonly evidenceChecksum: string;
}

export interface ApprovalAttendanceMonthReopenMigrationReference {
  readonly id: string;
  readonly completedAt: string;
  readonly evidenceChecksum: string;
}

export interface ApprovalPayrollMigrationReference {
  readonly id: string;
  readonly templateCode:
    | 'payroll_rule_pack' | 'payroll_compensation' | 'payroll_period_approval'
    | 'payroll_tax_filing_approval';
  readonly completedAt: string;
  readonly evidenceChecksum: string;
}

export interface ApprovalTreasuryMigrationReference {
  readonly id: string;
  readonly templateCode:
    | 'treasury_bank_account_attestation'
    | 'treasury_disbursement_export_approval';
  readonly completedAt: string;
  readonly evidenceChecksum: string;
}

export interface ApprovalTreasuryBankAccountDecision {
  readonly id: string;
  readonly completedAt: string;
  readonly approvedBy: string;
  readonly ownerType: 'organization' | 'employee';
  readonly ownerId: string;
  readonly accountName: string;
  readonly account: string;
  readonly clearingCode: string;
  readonly currency: 'CNY';
  readonly formDataHash: string;
}

/** 审批应用服务：唯一事务编排入口，REST、Worker 与 MCP 必须复用本服务。 */
@Injectable()
export class ApprovalApplicationService {
  constructor(
    private readonly idempotency: IdempotencyService,
    private readonly context: TenantContextService,
    private readonly profiles: AccessProfileRepository,
    private readonly templates: ApprovalTemplateRepository,
    private readonly legacyHistories: ApprovalLegacyHistoryRepository,
    private readonly instances: ApprovalInstanceRepository,
    private readonly actions: ApprovalActionRepository,
    private readonly delegations: ApprovalDelegationRepository,
    private readonly resolvers: ApprovalActorResolverService,
    private readonly outbox: ApprovalOutboxWriter,
    private readonly notifications: ApprovalNotificationWriter,
  ) {}

  async createTemplate(
    key: string,
    input: {
      readonly code: string;
      readonly name: string;
      readonly riskLevel: 'R1' | 'R2';
      readonly definition: ApprovalTemplateDefinition;
    },
  ): Promise<{ readonly template: ApprovalTemplateSummary }> {
    return this.run(async () => this.idempotency.execute(
      'approval.template.create', key, input, async (session) => {
        const trusted = this.context.getRequired();
        const now = new Date();
        const latest = await this.templates.findLatestByCode(input.code, session);
        const template = latest === null
          ? createApprovalTemplateDraft({
              ...input,
              id: createEventId(now),
              tenantId: trusted.tenant.tenantId,
              actorId: trusted.actor.actorId,
            }, now)
          : createNextApprovalTemplateRevision(latest, {
              ...input,
              id: createEventId(now),
              tenantId: trusted.tenant.tenantId,
              actorId: trusted.actor.actorId,
            }, now);
        await this.templates.insert(template, session);
        await this.outbox.append(buildApprovalTemplateEvent(template, 'draft_created'), session);
        return { template: templateSummary(template) };
      },
    ));
  }

  /** 数据迁移专用：登记已终结旧审批的最小索引，不恢复正文、不生成待办或通知。 */
  async importLegacyHistoryFromMigration(
    key: string,
    input: ImportApprovalLegacyHistoryFromMigrationInput,
  ): Promise<{ readonly history: ApprovalLegacyHistory }> {
    this.assertMigrationWriter();
    return this.run(async () => this.idempotency.execute(
      'approval.history.import_from_migration', key, input, async (session) => {
        const tenantId = this.context.getTenantRequired().tenantId;
        const [template] = await Promise.all([
          this.templates.findByCodeAndRevision(input.templateCode, input.templateRevision, session),
          this.requireMigrationActor(input.initiatorEmployeeId, session),
        ]);
        if (template === null || template.id !== input.templateId || template.status === 'draft') {
          throw new BadRequestException({
          code: 'APPROVAL_MIGRATION_HISTORY_TEMPLATE_MISSING',
          message: '旧审批历史必须精确引用已迁移的发布或退役模板版本',
          });
        }
        const candidate = createApprovalLegacyHistory({
          ...input,
          id: createEventId(),
          tenantId,
        }, new Date());
        const existing = await this.legacyHistories.findByEvidenceRef(
          input.migrationEvidenceRef,
          session,
        );
        if (existing !== null) {
          if (!sameMigratedLegacyHistory(existing, candidate)) throw new ConflictException({
            code: 'APPROVAL_MIGRATION_HISTORY_IMMUTABLE',
            message: '既有旧审批历史与迁移证据不一致，禁止覆盖',
          });
          return { history: existing };
        }
        await this.legacyHistories.insert(candidate, session);
        await this.outbox.append(buildApprovalLegacyHistoryMigratedEvent(candidate), session);
        return { history: candidate };
      },
    ));
  }

  /** 数据迁移专用：通过现有状态机重放无文件草稿或运行中审批，不产生正常通知。 */
  async importActiveInstanceFromMigration(
    key: string,
    input: ImportApprovalActiveInstanceFromMigrationInput,
  ): Promise<{ readonly instance: ApprovalInstanceSummary }> {
    this.assertMigrationWriter();
    return this.run(async () => this.idempotency.execute(
      'approval.instance.import_active_from_migration', key, input, async (session) => {
        const tenantId = this.context.getTenantRequired().tenantId;
        const template = await this.templates.findById(input.templateId, session);
        if (template === null || template.code !== input.templateCode ||
          template.revision !== input.templateRevision || template.status === 'draft') {
          throw new BadRequestException({
            code: 'APPROVAL_MIGRATION_ACTIVE_TEMPLATE_MISSING',
            message: '活动审批必须精确引用已迁移的发布或退役模板版本',
          });
        }
        assertActiveMigrationEvidence(input.migrationEvidenceRef, input.evidenceChecksum);
        assertActiveMigrationFormBoundary(
          template.definition,
          input.formData,
          input.mappedFormReferenceFields,
        );
        validateActiveMigrationTimeline(input, new Date());
        const employeeIds = activeMigrationEmployeeIds(input);
        if (employeeIds.length > 100) throw new ApprovalDomainError(
          'APPROVAL_MIGRATION_ACTIVE_ACTOR_LIMIT',
          '活动审批关联员工不能超过 100 人',
        );
        const actors = new Map<string, string>();
        await Promise.all(employeeIds.map(async (employeeId) => {
          actors.set(employeeId, await this.requireMigrationActor(employeeId, session));
        }));
        const actor = (employeeId: string): string => {
          const actorId = actors.get(employeeId);
          if (actorId === undefined) throw new Error('活动审批迁移身份映射丢失');
          return actorId;
        };
        const requiredActiveEmployeeIds = input.expectedStatus === 'draft'
          ? [input.initiatorEmployeeId]
          : input.expectedPendingApproverEmployeeIds;
        await Promise.all(requiredActiveEmployeeIds.map(async (employeeId) =>
          this.requireActiveMigrationEmployee(employeeId, actor(employeeId), session)));
        let instance = createApprovalInstanceDraftFromMigration({
          id: createEventId(),
          tenantId,
          title: input.title,
          initiatorId: actor(input.initiatorEmployeeId),
          template,
          formData: input.formData,
          createdAt: input.createdAt,
        });
        const transitions: Array<{
          readonly instance: ApprovalInstance;
          readonly action: Parameters<ApprovalActionRepository['append']>[1];
        }> = [];
        for (const migrationAction of input.actions) {
          const transition = replayActiveMigrationAction(
            instance,
            migrationAction,
            input.resolvedNodes,
            actor,
          );
          transitions.push(transition);
          instance = transition.instance;
        }
        assertActiveMigrationResult(instance, input, actor);
        await this.instances.insert(instance, session);
        for (const transition of transitions) {
          await this.actions.append(transition.instance, transition.action, session);
        }
        await this.outbox.append(buildApprovalInstanceMigratedEvent(
          instance,
          transitions.length,
          input.evidenceChecksum,
        ), session);
        return { instance: instanceSummary(instance) };
      },
    ));
  }

  /** 招聘迁移只读校验：返回不含表单、标题、人员与证据定位符的审批引用投影。 */
  async verifyRecruitmentMigrationReference(
    type: ApprovalRecruitmentMigrationReference['type'],
    id: string,
    session: ClientSession,
  ): Promise<ApprovalRecruitmentMigrationReference> {
    this.assertRecruitmentMigrationVerifier();
    if (type === 'approval_instance') {
      const instance = await this.instances.findById(id, session);
      if (instance === null || instance.status !== 'running') throw new BadRequestException({
        code: 'APPROVAL_MIGRATION_RECRUITMENT_REFERENCE_INVALID',
        message: '招聘迁移的活动审批引用不存在或不在运行状态',
      });
      return Object.freeze({
        id: instance.id,
        type,
        templateCode: instance.templateSnapshot.templateCode,
        outcome: 'running',
      });
    }
    const history = await this.legacyHistories.findById(id, session);
    if (history === null) throw new BadRequestException({
      code: 'APPROVAL_MIGRATION_RECRUITMENT_REFERENCE_INVALID',
      message: '招聘迁移的终结审批历史不存在',
    });
    return Object.freeze({
      id: history.id,
      type,
      templateCode: history.templateCode,
      outcome: history.outcome,
    });
  }

  /** 考勤迁移只读校验：只接受已通过的专用终结历史，不暴露审批正文或证据定位符。 */
  async verifyAttendanceCorrectionMigrationReference(
    id: string,
    session: ClientSession,
  ): Promise<ApprovalAttendanceCorrectionMigrationReference> {
    this.assertAttendanceMigrationVerifier();
    const history = await this.legacyHistories.findById(id, session);
    if (history === null || history.templateCode !== 'attendance_correction' ||
      history.outcome !== 'approved') {
      throw new BadRequestException({
        code: 'APPROVAL_MIGRATION_ATTENDANCE_CORRECTION_REFERENCE_INVALID',
        message: '考勤修订必须引用已迁移且已通过的专用审批历史',
      });
    }
    return Object.freeze({
      id: history.id,
      completedAt: history.completedAt,
      evidenceChecksum: history.evidenceChecksum,
    });
  }

  /** 月结迁移只读校验：只接受已通过的重开审批历史。 */
  async verifyAttendanceMonthReopenMigrationReference(
    id: string,
    session: ClientSession,
  ): Promise<ApprovalAttendanceMonthReopenMigrationReference> {
    this.assertAttendanceMigrationVerifier();
    const history = await this.legacyHistories.findById(id, session);
    if (history === null || history.templateCode !== 'attendance_month_reopen' ||
      history.outcome !== 'approved') {
      throw new BadRequestException({
        code: 'APPROVAL_MIGRATION_ATTENDANCE_REOPEN_REFERENCE_INVALID',
        message: '考勤月结重开必须引用已迁移且已通过的专用审批历史',
      });
    }
    return Object.freeze({
      id: history.id,
      completedAt: history.completedAt,
      evidenceChecksum: history.evidenceChecksum,
    });
  }

  /** 薪资主数据迁移只读校验：只接受已通过的专用审批历史。 */
  async verifyPayrollMigrationReference(
    id: string,
    templateCode: ApprovalPayrollMigrationReference['templateCode'],
    session: ClientSession,
  ): Promise<ApprovalPayrollMigrationReference> {
    this.assertPayrollMigrationVerifier();
    const history = await this.legacyHistories.findById(id, session);
    if (history === null || history.templateCode !== templateCode ||
      history.outcome !== 'approved') {
      throw new BadRequestException({
        code: 'APPROVAL_MIGRATION_PAYROLL_REFERENCE_INVALID',
        message: '薪资迁移必须引用已迁移且已通过的专用审批历史',
      });
    }
    return Object.freeze({
      id: history.id, templateCode, completedAt: history.completedAt,
      evidenceChecksum: history.evidenceChecksum,
    });
  }

  /** 资金迁移只读校验：只接受已通过的指定资金治理终结历史。 */
  async verifyTreasuryMigrationReference(
    id: string,
    templateCode: ApprovalTreasuryMigrationReference['templateCode'],
    session: ClientSession,
  ): Promise<ApprovalTreasuryMigrationReference> {
    this.assertTreasuryMigrationVerifier();
    const history = await this.legacyHistories.findById(id, session);
    if (history === null || history.templateCode !== templateCode ||
      history.outcome !== 'approved') {
      throw new BadRequestException({
        code: 'APPROVAL_MIGRATION_TREASURY_REFERENCE_INVALID',
        message: '资金迁移必须引用已迁移且已通过的专用审批历史',
      });
    }
    return Object.freeze({
      id: history.id, templateCode, completedAt: history.completedAt,
      evidenceChecksum: history.evidenceChecksum,
    });
  }

  /** 数据迁移专用：恢复模板版本，不重放发布、退役、通知或业务执行。 */
  async importTemplateFromMigration(
    key: string,
    input: ImportApprovalTemplateFromMigrationInput,
  ): Promise<{ readonly template: ApprovalTemplate }> {
    this.assertMigrationWriter();
    return this.run(async () => this.idempotency.execute(
      'approval.template.import_from_migration', key, input, async (session) => {
        const tenantId = this.context.getTenantRequired().tenantId;
        const [createdBy, updatedBy, approvedBy] = await Promise.all([
          this.requireMigrationActor(input.createdByEmployeeId, session),
          this.requireMigrationActor(input.updatedByEmployeeId, session),
          input.approvedByEmployeeId === null
            ? Promise.resolve(null)
            : this.requireMigrationActor(input.approvedByEmployeeId, session),
        ]);
        const candidate = restoreApprovalTemplateFromMigration({
          id: createEventId(), tenantId,
          code: input.code, name: input.name, riskLevel: input.riskLevel,
          revision: input.revision, status: input.status, definition: input.definition,
          createdBy, updatedBy, approvedBy,
          publishedAt: input.publishedAt, retiredAt: input.retiredAt,
          createdAt: input.createdAt, updatedAt: input.updatedAt,
        });
        const existing = await this.templates.findByCodeAndRevision(
          input.code,
          input.revision,
          session,
        );
        if (existing !== null) {
          if (!sameMigratedTemplate(existing, candidate)) throw new ConflictException({
            code: 'APPROVAL_MIGRATION_TEMPLATE_IMMUTABLE',
            message: '既有审批模板版本与迁移快照不一致，禁止覆盖',
          });
          return { template: existing };
        }
        const latest = await this.templates.findLatestByCode(input.code, session);
        const expectedRevision = latest === null ? 1 : latest.revision + 1;
        if (input.revision !== expectedRevision) throw new ConflictException({
          code: 'APPROVAL_MIGRATION_TEMPLATE_REVISION_GAP',
          message: '审批模板必须按修订号连续迁移',
        });
        await this.templates.insert(candidate, session);
        await this.outbox.append(buildApprovalTemplateMigratedEvent(candidate), session);
        return { template: candidate };
      },
    ));
  }

  async publishTemplate(
    id: string,
    expectedVersion: number,
    key: string,
  ): Promise<{ readonly template: ApprovalTemplateSummary }> {
    return this.run(async () => this.idempotency.execute(
      'approval.template.publish', key, { id, expectedVersion }, async (session) => {
        const current = await this.requireTemplate(id, session);
        const trusted = this.context.getRequired();
        const now = new Date();
        const published = publishApprovalTemplate(current, {
          tenantId: trusted.tenant.tenantId,
          expectedVersion,
          approverId: trusted.actor.actorId,
        }, now);
        const previous = await this.templates.findPublishedByCode(current.code, session);
        if (previous !== null && previous.id !== current.id) {
          const retired = retireApprovalTemplate(previous, {
            tenantId: trusted.tenant.tenantId,
            expectedVersion: previous.version,
            actorId: trusted.actor.actorId,
          }, now);
          await this.templates.replace(retired, previous.version, session);
          await this.outbox.append(buildApprovalTemplateEvent(retired, 'retired'), session);
        }
        await this.templates.replace(published, expectedVersion, session);
        await this.outbox.append(buildApprovalTemplateEvent(published, 'published'), session);
        return { template: templateSummary(published) };
      },
    ));
  }

  /** 修改当前模板草稿；编码和修订号不可变，发布或退役版本永久拒绝覆盖。 */
  async updateTemplate(
    id: string,
    expectedVersion: number,
    key: string,
    input: {
      readonly name: string;
      readonly riskLevel: 'R1' | 'R2';
      readonly definition: ApprovalTemplateDefinition;
    },
  ): Promise<{ readonly template: ApprovalTemplateSummary }> {
    return this.run(async () => this.idempotency.execute(
      'approval.template.update', key, { id, expectedVersion, ...input }, async (session) => {
        const current = await this.requireTemplate(id, session);
        const trusted = this.context.getRequired();
        const updated = updateApprovalTemplateDraft(current, {
          tenantId: trusted.tenant.tenantId,
          expectedVersion,
          actorId: trusted.actor.actorId,
          ...input,
        }, new Date());
        await this.templates.replace(updated, expectedVersion, session);
        await this.outbox.append(buildApprovalTemplateEvent(updated, 'draft_updated'), session);
        return { template: templateSummary(updated) };
      },
    ));
  }

  /** 返回可发起模板的最小表单投影；不暴露节点解析器、审批人或租户。 */
  async listPublishedTemplateForms(): Promise<readonly ApprovalPublishedTemplateFormView[]> {
    const templates = await this.templates.findPublished();
    return deepFreeze(templates.map((template) => ({
      id: template.id,
      code: template.code,
      name: template.name,
      revision: template.revision,
      riskLevel: template.riskLevel,
      definitionHash: template.definitionHash,
      fields: template.definition.fields.map((field) => ({ ...field })),
      version: template.version,
    })));
  }

  /** 返回当前主体创建或承接的委托；不暴露租户、权限快照或内部审计字段。 */
  async listMyDelegations(): Promise<readonly ApprovalDelegationView[]> {
    this.requireActorScope('erp:approval:delegation:read');
    const actorId = this.context.getActorRequired().actorId;
    return deepFreeze((await this.delegations.findMine(actorId)).map(delegationView));
  }

  async createDelegation(
    key: string,
    input: { readonly delegateId: string; readonly validFrom: string; readonly validUntil: string },
  ): Promise<{ readonly delegation: ApprovalDelegationView }> {
    this.requireActorScope('erp:approval:delegation:write');
    return this.run(async () => this.idempotency.execute(
      'approval.delegation.create', key, input, async (session) => {
        const trusted = this.context.getRequired();
        const now = new Date();
        await this.requireActiveActor(trusted.actor.actorId, session);
        await this.requireActiveActor(input.delegateId, session);
        const delegation = createApprovalDelegation({
          ...input,
          id: createEventId(now),
          tenantId: trusted.tenant.tenantId,
          principalApproverId: trusted.actor.actorId,
          actorId: trusted.actor.actorId,
        }, now);
        if (await this.delegations.hasOverlap(
          delegation.principalApproverId, delegation.validFrom, delegation.validUntil, session,
        )) throw new ConflictException({
          code: 'APPROVAL_DELEGATION_OVERLAP', message: '当前有效委托与所选时间范围重叠',
        });
        await this.delegations.insert(delegation, session);
        await this.outbox.append(buildApprovalDelegationEvent(delegation, 'created'), session);
        return { delegation: delegationView(delegation) };
      },
    ));
  }

  async revokeDelegation(
    id: string,
    expectedVersion: number,
    key: string,
  ): Promise<{ readonly delegation: ApprovalDelegationView }> {
    this.requireActorScope('erp:approval:delegation:write');
    return this.run(async () => this.idempotency.execute(
      'approval.delegation.revoke', key, { id, expectedVersion }, async (session) => {
        const current = await this.delegations.findById(id, session);
        if (current === null) throw new NotFoundException({
          code: 'APPROVAL_DELEGATION_NOT_FOUND', message: '审批委托不存在',
        });
        const trusted = this.context.getRequired();
        const revoked = revokeApprovalDelegation(current, {
          tenantId: trusted.tenant.tenantId,
          expectedVersion,
          actorId: trusted.actor.actorId,
        }, new Date());
        await this.delegations.replace(revoked, expectedVersion, session);
        await this.outbox.append(buildApprovalDelegationEvent(revoked, 'revoked'), session);
        return { delegation: delegationView(revoked) };
      },
    ));
  }

  async createInstance(
    key: string,
    input: {
      readonly templateCode: string;
      readonly title: string;
      readonly formData: ApprovalFormData;
    },
  ): Promise<{ readonly instance: ApprovalInstanceSummary }> {
    return this.run(async () => this.idempotency.execute(
      'approval.instance.create', key, input, async (session) => {
        const trusted = this.context.getRequired();
        await this.requireActiveActor(trusted.actor.actorId, session);
        const template = await this.templates.findPublishedByCode(input.templateCode, session);
        if (template === null) throw new NotFoundException({
          code: 'APPROVAL_TEMPLATE_NOT_FOUND', message: '未找到已发布审批模板',
        });
        const now = new Date();
        const instance = createApprovalInstanceDraft({
          id: createEventId(now),
          tenantId: trusted.tenant.tenantId,
          title: input.title,
          initiatorId: trusted.actor.actorId,
          template,
          formData: input.formData,
        }, now);
        await this.instances.insert(instance, session);
        await this.outbox.append(buildApprovalInstanceCreatedEvent(instance), session);
        return { instance: instanceSummary(instance) };
      },
    ));
  }

  /** 修改本人未提交实例草稿；模板快照不可替换，正文只进入加密聚合。 */
  async updateInstance(
    id: string,
    expectedVersion: number,
    key: string,
    input: {
      readonly title: string;
      readonly formData: ApprovalFormData;
    },
  ): Promise<{ readonly instance: ApprovalInstanceSummary }> {
    return this.run(async () => this.idempotency.execute(
      'approval.instance.update', key, { id, expectedVersion, ...input }, async (session) => {
        const current = await this.requireInstance(id, session);
        const trusted = this.context.getRequired();
        const updated = updateApprovalInstanceDraft(current, {
          tenantId: trusted.tenant.tenantId,
          expectedVersion,
          actorId: trusted.actor.actorId,
          ...input,
        }, new Date());
        await this.instances.replace(updated, expectedVersion, session);
        await this.outbox.append(buildApprovalInstanceUpdatedEvent(updated), session);
        return { instance: instanceSummary(updated) };
      },
    ));
  }

  /** OP 可信 Worker 专用：按 ERP 路由选定模板，以 ERP 员工主体原子创建并提交审批。 */
  async createAndSubmitFromOp(
    key: string,
    input: OpApprovalSubmissionInput,
  ): Promise<{ readonly instance: ApprovalInstanceSummary }> {
    const trusted = this.context.getRequired();
    if (
      trusted.actor.actorType !== 'system_job' ||
      !trusted.actor.scopes.includes('erp:approval:op:ingest')
    ) throw new ForbiddenException({
      code: 'APPROVAL_OP_INGEST_DENIED', message: 'OP 审批接入只允许可信后台任务',
    });
    if (!ULID_PATTERN.test(input.instanceId)) throw new BadRequestException({
      code: 'APPROVAL_OP_INSTANCE_ID_INVALID', message: 'OP 审批实例标识无效',
    });
    return this.run(async () => this.idempotency.execute(
      'approval.instance.op_ingest', key, input, async (session) => {
        const tenantId = trusted.tenant.tenantId;
        const initiatorId = await this.profiles.findActorIdByEmployee(
          tenantId, input.initiatorEmployeeId, session,
        );
        if (initiatorId === null) throw new BadRequestException({
          code: 'APPROVAL_OP_INITIATOR_NOT_FOUND', message: 'OP 审批发起员工未绑定有效 ERP 主体',
        });
        const profile = await this.profiles.resolveActive(tenantId, initiatorId, session);
        if (profile === null || profile.employeeId !== input.initiatorEmployeeId) {
          throw new BadRequestException({
            code: 'APPROVAL_OP_INITIATOR_INACTIVE', message: 'OP 审批发起员工主体已停用',
          });
        }
        const template = await this.templates.findPublishedByCode(input.templateCode, session);
        if (template === null) throw new NotFoundException({
          code: 'APPROVAL_TEMPLATE_NOT_FOUND', message: '未找到 OP 路由指定的已发布审批模板',
        });
        const now = new Date();
        const draft = createApprovalInstanceDraft({
          id: input.instanceId, tenantId, title: input.title,
          initiatorId, template, formData: input.formData,
        }, now);
        const resolvedNodes = await this.resolvers.resolve(
          draft.templateSnapshot, initiatorId, draft.formData, session,
        );
        const submitted = submitApprovalInstance(draft, {
          tenantId, expectedVersion: draft.version, actorId: initiatorId, resolvedNodes,
        }, now);
        await this.instances.insert(submitted.instance, session);
        await this.actions.append(submitted.instance, submitted.action, session);
        await this.outbox.append(buildApprovalInstanceCreatedEvent(draft), session);
        await this.outbox.append(
          buildApprovalActionEvent(submitted.instance, submitted.action), session,
        );
        await this.notifications.append(submitted.instance, submitted.action, session);
        return { instance: instanceSummary(submitted.instance) };
      },
    ));
  }

  async submitInstance(
    id: string,
    expectedVersion: number,
    key: string,
  ): Promise<{ readonly instance: ApprovalInstanceSummary }> {
    return this.transition('approval.instance.submit', key, { id, expectedVersion }, async (session) => {
      const current = await this.requireInstance(id, session);
      const actorId = this.context.getActorRequired().actorId;
      const resolvedNodes = await this.resolvers.resolve(
        current.templateSnapshot, actorId, current.formData, session,
      );
      return submitApprovalInstance(current, {
        tenantId: this.context.getTenantRequired().tenantId,
        expectedVersion,
        actorId,
        resolvedNodes,
      }, new Date());
    });
  }

  /** 仅供已完成 MCP R1/R2 确认与强认证的内部执行路径调用。 */
  async decideConfirmedInstance(
    id: string,
    expectedVersion: number,
    principalApproverId: string,
    outcome: 'approved' | 'rejected',
    key: string,
  ): Promise<{ readonly instance: ApprovalInstanceSummary }> {
    return this.decide(id, expectedVersion, principalApproverId, outcome, key, true);
  }

  /** 普通 ERP 会话决策只允许 R1；R2 必须进入强认证确认执行路径。 */
  async decideInteractiveInstance(
    id: string,
    expectedVersion: number,
    principalApproverId: string,
    outcome: 'approved' | 'rejected',
    key: string,
  ): Promise<{ readonly instance: ApprovalInstanceSummary }> {
    return this.decide(id, expectedVersion, principalApproverId, outcome, key, false);
  }

  private async decide(
    id: string,
    expectedVersion: number,
    principalApproverId: string,
    outcome: 'approved' | 'rejected',
    key: string,
    confirmedR2: boolean,
  ): Promise<{ readonly instance: ApprovalInstanceSummary }> {
    return this.transition(
      'approval.instance.decide', key,
      { id, expectedVersion, principalApproverId, outcome, confirmedR2 },
      async (session) => {
        const current = await this.requireInstance(id, session);
        this.assertInteractiveRiskBoundary(current, confirmedR2);
        const actorId = this.context.getActorRequired().actorId;
        const delegated = actorId !== principalApproverId;
        const delegationVerified = !delegated || await this.delegations.isActive(
          principalApproverId, actorId, new Date(), session,
        );
        return decideApprovalInstance(current, {
          tenantId: this.context.getTenantRequired().tenantId,
          expectedVersion,
          actorId,
          principalApproverId,
          delegationVerified,
          outcome,
        }, new Date());
      },
    );
  }

  async transferTask(
    id: string,
    expectedVersion: number,
    fromApproverId: string,
    toApproverId: string,
    key: string,
  ): Promise<{ readonly instance: ApprovalInstanceSummary }> {
    return this.transition(
      'approval.instance.transfer', key,
      { id, expectedVersion, fromApproverId, toApproverId },
      async (session) => {
        const current = await this.requireInstance(id, session);
        this.assertInteractiveRiskBoundary(current, false);
        const actorId = this.context.getActorRequired().actorId;
        await this.requireActiveActor(toApproverId, session);
        const delegated = actorId !== fromApproverId;
        const delegationVerified = !delegated || await this.delegations.isActive(
          fromApproverId, actorId, new Date(), session,
        );
        return transferApprovalTask(current, {
          tenantId: this.context.getTenantRequired().tenantId,
          expectedVersion,
          actorId,
          fromApproverId,
          toApproverId,
          delegationVerified,
        }, new Date());
      },
    );
  }

  async addSigner(
    id: string,
    expectedVersion: number,
    approverId: string,
    key: string,
  ): Promise<{ readonly instance: ApprovalInstanceSummary }> {
    return this.transition(
      'approval.instance.add_signer', key, { id, expectedVersion, approverId },
      async (session) => {
        const actor = this.context.getActorRequired();
        const current = await this.requireInstance(id, session);
        this.assertInteractiveRiskBoundary(current, false);
        await this.requireActiveActor(approverId, session);
        return addApprovalSigner(current, {
          tenantId: this.context.getTenantRequired().tenantId,
          expectedVersion,
          actorId: actor.actorId,
          approverId,
          authorizationVerified: actor.scopes.includes('erp:approval:task:add_signer'),
        }, new Date());
      },
    );
  }

  async withdrawInstance(
    id: string,
    expectedVersion: number,
    key: string,
  ): Promise<{ readonly instance: ApprovalInstanceSummary }> {
    return this.transition(
      'approval.instance.withdraw', key, { id, expectedVersion }, async (session) => {
        const current = await this.requireInstance(id, session);
        return withdrawApprovalInstance(current, {
          tenantId: this.context.getTenantRequired().tenantId,
          expectedVersion,
          actorId: this.context.getActorRequired().actorId,
        }, new Date());
      },
    );
  }

  async archiveInstance(
    id: string,
    expectedVersion: number,
    key: string,
  ): Promise<{ readonly instance: ApprovalInstanceSummary }> {
    return this.transition(
      'approval.instance.archive', key, { id, expectedVersion }, async (session) => {
        const actor = this.context.getActorRequired();
        const current = await this.requireInstance(id, session);
        return archiveApprovalInstance(current, {
          tenantId: this.context.getTenantRequired().tenantId,
          expectedVersion,
          actorId: actor.actorId,
          authorizationVerified: actor.scopes.includes('erp:approval:instance:archive'),
        }, new Date());
      },
    );
  }

  async getInstance(id: string): Promise<ApprovalInstanceView> {
    const instance = await this.requireReadableInstance(id);
    const actor = this.context.getActorRequired();
    const canReadSensitive = actor.actorId === instance.initiatorId ||
      actor.scopes.includes('erp:approval:instance:read_sensitive');
    const fields = new Map(instance.templateSnapshot.definition.fields.map((field) => [field.key, field]));
    const formData: Record<string, ApprovalReadableFormValue> = Object.create(null) as
      Record<string, ApprovalReadableFormValue>;
    for (const [key, value] of Object.entries(instance.formData)) {
      const field = fields.get(key);
      if (field === undefined) continue;
      formData[key] = canReadSensitive || field.sensitivity === 'L1' || field.sensitivity === 'L2'
        ? cloneReadableValue(value)
        : Object.freeze({ redacted: true });
    }
    return deepFreeze({
      id: instance.id,
      title: instance.title,
      initiatorId: instance.initiatorId,
      status: instance.status,
      templateCode: instance.templateSnapshot.templateCode,
      templateRevision: instance.templateSnapshot.revision,
      riskLevel: instance.templateSnapshot.riskLevel,
      formData,
      currentNodeIndex: instance.currentNodeIndex,
      version: instance.version,
      submittedAt: instance.submittedAt,
      completedAt: instance.completedAt,
    });
  }

  private assertInteractiveRiskBoundary(instance: ApprovalInstance, confirmedR2: boolean): void {
    if (instance.templateSnapshot.riskLevel === 'R2' && !confirmedR2) {
      throw new ForbiddenException({
        code: 'APPROVAL_R2_STRONG_AUTH_REQUIRED',
        message: 'R2 审批操作必须通过强认证确认流程',
      });
    }
  }

  /** 返回已授权实例的追加式动作时间线；投影不含表单正文和租户字段。 */
  async getTimeline(id: string): Promise<readonly ApprovalTimelineEntry[]> {
    await this.requireReadableInstance(id);
    return this.actions.findTimeline(id);
  }

  async getInbox(): Promise<readonly ApprovalInstanceSummary[]> {
    const instances = await this.instances.findInbox(this.context.getActorRequired().actorId);
    return Object.freeze(instances.map((instance) => instanceSummary(instance)));
  }

  private async requireReadableInstance(id: string): Promise<ApprovalInstance> {
    const instance = await this.requireInstance(id);
    const actor = this.context.getActorRequired();
    if (
      actor.actorId !== instance.initiatorId &&
      !instance.resolvedNodes.some((node) => node.actorIds.includes(actor.actorId)) &&
      !actor.scopes.includes('erp:approval:instance:read_all')
    ) throw new ForbiddenException({ code: 'APPROVAL_READ_DENIED', message: '无权读取该审批' });
    return instance;
  }

  /** Recruitment 只读取审批终态；必须使用专用 Scope，禁止读取表单正文。 */
  async getInstanceStatusForRecruitment(id: string): Promise<ApprovalInstanceSummary> {
    const actor = this.context.getActorRequired();
    if (!actor.scopes.includes('erp:recruitment:requisition:sync_approval')) {
      throw new ForbiddenException({
        code: 'APPROVAL_INTEGRATION_STATUS_DENIED', message: '无权同步招聘审批状态',
      });
    }
    const instance = await this.requireInstance(id);
    if (instance.templateSnapshot.templateCode !== 'recruitment_hc') {
      throw new ForbiddenException({
        code: 'APPROVAL_INTEGRATION_TEMPLATE_DENIED', message: '招聘集成只能读取 HC 审批状态',
      });
    }
    return instanceSummary(instance);
  }

  /** Offer 工作流只读取专用模板终态，不读取 L4 表单正文。 */
  async getInstanceStatusForRecruitmentOffer(id: string): Promise<ApprovalInstanceSummary> {
    const actor = this.context.getActorRequired();
    if (!actor.scopes.includes('erp:recruitment:offer:sync_approval')) {
      throw new ForbiddenException({
        code: 'APPROVAL_OFFER_INTEGRATION_STATUS_DENIED', message: '无权同步 Offer 审批状态',
      });
    }
    const instance = await this.requireInstance(id);
    if (instance.templateSnapshot.templateCode !== 'recruitment_offer') {
      throw new ForbiddenException({
        code: 'APPROVAL_OFFER_INTEGRATION_TEMPLATE_DENIED',
        message: 'Offer 集成只能读取 Offer 审批状态',
      });
    }
    return instanceSummary(instance);
  }

  /** Care 只读取离职模板终态，不读取清算或审批表单正文。 */
  async getInstanceStatusForCare(id: string): Promise<ApprovalInstanceSummary> {
    const actor = this.context.getActorRequired();
    if (!actor.scopes.includes('erp:care:approval:sync')) {
      throw new ForbiddenException({
        code: 'APPROVAL_CARE_INTEGRATION_STATUS_DENIED', message: '无权同步离职审批状态',
      });
    }
    const instance = await this.requireInstance(id);
    if (instance.templateSnapshot.templateCode !== 'care_offboarding') {
      throw new ForbiddenException({
        code: 'APPROVAL_CARE_INTEGRATION_TEMPLATE_DENIED',
        message: 'Care 集成只能读取离职审批状态',
      });
    }
    return instanceSummary(instance);
  }

  /** 返回修订执行所需的强类型批准内容；字段不匹配模板契约时失败关闭。 */
  async getAttendanceCorrectionDecision(id: string): Promise<AttendanceCorrectionDecision> {
    const instance = await this.requireApprovedAttendanceInstance(id, 'attendance_correction');
    const form = instance.formData;
    return Object.freeze({
      id: instance.id,
      completedAt: requiredCompletedAt(instance),
      sourceFactId: requiredFormString(form, 'source_fact_id', /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/),
      employeeId: requiredFormString(form, 'employee_id', /^[A-Za-z0-9._:-]{1,128}$/),
      businessDate: requiredFormString(form, 'business_date', /^\d{4}-\d{2}-\d{2}$/),
      replacementImpact: Object.freeze({
        workedMinutes: requiredFormMinutes(form, 'worked_minutes'),
        leaveMinutes: requiredFormMinutes(form, 'leave_minutes'),
        overtimeMinutes: requiredFormMinutes(form, 'overtime_minutes'),
        absentMinutes: requiredFormMinutes(form, 'absent_minutes'),
      }),
      reasonCode: requiredFormString(form, 'reason_code', /^[A-Z][A-Z0-9_]{1,63}$/),
      formDataHash: instance.formDataHash,
    });
  }

  /** 返回月结重开所需的强类型批准绑定；禁止同一批准引用重开其他员工或月份。 */
  async getAttendanceMonthReopenDecision(id: string): Promise<AttendanceMonthReopenDecision> {
    const instance = await this.requireApprovedAttendanceInstance(id, 'attendance_month_reopen');
    return Object.freeze({
      id: instance.id,
      completedAt: requiredCompletedAt(instance),
      employeeId: requiredFormString(
        instance.formData, 'employee_id', /^[A-Za-z0-9._:-]{1,128}$/,
      ),
      month: requiredFormString(instance.formData, 'month', /^\d{4}-(0[1-9]|1[0-2])$/),
      previousSnapshotId: requiredFormString(
        instance.formData, 'previous_snapshot_id', /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/,
      ),
      formDataHash: instance.formDataHash,
    });
  }

  /** Payroll 只读取专用审批的可信终态和固定摘要，不暴露工资明细或审批正文。 */
  async getPayrollPeriodDecision(id: string): Promise<PayrollPeriodApprovalDecision> {
    const actor = this.context.getActorRequired();
    if (!actor.scopes.includes('erp:payroll:approval:sync')) throw new ForbiddenException({
      code: 'APPROVAL_PAYROLL_INTEGRATION_STATUS_DENIED', message: '无权同步工资审批状态',
    });
    const instance = await this.requireInstance(id);
    if (instance.templateSnapshot.templateCode !== 'payroll_period_approval') {
      throw new ForbiddenException({
        code: 'APPROVAL_PAYROLL_INTEGRATION_TEMPLATE_DENIED',
        message: '工资审批模板与执行动作不匹配',
      });
    }
    if (
      (instance.status !== 'approved' && instance.status !== 'rejected') ||
      instance.completedAt === null
    ) throw new ConflictException({
      code: 'APPROVAL_PAYROLL_DECISION_INCOMPLETE', message: '工资审批尚未形成可信终态',
    });
    const outcome = instance.status;
    const finalDecision = instance.resolvedNodes
      .flatMap((node) => node.decisions)
      .filter((decision) => decision.outcome === outcome)
      .sort((left, right) => left.decidedAt < right.decidedAt ? -1 : 1)
      .at(-1);
    if (finalDecision === undefined || finalDecision.decidedAt !== instance.completedAt) {
      throw new ConflictException({
        code: 'APPROVAL_PAYROLL_DECISION_INVALID', message: '工资审批终态证据不完整',
      });
    }
    return Object.freeze({
      id: instance.id, outcome, decidedBy: finalDecision.decidedBy,
      completedAt: instance.completedAt,
      periodId: requiredPayrollFormString(instance.formData, 'period_id', ULID_PATTERN),
      runId: requiredPayrollFormString(instance.formData, 'run_id', ULID_PATTERN),
      inputSnapshotHash: requiredPayrollFormString(
        instance.formData, 'input_snapshot_hash', HASH_PATTERN,
      ),
      resultHash: requiredPayrollFormString(instance.formData, 'result_hash', HASH_PATTERN),
      formDataHash: instance.formDataHash,
    });
  }

  /**
   * Treasury 账户登记只读取专用审批的可信通过终态。
   *
   * L4 表单只在同进程应用服务调用期间返回，不进入 REST、MCP、事件、审计或日志。
   */
  async getTreasuryBankAccountDecision(
    id: string,
    session: ClientSession,
  ): Promise<ApprovalTreasuryBankAccountDecision> {
    const actor = this.context.getActorRequired();
    if (!actor.scopes.includes('erp:treasury:account:attest')) throw new ForbiddenException({
      code: 'APPROVAL_TREASURY_INTEGRATION_STATUS_DENIED',
      message: '无权读取资金账户审批终态',
    });
    const instance = await this.requireInstance(id, session);
    if (instance.templateSnapshot.templateCode !== 'treasury_bank_account_attestation') {
      throw new ForbiddenException({
        code: 'APPROVAL_TREASURY_INTEGRATION_TEMPLATE_DENIED',
        message: '资金账户审批模板与登记动作不匹配',
      });
    }
    if (instance.status !== 'approved' || instance.completedAt === null) {
      throw new ConflictException({
        code: 'APPROVAL_TREASURY_DECISION_INCOMPLETE',
        message: '资金账户审批尚未形成可信通过终态',
      });
    }
    const finalDecision = instance.resolvedNodes
      .flatMap((node) => node.decisions)
      .filter((decision) => decision.outcome === 'approved')
      .sort((left, right) => left.decidedAt < right.decidedAt ? -1 : 1)
      .at(-1);
    if (finalDecision === undefined || finalDecision.decidedAt !== instance.completedAt) {
      throw new ConflictException({
        code: 'APPROVAL_TREASURY_DECISION_INVALID',
        message: '资金账户审批终态证据不完整',
      });
    }
    const form = instance.formData;
    const ownerType = requiredTreasuryFormString(
      form, 'owner_type', /^(organization|employee)$/u,
    );
    const currency = requiredTreasuryFormString(form, 'currency', /^CNY$/u);
    return Object.freeze({
      id: instance.id,
      completedAt: instance.completedAt,
      approvedBy: finalDecision.decidedBy,
      ownerType: ownerType as 'organization' | 'employee',
      ownerId: requiredTreasuryFormString(
        form, 'owner_id', /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u,
      ),
      accountName: requiredTreasuryFormString(
        form, 'account_name', /^(?!.*[\p{Cc}\p{Cf}])[\s\S]{1,140}$/u,
      ),
      account: requiredTreasuryFormString(form, 'account', /^[0-9]{8,32}$/u),
      clearingCode: requiredTreasuryFormString(
        form, 'clearing_code', /^[0-9A-Z]{8,12}$/u,
      ),
      currency: currency as 'CNY',
      formDataHash: instance.formDataHash,
    });
  }

  /** Payroll 调整只读取专用审批的可信终态和固定控制摘要，不暴露员工或金额。 */
  async getPayrollAdjustmentDecision(id: string): Promise<PayrollAdjustmentApprovalDecision> {
    const actor = this.context.getActorRequired();
    if (!actor.scopes.includes('erp:payroll:adjustment:approval:sync')) {
      throw new ForbiddenException({
        code: 'APPROVAL_PAYROLL_ADJUSTMENT_STATUS_DENIED',
        message: '无权同步工资调整审批状态',
      });
    }
    const instance = await this.requireInstance(id);
    if (instance.templateSnapshot.templateCode !== 'payroll_adjustment_approval') {
      throw new ForbiddenException({
        code: 'APPROVAL_PAYROLL_ADJUSTMENT_TEMPLATE_DENIED',
        message: '工资调整审批模板与执行动作不匹配',
      });
    }
    if (
      (instance.status !== 'approved' && instance.status !== 'rejected') ||
      instance.completedAt === null
    ) throw new ConflictException({
      code: 'APPROVAL_PAYROLL_ADJUSTMENT_INCOMPLETE',
      message: '工资调整审批尚未形成可信终态',
    });
    const outcome = instance.status;
    const finalDecision = instance.resolvedNodes
      .flatMap((node) => node.decisions)
      .filter((decision) => decision.outcome === outcome)
      .sort((left, right) => left.decidedAt < right.decidedAt ? -1 : 1)
      .at(-1);
    if (finalDecision === undefined || finalDecision.decidedAt !== instance.completedAt) {
      throw new ConflictException({
        code: 'APPROVAL_PAYROLL_ADJUSTMENT_DECISION_INVALID',
        message: '工资调整审批终态证据不完整',
      });
    }
    const adjustmentType = requiredPayrollFormString(
      instance.formData,
      'adjustment_type',
      /^(supplement|reversal|tax_only)$/,
    ) as PayrollAdjustmentApprovalDecision['adjustmentType'];
    return Object.freeze({
      id: instance.id,
      outcome,
      decidedBy: finalDecision.decidedBy,
      completedAt: instance.completedAt,
      adjustmentId: requiredPayrollFormString(
        instance.formData, 'adjustment_id', ULID_PATTERN,
      ),
      adjustmentHash: requiredPayrollFormString(
        instance.formData, 'adjustment_hash', HASH_PATTERN,
      ),
      period: requiredPayrollFormString(
        instance.formData, 'period', /^\d{4}-(0[1-9]|1[0-2])$/,
      ),
      adjustmentType,
      reasonCode: requiredPayrollFormString(
        instance.formData, 'reason_code', /^[A-Z][A-Z0-9_]{1,63}$/,
      ),
      formDataHash: instance.formDataHash,
    });
  }

  private async requireApprovedAttendanceInstance(
    id: string,
    templateCode: 'attendance_correction' | 'attendance_month_reopen',
  ): Promise<ApprovalInstance> {
    const actor = this.context.getActorRequired();
    if (!actor.scopes.includes('erp:attendance:approval:sync')) {
      throw new ForbiddenException({
        code: 'APPROVAL_ATTENDANCE_INTEGRATION_STATUS_DENIED',
        message: '无权同步考勤审批状态',
      });
    }
    const instance = await this.requireInstance(id);
    if (instance.templateSnapshot.templateCode !== templateCode) {
      throw new ForbiddenException({
        code: 'APPROVAL_ATTENDANCE_INTEGRATION_TEMPLATE_DENIED',
        message: '考勤审批模板与执行动作不匹配',
      });
    }
    if (instance.status !== 'approved' || instance.completedAt === null) {
      throw new ConflictException({
        code: 'APPROVAL_ATTENDANCE_DECISION_INCOMPLETE',
        message: '考勤审批尚未形成可信通过终态',
      });
    }
    return instance;
  }

  private async transition(
    operation: string,
    key: string,
    request: Record<string, unknown>,
    handler: (session: ClientSession) => Promise<{
      readonly instance: ApprovalInstance;
      readonly action: Parameters<typeof buildApprovalActionEvent>[1];
    }>,
  ): Promise<{ readonly instance: ApprovalInstanceSummary }> {
    return this.run(async () => this.idempotency.execute(operation, key, request, async (session) => {
      const result = await handler(session);
      await this.instances.replace(result.instance, result.instance.version - 1, session);
      await this.actions.append(result.instance, result.action, session);
      await this.outbox.append(buildApprovalActionEvent(result.instance, result.action), session);
      await this.notifications.append(result.instance, result.action, session);
      return { instance: instanceSummary(result.instance) };
    }));
  }

  private async requireTemplate(id: string, session?: ClientSession): Promise<ApprovalTemplate> {
    const template = await this.templates.findById(id, session);
    if (template === null) throw new NotFoundException({
      code: 'APPROVAL_TEMPLATE_NOT_FOUND', message: '审批模板不存在',
    });
    return template;
  }

  private async requireInstance(id: string, session?: ClientSession): Promise<ApprovalInstance> {
    const instance = await this.instances.findById(id, session);
    if (instance === null) throw new NotFoundException({
      code: 'APPROVAL_INSTANCE_NOT_FOUND', message: '审批实例不存在',
    });
    return instance;
  }

  private async requireActiveActor(actorId: string, session: ClientSession): Promise<void> {
    const profile = await this.profiles.resolveActive(
      this.context.getTenantRequired().tenantId, actorId, session,
    );
    if (profile === null) throw new BadRequestException({
      code: 'APPROVAL_ACTOR_INACTIVE', message: '审批主体不存在或已停用',
    });
  }

  private async requireMigrationActor(
    employeeId: string,
    session: ClientSession,
  ): Promise<string> {
    const actorId = await this.profiles.findActorIdByEmployee(
      this.context.getTenantRequired().tenantId,
      employeeId,
      session,
    );
    if (actorId === null) throw new BadRequestException({
      code: 'APPROVAL_MIGRATION_IDENTITY_MISSING',
      message: '审批迁移员工未映射 ERP 身份',
    });
    return actorId;
  }

  private async requireActiveMigrationEmployee(
    employeeId: string,
    actorId: string,
    session: ClientSession,
  ): Promise<void> {
    const profile = await this.profiles.resolveActive(
      this.context.getTenantRequired().tenantId,
      actorId,
      session,
    );
    if (profile === null || profile.employeeId !== employeeId) throw new BadRequestException({
      code: 'APPROVAL_MIGRATION_ACTIVE_ACTOR_INACTIVE',
      message: '活动审批草稿所有者或当前待办员工身份不可用',
    });
  }

  private assertMigrationWriter(): void {
    const actor = this.context.getActorRequired();
    if (!['service', 'system_job'].includes(actor.actorType) ||
      !actor.scopes.includes('erp:migration:execute') ||
      !actor.scopes.includes('erp:approval:migration:write')) {
      throw new ForbiddenException({
        code: 'APPROVAL_MIGRATION_WRITER_DENIED',
        message: '审批迁移必须由受信任服务身份执行',
      });
    }
  }

  private assertRecruitmentMigrationVerifier(): void {
    const actor = this.context.getActorRequired();
    if (!['service', 'system_job'].includes(actor.actorType) ||
      !actor.scopes.includes('erp:migration:execute') ||
      !actor.scopes.includes('erp:recruitment:migration:write')) {
      throw new ForbiddenException({
        code: 'APPROVAL_MIGRATION_RECRUITMENT_VERIFIER_DENIED',
        message: '招聘迁移审批引用校验只允许受信任服务身份',
      });
    }
  }

  private assertAttendanceMigrationVerifier(): void {
    const actor = this.context.getActorRequired();
    if (!['service', 'system_job'].includes(actor.actorType) ||
      !actor.scopes.includes('erp:migration:execute') ||
      !actor.scopes.includes('erp:attendance:migration:write')) {
      throw new ForbiddenException({
        code: 'APPROVAL_MIGRATION_ATTENDANCE_VERIFIER_DENIED',
        message: '考勤迁移审批引用校验只允许受信任服务身份',
      });
    }
  }

  private assertPayrollMigrationVerifier(): void {
    const actor = this.context.getActorRequired();
    if (!['service', 'system_job'].includes(actor.actorType) ||
      !actor.scopes.includes('erp:migration:execute') ||
      !actor.scopes.includes('erp:payroll:migration:write')) {
      throw new ForbiddenException({
        code: 'APPROVAL_MIGRATION_PAYROLL_VERIFIER_DENIED',
        message: '薪资迁移审批引用校验只允许受信任服务身份',
      });
    }
  }

  private assertTreasuryMigrationVerifier(): void {
    const actor = this.context.getActorRequired();
    if (!['service', 'system_job'].includes(actor.actorType) ||
      !actor.scopes.includes('erp:migration:execute') ||
      !actor.scopes.includes('erp:treasury:migration:write')) {
      throw new ForbiddenException({
        code: 'APPROVAL_MIGRATION_TREASURY_VERIFIER_DENIED',
        message: '资金迁移审批引用校验只允许受信任服务身份',
      });
    }
  }

  private requireActorScope(scope: string): void {
    if (!this.context.getActorRequired().scopes.includes(scope)) {
      throw new ForbiddenException({ code: 'APPROVAL_SCOPE_DENIED', message: '审批操作缺少必要权限' });
    }
  }

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof ApprovalWriteConflictError) {
        throw new ConflictException({ code: 'APPROVAL_VERSION_CONFLICT', message: error.message });
      }
      if (error instanceof ApprovalDomainError) {
        if (
          error.code.includes('DENIED') || error.code.includes('SOD') ||
          error.code === 'APPROVAL_DELEGATION_REQUIRED'
        ) {
          throw new ForbiddenException({ code: error.code, message: error.message });
        }
        if (error.code.includes('VERSION') || error.code.includes('ALREADY')) {
          throw new ConflictException({ code: error.code, message: error.message });
        }
        throw new BadRequestException({ code: error.code, message: error.message });
      }
      if (isDuplicateKeyError(error)) {
        throw new ConflictException({ code: 'APPROVAL_UNIQUE_CONFLICT', message: '审批唯一约束冲突' });
      }
      throw error;
    }
  }
}

function requiredCompletedAt(instance: ApprovalInstance): string {
  if (instance.completedAt === null || !Number.isFinite(Date.parse(instance.completedAt))) {
    throw new ConflictException({
      code: 'APPROVAL_ATTENDANCE_DECISION_INVALID', message: '考勤审批完成时间非法',
    });
  }
  return instance.completedAt;
}

function requiredFormString(
  form: ApprovalFormData,
  field: string,
  pattern: RegExp,
): string {
  const value = form[field];
  if (typeof value !== 'string' || !pattern.test(value)) throw new ConflictException({
    code: 'APPROVAL_ATTENDANCE_FORM_INVALID', message: `考勤审批字段 ${field} 非法或缺失`,
  });
  return value;
}

function requiredFormMinutes(form: ApprovalFormData, field: string): number {
  const value = form[field];
  if (!Number.isSafeInteger(value) || typeof value !== 'number' || value < 0 || value > 44_640) {
    throw new ConflictException({
      code: 'APPROVAL_ATTENDANCE_FORM_INVALID', message: `考勤审批字段 ${field} 非法或缺失`,
    });
  }
  return value;
}

function requiredPayrollFormString(
  form: ApprovalFormData,
  field: string,
  pattern: RegExp,
): string {
  const value = form[field];
  if (typeof value !== 'string' || !pattern.test(value)) throw new ConflictException({
    code: 'APPROVAL_PAYROLL_FORM_INVALID', message: `工资审批字段 ${field} 非法或缺失`,
  });
  return value;
}

function requiredTreasuryFormString(
  form: ApprovalFormData,
  field: string,
  pattern: RegExp,
): string {
  const value = form[field];
  if (typeof value !== 'string' || !pattern.test(value)) throw new ConflictException({
    code: 'APPROVAL_TREASURY_FORM_INVALID',
    message: `资金账户审批字段 ${field} 非法或缺失`,
  });
  return value;
}

function templateSummary(template: ApprovalTemplate): ApprovalTemplateSummary {
  return Object.freeze({
    id: template.id,
    code: template.code,
    revision: template.revision,
    status: template.status,
    riskLevel: template.riskLevel,
    definitionHash: template.definitionHash,
    version: template.version,
  });
}

function instanceSummary(instance: ApprovalInstance): ApprovalInstanceSummary {
  return Object.freeze({
    id: instance.id,
    status: instance.status,
    templateCode: instance.templateSnapshot.templateCode,
    templateRevision: instance.templateSnapshot.revision,
    riskLevel: instance.templateSnapshot.riskLevel,
    version: instance.version,
    submittedAt: instance.submittedAt,
    completedAt: instance.completedAt,
  });
}

function delegationView(delegation: ApprovalDelegation): ApprovalDelegationView {
  return Object.freeze({
    id: delegation.id,
    principalApproverId: delegation.principalApproverId,
    delegateId: delegation.delegateId,
    validFrom: delegation.validFrom,
    validUntil: delegation.validUntil,
    status: delegation.status,
    version: delegation.version,
  });
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000;
}

function sameMigratedTemplate(left: ApprovalTemplate, right: ApprovalTemplate): boolean {
  return left.code === right.code &&
    left.name === right.name &&
    left.riskLevel === right.riskLevel &&
    left.revision === right.revision &&
    left.status === right.status &&
    left.definitionHash === right.definitionHash &&
    left.approvedBy === right.approvedBy &&
    left.publishedAt === right.publishedAt &&
    left.retiredAt === right.retiredAt &&
    left.createdBy === right.createdBy &&
    left.updatedBy === right.updatedBy &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt;
}

function sameMigratedLegacyHistory(
  left: ApprovalLegacyHistory,
  right: ApprovalLegacyHistory,
): boolean {
  return left.templateCode === right.templateCode &&
    left.templateId === right.templateId &&
    left.templateRevision === right.templateRevision &&
    left.initiatorEmployeeId === right.initiatorEmployeeId &&
    left.outcome === right.outcome &&
    left.completedAt === right.completedAt &&
    left.archivedAt === right.archivedAt &&
    left.migrationEvidenceRef === right.migrationEvidenceRef &&
    left.evidenceChecksum === right.evidenceChecksum;
}

function assertActiveMigrationEvidence(reference: string, checksum: string): void {
  if (!MIGRATION_EVIDENCE_REF_PATTERN.test(reference) || !HASH_PATTERN.test(checksum)) {
    throw new ApprovalDomainError(
      'APPROVAL_MIGRATION_ACTIVE_EVIDENCE_INVALID',
      '活动审批必须绑定当前迁移运行的有效证据附件',
    );
  }
}

function assertActiveMigrationFormBoundary(
  definition: ApprovalTemplateDefinition,
  formData: ApprovalFormData,
  mappedFields: ImportApprovalActiveInstanceFromMigrationInput['mappedFormReferenceFields'],
): void {
  if (typeof formData !== 'object' || formData === null || Array.isArray(formData)) {
    throw new ApprovalDomainError('APPROVAL_MIGRATION_ACTIVE_FORM_INVALID', '活动审批表单无效');
  }
  const expected: string[] = [];
  for (const field of definition.fields) {
    const value = Object.hasOwn(formData, field.key) ? formData[field.key] : undefined;
    if (!hasMigrationFormValue(value)) continue;
    if (field.type === 'file_reference') throw new ApprovalDomainError(
      'APPROVAL_MIGRATION_ACTIVE_FILE_UNSUPPORTED',
      '带文件引用的活动审批必须在切换前排空或经批准重建',
    );
    if (field.type === 'employee' || field.type === 'department') {
      expected.push(`${field.key}:${field.type === 'employee' ? 'org.employee' : 'org.department'}`);
    }
  }
  const actual = mappedFields.map((field) => `${field.fieldKey}:${field.entityType}`);
  if (new Set(actual).size !== actual.length ||
    [...actual].sort().join('|') !== [...expected].sort().join('|')) {
    throw new ApprovalDomainError(
      'APPROVAL_MIGRATION_ACTIVE_FORM_MAPPING_INVALID',
      '活动审批表单主数据引用声明与模板不一致',
    );
  }
}

function validateActiveMigrationTimeline(
  input: ImportApprovalActiveInstanceFromMigrationInput,
  now: Date,
): void {
  const createdAt = strictMigrationIso(input.createdAt);
  const updatedAt = strictMigrationIso(input.updatedAt);
  const submittedAt = input.submittedAt === null ? null : strictMigrationIso(input.submittedAt);
  if (Date.parse(createdAt) > now.getTime() + 5 * 60 * 1_000 ||
    Date.parse(updatedAt) < Date.parse(createdAt) || input.actions.length > 500 ||
    !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion !== input.actions.length + 1) {
    throw new ApprovalDomainError(
      'APPROVAL_MIGRATION_ACTIVE_TIMELINE_INVALID',
      '活动审批时间线、版本或动作数量无效',
    );
  }
  let previous = createdAt;
  for (const action of input.actions) {
    const occurredAt = strictMigrationIso(action.occurredAt);
    if (occurredAt < previous || Date.parse(occurredAt) > now.getTime() + 5 * 60 * 1_000) {
      throw new ApprovalDomainError(
        'APPROVAL_MIGRATION_ACTIVE_TIMELINE_INVALID',
        '活动审批动作时间必须按顺序且不能位于未来',
      );
    }
    previous = occurredAt;
  }
  const first = input.actions[0];
  if (
    (input.expectedStatus === 'draft' &&
      (input.actions.length !== 0 || input.resolvedNodes.length !== 0 || submittedAt !== null)) ||
    (input.expectedStatus === 'running' &&
      (first?.type !== 'submitted' || submittedAt !== first.occurredAt)) ||
    updatedAt !== previous
  ) throw new ApprovalDomainError(
    'APPROVAL_MIGRATION_ACTIVE_TIMELINE_INVALID',
    '活动审批声明状态与动作时间线不一致',
  );
}

function activeMigrationEmployeeIds(
  input: ImportApprovalActiveInstanceFromMigrationInput,
): readonly string[] {
  const values = [
    input.initiatorEmployeeId,
    ...input.expectedPendingApproverEmployeeIds,
    ...input.resolvedNodes.flatMap((node) => node.actorEmployeeIds),
  ];
  for (const action of input.actions) {
    values.push(action.actorEmployeeId);
    if (action.type === 'decided') values.push(action.principalApproverEmployeeId);
    else if (action.type === 'approver_transferred') {
      values.push(action.fromApproverEmployeeId, action.toApproverEmployeeId);
    } else if (action.type === 'approver_added') values.push(action.approverEmployeeId);
  }
  return [...new Set(values)];
}

function replayActiveMigrationAction(
  instance: ApprovalInstance,
  action: ImportApprovalActiveActionFromMigration,
  resolvedNodes: ImportApprovalActiveInstanceFromMigrationInput['resolvedNodes'],
  actor: (employeeId: string) => string,
): { readonly instance: ApprovalInstance; readonly action: Parameters<ApprovalActionRepository['append']>[1] } {
  const common = { tenantId: instance.tenantId, expectedVersion: instance.version };
  const occurredAt = new Date(action.occurredAt);
  switch (action.type) {
    case 'submitted':
      return submitApprovalInstance(instance, {
        ...common,
        actorId: actor(action.actorEmployeeId),
        resolvedNodes: resolvedNodes.map((node) => ({
          nodeId: node.nodeId,
          actorIds: node.actorEmployeeIds.map(actor),
        })),
      }, occurredAt);
    case 'decided':
      return decideApprovalInstance(instance, {
        ...common,
        actorId: actor(action.actorEmployeeId),
        principalApproverId: actor(action.principalApproverEmployeeId),
        delegationVerified: true,
        outcome: action.outcome,
      }, occurredAt);
    case 'approver_transferred':
      return transferApprovalTask(instance, {
        ...common,
        actorId: actor(action.actorEmployeeId),
        fromApproverId: actor(action.fromApproverEmployeeId),
        toApproverId: actor(action.toApproverEmployeeId),
        delegationVerified: true,
      }, occurredAt);
    case 'approver_added':
      return addApprovalSigner(instance, {
        ...common,
        actorId: actor(action.actorEmployeeId),
        approverId: actor(action.approverEmployeeId),
        authorizationVerified: true,
      }, occurredAt);
  }
}

function assertActiveMigrationResult(
  instance: ApprovalInstance,
  input: ImportApprovalActiveInstanceFromMigrationInput,
  actor: (employeeId: string) => string,
): void {
  const node = currentApprovalNode(instance);
  const decided = new Set(node?.decisions.map((decision) => decision.principalApproverId) ?? []);
  const pending = node?.actorIds.filter((actorId) => !decided.has(actorId)) ?? [];
  const expectedPending = input.expectedPendingApproverEmployeeIds.map(actor);
  if (
    instance.status !== input.expectedStatus || instance.version !== input.expectedVersion ||
    instance.submittedAt !== input.submittedAt || instance.updatedAt !== input.updatedAt ||
    (node?.id ?? null) !== input.expectedCurrentNodeId ||
    new Set(expectedPending).size !== expectedPending.length ||
    [...pending].sort().join('|') !== [...expectedPending].sort().join('|')
  ) throw new ApprovalDomainError(
    'APPROVAL_MIGRATION_ACTIVE_RESULT_MISMATCH',
    '活动审批状态机重放结果与来源控制事实不一致',
  );
}

function strictMigrationIso(value: string): string {
  const parsed = new Date(value);
  if (typeof value !== 'string' || Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new ApprovalDomainError(
      'APPROVAL_MIGRATION_ACTIVE_TIMELINE_INVALID',
      '活动审批时间必须为规范 UTC ISO 时间',
    );
  }
  return value;
}

function hasMigrationFormValue(value: ApprovalFormValue | undefined): boolean {
  return value !== undefined && value !== null && value !== '' &&
    (!Array.isArray(value) || value.length > 0);
}

function cloneReadableValue(value: ApprovalFormValue): ApprovalFormValue {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}
