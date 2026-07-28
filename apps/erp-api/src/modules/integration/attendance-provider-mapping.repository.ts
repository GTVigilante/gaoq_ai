import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createEventId, ULID_PATTERN } from '@gaoq/shared-utils';
import type { ClientSession, Model } from 'mongoose';
import { z } from 'zod';

import { AttendanceDataCryptoService } from '../attendance/persistence/attendance-data-crypto.service.js';
import {
  AttendanceProviderEmployeeMappingRecord,
  type AttendanceProviderEmployeeMappingDocument,
  AttendanceProviderStateRecord,
  type AttendanceProviderStateDocument,
} from './attendance-provider.schemas.js';
import { OrgPushError } from './org-push.adapter.js';

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const EXTERNAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/;
const KEY_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const BLIND_INDEX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\.[A-Za-z0-9_-]{43}$/;

const mappingRequestSchema = z.object({
  tenantId: z.string().regex(ID_PATTERN),
  providerCode: z.enum(['dingtalk', 'feishu']),
  employeeId: z.string().regex(ID_PATTERN),
  externalEmployeeId: z.string().regex(EXTERNAL_ID_PATTERN),
}).strict();

const fingerprintSetSchema = z.array(
  z.string().regex(BLIND_INDEX_PATTERN),
).min(1).max(5).superRefine((values, context) => {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: 'custom', message: '考勤员工盲索引不得重复' });
  }
});

const protectedExternalIdSchema = z.object({
  keyId: z.string().regex(KEY_PATTERN),
  iv: z.string().regex(BASE64URL_PATTERN).length(16),
  ciphertext: z.string().regex(BASE64URL_PATTERN).min(1).max(1_024),
  authTag: z.string().regex(BASE64URL_PATTERN).length(22),
}).strict();

const existingMappingSchema = z.object({
  tenantId: z.string().regex(ID_PATTERN),
  providerCode: z.enum(['dingtalk', 'feishu']),
  employeeId: z.string().regex(ID_PATTERN),
  externalIdBlindIndexes: fingerprintSetSchema,
  status: z.enum(['active', 'disabled']),
}).strict();

type MappingRequest = z.infer<typeof mappingRequestSchema>;
interface ExistingMapping {
  readonly tenantId: string;
  readonly providerCode: 'dingtalk' | 'feishu';
  readonly employeeId: string;
  readonly externalIdBlindIndexes: readonly string[];
  readonly status: 'active' | 'disabled';
}

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
    tenantId: unknown,
    providerCode: unknown,
    employeeId: unknown,
    externalEmployeeId: unknown,
    sessionValue: unknown,
  ): Promise<void> {
    const request = this.requireRequest({
      tenantId,
      providerCode,
      employeeId,
      externalEmployeeId,
    });
    const session = this.requireTransaction(sessionValue);
    const fingerprints = this.requireFingerprints(this.crypto.providerFingerprints(
      request.tenantId,
      'employee',
      request.providerCode,
      request.externalEmployeeId,
    ));
    const stateResult = await this.states.updateOne(
      { tenantId: request.tenantId, providerCode: request.providerCode },
      { $setOnInsert: {
        id: createEventId(),
        tenantId: request.tenantId,
        providerCode: request.providerCode,
        timeZone: 'Asia/Shanghai',
        status: 'disabled', cursorKeyId: null, cursorIv: null,
        cursorCiphertext: null, cursorAuthTag: null, lastPolledAt: null,
        nextPollAt: new Date(), lastFailureCode: null,
      } },
      { upsert: true, session, runValidators: true },
    );
    this.assertStateResult(stateResult);
    const existingValues = await this.mappings.find(
      {
        tenantId: request.tenantId,
        providerCode: request.providerCode,
        $or: [
          { employeeId: request.employeeId },
          { externalIdBlindIndexes: { $in: [...fingerprints] } },
        ],
      },
      {
        tenantId: 1,
        providerCode: 1,
        employeeId: 1,
        externalIdBlindIndexes: 1,
        status: 1,
        _id: 0,
      },
    ).limit(2).session(session).lean().exec();
    const existing = this.requireExisting(existingValues, request, fingerprints);
    if (existing !== null) {
      return;
    }
    const id = createEventId();
    if (!ULID_PATTERN.test(id)) throw this.recordInvalid();
    const protectedId = this.requireProtectedId(this.crypto.protect({
      tenantId: request.tenantId,
      resourceType: 'provider_mapping',
      resourceId: id,
    }, request.externalEmployeeId));
    const created = await this.mappings.create([{
      id,
      tenantId: request.tenantId,
      providerCode: request.providerCode,
      employeeId: request.employeeId,
      externalIdBlindIndexes: [...fingerprints],
      externalIdKeyId: protectedId.keyId, externalIdIv: protectedId.iv,
      externalIdCiphertext: protectedId.ciphertext, externalIdAuthTag: protectedId.authTag,
      status: 'active',
    }], { session });
    this.assertCreated(created, request, id, fingerprints, protectedId);
  }

  private requireRequest(value: unknown): Readonly<MappingRequest> {
    const parsed = mappingRequestSchema.safeParse(value);
    if (!parsed.success) {
      throw new OrgPushError(
        'ORG_PROVISIONING_ATTENDANCE_MAPPING_INPUT_INVALID',
        'conflict',
        '考勤员工映射请求无效',
      );
    }
    return Object.freeze(parsed.data);
  }

  private requireTransaction(value: unknown): ClientSession {
    try {
      if (
        typeof value !== 'object' ||
        value === null ||
        typeof (value as { readonly inTransaction?: unknown }).inTransaction !== 'function' ||
        !(value as ClientSession).inTransaction()
      ) {
        throw this.transactionRequired();
      }
    } catch (error) {
      if (error instanceof OrgPushError) throw error;
      throw this.transactionRequired();
    }
    return value as ClientSession;
  }

  private requireFingerprints(value: unknown): readonly string[] {
    const parsed = fingerprintSetSchema.safeParse(value);
    if (!parsed.success) throw this.recordInvalid();
    return Object.freeze([...parsed.data]);
  }

  private requireProtectedId(value: unknown): z.infer<typeof protectedExternalIdSchema> {
    const parsed = protectedExternalIdSchema.safeParse(value);
    if (!parsed.success) throw this.recordInvalid();
    return Object.freeze(parsed.data);
  }

  private requireExisting(
    value: unknown,
    request: MappingRequest,
    fingerprints: readonly string[],
  ): ExistingMapping | null {
    if (!Array.isArray(value)) throw this.recordInvalid();
    if (value.length === 0) return null;
    if (value.length > 1) throw this.mappingConflict();
    const parsed = existingMappingSchema.safeParse(value[0]);
    if (
      !parsed.success ||
      parsed.data.tenantId !== request.tenantId ||
      parsed.data.providerCode !== request.providerCode
    ) {
      throw this.recordInvalid();
    }
    if (
      parsed.data.employeeId !== request.employeeId ||
      parsed.data.status !== 'active' ||
      !parsed.data.externalIdBlindIndexes.some((value) => fingerprints.includes(value))
    ) {
      throw this.mappingConflict();
    }
    return Object.freeze({
      ...parsed.data,
      externalIdBlindIndexes: Object.freeze([...parsed.data.externalIdBlindIndexes]),
    });
  }

  private assertStateResult(value: unknown): void {
    if (
      typeof value !== 'object' ||
      value === null ||
      (value as { readonly acknowledged?: unknown }).acknowledged !== true
    ) {
      throw this.writeUnavailable();
    }
    const matchedCount = (value as { readonly matchedCount?: unknown }).matchedCount;
    const upsertedCount = (value as { readonly upsertedCount?: unknown }).upsertedCount;
    if (
      !Number.isSafeInteger(matchedCount) ||
      !Number.isSafeInteger(upsertedCount) ||
      (matchedCount as number) < 0 ||
      (upsertedCount as number) < 0 ||
      (matchedCount as number) + (upsertedCount as number) !== 1
    ) {
      throw this.writeUnavailable();
    }
  }

  private assertCreated(
    value: unknown,
    request: MappingRequest,
    id: string,
    fingerprints: readonly string[],
    protectedId: z.infer<typeof protectedExternalIdSchema>,
  ): void {
    if (!Array.isArray(value) || value.length !== 1) throw this.writeUnavailable();
    const record = value[0] as Partial<AttendanceProviderEmployeeMappingRecord> | undefined;
    if (
      record === undefined ||
      record.id !== id ||
      record.tenantId !== request.tenantId ||
      record.providerCode !== request.providerCode ||
      record.employeeId !== request.employeeId ||
      record.status !== 'active' ||
      !Array.isArray(record.externalIdBlindIndexes) ||
      record.externalIdBlindIndexes.length !== fingerprints.length ||
      !record.externalIdBlindIndexes.every(
        (value, index) => value === fingerprints[index],
      ) ||
      record.externalIdKeyId !== protectedId.keyId ||
      record.externalIdIv !== protectedId.iv ||
      record.externalIdCiphertext !== protectedId.ciphertext ||
      record.externalIdAuthTag !== protectedId.authTag
    ) {
      throw this.writeUnavailable();
    }
  }

  private transactionRequired(): OrgPushError {
    return new OrgPushError(
      'ORG_PROVISIONING_ATTENDANCE_MAPPING_TRANSACTION_REQUIRED',
      'conflict',
      '考勤员工映射必须在活动事务中写入',
    );
  }

  private recordInvalid(): OrgPushError {
    return new OrgPushError(
      'ORG_PROVISIONING_ATTENDANCE_MAPPING_RECORD_INVALID',
      'conflict',
      '考勤员工映射记录无效',
    );
  }

  private mappingConflict(): OrgPushError {
    return new OrgPushError(
      'ORG_PROVISIONING_ATTENDANCE_MAPPING_CONFLICT',
      'conflict',
      '考勤员工映射与平台开户身份冲突',
    );
  }

  private writeUnavailable(): OrgPushError {
    return new OrgPushError(
      'ORG_PROVISIONING_ATTENDANCE_MAPPING_WRITE_UNAVAILABLE',
      'retryable',
      '考勤员工映射暂时无法写入',
    );
  }
}
