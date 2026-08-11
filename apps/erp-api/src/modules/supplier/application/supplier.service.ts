import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { createEventId } from '@gaoq/shared-utils';
import type { ClientSession } from 'mongoose';

import { IdempotencyService } from '../../../core/idempotency/idempotency.service.js';
import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { EmployeeRepository } from '../../org/persistence/org.repositories.js';
import {
  approveSupplier, closeSupplier, createSupplierDraft, reactivateSupplier, rejectSupplier,
  replaceSupplierCapabilities, replaceSupplierRates, resolveSupplierEligibility, reviseSupplierDraft, submitSupplier, suspendSupplier,
  reviewSupplierQualificationExpiry, type SupplierRelationship,
} from '../domain/supplier.js';
import { SupplierDataCryptoService, type SupplierLegalIdentity } from '../persistence/supplier-data-crypto.service.js';
import { SupplierOutboxWriter } from '../persistence/supplier-outbox.writer.js';
import { SupplierRepository } from '../persistence/supplier.repository.js';
import { SupplierMemberAuthorizationService } from './supplier-member-authorization.service.js';
import type { ChangeSupplierStatusDto, CreateSupplierDraftDto, DecideSupplierDto, ReactivateSupplierDto, ReplaceSupplierCapabilitiesDto, ReplaceSupplierRatesDto, SupplierEligibilityDto, SupplierSearchDto, UpdateSupplierDraftDto } from './supplier.dto.js';

export interface SupplierProjection {
  readonly id: string; readonly supplierNumber: string; readonly partyKind: string; readonly legalForm: string;
  readonly displayName: string; readonly identityHint: string; readonly ownerEmployeeId: string;
  readonly responsibleDepartmentId: string; readonly riskTier: string; readonly status: string;
  readonly capabilities: readonly Record<string, unknown>[]; readonly rates: readonly Record<string, unknown>[];
  readonly qualifications: readonly Record<string, unknown>[]; readonly statusReasonCode: string | null;
  readonly version: number; readonly createdAt: string; readonly updatedAt: string;
}

export interface SupplierSelfSourcingControl {
  readonly supplierId: string;
  readonly supplierVersion: number;
  readonly eligibility: readonly ReturnType<typeof resolveSupplierEligibility>[];
}

/** 供应方主档深模块；授权、准入状态、身份加密、事务、幂等与事件均封装在此。 */
@Injectable()
export class SupplierService {
  constructor(
    private readonly context: TenantContextService,
    private readonly idempotency: IdempotencyService,
    private readonly employees: EmployeeRepository,
    private readonly repository: SupplierRepository,
    private readonly crypto: SupplierDataCryptoService,
    private readonly outbox: SupplierOutboxWriter,
    private readonly memberAuthorization: SupplierMemberAuthorizationService,
  ) {}

  async createDraft(key: string, input: CreateSupplierDraftDto): Promise<{ readonly supplier: SupplierProjection }> {
    this.requireScope('erp:supplier:relationship:write');
    return this.idempotency.execute('supplier.relationship.create', key, input, async (session) => {
      await this.assertOwner(input.ownerEmployeeId, input.responsibleDepartmentId, session);
      const now = new Date(); const id = createEventId(now); const identity = legalIdentity(input);
      const fingerprints = this.crypto.identityFingerprints(this.tenant(), identity);
      await this.assertIdentityAvailable(fingerprints, null, session);
      const supplier = domain(() => createSupplierDraft({
        id, tenantId: this.tenant(), supplierNumber: `SUP-${id.slice(-10)}`,
        partyKind: input.partyKind, legalForm: input.legalForm, displayName: input.displayName,
        identityFingerprint: fingerprints[0]!, identityHint: this.crypto.identityHint(identity),
        ownerEmployeeId: input.ownerEmployeeId, responsibleDepartmentId: input.responsibleDepartmentId,
        riskTier: input.riskTier, capabilities: capabilities(input), rates: rates(input),
      }, now));
      const protectedIdentity = this.crypto.protect({ tenantId: this.tenant(), supplierId: id, version: 1 }, identity);
      await this.repository.insert(supplier, protectedIdentity, session); await this.outbox.append(supplier, 'created', session);
      return { supplier: project(supplier) };
    });
  }

  async reviewQualificationExpiry(
    id: string,
    expectedVersion: number,
    scanDay: string,
    key: string,
  ): Promise<{ readonly outcome: 'skipped' | 'expiring' | 'expired'; readonly supplierId: string; readonly version: number }> {
    this.requireScope('erp:supplier:qualification:review');
    return this.idempotency.execute('supplier.qualification.review', key, { id, expectedVersion, scanDay }, async (session) => {
      const current = await this.required(id, session);
      if (current.version !== expectedVersion) throw new ConflictException({ code: 'SUPPLIER_VERSION_CONFLICT', message: '供应方记录版本已变化' });
      const review = reviewSupplierQualificationExpiry(current, scanDay);
      if (review === null) return { outcome: 'skipped' as const, supplierId: current.id, version: current.version };
      if (review.kind === 'expiring') {
        await this.outbox.appendQualification(current, 'expiring', review.effectiveOn, review.sourceCodes, scanDay, session);
        return { outcome: 'expiring' as const, supplierId: current.id, version: current.version };
      }
      const updated = domain(() => suspendSupplier(current, 'qualification_expired', new Date(`${scanDay}T00:00:00.000Z`)));
      await this.repository.replace(updated, expectedVersion, session);
      await this.outbox.append(updated, 'suspended', session);
      await this.outbox.appendQualification(updated, 'expired', review.effectiveOn, review.sourceCodes, scanDay, session);
      return { outcome: 'expired' as const, supplierId: updated.id, version: updated.version };
    });
  }

  async getEngagementPartyKind(id: string): Promise<{ readonly supplierId: string; readonly partyKind: SupplierRelationship['partyKind'] }> {
    const scopes = this.context.getActorRequired().scopes;
    if (!scopes.includes('erp:engagement:management:write') &&
        !scopes.includes('erp:engagement:management:decide')) {
      throw new ForbiddenException({ code: 'SUPPLIER_SCOPE_DENIED', message: '当前身份无权读取履约所需供应方控制事实' });
    }
    const supplier = await this.required(id);
    if (supplier.status !== 'active') {
      throw new ConflictException({ code: 'SUPPLIER_ENGAGEMENT_SOURCE_INVALID', message: '供应方状态不能形成履约委托' });
    }
    return Object.freeze({ supplierId: supplier.id, partyKind: supplier.partyKind });
  }

  async getSelf(): Promise<SupplierProjection> {
    this.requireScope('erp:supplier:self:read');
    const member = await this.memberAuthorization.resolveUniqueSelf('profile_read');
    return project(await this.required(member.supplierId));
  }

  async replaceCapabilitiesSelf(
    expectedVersion: number,
    key: string,
    input: ReplaceSupplierCapabilitiesDto,
  ): Promise<{ readonly supplier: SupplierProjection }> {
    this.requireScope('erp:supplier:self:catalog:write');
    const member = await this.memberAuthorization.resolveUniqueSelf('catalog_manage');
    return this.replaceCapabilitiesAuthorized(member.supplierId, expectedVersion, key, input, true);
  }

  async replaceRatesSelf(
    expectedVersion: number,
    key: string,
    input: ReplaceSupplierRatesDto,
  ): Promise<{ readonly supplier: SupplierProjection }> {
    this.requireScope('erp:supplier:self:catalog:write');
    const member = await this.memberAuthorization.resolveUniqueSelf('catalog_manage');
    return this.replaceRatesAuthorized(member.supplierId, expectedVersion, key, input, true);
  }

  /** 为寻源自助入口解析可信供应关系并批量计算资格，调用方不能指定或替换供应方。 */
  async resolveSelfSourcingControl(
    permission: 'opportunities_read' | 'response_submit',
    serviceCategoryCodes: readonly string[],
  ): Promise<SupplierSelfSourcingControl> {
    this.requireScope(permission === 'opportunities_read'
      ? 'erp:supplier:self:opportunities:read'
      : 'erp:supplier:self:response:write');
    if (serviceCategoryCodes.length > 100 ||
        new Set(serviceCategoryCodes).size !== serviceCategoryCodes.length) {
      throw new BadRequestException({
        code: 'SUPPLIER_SELF_SOURCING_CATEGORIES_INVALID',
        message: '服务分类集合不符合约束',
      });
    }
    const member = await this.memberAuthorization.resolveUniqueSelf(permission);
    const supplier = await this.required(member.supplierId);
    const now = new Date();
    return Object.freeze({
      supplierId: supplier.id,
      supplierVersion: supplier.version,
      eligibility: Object.freeze(serviceCategoryCodes.map((serviceCategoryCode) =>
        domain(() => resolveSupplierEligibility(
          supplier, 'sourcing_response', serviceCategoryCode, now,
        )),
      )),
    });
  }

  async updateDraft(id: string, expectedVersion: number, key: string, input: UpdateSupplierDraftDto): Promise<{ readonly supplier: SupplierProjection }> {
    this.requireScope('erp:supplier:relationship:write');
    return this.idempotency.execute('supplier.relationship.update_draft', key, { id, expectedVersion, ...input }, async (session) => {
      const current = await this.required(id, session); this.assertVisible(current); this.assertExpected(current, expectedVersion);
      await this.assertOwner(input.ownerEmployeeId, input.responsibleDepartmentId, session);
      const identity = legalIdentity(input); const fingerprints = this.crypto.identityFingerprints(this.tenant(), identity);
      await this.assertIdentityAvailable(fingerprints, id, session);
      const updated = domain(() => reviseSupplierDraft(current, {
        partyKind: input.partyKind, legalForm: input.legalForm, displayName: input.displayName,
        identityFingerprint: fingerprints[0]!, identityHint: this.crypto.identityHint(identity),
        ownerEmployeeId: input.ownerEmployeeId, responsibleDepartmentId: input.responsibleDepartmentId,
        riskTier: input.riskTier, capabilities: capabilities(input), rates: rates(input),
      }, new Date()));
      const protectedIdentity = this.crypto.protect({ tenantId: this.tenant(), supplierId: id, version: updated.version }, identity);
      await this.repository.replace(updated, expectedVersion, session, protectedIdentity); await this.outbox.append(updated, 'updated', session);
      return { supplier: project(updated) };
    });
  }

  async submit(id: string, expectedVersion: number, key: string): Promise<{ readonly supplier: SupplierProjection }> {
    return this.transition('supplier.relationship.submit', 'erp:supplier:relationship:write', id, expectedVersion, key, {}, 'submitted', submitSupplier);
  }

  async replaceCapabilities(id: string, expectedVersion: number, key: string, input: ReplaceSupplierCapabilitiesDto): Promise<{ readonly supplier: SupplierProjection }> {
    this.requireScope('erp:supplier:catalog:write');
    return this.replaceCapabilitiesAuthorized(id, expectedVersion, key, input, false);
  }

  private async replaceCapabilitiesAuthorized(id: string, expectedVersion: number, key: string, input: ReplaceSupplierCapabilitiesDto, selfAuthorized: boolean): Promise<{ readonly supplier: SupplierProjection }> {
    return this.idempotency.execute(selfAuthorized ? 'supplier.self.capabilities.replace' : 'supplier.capabilities.replace', key, { id, expectedVersion, ...input }, async (session) => {
      const current = await this.required(id, session); if (!selfAuthorized) this.assertVisible(current); this.assertExpected(current, expectedVersion);
      const updated = domain(() => replaceSupplierCapabilities(current, input.capabilities.map((item) => ({ serviceCategoryCode: item.serviceCategoryCode, level: item.level, evidenceRef: item.evidenceRef ?? null, validUntil: item.validUntil ?? null })), new Date()));
      await this.repository.replace(updated, expectedVersion, session); await this.outbox.appendCatalog(updated, 'capabilities.updated', session);
      return { supplier: project(updated) };
    });
  }

  async replaceRates(id: string, expectedVersion: number, key: string, input: ReplaceSupplierRatesDto): Promise<{ readonly supplier: SupplierProjection }> {
    this.requireScope('erp:supplier:catalog:write');
    return this.replaceRatesAuthorized(id, expectedVersion, key, input, false);
  }

  private async replaceRatesAuthorized(id: string, expectedVersion: number, key: string, input: ReplaceSupplierRatesDto, selfAuthorized: boolean): Promise<{ readonly supplier: SupplierProjection }> {
    return this.idempotency.execute(selfAuthorized ? 'supplier.self.rates.replace' : 'supplier.rates.replace', key, { id, expectedVersion, ...input }, async (session) => {
      const current = await this.required(id, session); if (!selfAuthorized) this.assertVisible(current); this.assertExpected(current, expectedVersion);
      const updated = domain(() => replaceSupplierRates(current, input.rates.map((item) => ({ serviceCategoryCode: item.serviceCategoryCode, unit: item.unit, amountMinor: item.amountMinor, currency: item.currency, taxIncluded: item.taxIncluded, validFrom: item.validFrom, validUntil: item.validUntil ?? null })), new Date()));
      await this.repository.replace(updated, expectedVersion, session); await this.outbox.appendCatalog(updated, 'rates.updated', session);
      return { supplier: project(updated) };
    });
  }

  async decide(id: string, expectedVersion: number, key: string, input: DecideSupplierDto): Promise<{ readonly supplier: SupplierProjection }> {
    this.requireScope('erp:supplier:relationship:decide');
    return this.idempotency.execute('supplier.relationship.decide', key, { id, expectedVersion, ...input }, async (session) => {
      const current = await this.required(id, session); this.assertVisible(current); this.assertExpected(current, expectedVersion); const now = new Date();
      const updated = input.outcome === 'approved'
        ? domain(() => approveSupplier(current, (input.qualifications ?? []).map((item) => ({ type: item.type, evidenceRef: item.evidenceRef, verifiedAt: now.toISOString(), validUntil: item.validUntil ?? null })), input.decisionEvidenceRef, now))
        : domain(() => rejectSupplier(current, input.decisionEvidenceRef, input.reasonCode ?? '', now));
      await this.repository.replace(updated, expectedVersion, session); await this.outbox.append(updated, input.outcome === 'approved' ? 'activated' : 'rejected', session);
      return { supplier: project(updated) };
    });
  }

  async suspend(id: string, expectedVersion: number, key: string, input: ChangeSupplierStatusDto): Promise<{ readonly supplier: SupplierProjection }> {
    return this.transition('supplier.relationship.suspend', 'erp:supplier:relationship:decide', id, expectedVersion, key, { reasonCode: input.reasonCode }, 'suspended', (value, now) => suspendSupplier(value, input.reasonCode, now));
  }

  async reactivate(id: string, expectedVersion: number, key: string, input: ReactivateSupplierDto): Promise<{ readonly supplier: SupplierProjection }> {
    return this.transition('supplier.relationship.reactivate', 'erp:supplier:relationship:decide', id, expectedVersion, key, { decisionEvidenceRef: input.decisionEvidenceRef }, 'reactivated', (value, now) => reactivateSupplier(value, input.decisionEvidenceRef, now));
  }

  async close(id: string, expectedVersion: number, key: string, input: ChangeSupplierStatusDto): Promise<{ readonly supplier: SupplierProjection }> {
    return this.transition('supplier.relationship.close', 'erp:supplier:relationship:decide', id, expectedVersion, key, { reasonCode: input.reasonCode }, 'closed', (value, now) => closeSupplier(value, input.reasonCode, now));
  }

  async get(id: string): Promise<SupplierProjection> {
    this.requireScope('erp:supplier:relationship:read'); const value = await this.required(id); this.assertVisible(value); return project(value);
  }

  async search(input: SupplierSearchDto): Promise<{ readonly items: readonly SupplierProjection[]; readonly nextCursor: string | null }> {
    this.requireScope('erp:supplier:relationship:read'); const actor = this.context.getActorRequired();
    const result = await this.repository.search({
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.ownerEmployeeId === undefined ? {} : { ownerEmployeeId: input.ownerEmployeeId }),
      ...(input.serviceCategoryCode === undefined ? {} : { serviceCategoryCode: input.serviceCategoryCode }),
      ...(input.afterId === undefined ? {} : { afterId: input.afterId }), limit: input.limit ?? 20,
      ...(actor.scopes.includes('erp:supplier:relationship:read_all') ? {} : { departmentIds: actor.departmentIds }),
    });
    return Object.freeze({ items: Object.freeze(result.items.map(project)), nextCursor: result.nextCursor });
  }

  async resolveEligibility(id: string, input: SupplierEligibilityDto): Promise<ReturnType<typeof resolveSupplierEligibility>> {
    this.requireScope('erp:supplier:eligibility:read'); const value = await this.required(id); this.assertVisible(value);
    const at = input.at === undefined ? new Date() : new Date(input.at);
    return domain(() => resolveSupplierEligibility(value, input.purpose, input.serviceCategoryCode, at));
  }

  private async transition(
    operation: string, scope: string, id: string, expectedVersion: number, key: string, request: Record<string, unknown>, action: string,
    change: (value: SupplierRelationship, now: Date) => SupplierRelationship,
  ): Promise<{ readonly supplier: SupplierProjection }> {
    this.requireScope(scope);
    return this.idempotency.execute(operation, key, { id, expectedVersion, ...request }, async (session) => {
      const current = await this.required(id, session); this.assertVisible(current); this.assertExpected(current, expectedVersion);
      const updated = domain(() => change(current, new Date()));
      await this.repository.replace(updated, expectedVersion, session); await this.outbox.append(updated, action, session);
      return { supplier: project(updated) };
    });
  }

  private async required(id: string, session?: ClientSession): Promise<SupplierRelationship> { const value = await this.repository.findById(id, session); if (value === null) throw new NotFoundException({ code: 'SUPPLIER_NOT_FOUND', message: '供应方不存在' }); return value; }
  private async assertOwner(employeeId: string, departmentId: string, session: ClientSession): Promise<void> {
    const employee = await this.employees.findById(employeeId, session);
    if (employee === null || !['active', 'probation'].includes(employee.status) || !employee.departmentIds.includes(departmentId)) throw new BadRequestException({ code: 'SUPPLIER_OWNER_INVALID', message: '负责人不存在、劳动状态无效或不属于责任部门' });
    this.requireDepartment(departmentId, 'write_all');
  }
  private async assertIdentityAvailable(fingerprints: readonly string[], selfId: string | null, session: ClientSession): Promise<void> { const found = await this.repository.findByFingerprints(fingerprints, session); if (found.some((item) => item.id !== selfId)) throw new ConflictException({ code: 'SUPPLIER_IDENTITY_DUPLICATE', message: '该法定身份已存在供应关系' }); }
  private assertExpected(value: SupplierRelationship, expected: number): void { if (value.version !== expected) throw new ConflictException({ code: 'SUPPLIER_VERSION_CONFLICT', message: '供应方记录版本已变化' }); }
  private assertVisible(value: SupplierRelationship): void { this.requireDepartment(value.responsibleDepartmentId, 'read_all'); }
  private requireDepartment(departmentId: string, allSuffix: 'read_all' | 'write_all'): void { const actor = this.context.getActorRequired(); if (!actor.scopes.includes(`erp:supplier:relationship:${allSuffix}`) && !actor.departmentIds.includes(departmentId)) throw new ForbiddenException({ code: 'SUPPLIER_DATA_SCOPE_DENIED', message: '当前身份不具备目标责任部门数据范围' }); }
  private requireScope(scope: string): void { if (!this.context.getActorRequired().scopes.includes(scope)) throw new ForbiddenException({ code: 'SUPPLIER_SCOPE_DENIED', message: '当前身份无权执行供应方操作' }); }
  private tenant(): string { return this.context.getTenantRequired().tenantId; }
}

function legalIdentity(input: CreateSupplierDraftDto): SupplierLegalIdentity { return { identifierType: input.legalIdentity.identifierType, identifier: input.legalIdentity.identifier, legalName: input.legalIdentity.legalName }; }
function capabilities(input: CreateSupplierDraftDto) { return input.capabilities.map((item) => ({ serviceCategoryCode: item.serviceCategoryCode, level: item.level, evidenceRef: item.evidenceRef ?? null, validUntil: item.validUntil ?? null })); }
function rates(input: CreateSupplierDraftDto) { return input.rates.map((item) => ({ serviceCategoryCode: item.serviceCategoryCode, unit: item.unit, amountMinor: item.amountMinor, currency: item.currency, taxIncluded: item.taxIncluded, validFrom: item.validFrom, validUntil: item.validUntil ?? null })); }
function project(value: SupplierRelationship): SupplierProjection { return Object.freeze({ id: value.id, supplierNumber: value.supplierNumber, partyKind: value.partyKind, legalForm: value.legalForm, displayName: value.displayName, identityHint: value.identityHint, ownerEmployeeId: value.ownerEmployeeId, responsibleDepartmentId: value.responsibleDepartmentId, riskTier: value.riskTier, status: value.status, capabilities: Object.freeze(value.capabilities.map((item) => Object.freeze({ ...item }))), rates: Object.freeze(value.rates.map((item) => Object.freeze({ ...item }))), qualifications: Object.freeze(value.qualifications.map((item) => Object.freeze({ type: item.type, verifiedAt: item.verifiedAt, validUntil: item.validUntil }))), statusReasonCode: value.statusReasonCode, version: value.version, createdAt: value.createdAt, updatedAt: value.updatedAt }); }
function domain<T>(handler: () => T): T { try { return handler(); } catch (error) { const code = error instanceof Error ? error.message : 'SUPPLIER_DOMAIN_INVALID'; if (code.startsWith('SUPPLIER_')) throw new BadRequestException({ code, message: '供应方业务规则校验失败' }); throw error; } }
