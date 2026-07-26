import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createEventId } from '@gaoq/shared-utils';
import type { ClientSession, Model } from 'mongoose';

import { AttendanceDataCryptoService } from '../attendance/persistence/attendance-data-crypto.service.js';
import type { AttendanceProviderCode } from './attendance-provider.adapter.js';
import {
  AttendanceProviderEmployeeMappingRecord,
  type AttendanceProviderEmployeeMappingDocument,
  AttendanceProviderStateRecord,
  type AttendanceProviderStateDocument,
} from './attendance-provider.schemas.js';

/** 平台开户成功后，在同一事务中建立考勤外部员工 ID 的加密映射。 */
@Injectable()
export class AttendanceProviderMappingRepository {
  constructor(
    @InjectModel(AttendanceProviderEmployeeMappingRecord.name)
    private readonly mappings: Model<AttendanceProviderEmployeeMappingDocument>,
    @InjectModel(AttendanceProviderStateRecord.name)
    private readonly states: Model<AttendanceProviderStateDocument>,
    private readonly crypto: AttendanceDataCryptoService,
  ) {}

  async ensure(
    tenantId: string,
    providerCode: AttendanceProviderCode,
    employeeId: string,
    externalEmployeeId: string,
    session: ClientSession,
  ): Promise<void> {
    await this.states.updateOne(
      { tenantId, providerCode },
      { $setOnInsert: {
        id: createEventId(), tenantId, providerCode, timeZone: 'Asia/Shanghai',
        status: 'disabled', cursorKeyId: null, cursorIv: null,
        cursorCiphertext: null, cursorAuthTag: null, lastPolledAt: null,
        committedThroughDate: null,
        nextPollAt: new Date(), lastFailureCode: null,
      } },
      { upsert: true, session, runValidators: true },
    );
    const fingerprints = this.crypto.providerFingerprints(
      tenantId, 'employee', providerCode, externalEmployeeId,
    );
    const existing = await this.mappings.findOne({
      tenantId, providerCode, externalIdBlindIndexes: { $in: [...fingerprints] },
    }).session(session).lean().exec();
    if (existing !== null) {
      if (existing.employeeId !== employeeId || existing.status !== 'active') {
        throw new Error('ATTENDANCE_PROVIDER_EMPLOYEE_MAPPING_CONFLICT');
      }
      return;
    }
    const id = createEventId();
    const protectedId = this.crypto.protect({
      tenantId, resourceType: 'provider_mapping', resourceId: id,
    }, externalEmployeeId);
    await this.mappings.create([{
      id, tenantId, providerCode, employeeId,
      externalIdBlindIndexes: [...fingerprints],
      externalIdKeyId: protectedId.keyId, externalIdIv: protectedId.iv,
      externalIdCiphertext: protectedId.ciphertext, externalIdAuthTag: protectedId.authTag,
      status: 'active',
    }], { session });
  }
}
