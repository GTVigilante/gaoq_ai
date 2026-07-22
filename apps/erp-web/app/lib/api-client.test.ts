import { describe, expect, it } from 'vitest';

import { ErpApiError, isDefinitiveWriteRejection, parseApiEnvelope, strongEtag } from './api-client.js';

describe('ERP Web API Client', () => {
  it('只接受带 traceId 的统一成功信封', () => {
    const value = parseApiEnvelope<{ readonly count: number }>({
      code: 'SUCCESS', message: '成功', data: { count: 3 },
      traceId: 'trace-web-001', timestamp: '2026-07-22T00:00:00.000Z',
    });
    expect(value.data.count).toBe(3);
    expect(value.traceId).toBe('trace-web-001');
  });

  it('拒绝缺失 traceId 或时间戳的响应', () => {
    expect(() => parseApiEnvelope({ code: 'SUCCESS', message: '成功', data: [] }))
      .toThrowError(expect.objectContaining({ code: 'API_RESPONSE_INVALID' }));
  });

  it('生成强 ETag 并拒绝非法版本', () => {
    expect(strongEtag(7)).toBe('"7"');
    expect(() => strongEtag(0)).toThrowError('ETAG_VERSION_INVALID');
  });

  it('错误类型不携带响应正文或访问令牌', () => {
    const error = new ErpApiError('AUTH_REQUIRED', '请登录', 'trace-web-002', 401);
    expect(error).toMatchObject({
      name: 'ErpApiError', code: 'AUTH_REQUIRED', message: '请登录',
      traceId: 'trace-web-002', status: 401,
    });
    expect(JSON.stringify(error)).not.toContain('accessToken');
  });

  it('只把处理中、超时、限流和服务端故障视为可复用重试', () => {
    expect(isDefinitiveWriteRejection(new ErpApiError('IDEMPOTENCY_IN_PROGRESS', '处理中', null, 409))).toBe(false);
    expect(isDefinitiveWriteRejection(new ErpApiError('APPROVAL_VERSION_CONFLICT', '版本冲突', null, 409))).toBe(true);
    expect(isDefinitiveWriteRejection(new ErpApiError('IDEMPOTENCY_KEY_REUSED', '键已被其他请求使用', null, 409))).toBe(true);
    expect(isDefinitiveWriteRejection(new ErpApiError('RATE_LIMITED', '稍后重试', null, 429))).toBe(false);
    expect(isDefinitiveWriteRejection(new ErpApiError('UPSTREAM_FAILED', '服务异常', null, 503))).toBe(false);
  });
});
