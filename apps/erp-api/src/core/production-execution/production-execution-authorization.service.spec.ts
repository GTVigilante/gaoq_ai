import type { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppEnvironment } from '../../config/environment.js';
import {
  ProductionExecutionAuthorizationService,
  productionExecutionSubjectHash,
} from './production-execution-authorization.service.js';

const commit = 'a'.repeat(40);
const manifest = `sha256:${'b'.repeat(64)}`;
const subject = Object.freeze({
  action: 'treasury-bank-submission' as const,
  tenantId: 'tenant-001',
  resourceId: '01J8ZQK7V0A2M4N6P8R0T2W4B1',
  subjectHash: productionExecutionSubjectHash(['batch', 'a'.repeat(43), 100]),
  expectedVersion: 3,
});

function config(overrides?: Readonly<Record<string, string>>) {
  const values: Readonly<Record<string, string>> = {
    PHASE6_PRODUCTION_AUTHORIZATION_ENDPOINT:
      'https://release-authorization.example.internal/v1/authorizations',
    PHASE6_PRODUCTION_AUTHORIZATION_BEARER_TOKEN:
      'phase6-authorization-token-at-least-32-characters',
    PHASE6_RELEASE_COMMIT_SHA: commit,
    PHASE6_DEPLOYMENT_MANIFEST_SHA256: manifest,
    ...overrides,
  };
  return { get: (key: string) => values[key] } as unknown as ConfigService<AppEnvironment, true>;
}

function receipt(changes?: Readonly<Record<string, unknown>>) {
  const now = Date.now();
  return {
    authorizationId: 'authorization-001', evidenceId: 'worm-evidence-001',
    approved: true, singleUse: true, ...subject,
    releaseCommitSha: commit, deploymentManifestHash: manifest,
    issuedAt: new Date(now - 10_000).toISOString(),
    expiresAt: new Date(now + 5 * 60_000).toISOString(),
    ...changes,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('Phase 6 生产执行授权客户端', () => {
  it('把租户、对象、摘要、版本和发布物精确绑定到一次性短时授权', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(receipt()), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(new ProductionExecutionAuthorizationService(config()).authorize(subject))
      .resolves.toMatchObject({
        authorizationId: 'authorization-001', evidenceId: 'worm-evidence-001',
        releaseCommitSha: commit, deploymentManifestHash: manifest,
      });
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    if (typeof call[1].body !== 'string') throw new Error('测试请求体必须是 JSON 字符串');
    expect(JSON.parse(call[1].body)).toMatchObject({ ...subject, releaseCommitSha: commit });
    expect((call[1].headers as Record<string, string>)['idempotency-key'])
      .toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });

  it('拒绝错租户、错摘要、非一次性或过期授权', async () => {
    for (const invalid of [
      receipt({ tenantId: 'tenant-002' }), receipt({ subjectHash: 'c'.repeat(43) }),
      receipt({ singleUse: false }),
      receipt({ expiresAt: new Date(Date.now() - 1_000).toISOString() }),
    ]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(invalid), {
        status: 200, headers: { 'content-type': 'application/json' },
      })));
      await expect(new ProductionExecutionAuthorizationService(config()).authorize(subject))
        .rejects.toThrow(/PHASE6_PRODUCTION_AUTHORIZATION_/u);
    }
  });

  it('缺少发布绑定、非法端点或上游失败时失败关闭', async () => {
    await expect(new ProductionExecutionAuthorizationService(config({
      PHASE6_RELEASE_COMMIT_SHA: 'invalid',
    })).authorize(subject)).rejects.toThrow('PHASE6_PRODUCTION_RELEASE_BINDING_INVALID');
    await expect(new ProductionExecutionAuthorizationService(config({
      PHASE6_PRODUCTION_AUTHORIZATION_ENDPOINT:
        'https://release-authorization.example.internal/v1/auth?token=unsafe',
    })).authorize(subject)).rejects.toThrow('PHASE6_PRODUCTION_AUTHORIZATION_ENDPOINT_INVALID');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 503 })));
    await expect(new ProductionExecutionAuthorizationService(config()).authorize(subject))
      .rejects.toThrow('PHASE6_PRODUCTION_AUTHORIZATION_HTTP_503');
  });
});
