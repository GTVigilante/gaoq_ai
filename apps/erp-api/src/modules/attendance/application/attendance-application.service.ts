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
import type { Employment } from '../../org/domain/employment.js';
import {
  EmployeeRepository,
  EmploymentRepository,
} from '../../org/persistence/org.repositories.js';
import {
  AttendanceDomainError,
  closeAttendanceMonth,
  createAttendanceCorrection,
  createAttendanceSourceFact,
  restoreAttendanceCorrectionFromMigration,
  restoreAttendanceMonthFromMigration,
  restoreAttendanceSourceFactFromMigration,
  shiftPlanRequiredThroughDate,
  type AttendanceCorrection,
  type AttendanceFactType,
  type AttendanceImpact,
  type AttendanceMonthlySnapshot,
  type AttendanceShiftPlan,
  type AttendanceSourceFact,
} from '../domain/index.js';
import { AttendanceDataCryptoService } from '../persistence/attendance-data-crypto.service.js';
import { AttendanceOutboxWriter } from '../persistence/attendance-outbox.writer.js';
import { AttendanceSourceReadinessRepository } from '../persistence/attendance-source-readiness.repository.js';
import {
  AttendanceCorrectionRepository,
  AttendanceMonthlySnapshotRepository,
  AttendanceShiftPlanRepository,
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
  readonly sourceProviderCount: number;
  readonly sourceWatermarkDigest: string;
  readonly workedMinutes: number;
  readonly leaveMinutes: number;
  readonly overtimeMinutes: number;
  readonly absentMinutes: number;
  readonly sourceFactCount: number;
  readonly correctionCount: number;
  readonly snapshotHash: string;
  readonly closedAt: string;
}

export interface ImportAttendanceSourceFactFromMigrationInput {
  readonly targetId: string | null;
  readonly employeeId: string;
  readonly providerCode: string;
  readonly externalEventId: string;
  readonly factType: AttendanceFactType;
  readonly occurredAt: string;
  readonly timeZone: string;
  readonly impact: AttendanceImpact;
  readonly sourceObservedAt: string;
  readonly createdAt: string;
  readonly migrationEvidenceRef: string;
  readonly evidenceChecksum: string;
}

export interface ImportAttendanceCorrectionFromMigrationInput {
  readonly targetId: string | null;
  readonly employeeId: string;
  readonly sourceFactId: string;
  readonly approvalHistoryId: string;
  readonly approvalEvidenceChecksum: string;
  readonly replacementImpact: AttendanceImpact;
  readonly reasonCode: string;
  readonly createdAt: string;
  readonly migrationEvidenceRef: string;
  readonly evidenceChecksum: string;
}

export interface ImportAttendanceMonthFromMigrationInput {
  readonly targetId: string | null;
  readonly employeeId: string;
  readonly month: string;
  readonly snapshotVersion: number;
  readonly rulesetVersion: string;
  readonly sourceCutoffAt: string;
  readonly closedAt: string;
  readonly previousSnapshotId: string | null;
  readonly supersessionApprovalHistoryId: string | null;
  readonly supersessionApprovalEvidenceChecksum: string | null;
  readonly expectedImpact: AttendanceImpact;
  readonly expectedSourceFactCount: number;
  readonly expectedCorrectionCount: number;
  readonly migrationEvidenceRef: string;
  readonly evidenceChecksum: string;
}

@Injectable()
export class AttendanceApplicationService {
  constructor(
    private readonly idempotency: IdempotencyService,
    private readonly context: TenantContextService,
    private readonly profiles: AccessProfileRepository,
    private readonly employees: EmployeeRepository,
    private readonly employments: EmploymentRepository,
    private readonly approvals: ApprovalApplicationService,
    private readonly crypto: AttendanceDataCryptoService,
    private readonly facts: AttendanceSourceFactRepository,
    private readonly corrections: AttendanceCorrectionRepository,
    private readonly snapshots: AttendanceMonthlySnapshotRepository,
    private readonly shiftPlans: AttendanceShiftPlanRepository,
    private readonly sourceReadiness: AttendanceSourceReadinessRepository,
    private readonly outbox: AttendanceOutboxWriter,
  ) {}

  /** 数据迁移专用：L4 明细只进入既有密文仓储，外部标识只形成盲索引。 */
  async importSourceFactFromMigration(
    key: string,
    input: ImportAttendanceSourceFactFromMigrationInput,
  ): Promise<{ readonly fact: AttendanceFactSummary & { readonly version: 1 } }> {
    this.assertMigrationWriter();
    assertMigrationEvidence(input.migrationEvidenceRef, input.evidenceChecksum);
    return this.run(async () => this.idempotency.execute(
      'attendance.source_fact.import_from_migration', key, input, async (session) => {
        const tenantId = this.context.getTenantRequired().tenantId;
        const employee = await this.employees.findById(input.employeeId, session);
        if (employee === null) throw new NotFoundException({
          code: 'ATTENDANCE_MIGRATION_EMPLOYEE_NOT_FOUND', message: '考勤迁移员工主数据不存在',
        });
        const fingerprints = this.crypto.sourceEventFingerprints(
          tenantId, input.providerCode, input.externalEventId,
        );
        const collision = await this.facts.findByEventFingerprints(fingerprints, session);
        const id = input.targetId ?? createEventId(new Date(input.createdAt));
        const fact = restoreAttendanceSourceFactFromMigration({
          id, tenantId, employeeId: employee.id, providerCode: input.providerCode,
          factType: input.factType, occurredAt: input.occurredAt, timeZone: input.timeZone,
          impact: input.impact, sourceObservedAt: input.sourceObservedAt,
          createdAt: input.createdAt,
        }, new Date());
        if (input.targetId !== null) {
          const [existing, evidence] = await Promise.all([
            this.facts.findById(input.targetId, session),
            this.facts.findMigrationEvidenceById(input.targetId, session),
          ]);
          if (existing === null || evidence === null || collision?.id !== input.targetId ||
            !sameMigratedSourceFact(existing, fact) ||
            evidence.migrationEvidenceRef !== input.migrationEvidenceRef ||
            evidence.migrationEvidenceChecksum !== input.evidenceChecksum) {
            throw new ConflictException({
              code: 'ATTENDANCE_MIGRATION_SOURCE_FACT_IMMUTABLE',
              message: '既有考勤源事实、外部标识或 WORM 证据不一致，禁止覆盖',
            });
          }
          return { fact: migratedFactSummary(existing) };
        }
        if (collision !== null) throw new ConflictException({
          code: 'ATTENDANCE_MIGRATION_SOURCE_EVENT_CONFLICT',
          message: '迁移外部事件已绑定既有考勤事实',
        });
        await this.facts.insertMigrated(
          fact, fingerprints, input.migrationEvidenceRef, input.evidenceChecksum, session,
        );
        await this.outbox.append({
          type: 'attendance.source_fact.migrated', tenantId, aggregateId: fact.id,
          version: 1, occurredAt: fact.createdAt, data: {
            employeeId: fact.employeeId, providerCode: fact.providerCode,
            factType: fact.factType, businessDate: fact.businessDate,
          },
        }, session);
        return { fact: migratedFactSummary(fact) };
      },
    ));
  }

  /** 数据迁移专用：只恢复已批准修订，不创建审批、不覆盖源事实。 */
  async importCorrectionFromMigration(
    key: string,
    input: ImportAttendanceCorrectionFromMigrationInput,
  ): Promise<{
    readonly correction: Readonly<{
      id: string;
      employeeId: string;
      sourceFactId: string;
      businessDate: string;
      approvalReferenceType: 'legacy_history';
      approvalReferenceId: string;
      version: 1;
    }>;
  }> {
    this.assertMigrationWriter();
    assertMigrationEvidence(input.migrationEvidenceRef, input.evidenceChecksum);
    if (!HASH_PATTERN.test(input.approvalEvidenceChecksum)) {
      throw new BadRequestException({
        code: 'ATTENDANCE_MIGRATION_APPROVAL_EVIDENCE_INVALID',
        message: '考勤修订审批证据校验和无效',
      });
    }
    return this.run(async () => this.idempotency.execute(
      'attendance.correction.import_from_migration', key, input, async (session) => {
        const tenantId = this.context.getTenantRequired().tenantId;
        const [source, employee, approval] = await Promise.all([
          this.facts.findById(input.sourceFactId, session),
          this.employees.findById(input.employeeId, session),
          this.approvals.verifyAttendanceCorrectionMigrationReference(
            input.approvalHistoryId, session,
          ),
        ]);
        if (source === null) throw new NotFoundException({
          code: 'ATTENDANCE_MIGRATION_SOURCE_FACT_NOT_FOUND',
          message: '考勤修订引用的源事实不存在',
        });
        if (employee === null || employee.id !== source.employeeId) {
          throw new ConflictException({
            code: 'ATTENDANCE_MIGRATION_CORRECTION_EMPLOYEE_MISMATCH',
            message: '考勤修订员工映射与源事实不一致',
          });
        }
        if (approval.id !== input.approvalHistoryId ||
          approval.evidenceChecksum !== input.approvalEvidenceChecksum) {
          throw new ConflictException({
            code: 'ATTENDANCE_MIGRATION_CORRECTION_APPROVAL_MISMATCH',
            message: '考勤修订审批历史或证据摘要不一致',
          });
        }
        const id = input.targetId ?? createEventId(new Date(input.createdAt));
        const correction = restoreAttendanceCorrectionFromMigration({
          id, tenantId, employeeId: source.employeeId, sourceFactId: source.id,
          businessDate: source.businessDate, replacementImpact: input.replacementImpact,
          reasonCode: input.reasonCode, approvalReferenceType: 'legacy_history',
          approvalInstanceId: null, approvalHistoryId: approval.id,
          approvalEvidenceId: approval.id, approvedAt: approval.completedAt,
          createdAt: input.createdAt,
        }, new Date());
        if (Date.parse(source.createdAt) > Date.parse(correction.approvedAt)) {
          throw new ConflictException({
            code: 'ATTENDANCE_MIGRATION_CORRECTION_TIMELINE_INVALID',
            message: '考勤修订批准时间不得早于源事实落库时间',
          });
        }
        const collision = await this.corrections.findBySourceFactId(source.id, session);
        if (input.targetId !== null) {
          const [existing, evidence] = await Promise.all([
            this.corrections.findById(input.targetId, session),
            this.corrections.findMigrationEvidenceById(input.targetId, session),
          ]);
          if (existing === null || evidence === null || collision?.id !== input.targetId ||
            !sameMigratedCorrection(existing, correction) ||
            evidence.migrationEvidenceRef !== input.migrationEvidenceRef ||
            evidence.migrationEvidenceChecksum !== input.evidenceChecksum) {
            throw new ConflictException({
              code: 'ATTENDANCE_MIGRATION_CORRECTION_IMMUTABLE',
              message: '既有考勤修订、审批或 WORM 证据不一致，禁止覆盖',
            });
          }
          return { correction: migratedCorrectionSummary(existing) };
        }
        if (collision !== null) throw new ConflictException({
          code: 'ATTENDANCE_MIGRATION_CORRECTION_SOURCE_CONFLICT',
          message: '考勤源事实已绑定既有修订',
        });
        await this.corrections.insertMigrated(
          correction, input.migrationEvidenceRef, input.evidenceChecksum, session,
        );
        await this.outbox.append({
          type: 'attendance.correction.migrated', tenantId,
          aggregateId: correction.id, version: 1, occurredAt: correction.createdAt,
          data: {
            employeeId: correction.employeeId, sourceFactId: correction.sourceFactId,
            businessDate: correction.businessDate, approvalHistoryId: correction.approvalHistoryId,
          },
        }, session);
        return { correction: migratedCorrectionSummary(correction) };
      },
    ));
  }

  /** 数据迁移专用：从已恢复事实与修订重算月结，来源汇总只作为控制总量。 */
  async importMonthFromMigration(
    key: string,
    input: ImportAttendanceMonthFromMigrationInput,
  ): Promise<{ readonly month: AttendanceMonthSummary & { readonly version: number } }> {
    this.assertMigrationWriter();
    assertMigrationEvidence(input.migrationEvidenceRef, input.evidenceChecksum);
    const sourceCutoffAt = strictMigrationInputInstant(input.sourceCutoffAt);
    const closedAt = strictMigrationInputInstant(input.closedAt);
    return this.run(async () => this.idempotency.execute(
      'attendance.month.import_from_migration', key, input, async (session) => {
        const tenantId = this.context.getTenantRequired().tenantId;
        const employee = await this.employees.findById(input.employeeId, session);
        if (employee === null) throw new NotFoundException({
          code: 'ATTENDANCE_MIGRATION_EMPLOYEE_NOT_FOUND', message: '考勤月结员工主数据不存在',
        });
        let previous: AttendanceMonthlySnapshot | null = null;
        let supersessionEvidenceId: string | null = null;
        if (input.snapshotVersion === 1) {
          if (input.previousSnapshotId !== null ||
            input.supersessionApprovalHistoryId !== null ||
            input.supersessionApprovalEvidenceChecksum !== null) {
            throw invalidMigratedMonthChain();
          }
        } else {
          if (input.previousSnapshotId === null ||
            input.supersessionApprovalHistoryId === null ||
            input.supersessionApprovalEvidenceChecksum === null ||
            !HASH_PATTERN.test(input.supersessionApprovalEvidenceChecksum)) {
            throw invalidMigratedMonthChain();
          }
          const [resolvedPrevious, approval] = await Promise.all([
            this.snapshots.findById(input.previousSnapshotId, session),
            this.approvals.verifyAttendanceMonthReopenMigrationReference(
              input.supersessionApprovalHistoryId, session,
            ),
          ]);
          if (resolvedPrevious === null || resolvedPrevious.employeeId !== input.employeeId ||
            resolvedPrevious.month !== input.month ||
            resolvedPrevious.snapshotVersion !== input.snapshotVersion - 1 ||
            approval.id !== input.supersessionApprovalHistoryId ||
            approval.evidenceChecksum !== input.supersessionApprovalEvidenceChecksum ||
            Date.parse(approval.completedAt) < Date.parse(resolvedPrevious.closedAt) ||
            Date.parse(approval.completedAt) > closedAt.getTime() ||
            Date.parse(input.sourceCutoffAt) < Date.parse(resolvedPrevious.sourceCutoffAt) ||
            closedAt.getTime() < Date.parse(resolvedPrevious.closedAt)) {
            throw invalidMigratedMonthChain();
          }
          previous = resolvedPrevious;
          supersessionEvidenceId = approval.id;
        }
        const cutoffAt = sourceCutoffAt;
        const [facts, corrections, active] = await Promise.all([
          this.facts.findForMonth(input.employeeId, input.month, cutoffAt, session),
          this.corrections.findForMonth(input.employeeId, input.month, cutoffAt, session),
          this.snapshots.findActive(input.employeeId, input.month, session),
        ]);
        const employments = await this.employments.findOverlappingByEmployeeIds(
          [input.employeeId],
          `${input.month}-01`,
          endOfMonth(input.month),
          session,
        );
        assertEmploymentCoverage(input.employeeId, input.month, facts, employments);
        const id = input.targetId ?? createEventId(closedAt);
        const snapshot = restoreAttendanceMonthFromMigration({
          id, tenantId, employeeId: input.employeeId, month: input.month,
          snapshotVersion: input.snapshotVersion, rulesetVersion: input.rulesetVersion,
          sourceCutoffAt: input.sourceCutoffAt, facts, corrections,
          previousSnapshotId: previous?.id ?? null, supersessionEvidenceId,
          closedAt: input.closedAt,
        }, new Date());
        assertMigratedMonthControls(snapshot, input);
        if (input.targetId !== null) {
          const [existing, evidence] = await Promise.all([
            this.snapshots.findById(input.targetId, session),
            this.snapshots.findMigrationEvidenceById(input.targetId, session),
          ]);
          if (existing === null || evidence === null ||
            !sameMigratedMonth(existing, snapshot) ||
            evidence.migrationEvidenceRef !== input.migrationEvidenceRef ||
            evidence.migrationEvidenceChecksum !== input.evidenceChecksum) {
            throw new ConflictException({
              code: 'ATTENDANCE_MIGRATION_MONTH_IMMUTABLE',
              message: '既有考勤月结、重开审批或 WORM 证据不一致，禁止覆盖',
            });
          }
          return { month: migratedMonthSummary(existing) };
        }
        if ((previous === null && active !== null) ||
          (previous !== null && active?.id !== previous.id)) {
          throw new ConflictException({
            code: 'ATTENDANCE_MIGRATION_MONTH_CHAIN_CONFLICT',
            message: '考勤月结活动版本与迁移版本链不一致',
          });
        }
        await this.snapshots.activateMigrated(
          snapshot, previous, input.migrationEvidenceRef, input.evidenceChecksum, session,
        );
        await this.outbox.append({
          type: 'attendance.month.migrated', tenantId, aggregateId: snapshot.id,
          version: snapshot.snapshotVersion, occurredAt: snapshot.closedAt, data: {
            employeeId: snapshot.employeeId, month: snapshot.month,
            snapshotVersion: snapshot.snapshotVersion, snapshotHash: snapshot.snapshotHash,
            rulesetVersion: snapshot.rulesetVersion,
          },
        }, session);
        return { month: migratedMonthSummary(snapshot) };
      },
    ));
  }

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
          reasonCode: approval.reasonCode, approvalReferenceType: 'approval_instance',
          approvalInstanceId: approval.id, approvalHistoryId: null,
          approvalEvidenceId: approval.id, approvedAt: approval.completedAt,
        }, now);
        await this.corrections.insert(correction, session);
        await this.outbox.append({
          type: 'attendance.correction.approved', tenantId: correction.tenantId,
          aggregateId: correction.id, version: 1, occurredAt: now.toISOString(), data: {
            employeeId: correction.employeeId, sourceFactId: correction.sourceFactId,
            businessDate: correction.businessDate, approvalInstanceId: approval.id,
          },
        }, session);
        return { correction: Object.freeze({
          id: correction.id, employeeId: correction.employeeId,
          sourceFactId: correction.sourceFactId, businessDate: correction.businessDate,
          approvalInstanceId: approval.id,
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
        const [facts, corrections, employments, shiftPlans] = await Promise.all([
          this.facts.findForMonth(input.employeeId, input.month, cutoffAt, session),
          this.corrections.findForMonth(input.employeeId, input.month, cutoffAt, session),
          this.employments.findOverlappingByEmployeeIds(
            [input.employeeId],
            `${input.month}-01`,
            endOfMonth(input.month),
            session,
          ),
          this.shiftPlans.findForMonth(input.employeeId, input.month, cutoffAt, session),
        ]);
        assertEmploymentCoverage(input.employeeId, input.month, facts, employments);
        assertShiftPlanReadiness(input.rulesetVersion, facts, shiftPlans, employments);
        const requiredThroughDate = shiftPlans.reduce((value, plan) => {
          const planThroughDate = shiftPlanRequiredThroughDate(plan);
          return planThroughDate > value ? planThroughDate : value;
        }, endOfMonth(input.month));
        const sourceWatermarks = await this.sourceReadiness.reconcile(
          input.employeeId,
          input.month,
          cutoffAt,
          session,
          requiredThroughDate,
        );
        const now = new Date();
        const snapshot = closeAttendanceMonth({
          id: createEventId(now), tenantId: this.context.getTenantRequired().tenantId,
          employeeId: input.employeeId, month: input.month,
          snapshotVersion: (active?.snapshotVersion ?? 0) + 1,
          rulesetVersion: input.rulesetVersion, sourceCutoffAt: cutoffAt.toISOString(),
          sourceWatermarks, facts, corrections, previousSnapshotId: active?.id ?? null,
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
      approvalReferenceType: 'approval_instance', approvalInstanceId: 'validation-approval',
      approvalHistoryId: null, approvalEvidenceId: 'validation-approval',
      approvedAt: now.toISOString(),
    }, now);
  }

  private assertScope(scope: string): void {
    if (!this.context.getActorRequired().scopes.includes(scope)) throw new ForbiddenException({
      code: 'ATTENDANCE_SCOPE_REQUIRED', message: `缺少 ${scope}`,
    });
  }

  private assertMigrationWriter(): void {
    const actor = this.context.getActorRequired();
    if (!['service', 'system_job'].includes(actor.actorType) ||
      !actor.scopes.includes('erp:migration:execute') ||
      !actor.scopes.includes('erp:attendance:migration:write')) {
      throw new ForbiddenException({
        code: 'ATTENDANCE_MIGRATION_WRITER_DENIED',
        message: '考勤迁移必须由受信任服务身份执行',
      });
    }
  }

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); } catch (error) {
      if (error instanceof AttendanceDomainError) {
        if (error.code.includes('TENANT') || error.code.includes('SCOPE')) {
          throw new ForbiddenException({ code: error.code, message: error.message });
        }
        if (
          error.code.includes('SUPERSESSION') || error.code.includes('DUPLICATE') ||
          error.code.includes('OUT_OF_SCOPE') || error.code.includes('CUTOFF') ||
          error.code.includes('SOURCE_NOT_READY')
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

function migratedFactSummary(
  fact: AttendanceSourceFact,
): AttendanceFactSummary & { readonly version: 1 } {
  return Object.freeze({ ...factSummary(fact), version: 1 as const });
}

function migratedCorrectionSummary(
  correction: AttendanceCorrection,
): Readonly<{
  id: string;
  employeeId: string;
  sourceFactId: string;
  businessDate: string;
  approvalReferenceType: 'legacy_history';
  approvalReferenceId: string;
  version: 1;
}> {
  if (correction.approvalReferenceType !== 'legacy_history' ||
    correction.approvalHistoryId === null) throw new Error('迁移考勤修订缺少历史审批引用');
  return Object.freeze({
    id: correction.id, employeeId: correction.employeeId,
    sourceFactId: correction.sourceFactId, businessDate: correction.businessDate,
    approvalReferenceType: 'legacy_history', approvalReferenceId: correction.approvalHistoryId,
    version: 1 as const,
  });
}

function monthSummary(snapshot: AttendanceMonthlySnapshot): AttendanceMonthSummary {
  return Object.freeze({
    id: snapshot.id, employeeId: snapshot.employeeId, month: snapshot.month,
    snapshotVersion: snapshot.snapshotVersion, rulesetVersion: snapshot.rulesetVersion,
    sourceCutoffAt: snapshot.sourceCutoffAt, workedMinutes: snapshot.workedMinutes,
    sourceProviderCount: snapshot.sourceProviderCount,
    sourceWatermarkDigest: snapshot.sourceWatermarkDigest,
    leaveMinutes: snapshot.leaveMinutes, overtimeMinutes: snapshot.overtimeMinutes,
    absentMinutes: snapshot.absentMinutes, sourceFactCount: snapshot.sourceFactCount,
    correctionCount: snapshot.correctionCount, snapshotHash: snapshot.snapshotHash,
    closedAt: snapshot.closedAt,
  });
}

function migratedMonthSummary(
  snapshot: AttendanceMonthlySnapshot,
): AttendanceMonthSummary & { readonly version: number } {
  return Object.freeze({ ...monthSummary(snapshot), version: snapshot.snapshotVersion });
}

function normalizeInstant(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new BadRequestException({
    code: 'ATTENDANCE_INSTANT_INVALID', message: '考勤时间非法',
  });
  return parsed.toISOString();
}

function endOfMonth(month: string): string {
  const [yearText, monthText] = month.split('-');
  const year = Number(yearText);
  const monthIndex = Number(monthText);
  return new Date(Date.UTC(year, monthIndex, 0)).toISOString().slice(0, 10);
}

function assertEmploymentCoverage(
  employeeId: string,
  month: string,
  facts: readonly AttendanceSourceFact[],
  employments: readonly Employment[],
): void {
  if (employments.length === 0) throw new ConflictException({
    code: 'ATTENDANCE_EMPLOYMENT_NOT_EFFECTIVE',
    message: '员工在关账月份没有有效劳动关系',
  });
  for (const fact of facts) {
    const covered = employments.some((employment) =>
      employment.employeeId === employeeId &&
      employment.effectiveFrom <= fact.businessDate &&
      (employment.effectiveTo === null || employment.effectiveTo >= fact.businessDate));
    if (!covered) throw new ConflictException({
      code: 'ATTENDANCE_FACT_OUTSIDE_EMPLOYMENT',
      message: `考勤事实 ${fact.id} 不在员工劳动关系有效区间内`,
    });
  }
  const monthStart = `${month}-01`;
  const monthEnd = endOfMonth(month);
  if (!employments.some((employment) =>
    employment.effectiveFrom <= monthEnd &&
    (employment.effectiveTo === null || employment.effectiveTo >= monthStart))) {
    throw new ConflictException({
      code: 'ATTENDANCE_EMPLOYMENT_NOT_EFFECTIVE',
      message: '员工劳动关系未覆盖关账月份',
    });
  }
}

function assertShiftPlanReadiness(
  rulesetVersion: string,
  facts: readonly AttendanceSourceFact[],
  plans: readonly AttendanceShiftPlan[],
  employments: readonly Employment[],
): void {
  const planById = new Map(plans.map((plan) => [plan.id, plan]));
  for (const plan of plans) {
    if (plan.rulesetVersion !== rulesetVersion) throw new ConflictException({
      code: 'ATTENDANCE_SHIFT_RULESET_MISMATCH',
      message: `班次 ${plan.id} 的规则版本与月结规则版本不一致`,
    });
    if (!employments.some((employment) =>
      employment.employeeId === plan.employeeId &&
      employment.effectiveFrom <= plan.businessDate &&
      (employment.effectiveTo === null || employment.effectiveTo >= plan.businessDate))) {
      throw new ConflictException({
        code: 'ATTENDANCE_SHIFT_OUTSIDE_EMPLOYMENT',
        message: `班次 ${plan.id} 不在员工劳动关系有效区间内`,
      });
    }
  }
  const derivedByPlan = new Map<string, AttendanceSourceFact>();
  for (const fact of facts) {
    if (fact.shiftPlanId === undefined || fact.shiftPlanId === null) continue;
    const plan = planById.get(fact.shiftPlanId);
    if (plan === undefined || fact.factType !== 'shift' ||
      fact.providerCode !== 'attendance_rules' ||
      fact.businessDate !== plan.businessDate) {
      throw new ConflictException({
        code: 'ATTENDANCE_SHIFT_DERIVATION_INVALID',
        message: `班次派生事实 ${fact.id} 与计划绑定不一致`,
      });
    }
    if (derivedByPlan.has(plan.id)) throw new ConflictException({
      code: 'ATTENDANCE_SHIFT_DERIVATION_DUPLICATE',
      message: `班次 ${plan.id} 存在多个派生事实`,
    });
    derivedByPlan.set(plan.id, fact);
  }
  for (const plan of plans) {
    if (!derivedByPlan.has(plan.id)) throw new ConflictException({
      code: 'ATTENDANCE_SHIFT_EVALUATION_REQUIRED',
      message: `班次 ${plan.id} 尚未完成规则计算`,
    });
  }
  if (facts.some((fact) =>
    (fact.factType === 'punch_in' || fact.factType === 'punch_out')) &&
    plans.length === 0) {
    throw new ConflictException({
      code: 'ATTENDANCE_SHIFT_PLAN_REQUIRED',
      message: '存在 Provider 打卡但没有版本化班次计划',
    });
  }
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11_000;
}

function deriveKey(root: string, stage: string): string {
  const digest = createHash('sha256').update(JSON.stringify([root, stage]), 'utf8').digest('base64url');
  return `attendance:${digest}`;
}

function sameMigratedSourceFact(
  left: AttendanceSourceFact,
  right: AttendanceSourceFact,
): boolean {
  return left.id === right.id && left.tenantId === right.tenantId &&
    left.employeeId === right.employeeId && left.providerCode === right.providerCode &&
    left.factType === right.factType && left.occurredAt === right.occurredAt &&
    left.timeZone === right.timeZone && left.businessDate === right.businessDate &&
    JSON.stringify(left.impact) === JSON.stringify(right.impact) &&
    left.sourceObservedAt === right.sourceObservedAt && left.createdAt === right.createdAt;
}

function sameMigratedCorrection(
  left: AttendanceCorrection,
  right: AttendanceCorrection,
): boolean {
  return left.id === right.id && left.tenantId === right.tenantId &&
    left.employeeId === right.employeeId && left.sourceFactId === right.sourceFactId &&
    left.businessDate === right.businessDate &&
    JSON.stringify(left.replacementImpact) === JSON.stringify(right.replacementImpact) &&
    left.reasonCode === right.reasonCode &&
    left.approvalReferenceType === right.approvalReferenceType &&
    left.approvalInstanceId === right.approvalInstanceId &&
    left.approvalHistoryId === right.approvalHistoryId &&
    left.approvalEvidenceId === right.approvalEvidenceId &&
    left.approvedAt === right.approvedAt && left.createdAt === right.createdAt;
}

function sameMigratedMonth(
  left: AttendanceMonthlySnapshot,
  right: AttendanceMonthlySnapshot,
): boolean {
  return left.id === right.id && left.tenantId === right.tenantId &&
    left.employeeId === right.employeeId && left.month === right.month &&
    left.snapshotVersion === right.snapshotVersion &&
    left.rulesetVersion === right.rulesetVersion &&
    left.sourceCutoffAt === right.sourceCutoffAt &&
    left.sourceProviderCount === right.sourceProviderCount &&
    left.sourceWatermarkDigest === right.sourceWatermarkDigest &&
    left.workedMinutes === right.workedMinutes && left.leaveMinutes === right.leaveMinutes &&
    left.overtimeMinutes === right.overtimeMinutes && left.absentMinutes === right.absentMinutes &&
    left.sourceFactCount === right.sourceFactCount &&
    left.correctionCount === right.correctionCount &&
    JSON.stringify(left.dailySummaries) === JSON.stringify(right.dailySummaries) &&
    left.snapshotHash === right.snapshotHash &&
    left.previousSnapshotId === right.previousSnapshotId &&
    left.supersessionEvidenceId === right.supersessionEvidenceId &&
    left.closedAt === right.closedAt;
}

function assertMigratedMonthControls(
  snapshot: AttendanceMonthlySnapshot,
  input: ImportAttendanceMonthFromMigrationInput,
): void {
  const impactMatches = snapshot.workedMinutes === input.expectedImpact.workedMinutes &&
    snapshot.leaveMinutes === input.expectedImpact.leaveMinutes &&
    snapshot.overtimeMinutes === input.expectedImpact.overtimeMinutes &&
    snapshot.absentMinutes === input.expectedImpact.absentMinutes;
  if (!impactMatches || snapshot.sourceFactCount !== input.expectedSourceFactCount ||
    snapshot.correctionCount !== input.expectedCorrectionCount) {
    throw new ConflictException({
      code: 'ATTENDANCE_MIGRATION_MONTH_CONTROL_MISMATCH',
      message: '考勤月结重算结果与来源控制总量不一致',
    });
  }
}

function invalidMigratedMonthChain(): BadRequestException {
  return new BadRequestException({
    code: 'ATTENDANCE_MIGRATION_MONTH_CHAIN_INVALID',
    message: '考勤月结前序版本或重开审批链无效',
  });
}

function strictMigrationInputInstant(value: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new BadRequestException({
      code: 'ATTENDANCE_MIGRATION_TIME_INVALID',
      message: '考勤迁移时间必须为毫秒精度 UTC ISO instant',
    });
  }
  return parsed;
}

function assertMigrationEvidence(reference: string, checksum: string): void {
  if (!MIGRATION_EVIDENCE_REF_PATTERN.test(reference) || !HASH_PATTERN.test(checksum)) {
    throw new BadRequestException({
      code: 'ATTENDANCE_MIGRATION_EVIDENCE_INVALID',
      message: '考勤迁移必须精确引用 WORM 证据与校验和',
    });
  }
}

const HASH_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MIGRATION_EVIDENCE_REF_PATTERN =
  /^erp:\/\/data-migrations\/runs\/[0-7][0-9A-HJKMNP-TV-Z]{25}\/attachments\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
