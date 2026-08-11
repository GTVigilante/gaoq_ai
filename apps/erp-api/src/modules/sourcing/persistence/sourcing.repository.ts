import { ConflictException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { SourcingRequest, SourcingStatus } from '../domain/sourcing.js';
import {
  SourcingRequestRecord,
  type SourcingRequestDocument,
  toSourcingDomain,
} from './sourcing.schema.js';

export interface SourcingSearch {
  readonly status?: SourcingStatus;
  readonly serviceCategoryCode?: string;
  readonly departmentIds?: readonly string[];
  readonly afterId?: string;
  readonly limit: number;
}

export interface SupplierOpportunitySearch {
  readonly supplierId: string;
  readonly afterId?: string;
  readonly limit: number;
  readonly at: Date;
}

@Injectable()
export class SourcingRepository {
  constructor(
    private readonly context: TenantContextService,
    @InjectModel(SourcingRequestRecord.name)
    private readonly records: Model<SourcingRequestDocument>,
  ) {}

  async insert(value: SourcingRequest, session: ClientSession): Promise<void> {
    transaction(session);
    await this.records.create([record(value)], { session });
  }

  async findById(id: string, session?: ClientSession): Promise<SourcingRequest | null> {
    const tenantId = this.tenant();
    const query = this.records.findOne({ tenantId, id });
    if (session !== undefined) query.session(session);
    const row = await query.lean().exec();
    if (row === null) return null;
    const value = restore(row as unknown as Record<string, unknown>, tenantId);
    if (value.id !== id) corrupted();
    return value;
  }

  async replace(
    value: SourcingRequest,
    expectedVersion: number,
    session: ClientSession,
  ): Promise<void> {
    transaction(session);
    const result = await this.records.replaceOne(
      { tenantId: this.tenant(), id: value.id, version: expectedVersion },
      record(value),
      { session, timestamps: false, runValidators: true },
    );
    if (result.matchedCount !== 1 || result.modifiedCount !== 1) {
      throw new ConflictException({
        code: 'SOURCING_VERSION_CONFLICT',
        message: '寻源需求版本已变化',
      });
    }
  }

  async search(input: SourcingSearch): Promise<{
    readonly items: readonly SourcingRequest[];
    readonly nextCursor: string | null;
  }> {
    const tenantId = this.tenant();
    const query: Record<string, unknown> = {
      tenantId,
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.serviceCategoryCode === undefined
        ? {}
        : { serviceCategoryCode: input.serviceCategoryCode }),
      ...(input.departmentIds === undefined
        ? {}
        : { responsibleDepartmentId: { $in: [...input.departmentIds] } }),
      ...(input.afterId === undefined ? {} : { id: { $gt: input.afterId } }),
    };
    const rows = await this.records.find(query).sort({ id: 1 })
      .limit(input.limit + 1).lean().exec();
    const values = rows.map((row) => restore(
      row as unknown as Record<string, unknown>, tenantId,
    ));
    if (values.some((value) =>
      (input.status !== undefined && value.status !== input.status) ||
      (input.serviceCategoryCode !== undefined &&
        value.serviceCategoryCode !== input.serviceCategoryCode) ||
      (input.departmentIds !== undefined &&
        !input.departmentIds.includes(value.responsibleDepartmentId)) ||
      (input.afterId !== undefined && value.id <= input.afterId))) corrupted();
    orderedUnique(values);
    return page(values, input.limit);
  }

  /** 只读取当前供应方可见且仍在响应期内的已发布机会。 */
  async searchSupplierOpportunities(input: SupplierOpportunitySearch): Promise<{
    readonly items: readonly SourcingRequest[];
    readonly nextCursor: string | null;
  }> {
    const tenantId = this.tenant();
    const rows = await this.records.find({
      tenantId,
      status: 'published',
      responseDueAt: { $gte: input.at },
      $or: [
        { mode: 'open_invitation' },
        { invitedSupplierIds: input.supplierId },
      ],
      ...(input.afterId === undefined ? {} : { id: { $gt: input.afterId } }),
    }).sort({ id: 1 }).limit(input.limit + 1).lean().exec();
    const at = input.at.toISOString();
    const values = rows.map((row) => restore(
      row as unknown as Record<string, unknown>, tenantId,
    ));
    if (values.some((value) => value.status !== 'published' ||
        value.responseDueAt < at ||
        (value.mode !== 'open_invitation' &&
          !value.invitedSupplierIds.includes(input.supplierId)) ||
        (input.afterId !== undefined && value.id <= input.afterId))) corrupted();
    orderedUnique(values);
    return page(values, input.limit);
  }

  private tenant(): string { return this.context.getTenantRequired().tenantId; }
}

function restore(row: Record<string, unknown>, tenantId: string): SourcingRequest {
  const value = toSourcingDomain(row);
  if (value.tenantId !== tenantId) corrupted();
  return value;
}

function orderedUnique(values: readonly SourcingRequest[]): void {
  if (new Set(values.map((value) => value.id)).size !== values.length) corrupted();
  for (let index = 1; index < values.length; index += 1) {
    if (values[index - 1]!.id >= values[index]!.id) corrupted();
  }
}

function page(values: readonly SourcingRequest[], limit: number): {
  readonly items: readonly SourcingRequest[];
  readonly nextCursor: string | null;
} {
  const hasMore = values.length > limit;
  const selected = hasMore ? values.slice(0, limit) : values;
  return Object.freeze({
    items: Object.freeze(selected),
    nextCursor: hasMore ? selected.at(-1)?.id ?? null : null,
  });
}

function record(value: SourcingRequest): Record<string, unknown> {
  return {
    ...value,
    responseDueAt: new Date(value.responseDueAt),
    invitedSupplierIds: [...value.invitedSupplierIds],
    responses: value.responses.map((entry) => ({
      ...entry,
      submittedAt: new Date(entry.submittedAt),
    })),
    award: value.award === null ? null : {
      ...value.award,
      awardedAt: new Date(value.award.awardedAt),
    },
    createdAt: new Date(value.createdAt),
    updatedAt: new Date(value.updatedAt),
  };
}

function transaction(session: ClientSession): void {
  if (!session.inTransaction()) throw new Error('SOURCING_TRANSACTION_REQUIRED');
}

function corrupted(): never { throw new Error('SOURCING_PERSISTED_BINDING_INVALID'); }
