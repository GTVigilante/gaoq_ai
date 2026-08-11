import { ConflictException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { PayableItem, PayableStatus } from '../domain/payable.js';
import { PayableRecord, type PayableDocument, toPayableDomain } from './payable.schema.js';

@Injectable()
export class PayableRepository {
  constructor(
    private readonly context: TenantContextService,
    @InjectModel(PayableRecord.name) private readonly records: Model<PayableDocument>,
  ) {}

  async insert(value: PayableItem, session: ClientSession): Promise<void> {
    transaction(session);
    await this.records.create([record(value)], { session });
  }

  async findById(id: string, session?: ClientSession): Promise<PayableItem | null> {
    const tenantId = this.tenant();
    const query = this.records.findOne({ tenantId, id });
    if (session !== undefined) query.session(session);
    const row = await query.lean().exec();
    if (row === null) return null;
    const value = restore(row as unknown as Record<string, unknown>, tenantId);
    if (value.id !== id) corrupted();
    return value;
  }

  async findByEngagement(id: string, session?: ClientSession): Promise<PayableItem | null> {
    const tenantId = this.tenant();
    const query = this.records.findOne({ tenantId, engagementId: id });
    if (session !== undefined) query.session(session);
    const row = await query.lean().exec();
    if (row === null) return null;
    const value = restore(row as unknown as Record<string, unknown>, tenantId);
    if (value.engagementId !== id) corrupted();
    return value;
  }

  async replace(value: PayableItem, expected: number, session: ClientSession): Promise<void> {
    transaction(session);
    const result = await this.records.replaceOne(
      { tenantId: this.tenant(), id: value.id, version: expected },
      record(value),
      { session, timestamps: false, runValidators: true },
    );
    if (result.matchedCount !== 1 || result.modifiedCount !== 1) {
      throw new ConflictException({ code: 'PAYABLE_VERSION_CONFLICT', message: '应付事项版本已变化' });
    }
  }

  async search(input: { readonly status?: PayableStatus; readonly afterId?: string; readonly limit: number }) {
    const tenantId = this.tenant();
    const rows = await this.records.find({
      tenantId,
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.afterId === undefined ? {} : { id: { $gt: input.afterId } }),
    }).sort({ id: 1 }).limit(input.limit + 1).lean().exec();
    const values = rows.map((row) => restore(
      row as unknown as Record<string, unknown>, tenantId,
    ));
    if (values.some((value) =>
      (input.status !== undefined && value.status !== input.status) ||
      (input.afterId !== undefined && value.id <= input.afterId))) corrupted();
    orderedUnique(values);
    return page(values, input.limit);
  }

  /** 收益投影的有界最小来源；不返回超过 500 条的静默截断结果。 */
  async listBySupplier(supplierId: string): Promise<readonly PayableItem[]> {
    const tenantId = this.tenant();
    const rows = await this.records.find({ tenantId, supplierId })
      .sort({ id: -1 }).limit(501).lean().exec();
    if (rows.length > 500) throw new Error('PAYABLE_SUPPLIER_INCOME_LIMIT_EXCEEDED');
    const values = rows.map((row) => restore(
      row as unknown as Record<string, unknown>, tenantId,
    ));
    if (values.some((value) => value.supplierId !== supplierId) ||
        new Set(values.map((value) => value.id)).size !== values.length) corrupted();
    for (let index = 1; index < values.length; index += 1) {
      if (values[index - 1]!.id <= values[index]!.id) corrupted();
    }
    return Object.freeze(values);
  }

  private tenant(): string { return this.context.getTenantRequired().tenantId; }
}

function restore(row: Record<string, unknown>, tenantId: string): PayableItem {
  const value = toPayableDomain(row);
  if (value.tenantId !== tenantId) corrupted();
  return value;
}

function orderedUnique(values: readonly PayableItem[]): void {
  if (new Set(values.map((value) => value.id)).size !== values.length) corrupted();
  for (let index = 1; index < values.length; index += 1) {
    if (values[index - 1]!.id >= values[index]!.id) corrupted();
  }
}

function page(values: readonly PayableItem[], limit: number) {
  const more = values.length > limit;
  const selected = more ? values.slice(0, limit) : values;
  return Object.freeze({
    items: Object.freeze(selected),
    nextCursor: more ? selected.at(-1)?.id ?? null : null,
  });
}

function record(value: PayableItem) {
  return { ...value, createdAt: new Date(value.createdAt), updatedAt: new Date(value.updatedAt) };
}

function transaction(session: ClientSession): void {
  if (!session.inTransaction()) throw new Error('PAYABLE_TRANSACTION_REQUIRED');
}

function corrupted(): never { throw new Error('PAYABLE_PERSISTED_BINDING_INVALID'); }
