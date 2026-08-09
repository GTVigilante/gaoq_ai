import { createHash } from 'node:crypto';
import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { createEventId } from '@gaoq/shared-utils';
import type { ClientSession } from 'mongoose';

import { IdempotencyService } from '../../../core/idempotency/idempotency.service.js';
import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { AccessProfileRepository } from '../../identity/access-profile.repository.js';
import { DepartmentRepository, EmployeeRepository, EmploymentRepository } from '../../org/persistence/org.repositories.js';
import { HrbpAssignmentRepository, ReportingLineRepository } from '../../workforce/persistence/workforce.repositories.js';
import { appealPerformance, calibratePerformance, confirmPerformance, createPerformanceAssignment, createPerformanceCycle, createPerformanceTemplate, finalizePerformance, publishPerformanceCycle, submitManagerReview, submitSelfReview, type PerformanceAssignment, type PerformanceCycle } from '../domain/performance.js';
import { PerformanceOutboxWriter } from '../persistence/performance-outbox.writer.js';
import { PerformanceRepository } from '../persistence/performance.repositories.js';
import type { AppealPerformanceDto, CalibratePerformanceDto, CreatePerformanceCycleDto, CreatePerformanceTemplateDto, FinalizePerformanceDto, SubmitPerformanceScoreDto } from './performance.dto.js';

@Injectable()
export class PerformanceService {
  constructor(private readonly context: TenantContextService, private readonly idempotency: IdempotencyService, private readonly accessProfiles: AccessProfileRepository, private readonly employees: EmployeeRepository, private readonly employments: EmploymentRepository, private readonly departments: DepartmentRepository, private readonly reporting: ReportingLineRepository, private readonly hrbp: HrbpAssignmentRepository, private readonly repository: PerformanceRepository, private readonly outbox: PerformanceOutboxWriter) {}

  async createTemplate(key: string, input: CreatePerformanceTemplateDto) {
    this.scope('erp:performance:admin');
    return this.idempotency.execute('performance.template.create', key, input, async (session) => {
      const now = new Date(); const template = createPerformanceTemplate({ id: createEventId(now), tenantId: this.tenant(), name: input.name, okrWeightBps: input.okrWeightBps, kpiWeightBps: input.kpiWeightBps, competencyWeightBps: input.competencyWeightBps, thresholds: input.thresholds, coefficients: input.coefficients }, now);
      await this.repository.insertTemplate(template, session); await this.outbox.append({ aggregateType: 'template', aggregateId: template.id, version: template.version, action: 'created', occurredAt: now.toISOString(), data: { okrWeightBps: template.okrWeightBps, kpiWeightBps: template.kpiWeightBps, competencyWeightBps: template.competencyWeightBps } }, session); return { template };
    });
  }
  async listTemplates() { this.scope('erp:performance:admin'); return this.repository.listTemplates(); }
  async createCycle(key: string, input: CreatePerformanceCycleDto) {
    this.scope('erp:performance:admin');
    return this.idempotency.execute('performance.cycle.create', key, input, async (session) => {
      if (await this.repository.findTemplate(input.templateId, session) === null) throw missing('PERFORMANCE_TEMPLATE_NOT_FOUND', '绩效模板不存在');
      const now = new Date(); const cycle = createPerformanceCycle({ id: createEventId(now), tenantId: this.tenant(), name: input.name, templateId: input.templateId, startDate: input.startDate, endDate: input.endDate }, now);
      await this.repository.insertCycle(cycle, session); await this.outbox.append({ aggregateType: 'cycle', aggregateId: cycle.id, version: cycle.version, action: 'created', occurredAt: now.toISOString(), data: { templateId: cycle.templateId, startDate: cycle.startDate, endDate: cycle.endDate, status: cycle.status } }, session); return { cycle };
    });
  }
  async listCycles() { this.scope('erp:performance:read'); return this.repository.listCycles(); }

  async publishCycle(id: string, expectedVersion: number, key: string) {
    this.scope('erp:performance:admin');
    return this.idempotency.execute('performance.cycle.publish', key, { id, expectedVersion }, async (session) => {
      const cycle = await this.requiredCycle(id, session); if (cycle.version !== expectedVersion) throw new Error('PERFORMANCE_VERSION_CONFLICT');
      const people = (await this.employees.findAll(session)).filter((item) => ['active', 'probation'].includes(item.status));
      if (people.length > 10_000) throw new Error('PERFORMANCE_CYCLE_EMPLOYEE_LIMIT');
      const now = new Date(); const assignments: PerformanceAssignment[] = [];
      for (const employee of people) {
        const employment = await this.employments.findOpenByEmployeeId(employee.id, session); if (employment === null) throw new Error('PERFORMANCE_EMPLOYMENT_MISSING');
        const manager = await this.reporting.findEffective(employee.id, cycle.startDate, session); if (manager === null) throw new Error('PERFORMANCE_MANAGER_MISSING');
        const partner = await this.resolveHrbp(employee.primaryDepartmentId, cycle.startDate, session); if (partner === null) throw new Error('PERFORMANCE_HRBP_MISSING');
        assignments.push(createPerformanceAssignment({ id: createEventId(now), tenantId: this.tenant(), cycleId: cycle.id, employeeId: employee.id, employmentId: employment.id, departmentId: employee.primaryDepartmentId, managerEmployeeId: manager.managerEmployeeId, hrbpEmployeeId: partner.primaryEmployeeId }, now));
      }
      const published = publishPerformanceCycle(cycle, assignments.length, now); await this.repository.insertAssignments(assignments, session); await this.repository.replaceCycle(published, expectedVersion, session); await this.outbox.append({ aggregateType: 'cycle', aggregateId: published.id, version: published.version, action: 'published', occurredAt: now.toISOString(), data: { templateId: published.templateId, assignmentCount: published.assignmentCount, status: published.status } }, session); return { cycle: published };
    });
  }

  async listMine() { this.scope('erp:performance:self:read'); const profile = await this.profile(); return this.repository.listAssignments({ employeeId: profile.employeeId }); }
  async listTeam(cycleId?: string) { this.scope('erp:performance:team:read'); const profile = await this.profile(); return this.repository.listAssignments({ managerEmployeeId: profile.employeeId, ...(cycleId === undefined ? {} : { cycleId }) }); }
  async listCalibration(cycleId?: string) { this.scope('erp:performance:calibration:read'); const profile = await this.profile(); return this.repository.listAssignments({ hrbpEmployeeId: profile.employeeId, ...(cycleId === undefined ? {} : { cycleId }) }); }

  async submitSelf(id: string, expectedVersion: number, key: string, input: SubmitPerformanceScoreDto) { return this.mutate('performance.assignment.self_review', id, expectedVersion, key, input, 'erp:performance:self:write', (current, profile) => { if (current.employeeId !== profile.employeeId) deny(); return submitSelfReview(current, input.scoreBps, input.evidenceRef, new Date()); }, 'self_reviewed'); }
  async submitManager(id: string, expectedVersion: number, key: string, input: SubmitPerformanceScoreDto) { return this.mutate('performance.assignment.manager_review', id, expectedVersion, key, input, 'erp:performance:manager:write', (current, profile) => { if (current.managerEmployeeId !== profile.employeeId) deny(); return submitManagerReview(current, input.scoreBps, input.evidenceRef, new Date()); }, 'manager_reviewed'); }
  async calibrate(id: string, expectedVersion: number, key: string, input: CalibratePerformanceDto) { return this.mutate('performance.assignment.calibrate', id, expectedVersion, key, input, 'erp:performance:calibration:write', (current, profile) => { if (current.hrbpEmployeeId !== profile.employeeId) deny(); return calibratePerformance(current, input.scoreBps, input.reasonCode, new Date()); }, 'calibrated'); }
  async appeal(id: string, expectedVersion: number, key: string, input: AppealPerformanceDto) { return this.mutate('performance.assignment.appeal', id, expectedVersion, key, input, 'erp:performance:self:write', (current, profile) => { if (current.employeeId !== profile.employeeId) deny(); return appealPerformance(current, input.reasonCode, input.evidenceRef, new Date()); }, 'appealed'); }
  async confirm(id: string, expectedVersion: number, key: string) { return this.mutate('performance.assignment.confirm', id, expectedVersion, key, {}, 'erp:performance:self:write', (current, profile) => { if (current.employeeId !== profile.employeeId) deny(); return confirmPerformance(current, new Date()); }, 'confirmed'); }

  async finalize(id: string, expectedVersion: number, key: string, input: FinalizePerformanceDto) {
    this.scope('erp:performance:finalize'); const profile = await this.profile();
    return this.idempotency.execute('performance.assignment.finalize', key, { id, expectedVersion, ...input }, async (session) => {
      const current = await this.requiredAssignment(id, session); if (current.version !== expectedVersion) throw new Error('PERFORMANCE_VERSION_CONFLICT');
      if (current.hrbpEmployeeId !== profile.employeeId && !this.actor().scopes.includes('erp:performance:finalize_all')) deny();
      const cycle = await this.requiredCycle(current.cycleId, session); const template = await this.repository.findTemplate(cycle.templateId, session); if (template === null) throw new Error('PERFORMANCE_TEMPLATE_MISSING');
      const finalized = finalizePerformance(current, template, input.scoreBps ?? null, input.reasonCode ?? null, new Date()); await this.repository.replaceAssignment(finalized, expectedVersion, session);
      const finalizedAt = finalized.updatedAt; const snapshotData = { assignmentId: finalized.id, cycleId: finalized.cycleId, employeeId: finalized.employeeId, employmentId: finalized.employmentId, resultVersion: finalized.version, rating: finalized.rating!, coefficientBps: finalized.coefficientBps!, finalizedAt };
      const digest = createHash('sha256').update(JSON.stringify([this.tenant(), snapshotData.assignmentId, snapshotData.cycleId, snapshotData.employeeId, snapshotData.employmentId, snapshotData.resultVersion, snapshotData.rating, snapshotData.coefficientBps, snapshotData.finalizedAt])).digest('base64url');
      await this.repository.insertSnapshot({ id: createEventId(new Date(finalizedAt)), ...snapshotData, digest }, session); await this.outbox.append({ aggregateType: 'result', aggregateId: finalized.id, version: finalized.version, action: 'finalized', occurredAt: finalizedAt, data: { employeeId: finalized.employeeId, employmentId: finalized.employmentId, cycleId: finalized.cycleId, resultVersion: finalized.version, rating: finalized.rating, coefficientBps: finalized.coefficientBps, finalizedAt, digest } }, session); return { assignment: finalized };
    });
  }

  async payrollSnapshots(cycleId: string) { const actor = this.actor(); if (!['service', 'system_job'].includes(actor.actorType) || !actor.scopes.includes('erp:performance:payroll_snapshot:read')) deny(); return this.repository.listSnapshots(cycleId); }

  private async mutate(operation: string, id: string, expectedVersion: number, key: string, request: object, scope: string, transition: (current: PerformanceAssignment, profile: { employeeId: string }) => PerformanceAssignment | Promise<PerformanceAssignment>, action: string) { this.scope(scope); const profile = await this.profile(); return this.idempotency.execute(operation, key, { id, expectedVersion, ...request }, async (session) => { const current = await this.requiredAssignment(id, session); if (current.version !== expectedVersion) throw new Error('PERFORMANCE_VERSION_CONFLICT'); const updated = await transition(current, profile); await this.repository.replaceAssignment(updated, expectedVersion, session); await this.outbox.append({ aggregateType: 'assignment', aggregateId: updated.id, version: updated.version, action, occurredAt: updated.updatedAt, data: { cycleId: updated.cycleId, employeeId: updated.employeeId, status: updated.status } }, session); return { assignment: updated }; }); }
  private async profile() { const profile = await this.accessProfiles.resolveActive(this.tenant(), this.actor().actorId); if (profile === null) deny(); return profile; }
  private async requiredCycle(id: string, session: ClientSession): Promise<PerformanceCycle> { const value = await this.repository.findCycle(id, session); if (value === null) throw missing('PERFORMANCE_CYCLE_NOT_FOUND', '绩效周期不存在'); return value; }
  private async requiredAssignment(id: string, session: ClientSession): Promise<PerformanceAssignment> { const value = await this.repository.findAssignment(id, session); if (value === null) throw missing('PERFORMANCE_ASSIGNMENT_NOT_FOUND', '绩效任务不存在'); return value; }
  private async resolveHrbp(departmentId: string, asOf: string, session: ClientSession) { let current: string | null = departmentId; for (let depth = 0; depth < 50 && current !== null; depth += 1) { const direct = await this.hrbp.findEffective(current, asOf, session); if (direct !== null && (current === departmentId || direct.inheritToDescendants)) return direct; const department = await this.departments.findById(current, session); if (department === null || department.status !== 'active') return null; current = department.parentId; } return null; }
  private scope(scope: string) { if (!this.actor().scopes.includes(scope)) deny(); }
  private tenant() { return this.context.getTenantRequired().tenantId; }
  private actor() { return this.context.getActorRequired(); }
}
function deny(): never { throw new ForbiddenException({ code: 'PERFORMANCE_ACCESS_DENIED', message: '当前身份无权访问该绩效资源' }); }
function missing(code: string, message: string): NotFoundException { return new NotFoundException({ code, message }); }
