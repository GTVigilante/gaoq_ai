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

function config(overrides?: Readonly<Record<string, string | undefined>>) {
  const values: Readonly<Record<string, string | undefined>> = {
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
    const authorization = await new ProductionExecutionAuthorizationService(config())
      .authorize(subject);
    expect(authorization).toMatchObject({
      authorizationId: 'authorization-001', evidenceId: 'worm-evidence-001',
      releaseCommitSha: commit, deploymentManifestHash: manifest,
    });
    expect(Object.isFrozen(authorization)).toBe(true);
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    if (typeof call[1].body !== 'string') throw new Error('测试请求体必须是 JSON 字符串');
    expect(call[0]).toBe(
      'https://release-authorization.example.internal/v1/authorizations',
    );
    expect(call[1]).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(JSON.parse(call[1].body)).toMatchObject({
      ...subject,
      releaseCommitSha: commit,
      deploymentManifestHash: manifest,
    });
    const headers = call[1].headers as Record<string, string>;
    expect(headers).toMatchObject({
      authorization: 'Bearer phase6-authorization-token-at-least-32-characters',
      accept: 'application/json',
      'cache-control': 'no-store',
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(call[1].body)),
    });
    expect(headers['idempotency-key']).toMatch(/^[A-Za-z0-9_-]{43}$/u);
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

  it('拒绝不完整配置和非法发布物绑定且不发起外部请求', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    for (const key of [
      'PHASE6_PRODUCTION_AUTHORIZATION_ENDPOINT',
      'PHASE6_PRODUCTION_AUTHORIZATION_BEARER_TOKEN',
      'PHASE6_RELEASE_COMMIT_SHA',
      'PHASE6_DEPLOYMENT_MANIFEST_SHA256',
    ]) {
      await expect(new ProductionExecutionAuthorizationService(config({
        [key]: undefined,
      })).authorize(subject)).rejects.toThrow(
        'PHASE6_PRODUCTION_AUTHORIZATION_UNAVAILABLE',
      );
    }
    await expect(new ProductionExecutionAuthorizationService(config({
      PHASE6_DEPLOYMENT_MANIFEST_SHA256: 'sha256:invalid',
    })).authorize(subject)).rejects.toThrow(
      'PHASE6_PRODUCTION_RELEASE_BINDING_INVALID',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('主体摘要和授权主体输入必须满足数量、长度、格式与安全整数约束', async () => {
    for (const parts of [
      ['only-one'],
      Array.from({ length: 17 }, (_, index) => String(index)),
      ['valid', ''],
      ['valid', 'x'.repeat(513)],
      ['valid', Number.MAX_SAFE_INTEGER + 1],
    ]) {
      expect(() => productionExecutionSubjectHash(parts))
        .toThrow('PHASE6_PRODUCTION_SUBJECT_PARTS_INVALID');
    }

    const invalidSubjects = [
      { ...subject, action: 'unknown-action' },
      { ...subject, tenantId: 'tenant/unsafe' },
      { ...subject, resourceId: '' },
      { ...subject, subjectHash: 'short' },
      { ...subject, expectedVersion: 0 },
      { ...subject, expectedVersion: 1.5 },
    ];
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    for (const invalid of invalidSubjects) {
      await expect(new ProductionExecutionAuthorizationService(config()).authorize(
        invalid as typeof subject,
      )).rejects.toThrow('PHASE6_PRODUCTION_AUTHORIZATION_SUBJECT_INVALID');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('端点仅允许无凭据、无查询和锚点的标准 HTTPS 443 地址', async () => {
    for (const endpoint of [
      'not-a-url',
      'http://release-authorization.example.internal/v1/authorizations',
      'https://operator@release-authorization.example.internal/v1/authorizations',
      'https://operator:secret@release-authorization.example.internal/v1/authorizations',
      'https://release-authorization.example.internal/v1/authorizations?token=unsafe',
      'https://release-authorization.example.internal/v1/authorizations#unsafe',
      'https://release-authorization.example.internal:444/v1/authorizations',
    ]) {
      await expect(new ProductionExecutionAuthorizationService(config({
        PHASE6_PRODUCTION_AUTHORIZATION_ENDPOINT: endpoint,
      })).authorize(subject)).rejects.toThrow(
        'PHASE6_PRODUCTION_AUTHORIZATION_ENDPOINT_INVALID',
      );
    }
  });

  it('网络异常、非 JSON、空响应体和非字节流均失败关闭', async () => {
    const failures: Array<{
      readonly response?: Response;
      readonly rejection?: Error;
      readonly expected: string;
    }> = [
      {
        rejection: new Error('ECONNRESET'),
        expected: 'PHASE6_PRODUCTION_AUTHORIZATION_UNAVAILABLE',
      },
      {
        response: new Response('{}', {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        }),
        expected: 'PHASE6_PRODUCTION_AUTHORIZATION_RECEIPT_INVALID',
      },
      {
        response: new Response(null, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
        expected: 'PHASE6_PRODUCTION_AUTHORIZATION_RECEIPT_INVALID',
      },
    ];
    for (const failure of failures) {
      vi.stubGlobal('fetch', failure.rejection === undefined
        ? vi.fn().mockResolvedValue(failure.response)
        : vi.fn().mockRejectedValue(failure.rejection));
      await expect(new ProductionExecutionAuthorizationService(config()).authorize(subject))
        .rejects.toThrow(failure.expected);
    }

    const releaseLock = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: {
        getReader: () => ({
          read: vi.fn().mockResolvedValue({ done: false, value: 'not-bytes' }),
          releaseLock,
        }),
      },
    }));
    await expect(new ProductionExecutionAuthorizationService(config()).authorize(subject))
      .rejects.toThrow('PHASE6_PRODUCTION_AUTHORIZATION_RECEIPT_INVALID');
    expect(releaseLock).toHaveBeenCalledOnce();
  });

  it('响应正文拒绝超限、非法 UTF-8、破损 JSON 和不符合严格模式的回执', async () => {
    const responses = [
      new Response('x'.repeat(16 * 1024 + 1), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
      new Response(new Uint8Array([0xff]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
      new Response('{"authorizationId":', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
      new Response(JSON.stringify(receipt({ unexpected: true })), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ];
    const expected = [
      'PHASE6_PRODUCTION_AUTHORIZATION_RECEIPT_TOO_LARGE',
      'PHASE6_PRODUCTION_AUTHORIZATION_RECEIPT_INVALID',
      'PHASE6_PRODUCTION_AUTHORIZATION_RECEIPT_INVALID',
      'PHASE6_PRODUCTION_AUTHORIZATION_RECEIPT_INVALID',
    ];
    for (const [index, response] of responses.entries()) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
      await expect(new ProductionExecutionAuthorizationService(config()).authorize(subject))
        .rejects.toThrow(expected[index]);
    }
  });

  it('回执必须逐字段绑定主体、发布物并保持证据标识职责分离', async () => {
    for (const invalid of [
      receipt({ action: 'payroll-tax-submission' }),
      receipt({ resourceId: 'resource-other' }),
      receipt({ expectedVersion: 4 }),
      receipt({ authorizationId: 'same-id', evidenceId: 'same-id' }),
      receipt({ releaseCommitSha: 'c'.repeat(40) }),
      receipt({ deploymentManifestHash: `sha256:${'d'.repeat(64)}` }),
    ]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(invalid), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })));
      await expect(new ProductionExecutionAuthorizationService(config()).authorize(subject))
        .rejects.toThrow('PHASE6_PRODUCTION_AUTHORIZATION_BINDING_MISMATCH');
    }
  });

  it('回执签发时间必须新鲜且过期时间必须保留安全窗口', async () => {
    const now = Date.now();
    for (const invalid of [
      receipt({
        issuedAt: new Date(now + 31_000).toISOString(),
        expiresAt: new Date(now + 5 * 60_000).toISOString(),
      }),
      receipt({
        issuedAt: new Date(now - 5 * 60_000 - 1_000).toISOString(),
        expiresAt: new Date(now + 5 * 60_000).toISOString(),
      }),
      receipt({
        issuedAt: new Date(now - 10_000).toISOString(),
        expiresAt: new Date(now + 20_000).toISOString(),
      }),
      receipt({
        issuedAt: new Date(now - 10_000).toISOString(),
        expiresAt: new Date(now + 15 * 60_000 + 10_000).toISOString(),
      }),
    ]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(invalid), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })));
      await expect(new ProductionExecutionAuthorizationService(config()).authorize(subject))
        .rejects.toThrow('PHASE6_PRODUCTION_AUTHORIZATION_WINDOW_INVALID');
    }
  });
});
