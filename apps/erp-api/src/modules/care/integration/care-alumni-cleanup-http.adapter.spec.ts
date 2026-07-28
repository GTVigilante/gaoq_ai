import {
  createHash,
  generateKeyPairSync,
  sign,
} from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createAlumniCleanupTask,
  type AlumniCleanupTask,
} from '../domain/index.js';
import { CareAlumniCleanupHttpAdapter } from './care-alumni-cleanup-http.adapter.js';
import type { CareAlumniCleanupTargetRegistry } from './care-alumni-cleanup-target-registry.js';

const keyPair = generateKeyPairSync('ed25519');
const otherKeyPair = generateKeyPairSync('ed25519');
const rsaKeyPair = generateKeyPairSync('rsa', { modulusLength: 2_048 });
const target = Object.freeze({
  targetCode: 'crm',
  endpoint: 'https://privacy-crm.example.net',
  bearerToken: 'cleanup-token-$-distinct-at-least-32-characters',
  policyVersion: 'privacy-v1',
  signingKeyId: 'proof-key-v1',
  signingPublicKeyBase64: keyPair.publicKey.export({
    format: 'der',
    type: 'spki',
  }).toString('base64'),
  maxAttempts: 3,
  proofRetentionDays: 2_555,
});
const pendingTask = createAlumniCleanupTask({
  sourceEventId: '01J8ZQK7V0A2M4N6P8R0T2W4C6',
  tenantId: 'tenant-001',
  consentId: '01J8ZQK7V0A2M4N6P8R0T2W4C4',
  consentVersion: 2,
  consentPurpose: 'alumni_network',
  terminationReason: 'withdrawn',
  terminatedAt: '2026-07-27T00:00:00.000Z',
  target,
});
const task = Object.freeze({
  ...pendingTask,
  status: 'dispatching',
  lockedAt: '2026-07-27T00:00:30.000Z',
  lockedBy: 'care-worker-001',
}) as AlumniCleanupTask;
const completedAt = '2026-07-27T00:01:00.000Z';
const retentionUntil = new Date(
  Date.parse(completedAt) + target.proofRetentionDays * 24 * 60 * 60 * 1_000,
).toISOString();

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('CareAlumniCleanupHttpAdapter', () => {
  it('发送固定最小控制面并接受逐项绑定的 WORM 签名证明', async () => {
    let sentBody: Buffer | undefined;
    vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit) => {
      expect(url).toBe(
        'https://privacy-crm.example.net/v1/alumni-consent-cleanups/execute',
      );
      expect(init.method).toBe('POST');
      expect(init.redirect).toBe('error');
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(Buffer.isBuffer(init.body)).toBe(true);
      sentBody = init.body as Buffer;
      const headers = init.headers as Record<string, string>;
      const idempotencyKey = headers['idempotency-key'];
      expect(idempotencyKey).toMatch(
        /^care-alumni-cleanup:[A-Za-z0-9_-]{43}$/u,
      );
      expect(headers).toEqual({
        authorization: `Bearer ${target.bearerToken}`,
        accept: 'application/json',
        'cache-control': 'no-store',
        'content-type': 'application/json',
        'content-length': String(sentBody.length),
        'idempotency-key': idempotencyKey,
        'x-gaoq-protocol-version': 'care-alumni-cleanup-v1',
        'x-tenant-id': task.tenantId,
        'x-consent-id': task.consentId,
        'x-target-code': task.targetCode,
        'x-control-digest': task.controlDigest,
      });
      return Promise.resolve(proofResponse());
    }));
    const result = await adapter().execute(task);
    expect(result).toEqual({
      proofDigest: 'A'.repeat(43),
      action: 'anonymized',
      storage: 'immutable_worm',
      completedAt,
      retentionUntil,
      keyId: target.signingKeyId,
    });
    expect(Object.isFrozen(result)).toBe(true);
    const payload = JSON.parse(sentBody?.toString('utf8') ?? '{}') as
      Record<string, unknown>;
    expect(payload).toEqual({
      tenantId: task.tenantId,
      consentId: task.consentId,
      consentVersion: task.consentVersion,
      consentPurpose: task.consentPurpose,
      terminationReason: task.terminationReason,
      terminatedAt: task.terminatedAt,
      targetCode: task.targetCode,
      policyVersion: task.policyVersion,
      controlDigest: task.controlDigest,
      directives: [
        'delete_or_anonymize_business_contact',
        'deny_future_processing',
        'preserve_consent_attestation_and_audit',
      ],
    });
    expect(sentBody?.toString('utf8')).not.toMatch(
      /personId|consentEvidenceId|phone|emailAddress|proofObject/iu,
    );
    expect(sentBody?.toString('utf8')).not.toContain(target.bearerToken);
  });

  it('接受与追加账本声明一致的签名证明引用', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(proofResponse({
      proof: {
        storage: 'append_only_ledger',
        proofReference: 'ledger:proof-001',
        action: 'crypto_shredded',
      },
      contentType: 'application/json; charset=utf-8',
      contentEncoding: 'identity',
    })));
    await expect(adapter().execute(task)).resolves.toMatchObject({
      storage: 'append_only_ledger',
      action: 'crypto_shredded',
    });
  });

  it('为相同任务生成确定的幂等键', async () => {
    const keys: string[] = [];
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => {
      keys.push((init.headers as Record<string, string>)['idempotency-key'] ?? '');
      return Promise.resolve(proofResponse());
    }));
    const instance = adapter();
    await instance.execute(task);
    await instance.execute(task);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it.each([
    ['非 dispatching 状态', { status: 'pending', lockedAt: null, lockedBy: null }],
    ['尝试次数达到上限', { attempts: target.maxAttempts }],
    ['非法租户', { tenantId: ' tenant-001' }],
    ['非法锁定时间', { lockedAt: '2026-07-27T08:00:30.000+08:00' }],
    ['已有证明摘要', { proofDigest: 'A'.repeat(43) }],
    ['未知字段', { unexpected: true }],
  ])('在外呼前拒绝受损任务：%s', async (_name, overrides) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(adapter().execute({
      ...task,
      ...overrides,
    } as AlumniCleanupTask)).rejects.toThrow('CARE_ALUMNI_CLEANUP_TASK_INVALID');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['任务 ID', { id: 'B'.repeat(43) }],
    ['控制摘要', { controlDigest: 'B'.repeat(43) }],
    ['租户事实', { tenantId: 'tenant-002' }],
  ])('重算并拒绝受损的%s', async (_name, overrides) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(adapter().execute({
      ...task,
      ...overrides,
    })).rejects.toThrow('CARE_ALUMNI_CLEANUP_TASK_INTEGRITY_INVALID');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['目标代码', { targetCode: 'notify' }],
    ['政策版本', { policyVersion: 'privacy-v2' }],
    ['最大尝试次数', { maxAttempts: 4 }],
    ['保留天数', { proofRetentionDays: 3_650 }],
  ])('拒绝目标登记与任务%s漂移', async (_name, overrides) => {
    vi.stubGlobal('fetch', vi.fn());
    await expect(adapter({
      ...target,
      ...overrides,
    }).execute(task)).rejects.toThrow(
      'CARE_ALUMNI_CLEANUP_TARGET_POLICY_MISMATCH',
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['短凭据', 'short'],
    ['含空格', 'x'.repeat(31) + ' '],
    ['含换行', 'x'.repeat(31) + '\n'],
    ['含 Unicode', 'x'.repeat(31) + '密'],
    ['超长', 'x'.repeat(513)],
    ['非字符串', 42],
  ])('拒绝运行时受损凭据：%s', async (_name, bearerToken) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(adapter({
      ...target,
      bearerToken,
    }).execute(task)).rejects.toThrow(
      'CARE_ALUMNI_CLEANUP_TARGET_CREDENTIAL_INVALID',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['not-a-url'],
    ['http://privacy-crm.example.net'],
    ['https://user:pass@privacy-crm.example.net'],
    ['https://privacy-crm.example.net/base'],
    ['https://privacy-crm.example.net?x=1'],
    ['https://privacy-crm.example.net#fragment'],
    ['https://privacy-crm.example.net:8443'],
    ['https://localhost'],
    ['https://service.localhost'],
    ['https://127.0.0.1'],
    ['https://intranet'],
    ['https://privacy-crm.example.net.'],
  ])('拒绝运行时非标准目标根地址：%s', async (endpoint) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(adapter({
      ...target,
      endpoint,
    }).execute(task)).rejects.toThrow(
      'CARE_ALUMNI_CLEANUP_TARGET_ENDPOINT_INVALID',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('拒绝非字符串目标地址', async () => {
    vi.stubGlobal('fetch', vi.fn());
    await expect(adapter({
      ...target,
      endpoint: 42,
    }).execute(task)).rejects.toThrow(
      'CARE_ALUMNI_CLEANUP_TARGET_ENDPOINT_INVALID',
    );
  });

  it.each([
    ['非法 Key ID', { signingKeyId: ' bad-key' }],
    ['非法 base64', { signingPublicKeyBase64: 'x'.repeat(60) }],
    ['非规范 base64', {
      signingPublicKeyBase64: `${target.signingPublicKeyBase64}\n`,
    }],
    ['错误密钥类型', {
      signingPublicKeyBase64: rsaKeyPair.publicKey.export({
        format: 'der',
        type: 'spki',
      }).toString('base64'),
    }],
    ['非字符串公钥', { signingPublicKeyBase64: 42 }],
  ])('拒绝运行时受损签名信任根：%s', async (_name, overrides) => {
    vi.stubGlobal('fetch', vi.fn());
    await expect(adapter({
      ...target,
      ...overrides,
    }).execute(task)).rejects.toThrow(
      'CARE_ALUMNI_CLEANUP_SIGNING_KEY_INVALID',
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    new Error('token=secret tenant-001'),
    'network rejected',
  ])('把网络异常收敛为不泄露上下文的稳定错误', async (failure) => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(failure));
    await expect(adapter().execute(task)).rejects.toThrow(
      'CARE_ALUMNI_CLEANUP_GATEWAY_FAILED',
    );
  });

  it.each([201, 204, 400, 401, 429, 500])(
    '非 200 响应 %s 不读取下游正文',
    async (status) => {
      const bodyRead = vi.fn();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        status,
        get body() {
          bodyRead();
          return null;
        },
      }));
      await expect(adapter().execute(task)).rejects.toThrow(
        `CARE_ALUMNI_CLEANUP_GATEWAY_HTTP_${status}`,
      );
      expect(bodyRead).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['缺失', undefined],
    ['文本', 'text/plain'],
    ['后缀 JSON', 'application/problem+json'],
    ['错误字符集', 'application/json; charset=gbk'],
    ['额外参数', 'application/json; charset=utf-8; profile=v1'],
  ])('拒绝%s Content-Type', async (_name, contentType) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(proofResponse({
      contentType,
    })));
    await expect(adapter().execute(task)).rejects.toThrow(
      'CARE_ALUMNI_CLEANUP_PROOF_INVALID',
    );
  });

  it.each(['gzip', 'br'])('拒绝压缩响应 Content-Encoding=%s', async (encoding) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(proofResponse({
      contentEncoding: encoding,
    })));
    await expect(adapter().execute(task)).rejects.toThrow(
      'CARE_ALUMNI_CLEANUP_PROOF_INVALID',
    );
  });

  it('拒绝重定向或最终 URL 漂移', async () => {
    const redirected = proofResponse();
    Object.defineProperties(redirected, {
      redirected: { value: true },
      url: { value: 'https://evil.example.net/proof' },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(redirected));
    await expect(adapter().execute(task)).rejects.toThrow(
      'CARE_ALUMNI_CLEANUP_PROOF_INVALID',
    );
  });

  it.each([
    ['Key ID 缺失', { keyId: null }],
    ['Key ID 错位', { keyId: 'other-key' }],
    ['签名缺失', { signature: null }],
    ['签名字符非法', { signature: '*'.repeat(86) }],
    ['签名长度非法', { signature: 'A'.repeat(85) }],
    ['签名编码非规范', {
      signature: `${Buffer.alloc(64).toString('base64url').slice(0, -1)}B`,
    }],
  ])('拒绝%s', async (_name, options) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(proofResponse(options)));
    await expect(adapter().execute(task)).rejects.toThrow(
      'CARE_ALUMNI_CLEANUP_PROOF_SIGNATURE_INVALID',
    );
  });

  it('拒绝由非登记私钥签署的证明', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(proofResponse({
      privateKey: otherKeyPair.privateKey,
    })));
    await expect(adapter().execute(task)).rejects.toThrow(
      'CARE_ALUMNI_CLEANUP_PROOF_SIGNATURE_INVALID',
    );
  });

  it.each(['-1', '01', ' 1', '1.0', '1e3'])(
    '拒绝非规范 Content-Length=%s',
    async (contentLength) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(proofResponse({
        contentLength,
      })));
      await expect(adapter().execute(task)).rejects.toThrow(
        'CARE_ALUMNI_CLEANUP_PROOF_LENGTH_INVALID',
      );
    },
  );

  it.each(['16385', '999999999999999999999999'])(
    '在读取前拒绝超限 Content-Length=%s',
    async (contentLength) => {
      const cancel = vi.fn().mockResolvedValue(undefined);
      const response = proofResponse({ contentLength });
      Object.defineProperty(response, 'body', {
        value: { cancel },
      });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
      await expect(adapter().execute(task)).rejects.toThrow(
        'CARE_ALUMNI_CLEANUP_PROOF_TOO_LARGE',
      );
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it('取消超限响应失败时仍保留稳定错误', async () => {
    const response = proofResponse({ contentLength: '16385' });
    Object.defineProperty(response, 'body', {
      value: {
        cancel: vi.fn(() => {
          throw new Error('cancel leaked');
        }),
      },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    await expect(adapter().execute(task)).rejects.toThrow(
      'CARE_ALUMNI_CLEANUP_PROOF_TOO_LARGE',
    );
  });

  it('拒绝空响应流', async () => {
    const response = proofResponse();
    Object.defineProperty(response, 'body', { value: null });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    await expect(adapter().execute(task)).rejects.toThrow(
      'CARE_ALUMNI_CLEANUP_PROOF_INVALID',
    );
  });

  it('把 getReader 异常收敛为稳定错误', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(responseWithBody({
      getReader: () => {
        throw new Error('reader leaked');
      },
    })));
    await expect(adapter().execute(task)).rejects.toThrow(
      'CARE_ALUMNI_CLEANUP_PROOF_READ_ERROR',
    );
  });

  it('把流读取异常收敛并尽力取消和释放', async () => {
    const cancel = vi.fn().mockRejectedValue(new Error('cancel leaked'));
    const releaseLock = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(responseWithReader({
      read: vi.fn().mockRejectedValue(new Error('read leaked')),
      cancel,
      releaseLock,
    })));
    await expect(adapter().execute(task)).rejects.toThrow(
      'CARE_ALUMNI_CLEANUP_PROOF_READ_ERROR',
    );
    expect(cancel).toHaveBeenCalledOnce();
    expect(releaseLock).toHaveBeenCalledOnce();
  });

  it('拒绝非 Uint8Array 流分片', async () => {
    const cancel = vi.fn(() => {
      throw new Error('cancel leaked');
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(responseWithReader({
      read: vi.fn().mockResolvedValueOnce({
        done: false,
        value: 'not-bytes',
      }),
      cancel,
      releaseLock: vi.fn(),
    })));
    await expect(adapter().execute(task)).rejects.toThrow(
      'CARE_ALUMNI_CLEANUP_PROOF_READ_ERROR',
    );
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('在流式读取期间拒绝超出 16 KiB 的响应', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const response = responseWithReader({
      read: vi.fn()
        .mockResolvedValueOnce({ done: false, value: new Uint8Array(16_000) })
        .mockResolvedValueOnce({ done: false, value: new Uint8Array(385) }),
      cancel,
      releaseLock: vi.fn(),
    });
    response.headers.delete('content-length');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    await expect(adapter().execute(task)).rejects.toThrow(
      'CARE_ALUMNI_CLEANUP_PROOF_TOO_LARGE',
    );
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([
    ['声明过短', '1'],
    ['声明过长', '16384'],
  ])('拒绝实际字节与 Content-Length 不一致：%s', async (_name, contentLength) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(proofResponse({
      contentLength,
    })));
    await expect(adapter().execute(task)).rejects.toThrow(
      'CARE_ALUMNI_CLEANUP_PROOF_LENGTH_INVALID',
    );
  });

  it('释放 Reader 锁异常不覆盖有效证明', async () => {
    const bytes = proofBytes();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(responseWithReader({
      read: vi.fn()
        .mockResolvedValueOnce({ done: false, value: new Uint8Array(bytes) })
        .mockResolvedValueOnce({ done: true, value: undefined }),
      cancel: vi.fn(),
      releaseLock: vi.fn(() => {
        throw new Error('release leaked');
      }),
    }, bytes)));
    await expect(adapter().execute(task)).resolves.toMatchObject({
      action: 'anonymized',
    });
  });

  it.each([
    ['非法 UTF-8', Buffer.from([0xc3, 0x28])],
    ['非法 JSON', Buffer.from('{', 'utf8')],
    ['数组', Buffer.from('[]', 'utf8')],
    ['空对象', Buffer.from('{}', 'utf8')],
  ])('在验签后拒绝%s证明正文', async (_name, bytes) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(proofResponse({ bytes })));
    await expect(adapter().execute(task)).rejects.toThrow(
      'CARE_ALUMNI_CLEANUP_PROOF_INVALID',
    );
  });

  it.each([
    ['未知字段', { unexpected: true }],
    ['未来处理未阻断', { processingBlocked: false }],
    ['保留证据顺序错误', {
      retainedEvidenceClasses: ['audit_log', 'consent_attestation'],
    }],
    ['可变存储', { storage: 'mutable_object_store' }],
    ['非法证明引用', { proofReference: 'https://proof.example.net/001' }],
    ['非法摘要', { proofDigest: 'A'.repeat(42) }],
  ])('拒绝 Schema 不合规证明：%s', async (_name, proof) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(proofResponse({ proof })));
    await expect(adapter().execute(task)).rejects.toThrow(
      'CARE_ALUMNI_CLEANUP_PROOF_INVALID',
    );
  });

  it.each([
    ['tenantId', { tenantId: 'tenant-002' }],
    ['consentId', { consentId: '01J8ZQK7V0A2M4N6P8R0T2W4C5' }],
    ['consentVersion', { consentVersion: 3 }],
    ['consentPurpose', { consentPurpose: 'rehire_contact' }],
    ['targetCode', { targetCode: 'notify' }],
    ['policyVersion', { policyVersion: 'privacy-v2' }],
    ['controlDigest', { controlDigest: 'B'.repeat(43) }],
    ['keyId', { keyId: 'proof-key-v2' }],
    ['proofDigest', { proofDigest: task.controlDigest }],
  ])('拒绝回执上下文错位：%s', async (_field, proof) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(proofResponse({ proof })));
    await expect(adapter().execute(task)).rejects.toThrow(
      'CARE_ALUMNI_CLEANUP_PROOF_CONTEXT_MISMATCH',
    );
  });

  it.each([
    ['WORM 使用账本引用', {
      storage: 'immutable_worm',
      proofReference: 'ledger:proof-001',
    }],
    ['账本使用 WORM 引用', {
      storage: 'append_only_ledger',
      proofReference: 'worm:proof-001',
    }],
  ])('拒绝存储类型与引用不一致：%s', async (_name, proof) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(proofResponse({ proof })));
    await expect(adapter().execute(task)).rejects.toThrow(
      'CARE_ALUMNI_CLEANUP_PROOF_STORAGE_INVALID',
    );
  });

  it.each([
    ['非规范时区', { completedAt: '2026-07-27T08:01:00.000+08:00' }],
    ['不存在日期', { completedAt: '2026-02-30T00:01:00.000Z' }],
  ])('拒绝%s', async (_name, proof) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(proofResponse({ proof })));
    await expect(adapter().execute(task)).rejects.toThrow(
      'CARE_ALUMNI_CLEANUP_PROOF_TIME_INVALID',
    );
  });

  it.each([
    ['完成早于授权终止', { completedAt: '2026-07-26T23:59:59.000Z' }],
    ['证明保留期不足', { retentionUntil: '2030-07-27T00:01:00.000Z' }],
  ])('拒绝%s', async (_name, proof) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(proofResponse({ proof })));
    await expect(adapter().execute(task)).rejects.toThrow(
      'CARE_ALUMNI_CLEANUP_PROOF_RETENTION_INVALID',
    );
  });
});

function adapter(
  registeredTarget: Record<string, unknown> = target,
): CareAlumniCleanupHttpAdapter {
  return new CareAlumniCleanupHttpAdapter({
    require: vi.fn().mockReturnValue(registeredTarget),
  } as unknown as CareAlumniCleanupTargetRegistry);
}

function baseProof(): Record<string, unknown> {
  return {
    tenantId: task.tenantId,
    consentId: task.consentId,
    consentVersion: task.consentVersion,
    consentPurpose: task.consentPurpose,
    targetCode: task.targetCode,
    policyVersion: task.policyVersion,
    controlDigest: task.controlDigest,
    proofDigest: 'A'.repeat(43),
    action: 'anonymized',
    processingBlocked: true,
    retainedEvidenceClasses: ['consent_attestation', 'audit_log'],
    storage: 'immutable_worm',
    proofReference: 'worm:proof-001',
    completedAt,
    retentionUntil,
    keyId: target.signingKeyId,
  };
}

function proofBytes(
  proof: Record<string, unknown> = {},
): Buffer {
  return Buffer.from(JSON.stringify({
    ...baseProof(),
    ...proof,
  }), 'utf8');
}

function proofResponse(options: {
  readonly proof?: Record<string, unknown>;
  readonly bytes?: Buffer;
  readonly privateKey?: typeof keyPair.privateKey;
  readonly keyId?: string | null;
  readonly signature?: string | null;
  readonly contentType?: string | undefined;
  readonly contentEncoding?: string;
  readonly contentLength?: string;
} = {}): Response {
  const bytes = options.bytes ?? proofBytes(options.proof);
  const digest = createHash('sha256').update(bytes).digest('base64url');
  const keyId = options.keyId === undefined ? target.signingKeyId : options.keyId;
  const signature = options.signature === undefined
    ? sign(
      null,
      Buffer.from(
        `gaoq-care-alumni-cleanup-proof-v1\n${target.signingKeyId}\n${digest}`,
        'utf8',
      ),
      options.privateKey ?? keyPair.privateKey,
    ).toString('base64url')
    : options.signature;
  const headers = new Headers();
  if (options.contentType !== undefined) {
    headers.set('content-type', options.contentType);
  } else if (!Object.prototype.hasOwnProperty.call(options, 'contentType')) {
    headers.set('content-type', 'application/json');
  }
  if (options.contentEncoding !== undefined) {
    headers.set('content-encoding', options.contentEncoding);
  }
  if (keyId !== null) headers.set('x-gaoq-signing-key-id', keyId);
  if (signature !== null) headers.set('x-gaoq-signature', signature);
  if (options.contentLength !== undefined) {
    headers.set('content-length', options.contentLength);
  } else {
    headers.set('content-length', String(bytes.length));
  }
  return new Response(bytes, { status: 200, headers });
}

function responseWithBody(body: unknown): Response {
  const bytes = proofBytes();
  const response = proofResponse({ bytes });
  Object.defineProperty(response, 'body', { value: body });
  return response;
}

function responseWithReader(
  reader: {
    readonly read: () => Promise<unknown>;
    readonly cancel: () => unknown;
    readonly releaseLock: () => void;
  },
  bytes = proofBytes(),
): Response {
  const response = proofResponse({
    bytes,
    contentLength: String(bytes.length),
  });
  Object.defineProperty(response, 'body', {
    value: {
      getReader: () => reader,
    },
  });
  return response;
}
