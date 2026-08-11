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
import {
  createSupplierMember,
  revokeSupplierMember,
  type SupplierMemberRelationship,
} from '../domain/supplier-member.js';
import { SupplierMemberOutboxWriter } from '../persistence/supplier-member-outbox.writer.js';
import { SupplierMemberRepository } from '../persistence/supplier-member.repository.js';
import { SupplierRepository } from '../persistence/supplier.repository.js';
import type { CreateSupplierMemberDto, RevokeSupplierMemberDto } from './supplier-member.dto.js';

@Injectable()
export class SupplierMemberService {
  constructor(
    private readonly context: TenantContextService,
    private readonly idempotency: IdempotencyService,
    private readonly suppliers: SupplierRepository,
    private readonly members: SupplierMemberRepository,
    private readonly outbox: SupplierMemberOutboxWriter,
  ) {}

  async create(supplierId: string, key: string, input: CreateSupplierMemberDto) {
    this.scope('erp:supplier:member:manage');
    return this.idempotency.execute('supplier.member.create', key, { supplierId, ...input }, async (session) => {
      const supplier = await this.requiredSupplier(supplierId, session);
      if (supplier.status !== 'active') {
        throw new ConflictException({ code: 'SUPPLIER_MEMBER_SUPPLIER_INACTIVE', message: '仅活动供应方可登记成员授权' });
      }
      if (supplier.partyKind === 'individual' && input.role !== 'owner') {
        throw new ConflictException({ code: 'SUPPLIER_INDIVIDUAL_MEMBER_ROLE_INVALID', message: '个人供应方只能登记本人所有者关系' });
      }
      if (supplier.partyKind === 'individual' &&
          await this.members.findAnyActiveBySupplier(supplierId, session) !== null) {
        throw new ConflictException({
          code: 'SUPPLIER_INDIVIDUAL_MEMBER_DUPLICATE',
          message: '个人供应方只能存在一条有效本人关系',
        });
      }
      if (await this.members.findActiveDuplicate(supplierId, input.actorId, input.performerRef, session) !== null) {
        throw new ConflictException({ code: 'SUPPLIER_MEMBER_DUPLICATE', message: '账号或履约者已存在有效授权' });
      }
      const now = new Date(); const id = createEventId(now);
      const member = domain(() => createSupplierMember({
        id, tenantId: this.context.getTenantRequired().tenantId, supplierId,
        actorId: input.actorId, performerRef: input.performerRef, role: input.role,
        permissions: input.permissions, evidenceRef: input.evidenceRef,
        validFrom: input.validFrom, validUntil: input.validUntil ?? null,
      }, now));
      await this.members.insert(member, session);
      await this.outbox.append(member, 'authorized', session);
      return { member: project(member) };
    });
  }

  async list(supplierId: string) {
    this.scope('erp:supplier:member:read');
    await this.requiredSupplier(supplierId);
    return Object.freeze({ items: Object.freeze((await this.members.listBySupplier(supplierId)).map(project)) });
  }

  async revoke(
    supplierId: string,
    memberId: string,
    expectedVersion: number,
    key: string,
    input: RevokeSupplierMemberDto,
  ) {
    this.scope('erp:supplier:member:manage');
    return this.idempotency.execute('supplier.member.revoke', key, {
      supplierId, memberId, expectedVersion, reasonCode: input.reasonCode,
    }, async (session) => {
      await this.requiredSupplier(supplierId, session);
      const current = await this.requiredMember(memberId, session);
      if (current.supplierId !== supplierId) {
        throw new NotFoundException({ code: 'SUPPLIER_MEMBER_NOT_FOUND', message: '成员授权不存在' });
      }
      if (current.version !== expectedVersion) {
        throw new ConflictException({ code: 'SUPPLIER_MEMBER_VERSION_CONFLICT', message: '成员授权版本已变化' });
      }
      const updated = domain(() => revokeSupplierMember(current, input.reasonCode, new Date()));
      await this.members.replace(updated, expectedVersion, session);
      await this.outbox.append(updated, 'revoked', session);
      return { member: project(updated) };
    });
  }

  private async requiredSupplier(id: string, session?: ClientSession) {
    const supplier = await this.suppliers.findById(id, session);
    if (supplier === null) throw new NotFoundException({ code: 'SUPPLIER_NOT_FOUND', message: '供应方不存在' });
    const actor = this.context.getActorRequired();
    if (!actor.scopes.includes('erp:supplier:member:read_all') &&
        !actor.departmentIds.includes(supplier.responsibleDepartmentId)) {
      throw new ForbiddenException({ code: 'SUPPLIER_MEMBER_DATA_SCOPE_DENIED', message: '当前身份不具备责任部门范围' });
    }
    return supplier;
  }

  private async requiredMember(id: string, session?: ClientSession) {
    const member = await this.members.findById(id, session);
    if (member === null) throw new NotFoundException({ code: 'SUPPLIER_MEMBER_NOT_FOUND', message: '成员授权不存在' });
    return member;
  }

  private scope(scope: string): void {
    if (!this.context.getActorRequired().scopes.includes(scope)) {
      throw new ForbiddenException({ code: 'SUPPLIER_MEMBER_SCOPE_DENIED', message: '当前身份无权管理供应方成员' });
    }
  }
}

function project(value: SupplierMemberRelationship) {
  return Object.freeze({
    id: value.id, supplierId: value.supplierId, actorId: value.actorId,
    performerRef: value.performerRef, role: value.role,
    permissions: Object.freeze([...value.permissions]), validFrom: value.validFrom,
    validUntil: value.validUntil, status: value.status,
    revokedReasonCode: value.revokedReasonCode, version: value.version,
    createdAt: value.createdAt, updatedAt: value.updatedAt,
  });
}
function domain<T>(handler: () => T): T {
  try { return handler(); } catch (error) {
    const code = error instanceof Error ? error.message : 'SUPPLIER_MEMBER_DOMAIN_INVALID';
    if (code.startsWith('SUPPLIER_MEMBER_') || code.startsWith('SUPPLIER_INDIVIDUAL_')) {
      throw new BadRequestException({ code, message: '供应方成员授权规则校验失败' });
    }
    throw error;
  }
}
