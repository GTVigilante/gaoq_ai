import { ConflictException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { SupplierRelationship, SupplierStatus } from '../domain/supplier.js';
import type { ProtectedSupplierIdentity } from './supplier-data-crypto.service.js';
import { SupplierRelationshipRecord, type SupplierRelationshipDocument, toDomain } from './supplier.schemas.js';

export interface SupplierSearchFilter {
  readonly status?: SupplierStatus;
  readonly ownerEmployeeId?: string;
  readonly departmentIds?: readonly string[];
  readonly serviceCategoryCode?: string;
  readonly afterId?: string;
  readonly limit: number;
}

/** Supplier 聚合的租户绑定持久化 Adapter；读取后逐字段反向绑定并冻结。 */
@Injectable()
export class SupplierRepository {
  constructor(
    private readonly context: TenantContextService,
    @InjectModel(SupplierRelationshipRecord.name) private readonly records: Model<SupplierRelationshipDocument>,
  ) {}

  async insert(value: SupplierRelationship, identity: ProtectedSupplierIdentity, session: ClientSession): Promise<void> {
    assertTransaction(session);
    await this.records.create([{ ...record(value, identity) }], { session });
  }

  async findById(id: string, session?: ClientSession): Promise<SupplierRelationship | null> {
    const query = this.records.findOne({ tenantId: this.tenant(), id }); if (session !== undefined) query.session(session);
    const row = await query.lean().exec(); return row === null ? null : toDomain(row);
  }

  async findByFingerprints(fingerprints: readonly string[], session?: ClientSession): Promise<readonly { id: string; fingerprint: string }[]> {
    const query = this.records.find({ tenantId: this.tenant(), identityFingerprint: { $in: [...fingerprints] } }).select('id identityFingerprint -_id').limit(2);
    if (session !== undefined) query.session(session);
    const rows = await query.lean().exec();
    return Object.freeze(rows.map((row) => Object.freeze({ id: row.id, fingerprint: row.identityFingerprint })));
  }

  async search(filter: SupplierSearchFilter): Promise<{ readonly items: readonly SupplierRelationship[]; readonly nextCursor: string | null }> {
    const query: Record<string, unknown> = { tenantId: this.tenant() };
    if (filter.status !== undefined) query.status = filter.status;
    if (filter.ownerEmployeeId !== undefined) query.ownerEmployeeId = filter.ownerEmployeeId;
    if (filter.departmentIds !== undefined) query.responsibleDepartmentId = { $in: [...filter.departmentIds] };
    if (filter.serviceCategoryCode !== undefined) query['capabilities.serviceCategoryCode'] = filter.serviceCategoryCode;
    if (filter.afterId !== undefined) query.id = { $gt: filter.afterId };
    const rows = await this.records.find(query).sort({ id: 1 }).limit(filter.limit + 1).lean().exec();
    const hasMore = rows.length > filter.limit; const selected = hasMore ? rows.slice(0, filter.limit) : rows;
    const items = Object.freeze(selected.map(toDomain));
    return Object.freeze({ items, nextCursor: hasMore ? selected.at(-1)?.id ?? null : null });
  }

  async replace(value: SupplierRelationship, expectedVersion: number, session: ClientSession, identity?: ProtectedSupplierIdentity): Promise<void> {
    assertTransaction(session);
    const update: Record<string, unknown> = {
      partyKind: value.partyKind, legalForm: value.legalForm, displayName: value.displayName,
      identityFingerprint: value.identityFingerprint, identityHint: value.identityHint,
      ownerEmployeeId: value.ownerEmployeeId, responsibleDepartmentId: value.responsibleDepartmentId,
      riskTier: value.riskTier, status: value.status,
      capabilities: value.capabilities.map((item) => ({ ...item })), rates: value.rates.map((item) => ({ ...item })),
      qualifications: value.qualifications.map((item) => ({ ...item, verifiedAt: new Date(item.verifiedAt) })),
      decisionEvidenceRef: value.decisionEvidenceRef, statusReasonCode: value.statusReasonCode,
      version: value.version, updatedAt: new Date(value.updatedAt),
    };
    if (identity !== undefined) Object.assign(update, { identityKeyId: identity.keyId, identityIv: identity.iv, identityCiphertext: identity.ciphertext, identityAuthTag: identity.authTag });
    const result = await this.records.updateOne(
      { tenantId: this.tenant(), id: value.id, version: expectedVersion }, { $set: update },
      { session, timestamps: false, runValidators: true },
    );
    if (result.matchedCount !== 1 || result.modifiedCount !== 1) throw new ConflictException({ code: 'SUPPLIER_VERSION_CONFLICT', message: '供应方记录版本已变化' });
  }

  private tenant(): string { return this.context.getTenantRequired().tenantId; }
}

function record(value: SupplierRelationship, identity: ProtectedSupplierIdentity): Record<string, unknown> {
  return {
    ...value, identityKeyId: identity.keyId, identityIv: identity.iv,
    identityCiphertext: identity.ciphertext, identityAuthTag: identity.authTag,
    capabilities: value.capabilities.map((item) => ({ ...item })), rates: value.rates.map((item) => ({ ...item })),
    qualifications: value.qualifications.map((item) => ({ ...item, verifiedAt: new Date(item.verifiedAt) })),
    createdAt: new Date(value.createdAt), updatedAt: new Date(value.updatedAt),
  };
}
function assertTransaction(session: ClientSession): void { if (!session.inTransaction()) throw new Error('SUPPLIER_TRANSACTION_REQUIRED'); }
