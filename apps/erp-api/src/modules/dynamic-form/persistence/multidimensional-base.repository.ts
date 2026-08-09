import { ConflictException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { parseMultidimensionalBaseInput, type MultidimensionalBase } from '../domain/multidimensional-base.js';
import { MultidimensionalBaseRecord, type MultidimensionalBaseDocument } from './multidimensional-base.schema.js';

@Injectable()
export class MultidimensionalBaseRepository {
  constructor(private readonly context: TenantContextService, @InjectModel(MultidimensionalBaseRecord.name) private readonly records: Model<MultidimensionalBaseDocument>) {}

  async insert(value: MultidimensionalBase, session: ClientSession): Promise<void> {
    await this.records.create([{ ...value, tables: structuredClone(value.tables), views: structuredClone(value.views), automations: structuredClone(value.automations), createdAt: new Date(value.createdAt), updatedAt: new Date(value.updatedAt) }], { session });
  }

  async replace(value: MultidimensionalBase, expectedVersion: number, session: ClientSession): Promise<void> {
    const result = await this.records.updateOne({ tenantId: this.tenant(), id: value.id, version: expectedVersion }, { $set: { name: value.name, description: value.description, tables: structuredClone(value.tables), views: structuredClone(value.views), automations: structuredClone(value.automations), version: value.version, updatedAt: new Date(value.updatedAt) } }, { session, timestamps: false, runValidators: true });
    if (result.matchedCount !== 1) throw new ConflictException({ code: 'BASE_VERSION_CONFLICT', message: '多维表格版本已变化' });
  }

  async find(id: string, session?: ClientSession): Promise<MultidimensionalBase | null> {
    const query = this.records.findOne({ tenantId: this.tenant(), id }).select('-_id').lean();
    if (session !== undefined) query.session(session);
    const row = await query.exec();
    return row === null ? null : hydrate(row, this.tenant(), id);
  }

  async list(): Promise<readonly MultidimensionalBase[]> {
    const rows = await this.records.find({ tenantId: this.tenant() }).sort({ updatedAt: -1, id: 1 }).limit(101).select('-_id').lean().exec();
    if (rows.length > 100) throw new Error('BASE_LIST_LIMIT');
    return Object.freeze(rows.map((row) => hydrate(row, this.tenant(), row.id)));
  }

  private tenant(): string { return this.context.getTenantRequired().tenantId; }
}

function hydrate(row: MultidimensionalBaseRecord, tenantId: string, id: string): MultidimensionalBase {
  if (row.tenantId !== tenantId || row.id !== id || !Number.isSafeInteger(row.version) || row.version < 1) throw new Error('BASE_STATE_INVALID');
  const parsed = parseMultidimensionalBaseInput({ code: row.code, name: row.name, description: row.description, tables: row.tables, views: row.views, automations: row.automations });
  return Object.freeze({ ...parsed, id: row.id, tenantId: row.tenantId, version: row.version, createdByActorId: row.createdByActorId, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() });
}
