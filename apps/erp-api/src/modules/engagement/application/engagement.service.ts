import {
  BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException,
} from '@nestjs/common';
import { createEventId } from '@gaoq/shared-utils';
import type { ClientSession } from 'mongoose';

import { IdempotencyService } from '../../../core/idempotency/idempotency.service.js';
import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { SourcingService } from '../../sourcing/application/sourcing.service.js';
import { SupplierMemberAuthorizationService } from '../../supplier/application/supplier-member-authorization.service.js';
import { SupplierService } from '../../supplier/application/supplier.service.js';
import {
  acceptEngagement, activateEngagement, approveEngagement, cancelEngagement,
  createEngagementDraft, deliverEngagement, disputeEngagement, submitEngagement,
  type ServiceEngagement,
} from '../domain/engagement.js';
import { EngagementOutboxWriter } from '../persistence/engagement-outbox.writer.js';
import { EngagementRepository } from '../persistence/engagement.repository.js';
import type {
  CreateEngagementDto, EngagementDeliveryDto, EngagementEvidenceDto,
  EngagementReasonDto, EngagementSearchDto, SupplierSelfDeliveryDto,
  SupplierSelfEngagementSearchDto,
} from './engagement.dto.js';

@Injectable()
export class EngagementService {
  constructor(
    private readonly context: TenantContextService,
    private readonly idempotency: IdempotencyService,
    private readonly sourcing: SourcingService,
    private readonly suppliers: SupplierService,
    private readonly memberAuthorization: SupplierMemberAuthorizationService,
    private readonly repository: EngagementRepository,
    private readonly outbox: EngagementOutboxWriter,
  ) {}

  async create(key: string, input: CreateEngagementDto) {
    this.scope('erp:engagement:management:write');
    const source = await this.sourcing.get(input.sourcingRequestId);
    if (source.status !== 'awarded' || source.award === null) {
      throw new ConflictException({ code: 'ENGAGEMENT_SOURCING_NOT_AWARDED', message: '寻源需求尚未形成有效选定' });
    }
    this.department(source.responsibleDepartmentId, 'write_all');
    const supplierId = String(source.award.supplierId);
    const party = await this.suppliers.getEngagementPartyKind(supplierId);
    await this.memberAuthorization.assertPerformersAuthorized(
      supplierId, party.partyKind, input.performerRefs,
    );
    return this.idempotency.execute('engagement.service.create', key, input, async (session) => {
      const now = new Date(); const id = createEventId(now);
      const value = domain(() => createEngagementDraft({
        id, tenantId: this.tenant(), engagementNumber: `ENG-${id.slice(-10)}`,
        sourcingRequestId: source.id, supplierId,
        serviceCategoryCode: source.serviceCategoryCode,
        agreedAmountMinor: String(source.award?.agreedAmountMinor), currency: 'CNY',
        responsibleDepartmentId: source.responsibleDepartmentId,
        ownerEmployeeId: source.ownerEmployeeId, performerRefs: input.performerRefs,
        sourcingAwardVersion: source.version,
      }, now));
      await this.repository.insert(value, session);
      await this.outbox.append(value, 'created', session);
      return { engagement: project(value) };
    });
  }

  async get(id: string) {
    this.scope('erp:engagement:management:read');
    const value = await this.required(id); this.visible(value); return project(value);
  }

  async getAcceptedPayableSource(id: string) {
    this.scope('erp:payables:materialize');
    const value = await this.required(id); this.visible(value);
    if (value.status !== 'accepted' || value.acceptanceEvidenceRef === null) {
      throw new ConflictException({ code: 'ENGAGEMENT_NOT_ACCEPTED', message: '履约委托尚未形成可信验收终态' });
    }
    return Object.freeze({
      engagementId: value.id, engagementVersion: value.version,
      supplierId: value.supplierId, grossAmountMinor: value.agreedAmountMinor,
      currency: value.currency, acceptanceEvidenceRef: value.acceptanceEvidenceRef,
    });
  }

  async search(input: EngagementSearchDto) {
    this.scope('erp:engagement:management:read');
    const actor = this.context.getActorRequired();
    const result = await this.repository.search({
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.afterId === undefined ? {} : { afterId: input.afterId }),
      ...(actor.scopes.includes('erp:engagement:management:read_all') ? {} : { departmentIds: actor.departmentIds }),
      limit: input.limit ?? 20,
    });
    return Object.freeze({ items: Object.freeze(result.items.map(project)), nextCursor: result.nextCursor });
  }

  async listSelf(input: SupplierSelfEngagementSearchDto) {
    this.scope('erp:supplier:self:engagements:read');
    const member = await this.memberAuthorization.resolveUniqueSelf('delivery_submit');
    const result = await this.repository.searchForSupplierMember({
      supplierId: member.supplierId, performerRef: member.performerRef,
      ...(input.afterId === undefined ? {} : { afterId: input.afterId }),
      limit: input.limit ?? 20,
    });
    return Object.freeze({
      items: Object.freeze(result.items.map((value) => selfProject(value))),
      nextCursor: result.nextCursor,
    });
  }

  async submit(id: string, expected: number, key: string) {
    return this.transition('engagement.service.submit', 'erp:engagement:management:write', id, expected, key, {}, 'submitted', submitEngagement);
  }
  async approve(id: string, expected: number, key: string, input: EngagementEvidenceDto) {
    this.scope('erp:engagement:management:decide');
    return this.idempotency.execute(
      'engagement.service.approve', key, { id, expected, evidenceRef: input.evidenceRef },
      async (session) => {
        const current = await this.required(id, session);
        this.visible(current);
        this.expected(current, expected);
        const updated = domain(() => approveEngagement(current, input.evidenceRef, new Date()));
        await this.repository.replace(updated, expected, session);
        await this.outbox.append(updated, 'approved', session);
        await this.outbox.appendSignatureRequest(updated, session);
        return { engagement: project(updated) };
      },
    );
  }
  async activate(id: string, expected: number, key: string, input: EngagementEvidenceDto) {
    this.scope('erp:engagement:management:decide');
    return this.idempotency.execute('engagement.service.activate', key, { id, expected, ...input }, async (session) => {
      const current = await this.required(id, session); this.visible(current); this.expected(current, expected);
      const party = await this.suppliers.getEngagementPartyKind(current.supplierId);
      await this.memberAuthorization.assertPerformersAuthorized(
        current.supplierId, party.partyKind, current.performerRefs,
      );
      const eligibility = await this.suppliers.resolveEligibility(current.supplierId, {
        purpose: 'engagement_activate', serviceCategoryCode: current.serviceCategoryCode,
      });
      if (!eligibility.eligible) {
        throw new ConflictException({ code: 'ENGAGEMENT_SUPPLIER_INELIGIBLE', message: '供应方当前不具备委托激活资格', reasonCodes: eligibility.reasonCodes });
      }
      const updated = domain(() => activateEngagement(current, input.evidenceRef, eligibility.digest, new Date()));
      await this.repository.replace(updated, expected, session);
      await this.outbox.append(updated, 'activated', session);
      return { engagement: project(updated) };
    });
  }
  async deliver(id: string, expected: number, key: string, input: EngagementDeliveryDto) {
    return this.transition('engagement.service.deliver', 'erp:engagement:delivery:record', id, expected, key, { artifactRef: input.artifactRef, supplierId: input.supplierId }, 'delivered', (value, now) => deliverEngagement(value, input.artifactRef, input.supplierId, now));
  }
  async deliverSelf(id: string, expected: number, key: string, input: SupplierSelfDeliveryDto) {
    this.scope('erp:supplier:self:delivery:write');
    const member = await this.memberAuthorization.resolveUniqueSelf('delivery_submit');
    return this.idempotency.execute('engagement.self.deliver', key, { id, expected, artifactRef: input.artifactRef }, async (session) => {
      const current = await this.required(id, session); this.expected(current, expected);
      if (current.supplierId !== member.supplierId ||
          !current.performerRefs.includes(member.performerRef)) {
        throw new NotFoundException({ code: 'ENGAGEMENT_SELF_NOT_FOUND', message: '本人履约委托不存在' });
      }
      const updated = domain(() => deliverEngagement(
        current, input.artifactRef, member.supplierId, new Date(),
      ));
      await this.repository.replace(updated, expected, session);
      await this.outbox.append(updated, 'delivered', session);
      return { engagement: selfProject(updated) };
    });
  }
  async accept(id: string, expected: number, key: string, input: EngagementEvidenceDto) {
    return this.transition('engagement.service.accept', 'erp:engagement:management:accept', id, expected, key, { evidenceRef: input.evidenceRef }, 'accepted', (value, now) => acceptEngagement(value, input.evidenceRef, now));
  }
  async dispute(id: string, expected: number, key: string, input: EngagementReasonDto) {
    return this.transition('engagement.service.dispute', 'erp:engagement:management:decide', id, expected, key, { reasonCode: input.reasonCode }, 'disputed', (value, now) => disputeEngagement(value, input.reasonCode, now));
  }
  async cancel(id: string, expected: number, key: string, input: EngagementReasonDto) {
    return this.transition('engagement.service.cancel', 'erp:engagement:management:decide', id, expected, key, { reasonCode: input.reasonCode }, 'cancelled', (value, now) => cancelEngagement(value, input.reasonCode, now));
  }

  private async transition(
    operation: string, scope: string, id: string, expected: number, key: string,
    request: Record<string, unknown>, event: Parameters<EngagementOutboxWriter['append']>[1],
    change: (value: ServiceEngagement, now: Date) => ServiceEngagement,
  ) {
    this.scope(scope);
    return this.idempotency.execute(operation, key, { id, expected, ...request }, async (session) => {
      const current = await this.required(id, session); this.visible(current); this.expected(current, expected);
      const updated = domain(() => change(current, new Date()));
      await this.repository.replace(updated, expected, session);
      await this.outbox.append(updated, event, session);
      return { engagement: project(updated) };
    });
  }
  private async required(id: string, session?: ClientSession) {
    const value = await this.repository.findById(id, session);
    if (value === null) throw new NotFoundException({ code: 'ENGAGEMENT_NOT_FOUND', message: '履约委托不存在' });
    return value;
  }
  private expected(value: ServiceEngagement, expected: number): void {
    if (value.version !== expected) throw new ConflictException({ code: 'ENGAGEMENT_VERSION_CONFLICT', message: '履约委托版本已变化' });
  }
  private visible(value: ServiceEngagement): void { this.department(value.responsibleDepartmentId, 'read_all'); }
  private department(departmentId: string, suffix: 'read_all' | 'write_all'): void {
    const actor = this.context.getActorRequired();
    if (!actor.scopes.includes(`erp:engagement:management:${suffix}`) && !actor.departmentIds.includes(departmentId)) {
      throw new ForbiddenException({ code: 'ENGAGEMENT_DATA_SCOPE_DENIED', message: '当前身份不具备目标责任部门范围' });
    }
  }
  private scope(scope: string): void {
    if (!this.context.getActorRequired().scopes.includes(scope)) {
      throw new ForbiddenException({ code: 'ENGAGEMENT_SCOPE_DENIED', message: '当前身份无权执行履约操作' });
    }
  }
  private tenant(): string { return this.context.getTenantRequired().tenantId; }
}

function project(value: ServiceEngagement) {
  return Object.freeze({
    id: value.id, engagementNumber: value.engagementNumber,
    sourcingRequestId: value.sourcingRequestId, supplierId: value.supplierId,
    serviceCategoryCode: value.serviceCategoryCode, agreedAmountMinor: value.agreedAmountMinor,
    currency: value.currency, responsibleDepartmentId: value.responsibleDepartmentId,
    ownerEmployeeId: value.ownerEmployeeId, performerRefs: Object.freeze([...value.performerRefs]),
    deliveries: Object.freeze(value.deliveries.map((entry) => Object.freeze({ version: entry.version, submittedAt: entry.submittedAt }))),
    status: value.status, statusReasonCode: value.statusReasonCode, version: value.version,
    createdAt: value.createdAt, updatedAt: value.updatedAt,
  });
}
function selfProject(value: ServiceEngagement) {
  return Object.freeze({
    id: value.id, engagementNumber: value.engagementNumber,
    serviceCategoryCode: value.serviceCategoryCode,
    agreedAmountMinor: value.agreedAmountMinor, currency: value.currency,
    status: value.status, deliveryCount: value.deliveries.length,
    version: value.version, createdAt: value.createdAt, updatedAt: value.updatedAt,
  });
}
function domain<T>(handler: () => T): T {
  try { return handler(); } catch (error) {
    const code = error instanceof Error ? error.message : 'ENGAGEMENT_DOMAIN_INVALID';
    if (code.startsWith('ENGAGEMENT_')) throw new BadRequestException({ code, message: '履约业务规则校验失败' });
    throw error;
  }
}
