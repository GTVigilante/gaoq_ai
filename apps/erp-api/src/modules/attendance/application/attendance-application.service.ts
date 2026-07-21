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
import { AccessProfileRepository } from '../../identity/access-profile.repository.js';
import { EmployeeRepository } from '../../org/persistence/org.repositories.js';
import {
  AttendanceDomainError,
  closeAttendanceMonth,
  createAttendanceCorrection,
  createAttendanceSourceFact,
  type AttendanceMonthlySnapshot,
  type AttendanceSourceFact,
} from '../domain/index.js';
import { AttendanceDataCryptoService } from '../persistence/attendance-data-crypto.service.js';
import { AttendanceOutboxWriter } from '../persistence/attendance-outbox.writer.js';
import {
  AttendanceCorrectionRepository,
  AttendanceMonthlySnapshotRepository,
  AttendanceSourceFactRepository,
} from '../persistence/attendance.repositories.js';
import type {
  CloseAttendanceMonthDto,
  IngestAttendanceSourceFactDto,
  RegisterAttendanceCorrectionDto,
  RequestAttendanceCorrectionDto,
} from './attendance.dto.js';

export interface AttendanceFactSummary extends Record<string, unknown> {
  readonly id: string;
  readonly employeeId: string;
  readonly providerCode: string;
  readonly factType: AttendanceSourceFact['factType'];
  readonly businessDate: string;
}

export interface AttendanceCorrectionSummary extends Record<string, unknown> {
  readonly id: string;
  readonly employeeId: string;
  readonly sourceFactId: string;
  readonly businessDate: string;
  readonly approvalInstanceId: string;
}

export interface AttendanceCorrectionRequestSummary extends Record<string, unknown> {
  readonly approvalInstanceId: string;
  readonly approvalStatus: 'running' | 'approved';
  readonly approvalVersion: number;
  readonly sourceFactId: string;
  readonly employeeId: string;
  readonly businessDate: string;
}

export interface AttendanceMonthSummary extends Record<string, unknown> {
  readonly id: string;
  readonly employeeId: string;
  readonly month: string;
  readonly snapshotVersion: number;
  readonly rulesetVersion: string;
  readonly sourceCutoffAt: string;
  readonly workedMinutes: number;
  readonly leaveMinutes: number;
  readonly overtimeMinutes: number;
  readonly absentMinutes: number;
  readonly sourceFactCount: number;
  readonly correctionCount: number;
  readonly snapshotHash: string;
  readonly closedAt: string;
}

@Injectable()
export class AttendanceApplicationService {
  constructor(
    private readonly idempotency: IdempotencyService,
    private readonly context: TenantContextService,
    private readonly profiles: AccessProfileRepository,
    private readonly employees: EmployeeRepository,
    private readonly approvals: ApprovalApplicationService,
    private readonly crypto: AttendanceDataCryptoService,
    private readonly facts: AttendanceSourceFactRepository,
    private readonly corrections: AttendanceCorrectionRepository,
    private readonly snapshots: AttendanceMonthlySnapshotRepository,
    private readonly outbox: AttendanceOutboxWriter,
  ) {}

  /** 准备 MCP/REST 修订申请时只校验本人归属与是否已有生效修订，不产生写入。 */
  async validateCorrectionRequest(
    input: RequestAttendanceCorrectionDto,
  ): Promise<AttendanceFactSummary> {
    this.assertScope('erp:attendance:correction:request');
    const source = await this.requireOwnSourceFact(input.sourceFactId);
    if (await this.corrections.findBySourceFactId(source.id) !== null) {
      throw new ConflictException({
        code: 'ATTENDANCE_CORRECTION_ALREADY_EFFECTIVE', message: '该源事实已有生效修订',
      });
    }
    this.assertCorrectionPayload(source, input);
    return factSummary(source);
  }

  /** 创建并提交专用 Approval；Attendance 事件不包含原因或分钟明细。 */
  async requestCorrection(
    key: string,
    input: RequestAttendanceCorrectionDto,
  ): Promise<{ readonly request: AttendanceCorrectionRequestSummary }> {
    this.assertScope('erp:attendance:correction:request');
    this.assertScope('erp:approval:instance:submit');
    const source = await this.requireOwnSourceFact(input.sourceFactId);
    if (await this.corrections.findBySourceFactId(source.id) !== null) {
      throw new ConflictException({
        code: 'ATTENDANCE_CORRECTION_ALREADY_EFFECTIVE', message: '该源事实已有生效修订',
      });
    }
    this.assertCorrectionPayload(source, input);
    const created = await this.approvals.createInstance(deriveKey(key, 'approval-create'), {
      templateCode: 'attendance_correction',
      title: `考勤修订：${source.businessDate}`,
      formData: {
        source_fact_id: source.id,
        employee_id: source.employeeId,
        business_date: source.businessDate,
        worked_minutes: input.replacementImpact.workedMinutes,
        leave_minutes: input.replacementImpact.leaveMinutes,
        overtime_minutes: input.replacementImpact.overtimeMinutes,
        absent_minutes: input.replacementImpact.absentMinutes,
        reason_code: input.reasonCode,
      },
    });
    const submitted = await this.approvals.submitInstance(
      created.instance.id, created.instance.version, deriveKey(key, 'approval-submit'),
    );
    if (submitted.instance.status !== 'running' && submitted.instance.status !== 'approved') {
      throw new ConflictException({
        code: 'ATTENDANCE_CORRECTION_SUBMIT_INVALID', message: '考勤修订审批未进入可处理状态',
      });
    }
    const request = Object.freeze({
      approvalInstanceId: submitted.instance.id,
      approvalStatus: submitted.instance.status,
      approvalVersion: submitted.instance.version,
      sourceFactId: source.id,
      employeeId: source.employeeId,
      businessDate: source.businessDate,
    });
    return this.idempotency.execute(
      'attendance.correction.request_event', deriveKey(key, 'attendance-event'),
      { approvalInstanceId: request.approvalInstanceId, sourceFactId: source.id },
      async (session) => {
        await this.outbox.append({
          type: 'attendance.correction.requested', tenantId: source.tenantId,
          aggregateId: request.approvalInstanceId, version: 1,
          occurredAt: new Date().toISOString(), data: {
            employeeId: source.employeeId, sourceFactId: source.id,
            businessDate: source.businessDate,
            approvalInstanceId: request.approvalInstanceId,
          },
        }, session);
        return { request };
      },
    );
  }

  /** 只允许受信任服务/系统主体写入规范化事实；外部事件标识仅转为盲指纹。 */
  async ingest(
    key: string,
    input: IngestAttendanceSourceFactDto,
  ): Promise<{ readonly fact: AttendanceFactSummary }> {
    this.assertScope('erp:attendance:source:ingest');
    const actor = this.context.getActorRequired();
    if (actor.actorType !== 'service' && actor.actorType !== 'system_job') {
      throw new ForbiddenException({
        code: 'ATTENDANCE_SOURCE_ACTOR_DENIED', message: '考勤源事实只允许受信任服务主体写入',
      });
    }
    const tenantId = this.context.getTenantRequired().tenantId;
    const fingerprints = this.crypto.sourceEventFingerprints(
      tenantId, input.providerCode, input.externalEventId,
    );
    return this.run(async () => this.idempotency.execute(
      'attendance.source_fact.ingest', key, input, async (session) => {
        const existing = await this.facts.findByEventFingerprints(fingerprints, session);
        if (existing !== null) {
          if (
            existing.employeeId !== input.employeeId ||
            existing.providerCode !== input.providerCode || existing.factType !== input.factType
          ) throw new ConflictException({
            code: 'ATTENDANCE_SOURCE_EVENT_COLLISION', message: '外部事件已绑定到不同考勤事实',
          });
          return { fact: factSummary(existing) };
        }
        const employee = await this.employees.findById(input.employeeId, session);
        if (employee === null) throw new NotFoundException({
          code: 'ATTENDANCE_EMPLOYEE_NOT_FOUND', message: 'ERP 员工主数据不存在',
        });
        const now = new Date();
        const fact = createAttendanceSourceFact({
          id: createEventId(now), tenantId, employeeId: input.employeeId,
          providerCode: input.providerCode, factType: input.factType,
          occurredAt: normalizeInstant(input.occurredAt), timeZone: input.timeZone,
          impact: input.impact, sourceObservedAt: normalizeInstant(input.sourceObservedAt),
        }, now);
        await this.facts.insert(fact, fingerprints, session);
        await this.outbox.append({
          type: 'attendance.source_fact.ingested', tenantId, aggregateId: fact.id,
          version: 1, occurredAt: now.toISOString(), data: {
            employeeId: fact.employeeId, providerCode: fact.providerCode,
            factType: fact.factType, businessDate: fact.businessDate,
          },
        }, session);
        return { fact: factSummary(fact) };
      },
    ));
  }

  /** 只接纳 attendance_correction 专用审批的已通过终态；不信任客户端声称的员工或日期。 */
  async registerCorrection(
    key: string,
    input: RegisterAttendanceCorrectionDto,
  ): Promise<{ readonly correction: AttendanceCorrectionSummary }> {
    this.assertScope('erp:attendance:correction:attest');
    const approval = await this.approvals.getAttendanceCorrectionDecision(
      input.approvalInstanceId,
    );
    return this.run(async () => this.idempotency.execute(
      'attendance.correction.register', key, input, async (session) => {
        const source = await this.facts.findById(approval.sourceFactId, session);
        if (source === null) throw new NotFoundException({
          code: 'ATTENDANCE_SOURCE_FACT_NOT_FOUND', message: '考勤源事实不存在',
        });
        if (
          source.employeeId !== approval.employeeId ||
          source.businessDate !== approval.businessDate
        ) throw new ConflictException({
          code: 'ATTENDANCE_CORRECTION_APPROVAL_BINDING_MISMATCH',
          message: '考勤修订审批与源事实员工或业务日期不匹配',
        });
        const now = new Date();
        const correction = createAttendanceCorrection({
          id: createEventId(now), tenantId: this.context.getTenantRequired().tenantId,
          employeeId: source.employeeId, sourceFactId: source.id,
          businessDate: source.businessDate, replacementImpact: approval.replacementImpact,
          reasonCode: approval.reasonCode, approvalInstanceId: approval.id,
          approvalEvidenceId: approval.id, approvedAt: approval.completedAt,
        }, now);
        await this.corrections.insert(correction, session);
        await this.outbox.append({
          type: 'attendance.correction.approved', tenantId: correction.tenantId,
          aggregateId: correction.id, version: 1, occurredAt: now.toISOString(), data: {
            employeeId: correction.employeeId, sourceFactId: correction.sourceFactId,
            businessDate: correction.businessDate, approvalInstanceId: correction.approvalInstanceId,
          },
        }, session);
        return { correction: Object.freeze({
          id: correction.id, employeeId: correction.employeeId,
          sourceFactId: correction.sourceFactId, businessDate: correction.businessDate,
          approvalInstanceId: correction.approvalInstanceId,
        }) };
      },
    ));
  }

  /** 首次关账直接形成 v1；后续重开必须引用 attendance_month_reopen 审批。 */
  async closeMonth(
    key: string,
    input: CloseAttendanceMonthDto,
  ): Promise<{ readonly month: AttendanceMonthSummary }> {
    this.assertScope('erp:attendance:month:close');
    const employee = await this.employees.findById(input.employeeId);
    if (employee === null) throw new NotFoundException({
      code: 'ATTENDANCE_EMPLOYEE_NOT_FOUND', message: 'ERP 员工主数据不存在',
    });
    const current = await this.snapshots.findActive(input.employeeId, input.month);
    let supersessionEvidenceId: string | null = null;
    if (current !== null) {
      if (input.supersessionApprovalInstanceId === undefined) throw new ConflictException({
        code: 'ATTENDANCE_REOPEN_APPROVAL_REQUIRED', message: '已关账月份重开必须提供审批引用',
      });
      const approval = await this.approvals.getAttendanceMonthReopenDecision(
        input.supersessionApprovalInstanceId,
      );
      if (
        approval.employeeId !== input.employeeId || approval.month !== input.month ||
        approval.previousSnapshotId !== current.id
      ) throw new ConflictException({
        code: 'ATTENDANCE_REOPEN_APPROVAL_BINDING_MISMATCH',
        message: '月结重开审批与员工、月份或活动快照不匹配',
      });
      supersessionEvidenceId = approval.id;
    } else if (input.supersessionApprovalInstanceId !== undefined) {
      throw new BadRequestException({
        code: 'ATTENDANCE_INITIAL_CLOSE_APPROVAL_FORBIDDEN', message: '首次关账不得伪造重开审批链',
      });
    }
    return this.run(async () => this.idempotency.execute(
      'attendance.month.close', key, input, async (session) => {
        const active = await this.snapshots.findActive(input.employeeId, input.month, session);
        if (active?.id !== current?.id) throw new ConflictException({
          code: 'ATTENDANCE_MONTH_CHANGED', message: '考勤月结状态已变化，请重新读取',
        });
        const cutoffAt = new Date(normalizeInstant(input.sourceCutoffAt));
        const facts = await this.facts.findForMonth(
          input.employeeId, input.month, cutoffAt, session,
        );
        const corrections = await this.corrections.findForMonth(
          input.employeeId, input.month, cutoffAt, session,
        );
        const now = new Date();
        const snapshot = closeAttendanceMonth({
          id: createEventId(now), tenantId: this.context.getTenantRequired().tenantId,
          employeeId: input.employeeId, month: input.month,
          snapshotVersion: (active?.snapshotVersion ?? 0) + 1,
          rulesetVersion: input.rulesetVersion, sourceCutoffAt: cutoffAt.toISOString(),
          facts, corrections, previousSnapshotId: active?.id ?? null,
          supersessionEvidenceId,
        }, now);
        await this.snapshots.activate(snapshot, active, session);
        if (active !== null) await this.outbox.append({
          type: 'attendance.month.superseded', tenantId: snapshot.tenantId,
          aggregateId: active.id, version: active.snapshotVersion,
          occurredAt: now.toISOString(), data: {
            employeeId: snapshot.employeeId, month: snapshot.month,
            replacementSnapshotId: snapshot.id, supersessionEvidenceId,
          },
        }, session);
        await this.outbox.append({
          type: 'attendance.month.closed', tenantId: snapshot.tenantId,
          aggregateId: snapshot.id, version: snapshot.snapshotVersion,
          occurredAt: now.toISOString(), data: {
            employeeId: snapshot.employeeId, month: snapshot.month,
            snapshotVersion: snapshot.snapshotVersion, snapshotHash: snapshot.snapshotHash,
            rulesetVersion: snapshot.rulesetVersion,
          },
        }, session);
        return { month: monthSummary(snapshot) };
      },
    ));
  }

  async getMyMonth(month: string): Promise<AttendanceMonthSummary> {
    this.assertScope('erp:attendance:month:read_self');
    const trusted = this.context.getRequired();
    const profile = await this.profiles.resolveActive(trusted.tenant.tenantId, trusted.actor.actorId);
    if (profile === null) throw new ForbiddenException({
      code: 'ATTENDANCE_EMPLOYEE_IDENTITY_REQUIRED', message: '当前主体未绑定有效 ERP 员工身份',
    });
    const snapshot = await this.snapshots.findActive(profile.employeeId, month);
    if (snapshot === null) throw new NotFoundException({
      code: 'ATTENDANCE_MONTH_NOT_FOUND', message: '本人该月尚无有效考勤月结',
    });
    return monthSummary(snapshot);
  }

  private async requireOwnSourceFact(sourceFactId: string): Promise<AttendanceSourceFact> {
    const trusted = this.context.getRequired();
    const profile = await this.profiles.resolveActive(
      trusted.tenant.tenantId, trusted.actor.actorId,
    );
    if (profile === null) throw new ForbiddenException({
      code: 'ATTENDANCE_EMPLOYEE_IDENTITY_REQUIRED', message: '当前主体未绑定有效 ERP 员工身份',
    });
    const source = await this.facts.findById(sourceFactId);
    if (source === null) throw new NotFoundException({
      code: 'ATTENDANCE_SOURCE_FACT_NOT_FOUND', message: '考勤源事实不存在',
    });
    if (source.employeeId !== profile.employeeId) throw new ForbiddenException({
      code: 'ATTENDANCE_CORRECTION_SELF_ONLY', message: '只能为本人考勤事实发起修订',
    });
    return source;
  }

  private assertCorrectionPayload(
    source: AttendanceSourceFact,
    input: RequestAttendanceCorrectionDto,
  ): void {
    // 复用领域分钟与原因码约束，不依赖 Controller 或 MCP Schema 才保证安全。
    const now = new Date();
    createAttendanceCorrection({
      id: 'validation-only', tenantId: source.tenantId, employeeId: source.employeeId,
      sourceFactId: source.id, businessDate: source.businessDate,
      replacementImpact: input.replacementImpact, reasonCode: input.reasonCode,
      approvalInstanceId: 'validation-approval', approvalEvidenceId: 'validation-evidence',
      approvedAt: now.toISOString(),
    }, now);
  }

  private assertScope(scope: string): void {
    if (!this.context.getActorRequired().scopes.includes(scope)) throw new ForbiddenException({
      code: 'ATTENDANCE_SCOPE_REQUIRED', message: `缺少 ${scope}`,
    });
  }

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); } catch (error) {
      if (error instanceof AttendanceDomainError) {
        if (error.code.includes('TENANT') || error.code.includes('SCOPE')) {
          throw new ForbiddenException({ code: error.code, message: error.message });
        }
        if (
          error.code.includes('SUPERSESSION') || error.code.includes('DUPLICATE') ||
          error.code.includes('OUT_OF_SCOPE') || error.code.includes('CUTOFF')
        ) throw new ConflictException({ code: error.code, message: error.message });
        throw new BadRequestException({ code: error.code, message: error.message });
      }
      if (isDuplicateKeyError(error)) throw new ConflictException({
        code: 'ATTENDANCE_UNIQUE_CONFLICT', message: '考勤外部事件、修订审批或月结版本已存在',
      });
      if (error instanceof Error && error.message === 'ATTENDANCE_SNAPSHOT_WRITE_CONFLICT') {
        throw new ConflictException({ code: error.message, message: '考勤月结并发版本冲突' });
      }
      throw error;
    }
  }
}

function factSummary(fact: AttendanceSourceFact): AttendanceFactSummary {
  return Object.freeze({
    id: fact.id, employeeId: fact.employeeId, providerCode: fact.providerCode,
    factType: fact.factType, businessDate: fact.businessDate,
  });
}

function monthSummary(snapshot: AttendanceMonthlySnapshot): AttendanceMonthSummary {
  return Object.freeze({
    id: snapshot.id, employeeId: snapshot.employeeId, month: snapshot.month,
    snapshotVersion: snapshot.snapshotVersion, rulesetVersion: snapshot.rulesetVersion,
    sourceCutoffAt: snapshot.sourceCutoffAt, workedMinutes: snapshot.workedMinutes,
    leaveMinutes: snapshot.leaveMinutes, overtimeMinutes: snapshot.overtimeMinutes,
    absentMinutes: snapshot.absentMinutes, sourceFactCount: snapshot.sourceFactCount,
    correctionCount: snapshot.correctionCount, snapshotHash: snapshot.snapshotHash,
    closedAt: snapshot.closedAt,
  });
}

function normalizeInstant(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new BadRequestException({
    code: 'ATTENDANCE_INSTANT_INVALID', message: '考勤时间非法',
  });
  return parsed.toISOString();
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11_000;
}

function deriveKey(root: string, stage: string): string {
  const digest = createHash('sha256').update(JSON.stringify([root, stage]), 'utf8').digest('base64url');
  return `attendance:${digest}`;
}
