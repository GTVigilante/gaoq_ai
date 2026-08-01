import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MarketingLeadCryptoService } from './marketing-lead-crypto.service.js';

function service(encryption: string, blindIndex: string): MarketingLeadCryptoService {
  const values: Readonly<Record<string, string>> = {
    MARKETING_LEAD_ENCRYPTION_KEY_BASE64: encryption,
    MARKETING_LEAD_BLIND_INDEX_KEY_BASE64: blindIndex,
  };
  return new MarketingLeadCryptoService({
    get: (name: string) => values[name],
  } as never);
}

describe('营销线索数据保护', () => {
  it('联系人可在相同租户与线索 AAD 下解密', () => {
    const crypto = service(randomBytes(32).toString('base64url'), randomBytes(32).toString('base64url'));
    const protectedValue = crypto.protect('tenant-001', 'lead-001', 'creator@example.com');
    expect(protectedValue.ciphertext).not.toContain('creator');
    expect(crypto.unprotect('tenant-001', 'lead-001', protectedValue)).toBe('creator@example.com');
  });

  it('跨租户或跨线索解密失败', () => {
    const crypto = service(randomBytes(32).toString('base64url'), randomBytes(32).toString('base64url'));
    const protectedValue = crypto.protect('tenant-001', 'lead-001', '13800138000');
    expect(() => crypto.unprotect('tenant-002', 'lead-001', protectedValue)).toThrow();
    expect(() => crypto.unprotect('tenant-001', 'lead-002', protectedValue)).toThrow();
  });

  it('盲索引可重复但不暴露联系人明文', () => {
    const crypto = service(randomBytes(32).toString('base64url'), randomBytes(32).toString('base64url'));
    const first = crypto.blindIndex('tenant-001', 'Creator@Example.com');
    const second = crypto.blindIndex('tenant-001', 'creator@example.com');
    expect(first).toBe(second);
    expect(first).toHaveLength(43);
    expect(first).not.toContain('creator');
  });
});
