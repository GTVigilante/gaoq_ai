import { randomBytes } from 'node:crypto';

import { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';

import type { AppEnvironment } from '../../../config/environment.js';
import { AttendanceDataCryptoService } from './attendance-data-crypto.service.js';

function key(): string { return randomBytes(32).toString('base64url'); }

function service(input?: {
  readonly encryptionKey?: string;
  readonly blindKey?: string;
}): AttendanceDataCryptoService {
  return new AttendanceDataCryptoService(new ConfigService<AppEnvironment, true>({
    ATTENDANCE_DATA_ENCRYPTION_KEYS: JSON.stringify({
      activeKeyId: 'attendance-key-001',
      keys: [{
        keyId: 'attendance-key-001', keyBase64url: input?.encryptionKey ?? key(), status: 'active',
      }],
    }),
    ATTENDANCE_BLIND_INDEX_KEYS: JSON.stringify({
      activeKeyId: 'attendance-blind-001',
      keys: [{
        keyId: 'attendance-blind-001', keyBase64url: input?.blindKey ?? key(), status: 'active',
      }],
    }),
  } as AppEnvironment));
}

const context = {
  tenantId: 'tenant-001', resourceType: 'source_fact' as const, resourceId: 'fact-001',
};

describe('AttendanceDataCryptoService', () => {
  it('AES-GCM 往返且 AAD 绑定租户、资源类型和资源标识', () => {
    const crypto = service();
    const protectedData = crypto.protect(context, {
      occurredAt: '2026-04-01T01:02:03.000Z', location: '办公室东门',
    });
    expect(JSON.stringify(protectedData)).not.toContain('办公室东门');
    expect(crypto.unprotect(context, protectedData)).toEqual({
      occurredAt: '2026-04-01T01:02:03.000Z', location: '办公室东门',
    });
    expect(() => crypto.unprotect({ ...context, tenantId: 'tenant-002' }, protectedData))
      .toThrow('密文或上下文无效');
    expect(() => crypto.unprotect({ ...context, resourceType: 'correction' }, protectedData))
      .toThrow('密文或上下文无效');
  });

  it('外部事件盲指纹稳定且按租户和提供方隔离，不泄露原始事件标识', () => {
    const crypto = service();
    const first = crypto.sourceEventFingerprints('tenant-001', 'dingtalk', 'external-event-001');
    expect(first).toEqual(
      crypto.sourceEventFingerprints('tenant-001', 'dingtalk', 'external-event-001'),
    );
    expect(first).not.toEqual(
      crypto.sourceEventFingerprints('tenant-002', 'dingtalk', 'external-event-001'),
    );
    expect(first).not.toEqual(
      crypto.sourceEventFingerprints('tenant-001', 'feishu', 'external-event-001'),
    );
    expect(JSON.stringify(first)).not.toContain('external-event-001');
    expect(first).not.toEqual(
      crypto.providerFingerprints('tenant-001', 'event', 'dingtalk', 'external-event-001'),
    );
    expect(crypto.providerFingerprints(
      'tenant-001', 'event', 'dingtalk', 'external-event-001',
    )).not.toEqual(crypto.providerFingerprints(
      'tenant-001', 'employee', 'dingtalk', 'external-event-001',
    ));
  });

  it('缺失或错误密钥环时失败关闭', () => {
    const crypto = new AttendanceDataCryptoService(new ConfigService<AppEnvironment, true>({
      ATTENDANCE_DATA_ENCRYPTION_KEYS: '', ATTENDANCE_BLIND_INDEX_KEYS: '',
    } as AppEnvironment));
    expect(() => crypto.protect(context, {})).toThrow('密钥环无效');
    expect(() => crypto.sourceEventFingerprints('tenant-001', 'dingtalk', 'event-001'))
      .toThrow('密钥环无效');
  });
});
