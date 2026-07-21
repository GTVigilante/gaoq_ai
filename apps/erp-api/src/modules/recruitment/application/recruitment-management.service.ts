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
  DepartmentRepository,
  JobLevelRepository,
} from '../../org/persistence/org.repositories.js';
import {
  applyRecruitmentApprovalOutcome,
  buildRecruitmentPositionEvent,
  buildRecruitmentRequisitionEvent,
  createRecruitmentPosition,
  createRecruitmentRequisition,
  RecruitmentDomainError,
  submitRecruitmentRequisition,
  transitionRecruitmentPosition,
  type RecruitmentPosition,
  type RecruitmentPositionStatus,
  type RecruitmentRequisition,
} from '../domain/index.js';
import { RecruitmentOutboxWriter } from '../persistence/recruitment-outbox.writer.js';
import {
  RecruitmentPositionRepository,
  RecruitmentRequisitionRepository,
  RecruitmentWriteConflictError,
} from '../persistence/recruitment.repositories.js';

const HC_APPROVAL_TEMPLATE_CODE = 'recruitment_hc';

export interface RecruitmentRequisitionSummary extends Record<string, unknown> {
  readonly id: string;
  readonly departmentId: string;
  readonly positionTitle: string;
  readonly headcount: number;
  readonly status: RecruitmentRequisition['status'];
  readonly approvalInstanceId: string | null;
  readonly version: number;
}

export interface RecruitmentPositionSummary extends Record<string, unknown> {
  readonly id: string;
  readonly requisitionId: string;
  readonly title: string;
  readonly departmentId: string;
  readonly jobLevelId: string;
  readonly location: string;
  readonly headcount: number;
  readonly status: RecruitmentPositionStatus;
  readonly version: number;
  readonly publishedAt: string | null;
  readonly closedAt: string | null;
}

/** HC 与职位编排服务；审批跨域调用使用可恢复 Saga，不开启嵌套 Mongo 事务。 */
@Injectable()
export class RecruitmentManagementService {
  constructor(
    private readonly idempotency: IdempotencyService,
    private readonly context: TenantContextService,
    private readonly approvals: ApprovalApplicationService,
    private readonly departments: DepartmentRepository,
    private readonly jobLevels: JobLevelRepository,
    private readonly requisitions: RecruitmentRequisitionRepository,
    private readonly positions: RecruitmentPositionRepository,
    private readonly outbox: RecruitmentOutboxWriter,
  ) {}

  async createRequisition(
    key: string,
    input: {
      readonly departmentId: string;
      readonly positionTitle: string;
      readonly headcount: number;
      readonly justification: string;
    },
  ): Promise<{ readonly requisition: RecruitmentRequisitionSummary }> {
    return this.run(async () => this.idempotency.execute(
      'recruitment.requisition.create', key, input, async (session) => {
        const trusted = this.context.getRequired();
        const department = await this.departments.findById(input.departmentId, session);
        if (department === null || department.status !== 'active') throw new BadRequestException({
          code: 'RECRUITMENT_DEPARTMENT_INACTIVE', message: '只能为有效 ERP 部门申请 HC',
        });
        this.assertDepartmentWrite(department.id);
        const requisition = createRecruitmentRequisition({
          id: createEventId(new Date()), tenantId: trusted.tenant.tenantId,
          actorId: trusted.actor.actorId, ...input,
        }, new Date());
        await this.requisitions.insert(requisition, session);
        await this.outbox.append(buildRecruitmentRequisitionEvent(requisition, 'created'), session);
        return { requisition: requisitionSummary(requisition) };
      },
    ));
  }

  /** 审批创建与提交各自幂等；崩溃后使用同一根键可继续并精确绑定原审批实例。 */
  async submitRequisition(
    id: string,
    expectedVersion: number,
    key: string,
  ): Promise<{ readonly requisition: RecruitmentRequisitionSummary }> {
    return this.run(async () => {
      const current = await this.requireRequisition(id);
      if (current.status === 'pending_approval' && current.approvalInstanceId !== null) {
        return this.linkApproval(id, expectedVersion, key, current.approvalInstanceId);
      }
      submitRecruitmentRequisition(current, {
        tenantId: this.context.getTenantRequired().tenantId,
        expectedVersion,
        actorId: this.context.getActorRequired().actorId,
        approvalInstanceId: '00000000000000000000000000',
      }, new Date());
      const created = await this.approvals.createInstance(deriveKey(key, 'approval-create'), {
        templateCode: HC_APPROVAL_TEMPLATE_CODE,
        title: `HC审批：${current.positionTitle}`,
        formData: {
          requisition_id: current.id,
          department_id: current.departmentId,
          position_title: current.positionTitle,
          headcount: current.headcount,
          justification: current.justification,
        },
      });
      const submitted = await this.approvals.submitInstance(
        created.instance.id,
        created.instance.version,
        deriveKey(key, 'approval-submit'),
      );
      if (submitted.instance.status !== 'running' && submitted.instance.status !== 'approved') {
        throw new ConflictException({
          code: 'RECRUITMENT_APPROVAL_SUBMIT_INVALID', message: 'HC 审批未进入可处理状态',
        });
      }
      return this.linkApproval(id, expectedVersion, key, created.instance.id);
    });
  }

  /** 仅从 Approval 应用服务同步终态，客户端不能上报审批结果。 */
  async syncRequisitionApproval(
    id: string,
    expectedVersion: number,
    key: string,
  ): Promise<{ readonly requisition: RecruitmentRequisitionSummary }> {
    return this.run(async () => {
      const current = await this.requireRequisition(id);
      if (current.status === 'approved' || current.status === 'rejected') {
        if (current.approvalInstanceId === null) throw new Error('RECRUITMENT_APPROVAL_REFERENCE_INVALID');
        return this.applyApproval(
          id, expectedVersion, key, current.approvalInstanceId, current.status,
        );
      }
      if (current.status !== 'pending_approval' || current.approvalInstanceId === null) {
        throw new ConflictException({
          code: 'RECRUITMENT_APPROVAL_SYNC_INVALID', message: '当前 HC 状态不可同步审批',
        });
      }
      const approval = await this.approvals.getInstanceStatusForRecruitment(
        current.approvalInstanceId,
      );
      if (approval.status !== 'approved' && approval.status !== 'rejected') {
        throw new ConflictException({
          code: 'RECRUITMENT_APPROVAL_NOT_TERMINAL', message: '审批尚未形成可信终态',
        });
      }
      if (approval.templateCode !== HC_APPROVAL_TEMPLATE_CODE) throw new ForbiddenException({
        code: 'RECRUITMENT_APPROVAL_TEMPLATE_MISMATCH', message: 'HC 审批模板引用不匹配',
      });
      return this.applyApproval(id, expectedVersion, key, approval.id, approval.status);
    });
  }

  async createPosition(
    requisitionId: string,
    expectedRequisitionVersion: number,
    key: string,
    input: { readonly jobLevelId: string; readonly location: string },
  ): Promise<{ readonly position: RecruitmentPositionSummary }> {
    return this.run(async () => this.idempotency.execute(
      'recruitment.position.create', key,
      { requisitionId, expectedRequisitionVersion, ...input },
      async (session) => {
        const requisition = await this.requireRequisition(requisitionId, session);
        if (requisition.version !== expectedRequisitionVersion) throw new RecruitmentDomainError(
          'RECRUITMENT_VERSION_CONFLICT', 'HC 需求版本冲突',
        );
        if (requisition.status !== 'approved') throw new ConflictException({
          code: 'RECRUITMENT_REQUISITION_NOT_APPROVED', message: 'HC 审批通过前不能创建职位',
        });
        const jobLevel = await this.jobLevels.findById(input.jobLevelId, session);
        if (jobLevel === null) throw new BadRequestException({
          code: 'RECRUITMENT_JOB_LEVEL_NOT_FOUND', message: '职级必须引用 ERP 组织主数据',
        });
        const department = await this.departments.findById(requisition.departmentId, session);
        if (department === null || department.status !== 'active') throw new ConflictException({
          code: 'RECRUITMENT_DEPARTMENT_INACTIVE', message: '部门已失效，不能创建职位',
        });
        this.assertDepartmentWrite(department.id);
        const now = new Date();
        const position = createRecruitmentPosition({
          id: createEventId(now), tenantId: requisition.tenantId,
          requisitionId: requisition.id, title: requisition.positionTitle,
          departmentId: requisition.departmentId, jobLevelId: jobLevel.id,
          location: input.location, headcount: requisition.headcount,
        }, now);
        await this.positions.insert(position, session);
        await this.outbox.append(buildRecruitmentPositionEvent(position, 'created'), session);
        return { position: positionSummary(position) };
      },
    ));
  }

  async transitionPosition(
    id: string,
    expectedVersion: number,
    key: string,
    targetStatus: Exclude<RecruitmentPositionStatus, 'draft'>,
  ): Promise<{ readonly position: RecruitmentPositionSummary }> {
    return this.run(async () => this.idempotency.execute(
      'recruitment.position.transition', key, { id, expectedVersion, targetStatus },
      async (session) => {
        const current = await this.requirePosition(id, session);
        this.assertDepartmentWrite(current.departmentId);
        const requisition = await this.requireRequisition(current.requisitionId, session);
        const position = transitionRecruitmentPosition(current, {
          tenantId: this.context.getTenantRequired().tenantId,
          expectedVersion,
          targetStatus,
          requisitionApproved: requisition.status === 'approved',
        }, new Date());
        await this.positions.replace(position, expectedVersion, session);
        await this.outbox.append(buildRecruitmentPositionEvent(position, 'status_changed'), session);
        return { position: positionSummary(position) };
      },
    ));
  }

  async getRequisition(id: string): Promise<RecruitmentRequisitionSummary> {
    const requisition = await this.requireRequisition(id);
    this.assertDepartmentRead(requisition.departmentId);
    return requisitionSummary(requisition);
  }

  async getPosition(id: string): Promise<RecruitmentPositionSummary> {
    const position = await this.requirePosition(id);
    this.assertDepartmentRead(position.departmentId);
    return positionSummary(position);
  }

  private async linkApproval(
    id: string,
    expectedVersion: number,
    key: string,
    approvalInstanceId: string,
  ): Promise<{ readonly requisition: RecruitmentRequisitionSummary }> {
    return this.idempotency.execute(
      'recruitment.requisition.submit', key,
      { id, expectedVersion, approvalInstanceId },
      async (session) => {
        const current = await this.requireRequisition(id, session);
        const requisition = submitRecruitmentRequisition(current, {
          tenantId: this.context.getTenantRequired().tenantId,
          expectedVersion,
          actorId: this.context.getActorRequired().actorId,
          approvalInstanceId,
        }, new Date());
        await this.requisitions.replace(requisition, expectedVersion, session);
        await this.outbox.append(buildRecruitmentRequisitionEvent(requisition, 'submitted'), session);
        return { requisition: requisitionSummary(requisition) };
      },
    );
  }

  private async applyApproval(
    id: string,
    expectedVersion: number,
    key: string,
    approvalInstanceId: string,
    outcome: 'approved' | 'rejected',
  ): Promise<{ readonly requisition: RecruitmentRequisitionSummary }> {
    return this.idempotency.execute(
      'recruitment.requisition.sync_approval', key,
      { id, expectedVersion, approvalInstanceId, outcome },
      async (session) => {
        const current = await this.requireRequisition(id, session);
        const requisition = applyRecruitmentApprovalOutcome(current, {
          tenantId: this.context.getTenantRequired().tenantId,
          expectedVersion,
          approvalInstanceId,
          outcome,
          approvalVerified: true,
        }, new Date());
        await this.requisitions.replace(requisition, expectedVersion, session);
        await this.outbox.append(buildRecruitmentRequisitionEvent(requisition, outcome), session);
        return { requisition: requisitionSummary(requisition) };
      },
    );
  }

  private async requireRequisition(
    id: string,
    session?: ClientSession,
  ): Promise<RecruitmentRequisition> {
    const requisition = await this.requisitions.findById(id, session);
    if (requisition === null) throw new NotFoundException({
      code: 'RECRUITMENT_REQUISITION_NOT_FOUND', message: 'HC 需求不存在',
    });
    return requisition;
  }

  private async requirePosition(id: string, session?: ClientSession): Promise<RecruitmentPosition> {
    const position = await this.positions.findById(id, session);
    if (position === null) throw new NotFoundException({
      code: 'RECRUITMENT_POSITION_NOT_FOUND', message: '招聘职位不存在',
    });
    return position;
  }

  private assertDepartmentRead(departmentId: string): void {
    const actor = this.context.getActorRequired();
    if (
      !actor.scopes.includes('erp:recruitment:management:read_all') &&
      !actor.departmentIds.includes(departmentId)
    ) throw new ForbiddenException({
      code: 'RECRUITMENT_MANAGEMENT_READ_DENIED', message: '无权读取该部门招聘资源',
    });
  }

  private assertDepartmentWrite(departmentId: string): void {
    const actor = this.context.getActorRequired();
    if (
      !actor.scopes.includes('erp:recruitment:management:write_all') &&
      !actor.departmentIds.includes(departmentId)
    ) throw new ForbiddenException({
      code: 'RECRUITMENT_MANAGEMENT_WRITE_DENIED', message: '无权修改该部门招聘资源',
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
          error.code.includes('NOT_APPROVED') || error.code.includes('TRANSITION_INVALID')
        ) throw new ConflictException({ code: error.code, message: error.message });
        throw new BadRequestException({ code: error.code, message: error.message });
      }
      if (isDuplicateKeyError(error)) throw new ConflictException({
        code: 'RECRUITMENT_UNIQUE_CONFLICT', message: '招聘资源违反租户内唯一约束',
      });
      throw error;
    }
  }
}

function deriveKey(root: string, stage: string): string {
  const digest = createHash('sha256').update(JSON.stringify([root, stage]), 'utf8').digest('base64url');
  return `recruitment:${digest}`;
}

function requisitionSummary(value: RecruitmentRequisition): RecruitmentRequisitionSummary {
  return Object.freeze({
    id: value.id, departmentId: value.departmentId, positionTitle: value.positionTitle,
    headcount: value.headcount, status: value.status,
    approvalInstanceId: value.approvalInstanceId, version: value.version,
  });
}

function positionSummary(value: RecruitmentPosition): RecruitmentPositionSummary {
  return Object.freeze({
    id: value.id, requisitionId: value.requisitionId, title: value.title,
    departmentId: value.departmentId, jobLevelId: value.jobLevelId,
    location: value.location, headcount: value.headcount, status: value.status,
    version: value.version, publishedAt: value.publishedAt, closedAt: value.closedAt,
  });
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11_000;
}
