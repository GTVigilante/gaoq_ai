import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { MetricsAccessGuard } from './metrics-access.guard.js';
import type { MetricsAuthorizationService } from './metrics-authorization.service.js';

const token = 'metrics-token-that-is-at-least-32-characters';

function assemble(expected: string | undefined, authorization?: string) {
  const verify = vi.fn().mockReturnValue(
    expected === undefined ? 'disabled' : authorization === `Bearer ${expected}` ? 'valid' : 'invalid',
  );
  const request = { header: vi.fn().mockReturnValue(authorization) };
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return {
    guard: new MetricsAccessGuard({ verify } as unknown as MetricsAuthorizationService), context,
  };
}

describe('MetricsAccessGuard', () => {
  it('只接受独立 Prometheus Bearer 凭据', () => {
    const valid = assemble(token, `Bearer ${token}`);
    expect(valid.guard.canActivate(valid.context)).toBe(true);

    const invalid = assemble(token, 'Bearer wrong-token-that-is-at-least-32-characters');
    expect(() => invalid.guard.canActivate(invalid.context)).toThrow('抓取凭据无效');
  });

  it('未配置抓取凭据时失败关闭且不暴露指标', () => {
    const disabled = assemble(undefined, `Bearer ${token}`);
    expect(() => disabled.guard.canActivate(disabled.context)).toThrow('指标抓取端点未启用');
  });
});
