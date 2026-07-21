import { createHash } from 'node:crypto';

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
import { OrgApplicationService } from '../../org/application/org-application.service.js';
import { RecruitmentOnboardingBridgeService } from '../../recruitment/application/recruitment-onboarding-bridge.service.js';
import {
  OnboardingDomainError,
  beginOnboardingProvisioning,
  buildOnboardingCompletedEvent,
  buildOnboardingCreatedEvent,
  buildOnboardingProvisioningStartedEvent,
  buildOnboardingTaskCompletedEvent,
  completeOnboardingProvisioning,
  createOnboardingInstance,
  onboardingTaskStatuses,
  recordOnboardingTaskEvidence,
  type OnboardingInstance,
  type OnboardingTaskCode,
} from '../domain/index.js';
import { OnboardingOutboxWriter } from '../persistence/onboarding-outbox.writer.js';
import {
  OnboardingInstanceRepository,
  OnboardingTaskEvidenceRepository,
  OnboardingWriteConflictError,
} from '../persistence/onboarding.repositories.js';

export interface OnboardingSummary extends Record<string, unknown> {
  readonly id: string;
  readonly offerId: string;
  readonly applicationId: string;
  readonly candidateId: string;
  readonly departmentId: string;
  readonly jobLevelId: string;
  readonly orgPositionId: string | null;
  readonly proposedStartDate: string;
  readonly status: OnboardingInstance['status'];
  readonly tasks: Readonly<Record<OnboardingTaskCode, 'pending' | 'completed'>>;
  readonly employmentId: string | null;
  readonly version: number;
}

/** 入职应用服务：负责本地事务与跨 Recruitment/Org 的可恢复 Saga。 */
@Injectable()
export class OnboardingApplicationService {
  constructor(
    private readonly idempotency: IdempotencyService,
    private readonly context: TenantContextService,
    private readonly instances: OnboardingInstanceRepository,
    private readonly evidence: OnboardingTaskEvidenceRepository,
    private readonly outbox: OnboardingOutboxWriter,
    private readonly recruitment: RecruitmentOnboardingBridgeService,
    private readonly org: OrgApplicationService,
  ) {}

  async createFromOffer(
    offerId: string,
    key: string,
  ): Promise<{ readonly onboarding: OnboardingSummary }> {
    this.assertScope('erp:onboarding:create');
    const source = await this.recruitment.getOnboardingSource(offerId);
    this.assertDepartmentWrite(source.departmentId);
    const result = await this.run(async () => this.idempotency.execute(
      'onboarding.instance.create_from_offer', key, { offerId }, async (session) => {
        const existing = await this.instances.findByOfferId(offerId, session);
        if (existing !== null) {
          this.assertSourceMatches(existing, source);
          return { onboarding: summary(existing) };
        }
        const now = new Date();
        const instance = createOnboardingInstance({
          id: createEventId(now), tenantId: this.context.getTenantRequired().tenantId,
          offerId: source.offerId, applicationId: source.applicationId,
          candidateId: source.candidateId,
          acceptanceEvidenceId: source.acceptanceEvidenceId,
          signedEvidenceId: source.signedEvidenceId,
          departmentId: source.departmentId, jobLevelId: source.jobLevelId,
          proposedStartDate: source.proposedStartDate,
        }, now);
        await this.instances.insert(instance, session);
        await this.outbox.append(buildOnboardingCreatedEvent(instance), session);
        if (source.signedEvidenceId !== null) {
          await this.evidence.append({
            id: createEventId(now), tenantId: instance.tenantId,
            onboardingInstanceId: instance.id, taskCode: 'contract_archived',
            evidenceId: source.signedEvidenceId,
            actorId: this.context.getActorRequired().actorId,
            occurredAt: now.toISOString(),
          }, session);
          await this.outbox.append(
            buildOnboardingTaskCompletedEvent(instance, 'contract_archived'),
            session,
          );
        }
        return { onboarding: summary(instance) };
      },
    ));
    await this.recruitment.markPreboarding(deriveKey(key, 'recruitment-preboarding'), {
      offerId, onboardingInstanceId: result.onboarding.id,
    });
    return result;
  }

  async get(id: string): Promise<OnboardingSummary> {
    const instance = await this.requireInstance(id);
    this.assertDepartmentRead(instance.departmentId);
    return summary(instance);
  }

  async recordTaskEvidence(
    id: string,
    expectedVersion: number,
    key: string,
    input: {
      readonly taskCode: OnboardingTaskCode;
      readonly evidenceId: string;
      readonly orgPositionId?: string;
    },
  ): Promise<{ readonly onboarding: OnboardingSummary }> {
    this.assertTaskScope(input.taskCode);
    if (input.taskCode === 'org_assignment_verified') {
      const current = await this.requireInstance(id);
      await this.org.validateOnboardingAssignment({
        departmentId: current.departmentId,
        orgPositionId: required(input.orgPositionId ?? null, '正式组织岗位'),
        jobLevelId: current.jobLevelId,
      });
    }
    return this.run(async () => this.idempotency.execute(
      'onboarding.task.record_evidence', key, { id, expectedVersion, ...input },
      async (session) => {
        const current = await this.requireInstance(id, session);
        this.assertDepartmentWrite(current.departmentId);
        const result = recordOnboardingTaskEvidence(current, {
          tenantId: this.context.getTenantRequired().tenantId,
          expectedVersion, taskCode: input.taskCode, evidenceId: input.evidenceId,
          evidenceRecordId: createEventId(new Date()),
          actorId: this.context.getActorRequired().actorId,
          ...(input.orgPositionId === undefined ? {} : { orgPositionId: input.orgPositionId }),
        }, new Date());
        if (result.evidence === null) return { onboarding: summary(result.instance) };
        await this.instances.replace(result.instance, expectedVersion, session);
        await this.evidence.append(result.evidence, session);
        await this.outbox.append(
          buildOnboardingTaskCompletedEvent(result.instance, input.taskCode),
          session,
        );
        return { onboarding: summary(result.instance) };
      },
    ));
  }

  async syncContractEvidence(
    id: string,
    expectedVersion: number,
    key: string,
  ): Promise<{ readonly onboarding: OnboardingSummary }> {
    this.assertScope('erp:onboarding:contract:attest');
    const current = await this.requireInstance(id);
    const source = await this.recruitment.getOnboardingSource(current.offerId);
    this.assertSourceMatches(current, source);
    if (source.signedEvidenceId === null) throw new ConflictException({
      code: 'ONBOARDING_SIGNED_EVIDENCE_PENDING', message: '可信签署证据尚未归档',
    });
    return this.recordTaskEvidence(id, expectedVersion, key, {
      taskCode: 'contract_archived', evidenceId: source.signedEvidenceId,
    });
  }

  /**
   * R3 可信工作流：本地开始建档、组织域建档、本地完成、招聘 hired 四步均可重入。
   */
  async complete(
    id: string,
    expectedVersion: number,
    key: string,
  ): Promise<{ readonly onboarding: OnboardingSummary }> {
    this.assertScope('erp:onboarding:complete');
    let current = await this.requireInstance(id);
    this.assertDepartmentWrite(current.departmentId);
    if (current.status === 'ready') {
      await this.beginProvisioning(current, expectedVersion, key);
      current = await this.requireInstance(id);
    } else if (
      current.status === 'provisioning' &&
      expectedVersion !== current.version && expectedVersion !== current.version - 1
    ) {
      throw new ConflictException({
        code: 'ONBOARDING_VERSION_CONFLICT', message: '入职实例版本冲突',
      });
    }

    if (current.status === 'provisioning') {
      current = await this.provisionEmployment(current, key);
    }
    if (current.status !== 'completed' || current.employmentId === null) {
      throw new ConflictException({ code: 'ONBOARDING_NOT_COMPLETED', message: '入职建档尚未完成' });
    }
    await this.recruitment.markHired(deriveKey(key, 'recruitment-hired'), {
      offerId: current.offerId, onboardingInstanceId: current.id,
      onboardingCompletionEvidenceId: required(current.completionEvidenceId, '完成证据'),
      employmentId: current.employmentId,
    });
    return { onboarding: summary(current) };
  }

  private async beginProvisioning(
    current: OnboardingInstance,
    expectedVersion: number,
    key: string,
  ): Promise<void> {
    await this.run(async () => this.idempotency.execute(
      'onboarding.provisioning.begin', deriveKey(key, 'begin'),
      { id: current.id, expectedVersion }, async (session) => {
        const fresh = await this.requireInstance(current.id, session);
        const next = beginOnboardingProvisioning(fresh, {
          tenantId: this.context.getTenantRequired().tenantId,
          expectedVersion,
          completionEvidenceId: createEventId(new Date()),
        }, new Date());
        await this.instances.replace(next, expectedVersion, session);
        await this.outbox.append(buildOnboardingProvisioningStartedEvent(next), session);
        return { onboarding: summary(next) };
      },
    ));
  }

  private async provisionEmployment(
    current: OnboardingInstance,
    key: string,
  ): Promise<OnboardingInstance> {
    const source = await this.recruitment.getOnboardingSource(current.offerId);
    this.assertSourceMatches(current, source);
    if (
      current.signedEvidenceId === null || current.identityEvidenceId === null ||
      current.orgPositionId === null || current.completionEvidenceId === null
    ) throw new ConflictException({
      code: 'ONBOARDING_COMPLETION_EVIDENCE_MISSING', message: '入职完成证据不完整',
    });
    const employment = await this.org.establishEmploymentFromOnboarding(
      deriveKey(key, 'org-employment'),
      {
        onboardingInstanceId: current.id,
        onboardingCompletionEvidenceId: current.completionEvidenceId,
        candidateId: current.candidateId, offerId: current.offerId,
        signedEvidenceId: current.signedEvidenceId,
        identityEvidenceId: current.identityEvidenceId,
        displayName: source.candidateDisplayName,
        primaryDepartmentId: current.departmentId,
        orgPositionId: current.orgPositionId,
        jobLevelId: current.jobLevelId,
        effectiveFrom: current.proposedStartDate,
      },
    );
    await this.run(async () => this.idempotency.execute(
      'onboarding.provisioning.complete', deriveKey(key, 'finish'),
      {
        id: current.id, completionEvidenceId: current.completionEvidenceId,
        employmentId: employment.employment.id,
      }, async (session) => {
        const fresh = await this.requireInstance(current.id, session);
        if (fresh.status === 'completed') {
          if (fresh.employmentId !== employment.employment.id) throw new ConflictException({
            code: 'ONBOARDING_EMPLOYMENT_MISMATCH', message: '入职实例已绑定不同劳动关系',
          });
          return { onboarding: summary(fresh) };
        }
        const completed = completeOnboardingProvisioning(fresh, {
          tenantId: this.context.getTenantRequired().tenantId,
          expectedVersion: fresh.version,
          completionEvidenceId: current.completionEvidenceId ?? '',
          employmentId: employment.employment.id,
        }, new Date());
        await this.instances.replace(completed, fresh.version, session);
        await this.outbox.append(buildOnboardingCompletedEvent(completed), session);
        return { onboarding: summary(completed) };
      },
    ));
    return this.requireInstance(current.id);
  }

  private assertSourceMatches(
    instance: OnboardingInstance,
    source: Awaited<ReturnType<RecruitmentOnboardingBridgeService['getOnboardingSource']>>,
  ): void {
    if (
      instance.offerId !== source.offerId || instance.applicationId !== source.applicationId ||
      instance.candidateId !== source.candidateId ||
      instance.acceptanceEvidenceId !== source.acceptanceEvidenceId ||
      instance.departmentId !== source.departmentId || instance.jobLevelId !== source.jobLevelId ||
      instance.proposedStartDate !== source.proposedStartDate
    ) throw new ConflictException({
      code: 'ONBOARDING_SOURCE_MISMATCH', message: '招聘来源与入职实例不一致，必须人工复核',
    });
    if (
      instance.signedEvidenceId !== null &&
      source.signedEvidenceId !== instance.signedEvidenceId
    ) throw new ConflictException({
      code: 'ONBOARDING_SIGNED_EVIDENCE_MISMATCH', message: '签署证据引用不一致',
    });
  }

  private async requireInstance(id: string, session?: Parameters<OnboardingInstanceRepository['findById']>[1]) {
    const instance = await this.instances.findById(id, session);
    if (instance === null) throw new NotFoundException({
      code: 'ONBOARDING_NOT_FOUND', message: '入职实例不存在',
    });
    return instance;
  }

  private assertTaskScope(taskCode: OnboardingTaskCode): void {
    if (taskCode === 'contract_archived') return this.assertScope('erp:onboarding:contract:attest');
    if (taskCode === 'identity_verified') {
      return this.assertScope('erp:identity:onboarding:attest');
    }
    if (taskCode === 'mandatory_training_completed') {
      return this.assertScope('erp:knowledge:onboarding:attest');
    }
    this.assertScope('erp:onboarding:task:complete');
  }

  private assertScope(scope: string): void {
    if (!this.context.getActorRequired().scopes.includes(scope)) throw new ForbiddenException({
      code: 'ONBOARDING_SCOPE_REQUIRED', message: '缺少入职工作流权限',
    });
  }

  private assertDepartmentRead(departmentId: string): void {
    const actor = this.context.getActorRequired();
    if (
      !actor.scopes.includes('erp:onboarding:read_all') &&
      !actor.departmentIds.includes(departmentId)
    ) throw new ForbiddenException({ code: 'ONBOARDING_READ_DENIED', message: '无权读取该入职实例' });
  }

  private assertDepartmentWrite(departmentId: string): void {
    const actor = this.context.getActorRequired();
    if (
      !actor.scopes.includes('erp:onboarding:write_all') &&
      !actor.departmentIds.includes(departmentId)
    ) throw new ForbiddenException({ code: 'ONBOARDING_WRITE_DENIED', message: '无权修改该入职实例' });
  }

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof OnboardingWriteConflictError) throw new ConflictException({
        code: 'ONBOARDING_VERSION_CONFLICT', message: error.message,
      });
      if (error instanceof OnboardingDomainError) {
        if (error.code.includes('VERSION') || error.code.includes('IMMUTABLE') ||
          error.code.includes('LOCKED') || error.code.includes('READY') ||
          error.code.includes('EVIDENCE')) throw new ConflictException({
          code: error.code, message: error.message,
        });
        if (error.code.includes('TENANT')) throw new ForbiddenException({
          code: error.code, message: error.message,
        });
        throw new BadRequestException({ code: error.code, message: error.message });
      }
      if (isDuplicateKeyError(error)) throw new ConflictException({
        code: 'ONBOARDING_UNIQUE_CONFLICT', message: 'Offer、申请或任务证据已存在',
      });
      throw error;
    }
  }
}

function summary(instance: OnboardingInstance): OnboardingSummary {
  return Object.freeze({
    id: instance.id, offerId: instance.offerId, applicationId: instance.applicationId,
    candidateId: instance.candidateId, departmentId: instance.departmentId,
    jobLevelId: instance.jobLevelId, orgPositionId: instance.orgPositionId,
    proposedStartDate: instance.proposedStartDate, status: instance.status,
    tasks: onboardingTaskStatuses(instance), employmentId: instance.employmentId,
    version: instance.version,
  });
}

function deriveKey(root: string, stage: string): string {
  const digest = createHash('sha256').update(JSON.stringify([root, stage]), 'utf8').digest('base64url');
  return `onboarding:${digest}`;
}

function required(value: string | null, label: string): string {
  if (value === null) throw new ConflictException({
    code: 'ONBOARDING_COMPLETION_EVIDENCE_MISSING', message: `${label}缺失`,
  });
  return value;
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11_000;
}
