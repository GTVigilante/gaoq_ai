import {
  createCipheriv,
  hkdfSync,
  randomBytes,
} from 'node:crypto';

import { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';

import type { AppEnvironment } from '../../../config/environment.js';
import { AttendanceDomainError } from '../domain/index.js';
import {
  AttendanceDataCryptoService,
  type AttendanceCryptoContext,
  type ProtectedAttendanceData,
} from './attendance-data-crypto.service.js';

const OLD_KEY = Buffer.alloc(32, 1).toString('base64url');
const NEW_KEY = Buffer.alloc(32, 2).toString('base64url');
const OLD_BLIND_KEY = Buffer.alloc(32, 3).toString('base64url');
const NEW_BLIND_KEY = Buffer.alloc(32, 4).toString('base64url');
const context: AttendanceCryptoContext = Object.freeze({
  tenantId: 'tenant-001',
  resourceType: 'source_fact',
  resourceId: 'fact-001',
});

function encryptionRing(
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    activeKeyId: 'attendance-key-new',
    keys: [{
      keyId: 'attendance-key-new',
      keyBase64url: NEW_KEY,
      status: 'active',
    }],
    ...overrides,
  };
}

function blindRing(
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    activeKeyId: 'attendance-blind-new',
    keys: [{
      keyId: 'attendance-blind-new',
      keyBase64url: NEW_BLIND_KEY,
      status: 'active',
    }],
    ...overrides,
  };
}

function service(input: {
  readonly encryption?: unknown;
  readonly blind?: unknown;
  readonly rawEncryption?: string;
  readonly rawBlind?: string;
} = {}): AttendanceDataCryptoService {
  return new AttendanceDataCryptoService(new ConfigService<AppEnvironment, true>({
    ATTENDANCE_DATA_ENCRYPTION_KEYS: input.rawEncryption ??
      JSON.stringify(input.encryption ?? encryptionRing()),
    ATTENDANCE_BLIND_INDEX_KEYS: input.rawBlind ??
      JSON.stringify(input.blind ?? blindRing()),
  } as AppEnvironment));
}

function expectCode(operation: () => unknown, code: string): void {
  let thrown: unknown;
  try {
    operation();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(AttendanceDomainError);
  expect(thrown).toMatchObject({ code });
}

describe('Attendance L4 加密失败关闭', () => {
  it('加密密钥无停机轮换：新写入使用 active，旧密文使用 decrypt_only 解密', () => {
    const old = service({
      encryption: {
        activeKeyId: 'attendance-key-old',
        keys: [{
          keyId: 'attendance-key-old',
          keyBase64url: OLD_KEY,
          status: 'active',
        }],
      },
    });
    const protectedOld = old.protect(context, { occurredAt: '2026-04-01T01:00:00.000Z' });
    const rotated = service({
      encryption: {
        activeKeyId: 'attendance-key-new',
        keys: [
          {
            keyId: 'attendance-key-new',
            keyBase64url: NEW_KEY,
            status: 'active',
          },
          {
            keyId: 'attendance-key-old',
            keyBase64url: OLD_KEY,
            status: 'decrypt_only',
          },
        ],
      },
    });
    expect(rotated.unprotect(context, protectedOld)).toEqual({
      occurredAt: '2026-04-01T01:00:00.000Z',
    });
    expect(rotated.protect(context, { version: 2 }).keyId).toBe('attendance-key-new');
  });

  it('盲索引轮换同时生成 active 与 lookup_only 指纹且全部冻结', () => {
    const crypto = service({
      blind: {
        activeKeyId: 'attendance-blind-new',
        keys: [
          {
            keyId: 'attendance-blind-new',
            keyBase64url: NEW_BLIND_KEY,
            status: 'active',
          },
          {
            keyId: 'attendance-blind-old',
            keyBase64url: OLD_BLIND_KEY,
            status: 'lookup_only',
          },
        ],
      },
    });
    const values = crypto.providerFingerprints(
      'tenant-001',
      'employee',
      'dingtalk',
      'external-employee-001',
    );
    expect(values).toHaveLength(2);
    expect(values[0]).toMatch(/^attendance-blind-new\.[A-Za-z0-9_-]{43}$/);
    expect(values[1]).toMatch(/^attendance-blind-old\.[A-Za-z0-9_-]{43}$/);
    expect(Object.isFrozen(values)).toBe(true);
  });

  it.each([
    ['重复 keyId', {
      activeKeyId: 'duplicate',
      keys: [
        { keyId: 'duplicate', keyBase64url: OLD_KEY, status: 'active' },
        { keyId: 'duplicate', keyBase64url: NEW_KEY, status: 'decrypt_only' },
      ],
    }],
    ['没有 active', {
      activeKeyId: 'old',
      keys: [{ keyId: 'old', keyBase64url: OLD_KEY, status: 'decrypt_only' }],
    }],
    ['多个 active', {
      activeKeyId: 'old',
      keys: [
        { keyId: 'old', keyBase64url: OLD_KEY, status: 'active' },
        { keyId: 'new', keyBase64url: NEW_KEY, status: 'active' },
      ],
    }],
    ['activeKeyId 不匹配', {
      activeKeyId: 'missing',
      keys: [{ keyId: 'old', keyBase64url: OLD_KEY, status: 'active' }],
    }],
    ['未知字段', {
      ...encryptionRing(),
      unexpectedField: true,
    }],
    ['空密钥', {
      activeKeyId: 'old',
      keys: [],
    }],
  ])('加密密钥环%s时统一失败关闭', (_name, ring) => {
    expectCode(
      () => service({ encryption: ring }).protect(context, {}),
      'ATTENDANCE_DATA_KEY_RING_INVALID',
    );
  });

  it.each([
    ['重复 keyId', {
      activeKeyId: 'duplicate',
      keys: [
        { keyId: 'duplicate', keyBase64url: OLD_BLIND_KEY, status: 'active' },
        { keyId: 'duplicate', keyBase64url: NEW_BLIND_KEY, status: 'lookup_only' },
      ],
    }],
    ['没有 active', {
      activeKeyId: 'old',
      keys: [{ keyId: 'old', keyBase64url: OLD_BLIND_KEY, status: 'lookup_only' }],
    }],
    ['多个 active', {
      activeKeyId: 'old',
      keys: [
        { keyId: 'old', keyBase64url: OLD_BLIND_KEY, status: 'active' },
        { keyId: 'new', keyBase64url: NEW_BLIND_KEY, status: 'active' },
      ],
    }],
    ['activeKeyId 不匹配', {
      activeKeyId: 'missing',
      keys: [{ keyId: 'old', keyBase64url: OLD_BLIND_KEY, status: 'active' }],
    }],
  ])('盲索引密钥环%s时统一失败关闭', (_name, ring) => {
    expectCode(
      () => service({ blind: ring }).sourceEventFingerprints(
        'tenant-001',
        'dingtalk',
        'event-001',
      ),
      'ATTENDANCE_DATA_KEY_RING_INVALID',
    );
  });

  it('缺失、非 JSON 与错误密钥配置均不回显原配置', () => {
    for (const rawEncryption of ['', '{bad-json', JSON.stringify({
      activeKeyId: 'old',
      keys: [{ keyId: 'old', keyBase64url: 'not-a-key', status: 'active' }],
    })]) {
      expectCode(
        () => service({ rawEncryption }).protect(context, {}),
        'ATTENDANCE_DATA_KEY_RING_INVALID',
      );
    }
    expectCode(
      () => service({ rawBlind: '{bad-json' }).sourceEventFingerprints(
        'tenant-001',
        'dingtalk',
        'event-001',
      ),
      'ATTENDANCE_DATA_KEY_RING_INVALID',
    );
  });

  it.each([
    ['租户', { tenantId: 'bad tenant' }],
    ['资源标识', { resourceId: '' }],
    ['资源类型', { resourceType: 'payroll' }],
  ])('%s上下文非法时在读取密钥前失败关闭', (_name, overrides) => {
    expectCode(
      () => service().protect({ ...context, ...overrides } as never, {}),
      'ATTENDANCE_DATA_CIPHERTEXT_INVALID',
    );
  });

  it.each([
    ['Provider', 'bad provider', 'event-001'],
    ['空外部标识', 'dingtalk', ''],
    ['超长外部标识', 'dingtalk', 'x'.repeat(257)],
  ])('%s盲索引输入非法时失败关闭', (_name, providerCode, externalId) => {
    expectCode(
      () => service().sourceEventFingerprints('tenant-001', providerCode, externalId),
      'ATTENDANCE_DATA_CIPHERTEXT_INVALID',
    );
  });

  it('明文超限或无法 JSON 序列化时失败关闭', () => {
    const crypto = service();
    expectCode(
      () => crypto.protect(context, { value: 'x'.repeat(256 * 1024) }),
      'ATTENDANCE_DATA_CIPHERTEXT_INVALID',
    );
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expectCode(
      () => crypto.protect(context, cyclic),
      'ATTENDANCE_DATA_CIPHERTEXT_INVALID',
    );
    expectCode(
      () => crypto.protect(context, undefined),
      'ATTENDANCE_DATA_CIPHERTEXT_INVALID',
    );
  });

  it('密文编码长度在解码前受限，未知 keyId 单独分类', () => {
    const crypto = service();
    const valid = crypto.protect(context, { value: 'safe' });
    const invalidValues: readonly ProtectedAttendanceData[] = [
      { ...valid, keyId: 'bad key' },
      { ...valid, iv: '*' },
      { ...valid, iv: 'A'.repeat(15) },
      { ...valid, ciphertext: '*' },
      { ...valid, ciphertext: 'A'.repeat(Math.ceil((256 * 1024) * 4 / 3) + 1) },
      { ...valid, authTag: '*' },
      { ...valid, authTag: 'A'.repeat(21) },
    ];
    for (const value of invalidValues) {
      expectCode(
        () => crypto.unprotect(context, value),
        'ATTENDANCE_DATA_CIPHERTEXT_INVALID',
      );
    }
    expectCode(
      () => crypto.unprotect(context, { ...valid, keyId: 'missing-key' }),
      'ATTENDANCE_DATA_KEY_UNAVAILABLE',
    );
  });

  it('规范 Base64URL、IV、Tag、认证和 JSON 任一受损都拒绝解密', () => {
    const crypto = service();
    const valid = crypto.protect(context, { value: 'safe' });
    for (const value of [
      { ...valid, ciphertext: 'A' },
      { ...valid, iv: Buffer.alloc(12, 9).toString('base64url') },
      { ...valid, authTag: Buffer.alloc(16, 9).toString('base64url') },
    ]) {
      expectCode(
        () => crypto.unprotect(context, value),
        'ATTENDANCE_DATA_CIPHERTEXT_INVALID',
      );
    }

    const iv = randomBytes(12);
    const key = Buffer.from(hkdfSync(
      'sha256',
      Buffer.from(NEW_KEY, 'base64url'),
      Buffer.from('gaoq-attendance-data-v1'),
      Buffer.from('sensitive-data-encryption-v1'),
      32,
    ));
    const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    cipher.setAAD(Buffer.from(JSON.stringify([
      'gaoq-attendance-data-v1',
      context.tenantId,
      context.resourceType,
      context.resourceId,
    ])));
    const ciphertext = Buffer.concat([cipher.update('not-json', 'utf8'), cipher.final()]);
    expectCode(() => crypto.unprotect(context, {
      keyId: 'attendance-key-new',
      iv: iv.toString('base64url'),
      ciphertext: ciphertext.toString('base64url'),
      authTag: cipher.getAuthTag().toString('base64url'),
    }), 'ATTENDANCE_DATA_CIPHERTEXT_INVALID');
    key.fill(0);
  });
});
