import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  recruitmentPortalFetch,
  resetRecruitmentPortalTokenCacheForTests,
} from './recruitment-portal-api.js';

const TOKEN = 't'.repeat(48);

describe('招聘门户上游调用策略', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ERP_API_ORIGIN', 'https://erp.example.com');
    vi.stubEnv('ERP_PORTAL_CLIENT_ID', 'careers-portal-client');
    vi.stubEnv('ERP_PORTAL_CLIENT_SECRET', 'client-secret-at-least-thirty-two-characters');
    vi.stubEnv('ERP_PORTAL_OAUTH_RESOURCE', 'https://erp.example.com/mcp');
  });

  afterEach(() => {
    resetRecruitmentPortalTokenCacheForTests();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('GET 遇到暂态故障只重试一次', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(envelopeResponse(503, 'UPSTREAM_BUSY'))
      .mockResolvedValueOnce(envelopeResponse(200, 'SUCCESS', { positions: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(recruitmentPortalFetch(
      '/api/recruitment/portal/positions',
      'erp:recruitment:portal:read',
    )).resolves.toEqual({ positions: [] });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('写请求只有携带幂等键时才允许重试', async () => {
    const withoutKey = vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(envelopeResponse(503, 'UPSTREAM_BUSY'));
    vi.stubGlobal('fetch', withoutKey);
    await expect(recruitmentPortalFetch(
      '/api/recruitment/applications',
      'erp:recruitment:application:create',
      { method: 'POST' },
    )).rejects.toMatchObject({ code: 'UPSTREAM_BUSY' });
    expect(withoutKey).toHaveBeenCalledTimes(2);

    resetRecruitmentPortalTokenCacheForTests();
    const withKey = vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(envelopeResponse(503, 'UPSTREAM_BUSY'))
      .mockResolvedValueOnce(envelopeResponse(200, 'SUCCESS', { application: { id: 'a' } }));
    vi.stubGlobal('fetch', withKey);
    await expect(recruitmentPortalFetch(
      '/api/recruitment/applications',
      'erp:recruitment:application:create',
      { method: 'POST', headers: { 'idempotency-key': 'portal:request-001' } },
    )).resolves.toEqual({ application: { id: 'a' } });
    expect(withKey).toHaveBeenCalledTimes(3);
  });

  it('连续超时返回可观测错误码且停止重试', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockRejectedValue(new DOMException('timeout', 'TimeoutError'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(recruitmentPortalFetch(
      '/api/recruitment/portal/positions',
      'erp:recruitment:portal:read',
    )).rejects.toMatchObject({
      code: 'RECRUITMENT_PORTAL_UPSTREAM_TIMEOUT',
      status: 504,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('调用方不能覆盖服务端 Authorization，生产也拒绝 localhost', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(envelopeResponse(200, 'SUCCESS', { positions: [] }));
    vi.stubGlobal('fetch', fetchMock);
    await recruitmentPortalFetch(
      '/api/recruitment/portal/positions',
      'erp:recruitment:portal:read',
      { headers: { authorization: 'Bearer attacker-controlled' } },
    );
    const requestInit = fetchMock.mock.calls[1]?.[1] as RequestInit | undefined;
    expect(new Headers(requestInit?.headers).get('authorization'))
      .toBe(`Bearer ${TOKEN}`);

    resetRecruitmentPortalTokenCacheForTests();
    vi.stubEnv('ERP_API_ORIGIN', 'https://localhost');
    await expect(recruitmentPortalFetch(
      '/api/recruitment/portal/positions',
      'erp:recruitment:portal:read',
    )).rejects.toThrow('RECRUITMENT_PORTAL_API_ORIGIN_INVALID');
  });
});

function tokenResponse(): Response {
  return Response.json({
    access_token: TOKEN,
    token_type: 'Bearer',
    expires_in: 600,
  });
}

function envelopeResponse(status: number, code: string, data: unknown = null): Response {
  return Response.json({
    code,
    message: code,
    data,
    traceId: 'trace-001',
  }, { status });
}
