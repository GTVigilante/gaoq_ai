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
  buildApprovalInstanceCreatedEvent,
  buildApprovalTemplateEvent,
  createApprovalInstanceDraft,
  createApprovalTemplateDraft,
  createNextApprovalTemplateRevision,
  decideApprovalInstance,
  publishApprovalTemplate,
  retireApprovalTemplate,
  submitApprovalInstance,
  transferApprovalTask,
  withdrawApprovalInstance,
  ApprovalDomainError,
  type ApprovalFormData,
  type ApprovalFormValue,
  type ApprovalInstance,
  type ApprovalTemplate,
  type ApprovalTemplateDefinition,
} from '../domain/index.js';
import {
  ApprovalActionRepository,
  ApprovalDelegationRepository,
  ApprovalInstanceRepository,
  ApprovalTemplateRepository,
  ApprovalWriteConflictError,
} from '../persistence/approval.repositories.js';
import { ApprovalOutboxWriter } from '../persistence/approval-outbox.writer.js';
import { ApprovalActorResolverService } from './approval-actor-resolver.service.js';
import { ApprovalNotificationWriter } from '../notification/approval-notification.writer.js';

export interface ApprovalTemplateSummary extends Record<string, unknown> {
  readonly id: string;
  readonly code: string;
  readonly revision: number;
  readonly status: ApprovalTemplate['status'];
  readonly riskLevel: 'R1' | 'R2';
  readonly definitionHash: string;
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

/** 审批应用服务：唯一事务编排入口，REST、Worker 与 MCP 必须复用本服务。 */
@Injectable()
export class ApprovalApplicationService {
  constructor(
    private readonly idempotency: IdempotencyService,
    private readonly context: TenantContextService,
    private readonly profiles: AccessProfileRepository,
    private readonly templates: ApprovalTemplateRepository,
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

  async decideInstance(
    id: string,
    expectedVersion: number,
    principalApproverId: string,
    outcome: 'approved' | 'rejected',
    key: string,
  ): Promise<{ readonly instance: ApprovalInstanceSummary }> {
    return this.transition(
      'approval.instance.decide', key,
      { id, expectedVersion, principalApproverId, outcome },
      async (session) => {
        const current = await this.requireInstance(id, session);
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
    const instance = await this.requireInstance(id);
    const actor = this.context.getActorRequired();
    if (
      actor.actorId !== instance.initiatorId &&
      !instance.resolvedNodes.some((node) => node.actorIds.includes(actor.actorId)) &&
      !actor.scopes.includes('erp:approval:instance:read_all')
    ) throw new ForbiddenException({ code: 'APPROVAL_READ_DENIED', message: '无权读取该审批' });
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

  async getInbox(): Promise<readonly ApprovalInstanceSummary[]> {
    const instances = await this.instances.findInbox(this.context.getActorRequired().actorId);
    return Object.freeze(instances.map((instance) => instanceSummary(instance)));
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

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000;
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
