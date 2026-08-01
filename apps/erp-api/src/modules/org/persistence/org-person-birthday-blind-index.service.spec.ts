import type { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';

import type { AppEnvironment } from '../../../config/environment.js';
import { OrgPersonBirthdayBlindIndexService } from './org-person-birthday-blind-index.service.js';

function fixture(configured = true): OrgPersonBirthdayBlindIndexService {
  const ring = JSON.stringify({
    activeKeyId: 'birthday-active',
    keys: [
      {
        keyId: 'birthday-active',
        keyBase64url: Buffer.alloc(32, 7).toString('base64url'),
        status: 'active',
      },
      {
        keyId: 'birthday-old',
        keyBase64url: Buffer.alloc(32, 9).toString('base64url'),
        status: 'lookup_only',
      },
    ],
  });
  const config = {
    get: () => configured ? ring : undefined,
  } as unknown as ConfigService<AppEnvironment, true>;
  return new OrgPersonBirthdayBlindIndexService(config);
}

describe('OrgPersonBirthdayBlindIndexService', () => {
  it('使用独立轮换密钥生成不可逆盲索引并解析闰日', () => {
    const service = fixture();
    const fingerprints = service.fingerprints('tenant-001', '02-29');
    expect(fingerprints).toHaveLength(2);
    expect(fingerprints.every((value) =>
      /^[A-Za-z0-9._-]+\.[A-Za-z0-9_-]{43}$/.test(value),
    )).toBe(true);
    expect(JSON.stringify(fingerprints)).not.toContain('02-29');
    expect(service.resolveMonthDay('tenant-001', fingerprints)).toBe('02-29');
    expect(service.activeFingerprint('tenant-001', '02-29')).toBe(fingerprints[0]);
  });

  it('租户错位不能解析，非法日期和缺失密钥失败关闭', () => {
    const fingerprints = fixture().fingerprints('tenant-001', '07-27');
    expect(fixture().resolveMonthDay('tenant-other', fingerprints)).toBeNull();
    expect(() => fixture().fingerprints('tenant-001', '02-30'))
      .toThrow('生日月日不是合法日期');
    expect(() => fixture(false).fingerprints('tenant-001', '07-27'))
      .toThrow('自然人生日盲索引密钥环无效');
  });
});
