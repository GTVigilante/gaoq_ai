import { ConflictException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { EngagementStatus, ServiceEngagement } from '../domain/engagement.js';
import {
  ServiceEngagementRecord,
  type ServiceEngagementDocument,
  toEngagementDomain,
} from './engagement.schema.js';

@Injectable()
export class EngagementRepository {
  constructor(
    private readonly context: TenantContextService,
    @InjectModel(ServiceEngagementRecord.name)
    private readonly records: Model<ServiceEngagementDocument>,
  ) {}

  async insert(value: ServiceEngagement, session: ClientSession): Promise<void> {
    transaction(session); await this.records.create([record(value)], { session });
  }

  async findById(id: string, session?: ClientSession): Promise<ServiceEngagement | null> {
    const tenantId = this.tenant(); const query = this.records.findOne({ tenantId, id });
    if (session !== undefined) query.session(session);
    const row = await query.lean().exec();
    if (row === null) return null;
    const value = restore(row as unknown as Record<string, unknown>, tenantId);
    if (value.id !== id) corrupted();
    return value;
  }

  async replace(value: ServiceEngagement, expected: number, session: ClientSession): Promise<void> {
    transaction(session);
    const result = await this.records.replaceOne(
      { tenantId: this.tenant(), id: value.id, version: expected }, record(value),
      { session, timestamps: false, runValidators: true },
    );
    if (result.matchedCount !== 1 || result.modifiedCount !== 1) {
      throw new ConflictException({ code: 'ENGAGEMENT_VERSION_CONFLICT', message: '履约委托版本已变化' });
    }
  }

  async search(input: {
    readonly status?: EngagementStatus; readonly departmentIds?: readonly string[];
    readonly afterId?: string; readonly limit: number;
  }) {
    const tenantId = this.tenant();
    const rows = await this.records.find({
      tenantId, ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.departmentIds === undefined ? {} : { responsibleDepartmentId: { $in: [...input.departmentIds] } }),
      ...(input.afterId === undefined ? {} : { id: { $gt: input.afterId } }),
    }).sort({ id: 1 }).limit(input.limit + 1).lean().exec();
    const values = rows.map((row) => restore(row as unknown as Record<string, unknown>, tenantId));
    if (values.some((value) =>
      (input.status !== undefined && value.status !== input.status) ||
      (input.departmentIds !== undefined && !input.departmentIds.includes(value.responsibleDepartmentId)) ||
      (input.afterId !== undefined && value.id <= input.afterId))) corrupted();
    orderedUnique(values); return page(values, input.limit);
  }

  async searchForSupplierMember(input: {
    readonly supplierId: string; readonly performerRef: string;
    readonly afterId?: string; readonly limit: number;
  }) {
    const tenantId = this.tenant();
    const rows = await this.records.find({
      tenantId, supplierId: input.supplierId, performerRefs: input.performerRef,
      ...(input.afterId === undefined ? {} : { id: { $gt: input.afterId } }),
    }).sort({ id: 1 }).limit(input.limit + 1).lean().exec();
    const values = rows.map((row) => restore(row as unknown as Record<string, unknown>, tenantId));
    if (values.some((value) => value.supplierId !== input.supplierId ||
        !value.performerRefs.includes(input.performerRef) ||
        (input.afterId !== undefined && value.id <= input.afterId))) corrupted();
    orderedUnique(values); return page(values, input.limit);
  }

  private tenant(): string { return this.context.getTenantRequired().tenantId; }
}

function restore(row: Record<string, unknown>, tenantId: string): ServiceEngagement {
  const value = toEngagementDomain(row); if (value.tenantId !== tenantId) corrupted(); return value;
}
function orderedUnique(values: readonly ServiceEngagement[]): void {
  if (new Set(values.map((value) => value.id)).size !== values.length) corrupted();
  for (let index = 1; index < values.length; index += 1) {
    if (values[index - 1]!.id >= values[index]!.id) corrupted();
  }
}
function page(values: readonly ServiceEngagement[], limit: number) {
  const more = values.length > limit; const selected = more ? values.slice(0, limit) : values;
  return Object.freeze({ items: Object.freeze(selected), nextCursor: more ? selected.at(-1)?.id ?? null : null });
}
function record(value: ServiceEngagement) {
  return { ...value, performerRefs: [...value.performerRefs], deliveries: value.deliveries.map((entry) => ({ ...entry, submittedAt: new Date(entry.submittedAt) })), createdAt: new Date(value.createdAt), updatedAt: new Date(value.updatedAt) };
}
function transaction(session: ClientSession): void {
  if (!session.inTransaction()) throw new Error('ENGAGEMENT_TRANSACTION_REQUIRED');
}
function corrupted(): never { throw new Error('ENGAGEMENT_PERSISTED_BINDING_INVALID'); }
