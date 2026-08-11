import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';

import {
  SupplierRelationshipRecord,
  type SupplierRelationshipDocument,
} from './supplier.schemas.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;

export interface SupplierQualificationScanCandidate {
  readonly tenantId: string;
  readonly supplierId: string;
  readonly version: number;
}

/** Worker 专用全局最小投影；只发现候选，真实状态仍由租户内应用服务复核。 */
@Injectable()
export class SupplierQualificationScanRepository {
  constructor(
    @InjectModel(SupplierRelationshipRecord.name)
    private readonly records: Model<SupplierRelationshipDocument>,
  ) {}

  async listCandidates(
    warningDate: string,
    after: { readonly tenantId: string; readonly supplierId: string } | null,
    limit = 200,
  ): Promise<readonly SupplierQualificationScanCandidate[]> {
    const cursor = after === null ? {} : {
      $or: [
        { tenantId: { $gt: after.tenantId } },
        { tenantId: after.tenantId, id: { $gt: after.supplierId } },
      ],
    };
    const rows = await this.records.find({
      $and: [
        { status: 'active' },
        { $or: [
          { 'qualifications.validUntil': { $lte: warningDate } },
          { 'capabilities.validUntil': { $lte: warningDate } },
        ] },
        cursor,
      ],
    }).select('tenantId id version -_id').sort({ tenantId: 1, id: 1 }).limit(limit).lean().exec();
    return Object.freeze(rows.map((row) => {
      if (!ID.test(row.tenantId) || !ULID.test(row.id) || !Number.isSafeInteger(row.version) || row.version < 1) {
        throw new Error('SUPPLIER_QUALIFICATION_SCAN_RECORD_INVALID');
      }
      return Object.freeze({ tenantId: row.tenantId, supplierId: row.id, version: row.version });
    }));
  }
}
