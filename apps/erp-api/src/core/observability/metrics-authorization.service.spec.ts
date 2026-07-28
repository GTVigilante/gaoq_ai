import type { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';

import type { AppEnvironment } from '../../config/environment.js';
import { MetricsAuthorizationService } from './metrics-authorization.service.js';

const token = 'metrics-token-that-is-at-least-32-characters';

function service(expected: string | undefined): MetricsAuthorizationService {
  return new MetricsAuthorizationService({
    get: () => expected,
  } as unknown as ConfigService<AppEnvironment, true>);
}

describe('MetricsAuthorizationService', () => {
  it('未配置独立凭据时禁用指标入口', () => {
    expect(service(undefined).verify(`Bearer ${token}`)).toBe('disabled');
  });

  it('只接受规范 Bearer 且使用摘要比较', () => {
    expect(service(token).verify(`Bearer ${token}`)).toBe('valid');
    for (const authorization of [
      undefined,
      token,
      `bearer ${token}`,
      'Bearer short',
      `Bearer ${'x'.repeat(257)}`,
      `Bearer ${token}\n`,
      `Bearer ${token}-different`,
    ]) {
      expect(service(token).verify(authorization)).toBe('invalid');
    }
  });
});
