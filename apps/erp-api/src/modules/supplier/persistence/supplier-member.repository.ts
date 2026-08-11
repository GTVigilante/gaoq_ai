import { ConflictException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type {
  SupplierMemberPermission,
  SupplierMemberRelationship,
} from '../domain/supplier-member.js';
import {
  SupplierMemberRecord,
  type SupplierMemberDocument,
  toSupplierMember,
} from './supplier-member.schema.js';

@Injectable()
export class SupplierMemberRepository {
  constructor(
    private readonly context: TenantContextService,
    @InjectModel(SupplierMemberRecord.name)
    private readonly records: Model<SupplierMemberDocument>,
  ) {}

  async insert(value: SupplierMemberRelationship, session: ClientSession): Promise<void> {
    transaction(session);
    await this.records.create([{ ...value, permissions: [...value.permissions], createdAt: new Date(value.createdAt), updatedAt: new Date(value.updatedAt) }], { session });
  }

  async findById(id: string, session?: ClientSession): Promise<SupplierMemberRelationship | null> {
    const tenantId = this.tenant();
    const query = this.records.findOne({ tenantId, id });
    if (session !== undefined) query.session(session);
    const row = await query.lean().exec();
    if (row === null) return null;
    const member = bind(toSupplierMember(row), tenantId);
    if (member.id !== id) corrupted();
    return member;
  }

  async listBySupplier(supplierId: string): Promise<readonly SupplierMemberRelationship[]> {
    const tenantId = this.tenant();
    const rows = await this.records.find({ tenantId, supplierId })
      .sort({ id: 1 }).limit(101).lean().exec();
    if (rows.length > 100) throw new Error('SUPPLIER_MEMBER_LIMIT_EXCEEDED');
    const members = rows.map((row) => bind(
      toSupplierMember(row as unknown as SupplierMemberRecord), tenantId,
    ));
    if (members.some((member) => member.supplierId !== supplierId) ||
        new Set(members.map((member) => member.id)).size !== members.length) corrupted();
    return Object.freeze(members);
  }

  async listActiveByActor(
    actorId: string,
    permission: SupplierMemberPermission,
    day: string,
  ): Promise<readonly SupplierMemberRelationship[]> {
    const tenantId = this.tenant();
    const rows = await this.records.find({
      tenantId, actorId, status: 'active', permissions: permission,
      validFrom: { $lte: day }, $or: [{ validUntil: null }, { validUntil: { $gte: day } }],
    }).sort({ id: 1 }).limit(11).lean().exec();
    if (rows.length > 10) throw new Error('SUPPLIER_MEMBER_ACTOR_SCOPE_AMBIGUOUS');
    const members = rows.map((row) => bind(
      toSupplierMember(row as unknown as SupplierMemberRecord), tenantId,
    ));
    if (members.some((member) => member.actorId !== actorId || member.status !== 'active' ||
        !member.permissions.includes(permission) || member.validFrom > day ||
        (member.validUntil !== null && member.validUntil < day)) ||
        new Set(members.map((member) => member.id)).size !== members.length) corrupted();
    return Object.freeze(members);
  }

  async listActivePerformers(
    supplierId: string,
    performerRefs: readonly string[],
    day: string,
  ): Promise<readonly SupplierMemberRelationship[]> {
    const tenantId = this.tenant();
    const requested = new Set(performerRefs);
    if (requested.size !== performerRefs.length || requested.size > 50) corrupted();
    const rows = await this.records.find({
      tenantId, supplierId, performerRef: { $in: [...performerRefs] },
      status: 'active', permissions: 'delivery_submit', validFrom: { $lte: day },
      $or: [{ validUntil: null }, { validUntil: { $gte: day } }],
    }).limit(51).lean().exec();
    const members = rows.map((row) => bind(
      toSupplierMember(row as unknown as SupplierMemberRecord), tenantId,
    ));
    if (members.length > performerRefs.length ||
        members.some((member) => member.supplierId !== supplierId ||
          !requested.has(member.performerRef) || member.status !== 'active' ||
          !member.permissions.includes('delivery_submit') || member.validFrom > day ||
          (member.validUntil !== null && member.validUntil < day)) ||
        new Set(members.map((member) => member.performerRef)).size !== members.length) corrupted();
    return Object.freeze(members);
  }

  async findActiveDuplicate(
    supplierId: string,
    actorId: string,
    performerRef: string,
    session: ClientSession,
  ): Promise<SupplierMemberRelationship | null> {
    const tenantId = this.tenant();
    const row = await this.records.findOne({
      tenantId, supplierId, status: 'active',
      $or: [{ actorId }, { performerRef }],
    }).session(session).lean().exec();
    if (row === null) return null;
    const member = bind(toSupplierMember(row), tenantId);
    if (member.supplierId !== supplierId || member.status !== 'active' ||
        (member.actorId !== actorId && member.performerRef !== performerRef)) corrupted();
    return member;
  }

  async findAnyActiveBySupplier(
    supplierId: string,
    session: ClientSession,
  ): Promise<SupplierMemberRelationship | null> {
    const tenantId = this.tenant();
    const row = await this.records.findOne({ tenantId, supplierId, status: 'active' })
      .sort({ id: 1 }).session(session).lean().exec();
    if (row === null) return null;
    const member = bind(toSupplierMember(row), tenantId);
    if (member.supplierId !== supplierId || member.status !== 'active') corrupted();
    return member;
  }

  async replace(
    value: SupplierMemberRelationship,
    expectedVersion: number,
    session: ClientSession,
  ): Promise<void> {
    transaction(session);
    const result = await this.records.replaceOne(
      { tenantId: this.tenant(), id: value.id, version: expectedVersion },
      { ...value, permissions: [...value.permissions], createdAt: new Date(value.createdAt), updatedAt: new Date(value.updatedAt) },
      { session, timestamps: false, runValidators: true },
    );
    if (result.matchedCount !== 1 || result.modifiedCount !== 1) {
      throw new ConflictException({ code: 'SUPPLIER_MEMBER_VERSION_CONFLICT', message: '成员授权版本已变化' });
    }
  }

  private tenant(): string { return this.context.getTenantRequired().tenantId; }
}

function transaction(session: ClientSession): void {
  if (!session.inTransaction()) throw new Error('SUPPLIER_MEMBER_TRANSACTION_REQUIRED');
}

function bind(value: SupplierMemberRelationship, tenantId: string): SupplierMemberRelationship {
  if (value.tenantId !== tenantId) corrupted();
  return value;
}

function corrupted(): never { throw new Error('SUPPLIER_MEMBER_PERSISTED_BINDING_INVALID'); }
