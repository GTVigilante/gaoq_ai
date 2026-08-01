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
import { ApprovalApplicationService } from '../../approval/application/approval-application.service.js';
import { OrgApplicationService } from '../../org/application/org-application.service.js';
import {
  CareDomainError,
  alumniConsentEvent,
  approveCareCase,
  beginCareExecution,
  careCaseEvent,
  careTaskStatuses,
  completeCareExecution,
  createAlumniConsent,
  createOffboardingCase,
  expireAlumniConsent as expireConsent,
  recordCareTaskEvidence,
  rejectCareCase,
  scheduleCareExecution,
  submitCareCaseForApproval,
  withdrawAlumniConsent,
  type AlumniConsent,
  type CareCase,
  type CareTaskCode,
} from '../domain/index.js';
import { CareOutboxWriter } from '../persistence/care-outbox.writer.js';
import {
  CareCaseRepository,
  CareAlumniConsentRepository,
  CareTaskEvidenceRepository,
  CareWriteConflictError,
} from '../persistence/care.repositories.js';
import type { CreateAlumniConsentDto, CreateOffboardingCaseDto } from './care.dto.js';
import { CareExecutionQueueService } from '../care-execution-queue.service.js';
import { AlumniConsentVerificationPort, CareTaskEvidenceVerificationPort } from './care-ports.js';

const APPROVAL_TEMPLATE = 'care_offboarding';

export interface CareCaseSummary extends Record<string, unknown> {
  readonly id: string;
  readonly employeeId: string;
  readonly employmentId: string;
  readonly separationType: CareCase['separationType'];
  readonly reasonCode: string;
  readonly lastWorkingDate: string;
  readonly accessDisableAt: string;
  readonly status: CareCase['status'];
  readonly approvalInstanceId: string | null;
  readonly tasks: Readonly<Record<CareTaskCode, 'pending' | 'completed'>>;
  readonly version: number;
}

export type CareMcpSummary = Pick<
  CareCaseSummary,
  'id' | 'employeeId' | 'employmentId' | 'lastWorkingDate' |
  'accessDisableAt' | 'status' | 'tasks' | 'version'
>;

export interface AlumniConsentSummary extends Record<string, unknown> {
  readonly id: string;
  readonly careCaseId: string;
  readonly purpose: AlumniConsent['purpose'];
  readonly channels: AlumniConsent['channels'];
  readonly grantedAt: string;
  readonly expiresAt: string;
  readonly status: AlumniConsent['status'];
  readonly version: number;
}

@Injectable()
export class CareApplicationService {
  constructor(
    private readonly idempotency: IdempotencyService,
    private readonly context: TenantContextService,
    private readonly cases: CareCaseRepository,
    private readonly evidence: CareTaskEvidenceRepository,
    private readonly alumni: CareAlumniConsentRepository,
    private readonly outbox: CareOutboxWriter,
    private readonly approvals: ApprovalApplicationService,
    private readonly organization: OrgApplicationService,
    private readonly executionQueue: CareExecutionQueueService,
    private readonly taskEvidenceVerifier: CareTaskEvidenceVerificationPort,
    private readonly consentVerifier: AlumniConsentVerificationPort,
  ) {}

  async create(
    key: string,
    input: CreateOffboardingCaseDto,
  ): Promise<{ readonly careCase: CareCaseSummary }> {
    this.assertScope('erp:care:case:create');
    return this.run(async () => this.idempotency.execute(
      'care.case.create', key, input, async (session) => {
        const source = await this.organization.getEmploymentForCare(input.employmentId);
        this.assertDepartmentWrite(source.employee.departmentIds);
        if (
          source.employment.status === 'resigned' || source.employment.effectiveTo !== null ||
          source.employee.status === 'terminated'
        ) throw new ConflictException({
          code: 'CARE_EMPLOYMENT_ALREADY_TERMINATED', message: '劳动关系已经关闭',
        });
        const now = new Date();
        const careCase = createOffboardingCase({
          id: createEventId(now), tenantId: this.context.getTenantRequired().tenantId,
          employeeId: source.employee.id, ...input,
        }, now);
        await this.cases.insert(careCase, session);
        await this.outbox.append(careCaseEvent(careCase, 'care.case.created'), session);
        return { careCase: summary(careCase) };
      },
    ));
  }

  async get(id: string): Promise<CareCaseSummary> {
    this.assertScope('erp:care:case:read');
    const careCase = await this.requireCase(id);
    const source = await this.organization.getEmploymentForCare(careCase.employmentId);
    this.assertDepartmentRead(source.employee.departmentIds);
    return summary(careCase);
  }

  async getForMcp(id: string): Promise<CareMcpSummary> {
    const value = await this.get(id);
    return Object.freeze({
      id: value.id, employeeId: value.employeeId, employmentId: value.employmentId,
      lastWorkingDate: value.lastWorkingDate, accessDisableAt: value.accessDisableAt,
      status: value.status, tasks: value.tasks, version: value.version,
    });
  }

  /** 只接受校友门户/同意管理系统形成的不可变授权证明。 */
  async createAlumniConsent(
    careCaseId: string,
    key: string,
    input: CreateAlumniConsentDto,
  ): Promise<{ readonly consent: AlumniConsentSummary }> {
    this.assertScope('erp:care:alumni:consent:attest');
    const result = await this.run(async () => this.idempotency.execute(
      'care.alumni_consent.create', key, { careCaseId, ...input }, async (session) => {
        const careCase = await this.requireCase(careCaseId, session);
        if (careCase.status !== 'completed') throw new ConflictException({
          code: 'CARE_ALUMNI_CASE_INCOMPLETE', message: '离职案件未完成，不能建立校友授权',
        });
        const grantedAt = Date.parse(input.grantedAt);
        if (
          grantedAt < Date.parse(careCase.updatedAt) ||
          grantedAt > Date.now() + 5 * 60 * 1_000
        ) throw new ConflictException({
          code: 'CARE_CONSENT_TIME_INVALID', message: '校友授权时间早于离职完成或超前',
        });
        const source = await this.organization.getEmploymentForCare(careCase.employmentId);
        if (
          source.employment.terminationCareCaseId !== careCase.id ||
          source.employment.terminationEvidenceId === null
        ) throw new ConflictException({
          code: 'CARE_ALUMNI_TERMINATION_UNVERIFIED', message: '劳动关系终止证明不匹配',
        });
        const verified = await this.consentVerifier.verify({
          tenantId: this.context.getTenantRequired().tenantId,
          careCaseId, personId: source.employment.personId, ...input,
        });
        if (!verified.verified) throw new ConflictException({
          code: 'CARE_CONSENT_UNVERIFIED', message: '校友授权证据未通过受信任校验',
        });
        const consent = createAlumniConsent({
          id: createEventId(new Date(input.grantedAt)),
          tenantId: this.context.getTenantRequired().tenantId,
          personId: source.employment.personId, careCaseId, ...input,
          careCompletedVerified: true,
        });
        await this.alumni.insert(consent, session);
        await this.outbox.append(
          alumniConsentEvent(consent, 'care.alumni_consent.granted'), session,
        );
        return { consent: consentSummary(consent) };
      },
    ));
    await this.executionQueue.scheduleAlumniConsentExpiry(result.consent);
    return result;
  }

  async withdrawAlumniConsent(
    id: string,
    expectedVersion: number,
    key: string,
  ): Promise<{ readonly consent: AlumniConsentSummary }> {
    this.assertScope('erp:care:alumni:consent:withdraw');
    return this.run(async () => this.idempotency.execute(
      'care.alumni_consent.withdraw', key, { id, expectedVersion }, async (session) => {
        const current = await this.requireConsent(id, session);
        const consent = withdrawAlumniConsent(current, {
          tenantId: this.context.getTenantRequired().tenantId, expectedVersion,
        }, new Date());
        if (consent !== current) {
          await this.alumni.replace(consent, expectedVersion, session);
          await this.outbox.append(
            alumniConsentEvent(consent, 'care.alumni_consent.withdrawn'), session,
          );
        }
        return { consent: consentSummary(consent) };
      },
    ));
  }

  async expireAlumniConsent(
    id: string,
  ): Promise<{ readonly consent: AlumniConsentSummary }> {
    this.assertScope('erp:care:alumni:consent:expire');
    const snapshot = await this.requireConsent(id);
    if (snapshot.status !== 'active') return { consent: consentSummary(snapshot) };
    return this.run(async () =>
      this.idempotency.execute(
        'care.alumni_consent.expire', `care-consent-expiry-${id}`,
        { id, expectedVersion: snapshot.version }, async (databaseSession) => {
          const current = await this.requireConsent(id, databaseSession);
          if (current.status !== 'active') return { consent: consentSummary(current) };
          const consent = expireConsent(current, {
            tenantId: this.context.getTenantRequired().tenantId,
            expectedVersion: current.version,
          }, new Date());
          await this.alumni.replace(consent, current.version, databaseSession);
          await this.outbox.append(
            alumniConsentEvent(consent, 'care.alumni_consent.expired'), databaseSession,
          );
          return { consent: consentSummary(consent) };
        },
      ),
    );
  }

  /** 审批创建、提交与 Care 绑定均使用根幂等键派生，可跨崩溃恢复。 */
  async submit(
    id: string,
    expectedVersion: number,
    key: string,
  ): Promise<{ readonly careCase: CareCaseSummary }> {
    this.assertScope('erp:care:case:submit');
    const current = await this.requireCase(id);
    await this.assertCaseWrite(current);
    if (current.status === 'pending_approval' && current.approvalInstanceId !== null) {
      return this.linkApproval(id, expectedVersion, key, current.approvalInstanceId);
    }
    submitCareCaseForApproval(current, {
      tenantId: this.context.getTenantRequired().tenantId, expectedVersion,
      approvalInstanceId: '00000000000000000000000000',
    }, new Date());
    const created = await this.approvals.createInstance(deriveKey(key, 'approval-create'), {
      templateCode: APPROVAL_TEMPLATE,
      title: `离职审批：${current.id}`,
      formData: {
        care_case_id: current.id, employee_id: current.employeeId,
        employment_id: current.employmentId, separation_type: current.separationType,
        reason_code: current.reasonCode, last_working_date: current.lastWorkingDate,
        access_disable_at: current.accessDisableAt,
      },
    });
    const submitted = await this.approvals.submitInstance(
      created.instance.id, created.instance.version, deriveKey(key, 'approval-submit'),
    );
    if (submitted.instance.status !== 'running' && submitted.instance.status !== 'approved') {
      throw new ConflictException({
        code: 'CARE_APPROVAL_SUBMIT_INVALID', message: '离职审批未进入可处理状态',
      });
    }
    return this.linkApproval(id, expectedVersion, key, created.instance.id);
  }

  async syncApproval(
    id: string,
    expectedVersion: number,
    key: string,
  ): Promise<{ readonly careCase: CareCaseSummary }> {
    this.assertScope('erp:care:approval:sync');
    const current = await this.requireCase(id);
    if (current.status === 'approved' || current.status === 'cancelled') {
      if (current.approvalInstanceId === null) throw new Error('CARE_APPROVAL_REFERENCE_MISSING');
      return this.applyApproval(
        id, expectedVersion, key, current.approvalInstanceId,
        current.status === 'approved' ? 'approved' : 'rejected',
      );
    }
    if (current.status !== 'pending_approval' || current.approvalInstanceId === null) {
      throw new ConflictException({
        code: 'CARE_APPROVAL_SYNC_INVALID', message: '当前离职案件不可同步审批',
      });
    }
    const approval = await this.approvals.getInstanceStatusForCare(current.approvalInstanceId);
    if (approval.status !== 'approved' && approval.status !== 'rejected') throw new ConflictException({
      code: 'CARE_APPROVAL_NOT_TERMINAL', message: '审批尚未形成可信终态',
    });
    return this.applyApproval(id, expectedVersion, key, approval.id, approval.status);
  }

  async recordTaskEvidence(
    id: string,
    expectedVersion: number,
    key: string,
    taskCode: CareTaskCode,
    evidenceId: string,
  ): Promise<{ readonly careCase: CareCaseSummary }> {
    this.assertTaskScope(taskCode);
    return this.run(async () => this.idempotency.execute(
      'care.case.record_task_evidence', key,
      { id, expectedVersion, taskCode, evidenceId }, async (session) => {
        const current = await this.requireCase(id, session);
        const verified = await this.taskEvidenceVerifier.verify({
          tenantId: this.context.getTenantRequired().tenantId,
          careCaseId: current.id, employeeId: current.employeeId, taskCode, evidenceId,
        });
        if (!verified.verified) throw new ConflictException({
          code: 'CARE_TASK_EVIDENCE_UNVERIFIED', message: '清算证据未通过受信任校验',
        });
        const now = new Date();
        const result = recordCareTaskEvidence(current, {
          tenantId: this.context.getTenantRequired().tenantId, expectedVersion,
          taskCode, evidenceId, evidenceRecordId: createEventId(now),
          actorId: this.context.getActorRequired().actorId,
        }, now);
        if (result.evidence !== null) {
          await this.cases.replace(result.careCase, expectedVersion, session);
          await this.evidence.append(result.evidence, session);
          await this.outbox.append(careCaseEvent(
            result.careCase, 'care.case.task_completed', { taskCode },
          ), session);
        }
        return { careCase: summary(result.careCase) };
      },
    ));
  }

  async schedule(
    id: string,
    expectedVersion: number,
    key: string,
  ): Promise<{ readonly careCase: CareCaseSummary }> {
    this.assertScope('erp:care:case:schedule');
    await this.assertCaseWrite(await this.requireCase(id));
    const result = await this.run(async () => this.idempotency.execute(
      'care.case.schedule', key, { id, expectedVersion }, async (session) => {
        const current = await this.requireCase(id, session);
        const careCase = scheduleCareExecution(current, {
          tenantId: this.context.getTenantRequired().tenantId, expectedVersion,
        }, new Date());
        await this.cases.replace(careCase, expectedVersion, session);
        await this.outbox.append(careCaseEvent(careCase, 'care.case.scheduled'), session);
        return { careCase: summary(careCase) };
      },
    ));
    await this.executionQueue.schedule(result.careCase);
    return result;
  }

  /** 队列重试每次读取最新版本，支持 begin/Org/complete 任一步中断后的稳定续跑。 */
  async executeScheduledJob(
    id: string,
    key: string,
  ): Promise<{ readonly careCase: CareCaseSummary }> {
    this.assertScope('erp:care:execution:run');
    const current = await this.requireCase(id);
    if (!['scheduled', 'executing', 'completed'].includes(current.status)) {
      throw new ConflictException({
        code: 'CARE_EXECUTION_STATE_INVALID', message: '离职案件不在可执行或可恢复状态',
      });
    }
    return this.execute(id, current.version, key);
  }

  /** Worker 专用可恢复 Saga；R3 能力永不注册 MCP 或人工 REST。 */
  async execute(
    id: string,
    expectedVersion: number,
    key: string,
  ): Promise<{ readonly careCase: CareCaseSummary }> {
    this.assertScope('erp:care:execution:run');
    const snapshot = await this.requireCase(id);
    if (snapshot.version !== expectedVersion) throw new ConflictException({
      code: 'CARE_VERSION_CONFLICT', message: '离职案件版本冲突',
    });
    if (snapshot.status === 'completed') return { careCase: summary(snapshot) };
    const executing = snapshot.status === 'executing'
      ? snapshot
      : await this.beginExecution(id, expectedVersion, key);
    if (executing.executionEvidenceId === null) throw new Error('CARE_EXECUTION_EVIDENCE_MISSING');
    const termination = await this.organization.terminateEmploymentFromCare(
      deriveKey(key, 'org-termination'), {
        careCaseId: executing.id, employeeId: executing.employeeId,
        employmentId: executing.employmentId, effectiveTo: executing.lastWorkingDate,
        executionEvidenceId: executing.executionEvidenceId,
      },
    );
    return this.completeExecution(
      executing.id, executing.version, deriveKey(key, 'complete'),
      termination.terminationEvidenceId,
    );
  }

  private async beginExecution(
    id: string,
    expectedVersion: number,
    key: string,
  ): Promise<CareCase> {
    const result = await this.run(async () => this.idempotency.execute(
      'care.case.begin_execution', deriveKey(key, 'begin'), { id, expectedVersion },
      async (session) => {
        const current = await this.requireCase(id, session);
        const now = new Date();
        const careCase = beginCareExecution(current, {
          tenantId: this.context.getTenantRequired().tenantId, expectedVersion,
          executionEvidenceId: createEventId(now),
        }, now);
        await this.cases.replace(careCase, expectedVersion, session);
        await this.outbox.append(careCaseEvent(careCase, 'care.case.execution_started'), session);
        return { careCase };
      },
    ));
    return result.careCase;
  }

  private async completeExecution(
    id: string,
    expectedVersion: number,
    key: string,
    terminationEvidenceId: string,
  ): Promise<{ readonly careCase: CareCaseSummary }> {
    return this.run(async () => this.idempotency.execute(
      'care.case.complete_execution', key,
      { id, expectedVersion, terminationEvidenceId }, async (session) => {
        const current = await this.requireCase(id, session);
        const careCase = completeCareExecution(current, {
          tenantId: this.context.getTenantRequired().tenantId, expectedVersion,
          orgTerminationEvidenceId: terminationEvidenceId, orgTerminationVerified: true,
        }, new Date());
        await this.cases.replace(careCase, expectedVersion, session);
        await this.outbox.append(careCaseEvent(careCase, 'care.case.completed'), session);
        return { careCase: summary(careCase) };
      },
    ));
  }

  private async linkApproval(
    id: string,
    expectedVersion: number,
    key: string,
    approvalInstanceId: string,
  ): Promise<{ readonly careCase: CareCaseSummary }> {
    return this.run(async () => this.idempotency.execute(
      'care.case.link_approval', deriveKey(key, 'link'),
      { id, expectedVersion, approvalInstanceId }, async (session) => {
        const current = await this.requireCase(id, session);
        if (current.status === 'pending_approval') {
          if (
            current.approvalInstanceId !== approvalInstanceId ||
            current.version !== expectedVersion
          ) throw new ConflictException({
            code: 'CARE_APPROVAL_LINK_MISMATCH', message: '离职案件审批引用或版本不一致',
          });
          return { careCase: summary(current) };
        }
        const careCase = submitCareCaseForApproval(current, {
          tenantId: this.context.getTenantRequired().tenantId,
          expectedVersion, approvalInstanceId,
        }, new Date());
        await this.cases.replace(careCase, expectedVersion, session);
        await this.outbox.append(
          careCaseEvent(careCase, 'care.case.approval_submitted'), session,
        );
        return { careCase: summary(careCase) };
      },
    ));
  }

  private async applyApproval(
    id: string,
    expectedVersion: number,
    key: string,
    approvalInstanceId: string,
    outcome: 'approved' | 'rejected',
  ): Promise<{ readonly careCase: CareCaseSummary }> {
    return this.run(async () => this.idempotency.execute(
      'care.case.sync_approval', key,
      { id, expectedVersion, approvalInstanceId, outcome }, async (session) => {
        const current = await this.requireCase(id, session);
        const terminalMatches =
          (outcome === 'approved' && current.status === 'approved') ||
          (outcome === 'rejected' && current.status === 'cancelled');
        if (terminalMatches) {
          if (
            current.approvalInstanceId !== approvalInstanceId ||
            current.version !== expectedVersion
          ) throw new ConflictException({
            code: 'CARE_APPROVAL_RESULT_MISMATCH', message: '离职审批终态或版本不一致',
          });
          return { careCase: summary(current) };
        }
        const now = new Date();
        const careCase = outcome === 'approved'
          ? approveCareCase(current, {
              tenantId: this.context.getTenantRequired().tenantId,
              expectedVersion, approvalVerified: true,
            }, now)
          : rejectCareCase(current, {
              tenantId: this.context.getTenantRequired().tenantId,
              expectedVersion, rejectionVerified: true,
            }, now);
        await this.cases.replace(careCase, expectedVersion, session);
        await this.outbox.append(careCaseEvent(
          careCase, outcome === 'approved' ? 'care.case.approved' : 'care.case.rejected',
        ), session);
        return { careCase: summary(careCase) };
      },
    ));
  }

  private async requireCase(id: string, session?: Parameters<CareCaseRepository['findById']>[1]) {
    const careCase = await this.cases.findById(id, session);
    if (careCase === null) throw new NotFoundException({
      code: 'CARE_CASE_NOT_FOUND', message: '离职案件不存在',
    });
    return careCase;
  }

  private async requireConsent(
    id: string,
    session?: Parameters<CareAlumniConsentRepository['findById']>[1],
  ): Promise<AlumniConsent> {
    const consent = await this.alumni.findById(id, session);
    if (consent === null) throw new NotFoundException({
      code: 'CARE_ALUMNI_CONSENT_NOT_FOUND', message: '校友授权不存在',
    });
    return consent;
  }

  private assertTaskScope(taskCode: CareTaskCode): void {
    const scopes: Readonly<Record<CareTaskCode, string>> = {
      handover_accepted: 'erp:care:handover:attest',
      assets_cleared: 'erp:care:assets:attest',
      finance_cleared: 'erp:care:finance:attest',
      data_retention_confirmed: 'erp:care:retention:attest',
    };
    this.assertScope(scopes[taskCode]);
  }

  private assertScope(scope: string): void {
    if (!this.context.getActorRequired().scopes.includes(scope)) throw new ForbiddenException({
      code: 'CARE_SCOPE_REQUIRED', message: `缺少 ${scope}`,
    });
  }

  private assertDepartmentWrite(departmentIds: readonly string[]): void {
    const actor = this.context.getActorRequired();
    if (
      !actor.scopes.includes('erp:care:case:write_all') &&
      !departmentIds.some((id) => actor.departmentIds.includes(id))
    ) throw new ForbiddenException({ code: 'CARE_DATA_SCOPE_DENIED', message: '无权操作该员工离职案件' });
  }

  private assertDepartmentRead(departmentIds: readonly string[]): void {
    const actor = this.context.getActorRequired();
    if (
      !actor.scopes.includes('erp:care:case:read_all') &&
      !departmentIds.some((id) => actor.departmentIds.includes(id))
    ) throw new ForbiddenException({ code: 'CARE_DATA_SCOPE_DENIED', message: '无权读取该员工离职案件' });
  }

  private async assertCaseWrite(careCase: CareCase): Promise<void> {
    const source = await this.organization.getEmploymentForCare(careCase.employmentId);
    if (source.employee.id !== careCase.employeeId) throw new ConflictException({
      code: 'CARE_EMPLOYMENT_SOURCE_CHANGED', message: '离职案件组织来源已变化',
    });
    this.assertDepartmentWrite(source.employee.departmentIds);
  }

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); } catch (error) {
      if (error instanceof CareWriteConflictError) throw new ConflictException({
        code: 'CARE_VERSION_CONFLICT', message: error.message,
      });
      if (error instanceof CareDomainError) {
        if (error.code.includes('TENANT')) throw new ForbiddenException({ code: error.code, message: error.message });
        if (
          error.code.includes('VERSION') || error.code.includes('LOCKED') ||
          error.code.includes('IMMUTABLE') || error.code.includes('READY') ||
          error.code.includes('EARLY') || error.code.includes('TERMINAL') ||
          error.code.includes('UNVERIFIED')
        ) throw new ConflictException({ code: error.code, message: error.message });
        throw new BadRequestException({ code: error.code, message: error.message });
      }
      if (isDuplicateKeyError(error)) throw new ConflictException({
        code: 'CARE_UNIQUE_CONFLICT', message: '劳动关系已有进行中的离职案件或证据重复',
      });
      throw error;
    }
  }
}

function summary(careCase: CareCase): CareCaseSummary {
  return Object.freeze({
    id: careCase.id, employeeId: careCase.employeeId, employmentId: careCase.employmentId,
    separationType: careCase.separationType, reasonCode: careCase.reasonCode,
    lastWorkingDate: careCase.lastWorkingDate, accessDisableAt: careCase.accessDisableAt,
    status: careCase.status, approvalInstanceId: careCase.approvalInstanceId,
    tasks: careTaskStatuses(careCase), version: careCase.version,
  });
}

function consentSummary(consent: AlumniConsent): AlumniConsentSummary {
  return Object.freeze({
    id: consent.id, careCaseId: consent.careCaseId, purpose: consent.purpose,
    channels: consent.channels, grantedAt: consent.grantedAt, expiresAt: consent.expiresAt,
    status: consent.status, version: consent.version,
  });
}

function deriveKey(root: string, stage: string): string {
  const digest = createHash('sha256').update(JSON.stringify([root, stage]), 'utf8').digest('base64url');
  return `care:${digest}`;
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11_000;
}
