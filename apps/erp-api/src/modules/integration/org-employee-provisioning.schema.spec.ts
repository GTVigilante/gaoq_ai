import { Mongoose } from 'mongoose';
import { describe, expect, it } from 'vitest';

import {
  OrgEmployeeProvisioningRequestSchema,
  type OrgEmployeeProvisioningRequest,
} from './org-employee-provisioning.schema.js';

/**
 * 不连库校验：独立 Mongoose 实例仅用于注册模型，
 * document.validate() 在内存中执行校验器，不发起任何连接。
 */
const mongoose = new Mongoose();

const ProvisioningModel = mongoose.model<OrgEmployeeProvisioningRequest>(
  'SpecOrgEmployeeProvisioning',
  OrgEmployeeProvisioningRequestSchema,
);

const VALID_ULID = '01J8ZQK7V0A2M4N6P8R0T2W4Y6';
/** 合法 SHA-256 base64url 摘要（43 字符）。 */
const VALID_DIGEST = 'a'.repeat(43);

/** 构造合法文档字段。 */
function validDoc(): Record<string, unknown> {
  return {
    tenantId: 'tenant-a',
    requestId: VALID_ULID,
    employeeId: 'emp:001-A',
    channel: 'dingtalk',
    requestedByActorId: 'actor-1',
    idempotencyKey: 'idem-key-001',
    inputDigest: VALID_DIGEST,
    payloadKeyId: 'kek-2026-01',
    payloadIv: 'a'.repeat(16),
    payloadCiphertext: 'Y2lwaGVydGV4dA',
    payloadAuthTag: 'b'.repeat(22),
    status: 'pending',
    attempts: 0,
    nextAttemptAt: new Date('2026-01-01T00:00:00.000Z'),
    sensitiveExpiresAt: new Date('2026-01-02T00:00:00.000Z'),
    purgeAt: new Date('2026-02-01T00:00:00.000Z'),
  };
}

/** 校验文档，期望通过；失败时抛出带校验明细的异常。 */
async function expectValid(fields: Record<string, unknown>): Promise<void> {
  await new ProvisioningModel(fields).validate();
}

/** 校验文档，期望失败且错误信息命中指定字段。 */
async function expectInvalid(fields: Record<string, unknown>, path: string): Promise<void> {
  await expect(new ProvisioningModel(fields).validate()).rejects.toThrowError(
    new RegExp(path),
  );
}

describe('OrgEmployeeProvisioningRequestSchema', () => {
  it('集合名与 Schema 选项正确', () => {
    expect(OrgEmployeeProvisioningRequestSchema.get('collection')).toBe(
      'integration_org_employee_provisioning_requests',
    );
    expect(OrgEmployeeProvisioningRequestSchema.get('timestamps')).toBe(true);
    expect(OrgEmployeeProvisioningRequestSchema.get('versionKey')).toBe(false);
    expect(OrgEmployeeProvisioningRequestSchema.get('id')).toBe(false);
  });

  it('索引齐备：幂等唯一、调度、敏感到期、purgeAt TTL', () => {
    const indexes = OrgEmployeeProvisioningRequestSchema.indexes();
    const hasIndex = (
      keys: Record<string, number>,
      predicate?: (options: Record<string, unknown>) => boolean,
    ): boolean =>
      indexes.some(([indexKeys, options]) => {
        const keysMatch =
          JSON.stringify(indexKeys) === JSON.stringify(keys);
        return keysMatch && (predicate ? predicate(options) : true);
      });

    expect(
      hasIndex(
        { tenantId: 1, channel: 1, idempotencyKey: 1 },
        (options) => options.unique === true,
      ),
    ).toBe(true);
    expect(hasIndex({ status: 1, nextAttemptAt: 1 })).toBe(true);
    expect(hasIndex({ sensitiveExpiresAt: 1 })).toBe(true);
    expect(
      hasIndex({ purgeAt: 1 }, (options) => options.expireAfterSeconds === 0),
    ).toBe(true);
  });

  it('合法文档校验通过', async () => {
    await expectValid(validDoc());
  });

  it('status 枚举：5 个合法值通过，非法值被拒绝', async () => {
    for (const status of ['pending', 'processing', 'succeeded', 'manual_review', 'expired']) {
      await expectValid({ ...validDoc(), status });
    }
    await expectInvalid({ ...validDoc(), status: 'dead' }, 'status');
  });

  it('requestId 必须为 ULID 形态', async () => {
    await expectInvalid({ ...validDoc(), requestId: 'not-a-ulid' }, 'requestId');
  });

  it('employeeId 必须为受控字符集', async () => {
    await expectInvalid({ ...validDoc(), employeeId: 'emp#001' }, 'employeeId');
  });

  it('idempotencyKey 必须为受控字符集', async () => {
    await expectInvalid(
      { ...validDoc(), idempotencyKey: 'key with space' },
      'idempotencyKey',
    );
    await expectInvalid({ ...validDoc(), idempotencyKey: 'short' }, 'idempotencyKey');
  });

  it('inputDigest 必须为 43 字符 base64url', async () => {
    await expectInvalid({ ...validDoc(), inputDigest: 'too-short' }, 'inputDigest');
    await expectInvalid(
      { ...validDoc(), inputDigest: `${'a'.repeat(42)}+` },
      'inputDigest',
    );
  });

  it('lastErrorCode 必须为大写错误码形态', async () => {
    await expectValid({ ...validDoc(), lastErrorCode: 'PROVISIONING_RETRYABLE' });
    await expectInvalid({ ...validDoc(), lastErrorCode: 'lowercase' }, 'lastErrorCode');
  });

  it('密文字段允许置 null（终态擦除）', async () => {
    await expectValid({
      ...validDoc(),
      payloadIv: null,
      payloadCiphertext: null,
      payloadAuthTag: null,
    });
  });

  it('密文字段非 base64url 被拒绝', async () => {
    await expectInvalid({ ...validDoc(), payloadCiphertext: 'not base64!' }, 'payloadCiphertext');
    await expectInvalid({ ...validDoc(), payloadIv: 'iv+with+plus' }, 'payloadIv');
    await expectInvalid({ ...validDoc(), payloadAuthTag: 'tag=with=pad' }, 'payloadAuthTag');
  });

  it('IV、认证标签与密文容量均失败关闭', async () => {
    await expectInvalid({ ...validDoc(), payloadIv: 'a'.repeat(15) }, 'payloadIv');
    await expectInvalid({ ...validDoc(), payloadAuthTag: 'a'.repeat(21) }, 'payloadAuthTag');
    await expectInvalid({ ...validDoc(), payloadCiphertext: 'a'.repeat(1025) }, 'payloadCiphertext');
  });

  it('attempts 边界：0 与 6 通过，7 与负数被拒绝', async () => {
    await expectValid({ ...validDoc(), attempts: 0 });
    await expectValid({ ...validDoc(), attempts: 6 });
    await expectInvalid({ ...validDoc(), attempts: 7 }, 'attempts');
    await expectInvalid({ ...validDoc(), attempts: -1 }, 'attempts');
    await expectInvalid({ ...validDoc(), attempts: 1.5 }, 'attempts');
  });

  it('必需日期字段缺失被拒绝', async () => {
    await expectInvalid({ ...validDoc(), nextAttemptAt: undefined }, 'nextAttemptAt');
    await expectInvalid({ ...validDoc(), sensitiveExpiresAt: undefined }, 'sensitiveExpiresAt');
    await expectInvalid({ ...validDoc(), purgeAt: undefined }, 'purgeAt');
  });

  it('Schema 严禁存在手机号/邮箱/联系方式明文字段', () => {
    expect(OrgEmployeeProvisioningRequestSchema.path('mobile')).toBeUndefined();
    expect(OrgEmployeeProvisioningRequestSchema.path('email')).toBeUndefined();
    expect(OrgEmployeeProvisioningRequestSchema.path('contact')).toBeUndefined();
    expect(OrgEmployeeProvisioningRequestSchema.path('phone')).toBeUndefined();
    expect(OrgEmployeeProvisioningRequestSchema.path('countryCode')).toBeUndefined();
    expect(OrgEmployeeProvisioningRequestSchema.path('subscriberNumber')).toBeUndefined();
  });
});
