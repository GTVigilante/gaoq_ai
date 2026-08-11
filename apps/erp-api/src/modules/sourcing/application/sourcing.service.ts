import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'; import { createEventId } from '@gaoq/shared-utils'; import type { ClientSession } from 'mongoose';
import { IdempotencyService } from '../../../core/idempotency/idempotency.service.js'; import { TenantContextService } from '../../../core/tenant/tenant-context.service.js'; import { EmployeeRepository } from '../../org/persistence/org.repositories.js'; import { SupplierService } from '../../supplier/application/supplier.service.js';
import { awardSourcing, cancelSourcing, closeSourcing, createSourcingDraft, publishSourcing, recordSourcingResponse, startSourcingEvaluation, submitSourcing, type SourcingRequest } from '../domain/sourcing.js'; import { SourcingOutboxWriter } from '../persistence/sourcing-outbox.writer.js'; import { SourcingRepository } from '../persistence/sourcing.repository.js';
import type { AwardSourcingDto, CancelSourcingDto, CreateSourcingDraftDto, RecordSourcingResponseDto, SourcingApprovalDto, SourcingSearchDto, SupplierSelfOpportunitySearchDto, SupplierSelfSourcingResponseDto } from './sourcing.dto.js';
export interface SourcingProjection { readonly id: string; readonly requestNumber: string; readonly title: string; readonly serviceCategoryCode: string; readonly mode: string; readonly budgetCeilingMinor: string; readonly currency: 'CNY'; readonly ownerEmployeeId: string; readonly responsibleDepartmentId: string; readonly responseDueAt: string; readonly invitedSupplierIds: readonly string[]; readonly responses: readonly Readonly<Record<string, unknown>>[]; readonly award: Readonly<Record<string, unknown>> | null; readonly status: string; readonly statusReasonCode: string | null; readonly version: number; readonly createdAt: string; readonly updatedAt: string; }
export interface SupplierOpportunityProjection { readonly id: string; readonly requestNumber: string; readonly title: string; readonly serviceCategoryCode: string; readonly mode: string; readonly budgetCeilingMinor: string; readonly currency: 'CNY'; readonly responseDueAt: string; readonly responded: boolean; readonly ownQuotationMinor: string | null; readonly status: 'published'; readonly version: number; }
@Injectable()
export class SourcingService {
  constructor(private readonly context: TenantContextService, private readonly idempotency: IdempotencyService, private readonly employees: EmployeeRepository, private readonly repository: SourcingRepository, private readonly suppliers: SupplierService, private readonly outbox: SourcingOutboxWriter) {}
  async createDraft(key: string, input: CreateSourcingDraftDto): Promise<{ readonly request: SourcingProjection }> { this.scope('erp:sourcing:management:write'); return this.idempotency.execute('sourcing.request.create', key, input, async (session) => { await this.owner(input.ownerEmployeeId, input.responsibleDepartmentId, session); const now = new Date(); const id = createEventId(now); const value = domain(() => createSourcingDraft({ id, tenantId: this.tenant(), requestNumber: `SRC-${id.slice(-10)}`, ...input }, now)); await this.repository.insert(value, session); await this.outbox.append(value, 'created', session); return { request: project(value) }; }); }
  async get(id: string): Promise<SourcingProjection> { this.scope('erp:sourcing:management:read'); const value = await this.required(id); this.visible(value); return project(value); }
  async search(input: SourcingSearchDto): Promise<{ readonly items: readonly SourcingProjection[]; readonly nextCursor: string | null }> { this.scope('erp:sourcing:management:read'); const actor = this.context.getActorRequired(); const result = await this.repository.search({ ...(input.status === undefined ? {} : { status: input.status }), ...(input.serviceCategoryCode === undefined ? {} : { serviceCategoryCode: input.serviceCategoryCode }), ...(input.afterId === undefined ? {} : { afterId: input.afterId }), ...(actor.scopes.includes('erp:sourcing:management:read_all') ? {} : { departmentIds: actor.departmentIds }), limit: input.limit ?? 20 }); return Object.freeze({ items: Object.freeze(result.items.map(project)), nextCursor: result.nextCursor }); }
  async listSelfOpportunities(input: SupplierSelfOpportunitySearchDto): Promise<{ readonly items: readonly SupplierOpportunityProjection[]; readonly nextCursor: string | null }> {
    this.scope('erp:supplier:self:opportunities:read');
    const identity = await this.suppliers.resolveSelfSourcingControl('opportunities_read', []);
    const result = await this.repository.searchSupplierOpportunities({
      supplierId: identity.supplierId,
      ...(input.afterId === undefined ? {} : { afterId: input.afterId }),
      limit: input.limit ?? 20,
      at: new Date(),
    });
    const categories = [...new Set(result.items.map((item) => item.serviceCategoryCode))];
    const control = await this.suppliers.resolveSelfSourcingControl('opportunities_read', categories);
    if (control.supplierId !== identity.supplierId) {
      throw new ForbiddenException({ code: 'SOURCING_SELF_RELATIONSHIP_CHANGED', message: '供应方本人关系已变化' });
    }
    const eligible = new Set(control.eligibility.filter((item) => item.eligible)
      .map((item) => item.serviceCategoryCode));
    return Object.freeze({
      items: Object.freeze(result.items.filter((item) => eligible.has(item.serviceCategoryCode))
        .map((item) => selfProject(item, identity.supplierId))),
      nextCursor: result.nextCursor,
    });
  }
  async submit(id: string, expected: number, key: string) { return this.transition('sourcing.request.submit', 'erp:sourcing:management:write', id, expected, key, {}, 'submitted', submitSourcing); }
  async publish(id: string, expected: number, key: string, input: SourcingApprovalDto) { return this.transition('sourcing.request.publish', 'erp:sourcing:management:decide', id, expected, key, { approvalEvidenceRef: input.approvalEvidenceRef }, 'published', (value, now) => publishSourcing(value, input.approvalEvidenceRef, now)); }
  async recordResponse(id: string, expected: number, key: string, input: RecordSourcingResponseDto) { this.scope('erp:sourcing:response:record'); return this.idempotency.execute('sourcing.response.record', key, { id, expected, ...input }, async (session) => { const current = await this.required(id, session); this.visible(current); this.expected(current, expected); const eligibility = await this.suppliers.resolveEligibility(input.supplierId, { purpose: 'sourcing_response', serviceCategoryCode: current.serviceCategoryCode }); if (!eligibility.eligible) throw new ConflictException({ code: 'SOURCING_SUPPLIER_INELIGIBLE', message: '供应方当前不具备响应资格', reasonCodes: eligibility.reasonCodes }); const updated = domain(() => recordSourcingResponse(current, { ...input, eligibilityDigest: eligibility.digest, supplierVersion: eligibility.supplierVersion }, new Date())); await this.repository.replace(updated, expected, session); await this.outbox.append(updated, 'response_recorded', session); return { request: project(updated) }; }); }
  async recordSelfResponse(id: string, expected: number, key: string, input: SupplierSelfSourcingResponseDto) {
    this.scope('erp:supplier:self:response:write');
    const identity = await this.suppliers.resolveSelfSourcingControl('response_submit', []);
    return this.idempotency.execute('sourcing.self.response.record', key, { id, expected, ...input }, async (session) => {
      const current = await this.required(id, session);
      this.expected(current, expected);
      const control = await this.suppliers.resolveSelfSourcingControl(
        'response_submit', [current.serviceCategoryCode],
      );
      if (control.supplierId !== identity.supplierId) {
        throw new ForbiddenException({ code: 'SOURCING_SELF_RELATIONSHIP_CHANGED', message: '供应方本人关系已变化' });
      }
      const eligibility = control.eligibility[0]!;
      if (!eligibility.eligible) {
        throw new ConflictException({
          code: 'SOURCING_SUPPLIER_INELIGIBLE', message: '供应方当前不具备响应资格',
          reasonCodes: eligibility.reasonCodes,
        });
      }
      const updated = domain(() => recordSourcingResponse(current, {
        supplierId: identity.supplierId, quotationMinor: input.quotationMinor,
        proposalRef: input.proposalRef, eligibilityDigest: eligibility.digest,
        supplierVersion: eligibility.supplierVersion,
      }, new Date()));
      await this.repository.replace(updated, expected, session);
      await this.outbox.append(updated, 'response_recorded', session);
      return { request: selfProject(updated, identity.supplierId) };
    });
  }
  async startEvaluation(id: string, expected: number, key: string) { return this.transition('sourcing.request.evaluate', 'erp:sourcing:management:decide', id, expected, key, {}, 'evaluation_started', startSourcingEvaluation); }
  async award(id: string, expected: number, key: string, input: AwardSourcingDto) { this.scope('erp:sourcing:management:decide'); return this.idempotency.execute('sourcing.request.award', key, { id, expected, ...input }, async (session) => { const current = await this.required(id, session); this.visible(current); this.expected(current, expected); const eligibility = await this.suppliers.resolveEligibility(input.supplierId, { purpose: 'sourcing_award', serviceCategoryCode: current.serviceCategoryCode }); if (!eligibility.eligible) throw new ConflictException({ code: 'SOURCING_SUPPLIER_INELIGIBLE', message: '供应方当前不具备选定资格', reasonCodes: eligibility.reasonCodes }); const updated = domain(() => awardSourcing(current, { ...input, eligibilityDigest: eligibility.digest, supplierVersion: eligibility.supplierVersion }, new Date())); await this.repository.replace(updated, expected, session); await this.outbox.append(updated, 'awarded', session); return { request: project(updated) }; }); }
  async cancel(id: string, expected: number, key: string, input: CancelSourcingDto) { return this.transition('sourcing.request.cancel', 'erp:sourcing:management:decide', id, expected, key, { reasonCode: input.reasonCode }, 'cancelled', (value, now) => cancelSourcing(value, input.reasonCode, now)); }
  async close(id: string, expected: number, key: string) { return this.transition('sourcing.request.close', 'erp:sourcing:management:decide', id, expected, key, {}, 'closed', closeSourcing); }
  private async transition(operation: string, scope: string, id: string, expected: number, key: string, request: Record<string, unknown>, event: Parameters<SourcingOutboxWriter['append']>[1], change: (value: SourcingRequest, now: Date) => SourcingRequest) { this.scope(scope); return this.idempotency.execute(operation, key, { id, expected, ...request }, async (session) => { const current = await this.required(id, session); this.visible(current); this.expected(current, expected); const updated = domain(() => change(current, new Date())); await this.repository.replace(updated, expected, session); await this.outbox.append(updated, event, session); return { request: project(updated) }; }); }
  private async required(id: string, session?: ClientSession): Promise<SourcingRequest> { const value = await this.repository.findById(id, session); if (value === null) throw new NotFoundException({ code: 'SOURCING_NOT_FOUND', message: '寻源需求不存在' }); return value; }
  private async owner(employeeId: string, departmentId: string, session: ClientSession): Promise<void> { const employee = await this.employees.findById(employeeId, session); if (employee === null || !['active','probation'].includes(employee.status) || !employee.departmentIds.includes(departmentId)) throw new BadRequestException({ code: 'SOURCING_OWNER_INVALID', message: '负责人不存在或不属于责任部门' }); this.department(departmentId, 'write_all'); }
  private visible(value: SourcingRequest): void { this.department(value.responsibleDepartmentId, 'read_all'); }
  private department(departmentId: string, suffix: 'read_all' | 'write_all'): void { const actor = this.context.getActorRequired(); if (!actor.scopes.includes(`erp:sourcing:management:${suffix}`) && !actor.departmentIds.includes(departmentId)) throw new ForbiddenException({ code: 'SOURCING_DATA_SCOPE_DENIED', message: '当前身份不具备目标责任部门范围' }); }
  private expected(value: SourcingRequest, expected: number): void { if (value.version !== expected) throw new ConflictException({ code: 'SOURCING_VERSION_CONFLICT', message: '寻源需求版本已变化' }); }
  private scope(scope: string): void { if (!this.context.getActorRequired().scopes.includes(scope)) throw new ForbiddenException({ code: 'SOURCING_SCOPE_DENIED', message: '当前身份无权执行寻源操作' }); }
  private tenant(): string { return this.context.getTenantRequired().tenantId; }
}
function project(value: SourcingRequest): SourcingProjection { return Object.freeze({ id: value.id, requestNumber: value.requestNumber, title: value.title, serviceCategoryCode: value.serviceCategoryCode, mode: value.mode, budgetCeilingMinor: value.budgetCeilingMinor, currency: value.currency, ownerEmployeeId: value.ownerEmployeeId, responsibleDepartmentId: value.responsibleDepartmentId, responseDueAt: value.responseDueAt, invitedSupplierIds: Object.freeze([...value.invitedSupplierIds]), responses: Object.freeze(value.responses.map((entry) => Object.freeze({ supplierId: entry.supplierId, quotationMinor: entry.quotationMinor, supplierVersion: entry.supplierVersion, submittedAt: entry.submittedAt }))), award: value.award === null ? null : Object.freeze({ supplierId: value.award.supplierId, agreedAmountMinor: value.award.agreedAmountMinor, supplierVersion: value.award.supplierVersion, awardedAt: value.award.awardedAt }), status: value.status, statusReasonCode: value.statusReasonCode, version: value.version, createdAt: value.createdAt, updatedAt: value.updatedAt }); }
function selfProject(value: SourcingRequest, supplierId: string): SupplierOpportunityProjection { const own = value.responses.find((entry) => entry.supplierId === supplierId); return Object.freeze({ id: value.id, requestNumber: value.requestNumber, title: value.title, serviceCategoryCode: value.serviceCategoryCode, mode: value.mode, budgetCeilingMinor: value.budgetCeilingMinor, currency: value.currency, responseDueAt: value.responseDueAt, responded: own !== undefined, ownQuotationMinor: own?.quotationMinor ?? null, status: 'published', version: value.version }); }
function domain<T>(handler: () => T): T { try { return handler(); } catch (error) { const code = error instanceof Error ? error.message : 'SOURCING_DOMAIN_INVALID'; if (code.startsWith('SOURCING_')) throw new BadRequestException({ code, message: '寻源业务规则校验失败' }); throw error; } }
