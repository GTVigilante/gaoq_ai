import { generateKeyPairSync } from 'node:crypto';

import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';

import type { AppEnvironment } from '../../../config/environment.js';
import { CareAlumniCleanupTargetRegistry } from './care-alumni-cleanup-target-registry.js';

const crmKey = generateKeyPairSync('ed25519').publicKey.export({
  format: 'der',
  type: 'spki',
}).toString('base64');
const notifyKey = generateKeyPairSync('ed25519').publicKey.export({
  format: 'der',
  type: 'spki',
}).toString('base64');

describe('CareAlumniCleanupTargetRegistry', () => {
  it('从服务端 Secret 配置构造排序后的只读索引', () => {
    const get = vi.fn().mockReturnValue(JSON.stringify([
      target({
        targetCode: 'notify',
        endpoint: 'https://privacy-notify.example.net',
        bearerToken: 'notify-cleanup-token-distinct-at-least-32-characters',
        signingKeyId: 'notify-key-v1',
        signingPublicKeyBase64: notifyKey,
      }),
      target(),
    ]));
    const registry = new CareAlumniCleanupTargetRegistry({
      get,
    } as unknown as ConfigService<AppEnvironment, true>);
    expect(get).toHaveBeenCalledWith(
      'CARE_ALUMNI_CLEANUP_TARGETS_JSON',
      { infer: true },
    );
    expect(registry.targets().map((value) => value.targetCode)).toEqual([
      'crm',
      'notify',
    ]);
    expect(Object.isFrozen(registry.targets())).toBe(true);
    expect(registry.require('crm')).toBe(registry.targets()[0]);
    expect(registry.require('notify')).toBe(registry.targets()[1]);
  });

  it.each(['', 'CRM', 'a', 'bad target', 'x'.repeat(33)])(
    '拒绝非法运行时目标代码 %s',
    (targetCode) => {
      const registry = registryWith([]);
      expect(() => registry.require(targetCode)).toThrow(
        'CARE_ALUMNI_CLEANUP_TARGET_CODE_INVALID',
      );
    },
  );

  it('对合法但未登记的目标失败关闭', () => {
    const registry = registryWith([]);
    expect(() => registry.require('crm')).toThrow(
      'CARE_ALUMNI_CLEANUP_TARGET_NOT_REGISTERED',
    );
  });

  it('配置解析失败时不构造半成品注册表', () => {
    expect(() => registryWith('{')).toThrow('合法 JSON');
  });
});

function registryWith(value: unknown): CareAlumniCleanupTargetRegistry {
  return new CareAlumniCleanupTargetRegistry({
    get: vi.fn().mockReturnValue(
      typeof value === 'string' ? value : JSON.stringify(value),
    ),
  } as unknown as ConfigService<AppEnvironment, true>);
}

function target(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    targetCode: 'crm',
    endpoint: 'https://privacy-crm.example.net',
    bearerToken: 'crm-cleanup-token-distinct-at-least-32-characters',
    policyVersion: 'privacy-v1',
    signingKeyId: 'crm-key-v1',
    signingPublicKeyBase64: crmKey,
    maxAttempts: 3,
    proofRetentionDays: 2_555,
    ...overrides,
  };
}
