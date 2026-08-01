import {
  createHash,
  generateKeyPairSync,
  sign,
} from 'node:crypto';

import type { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppEnvironment } from '../../../config/environment.js';
import { CareOccasionNotificationHttpAdapter } from './care-occasion-notification-http.adapter.js';
import type { CareOccasionNotificationRequest } from './care-occasion-notification.port.js';

const REQUEST: CareOccasionNotificationRequest = {
  tenantId: 'tenant-001',
  occasionTaskId: 'care-task-001',
  employeeId: 'employee-001',
  occasionType: 'birthday',
  purpose: 'employee_care',
  templateCode: 'birthday-v1',
  policyVersion: 'policy-v1',
  scheduledAt: '2026-07-27T00:00:00.000Z',
  preferredChannels: ['feishu'],
  sourceDigest: 'A'.repeat(43),
  idempotencyKey: 'B'.repeat(43),
};
const SIGNING_KEY_ID = 'key-001';
const signingKeys = generateKeyPairSync('ed25519');
const SIGNING_PUBLIC_KEY_BASE64 = signingKeys.publicKey.export({
  format: 'der',
  type: 'spki',
}).toString('base64');

function adapter(
  overrides: Partial<Record<keyof AppEnvironment, unknown>> = {},
): CareOccasionNotificationHttpAdapter {
  return new CareOccasionNotificationHttpAdapter(config({
    CARE_OCCASION_NOTIFICATION_ENDPOINT: 'https://notification.example.com/',
    CARE_OCCASION_NOTIFICATION_BEARER_TOKEN: 't'.repeat(32),
    CARE_OCCASION_NOTIFICATION_SIGNING_KEY_ID: SIGNING_KEY_ID,
    CARE_OCCASION_NOTIFICATION_SIGNING_PUBLIC_KEY_BASE64:
      SIGNING_PUBLIC_KEY_BASE64,
    ...overrides,
  }));
}

function signedResponse(
  body: unknown,
  options: {
    readonly bytes?: Uint8Array;
    readonly contentType?: string;
    readonly keyId?: string;
    readonly status?: number;
  } = {},
): Response {
  const keyId = options.keyId ?? SIGNING_KEY_ID;
  const bytes = options.bytes ?? Buffer.from(JSON.stringify(body), 'utf8');
  const digest = createHash('sha256').update(bytes).digest('base64url');
  const signature = sign(
    null,
    Buffer.from(
      `gaoq-care-occasion-receipt-v1\n${keyId}\n${digest}`,
      'utf8',
    ),
    signingKeys.privateKey,
  ).toString('base64url');
  return new Response(bytes, {
    status: options.status ?? 200,
    headers: {
      'content-type': options.contentType ?? 'application/json; charset=utf-8',
      'x-gaoq-signing-key-id': keyId,
      'x-gaoq-signature': signature,
    },
  });
}

function responseForRequest(
  init: RequestInit | undefined,
  receipt: Readonly<Record<string, unknown>>,
): Response {
  if (typeof init?.body !== 'string') throw new Error('TEST_BODY_INVALID');
  const body = JSON.parse(init.body) as { readonly controlDigest: string };
  return signedResponse({
    tenantId: REQUEST.tenantId,
    occasionTaskId: REQUEST.occasionTaskId,
    controlDigest: body.controlDigest,
    ...receipt,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CareOccasionNotificationHttpAdapter', () => {
  it('仅发送最小控制字段并验证绑定请求摘要的 Ed25519 回执', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const publicKeyBase64 = publicKey.export({ format: 'der', type: 'spki' })
      .toString('base64');
    let sentBody = '';
    vi.stubGlobal('fetch', vi.fn().mockImplementation(
      (url: URL, init: RequestInit) => {
        expect(url.toString()).toBe(
          'https://notification.example.com/v1/employee-care/dispatch',
        );
        if (typeof init.body !== 'string') throw new Error('TEST_BODY_INVALID');
        const headers = init.headers as Readonly<Record<string, string>>;
        expect(headers.accept).toBe('application/json');
        expect(headers['accept-encoding']).toBe('identity');
        expect(headers['cache-control']).toBe('no-store');
        expect(headers['content-length']).toBe(
          String(Buffer.byteLength(init.body, 'utf8')),
        );
        expect(headers['idempotency-key']).toBe(REQUEST.idempotencyKey);
        sentBody = init.body;
        const requestBody = JSON.parse(sentBody) as { controlDigest: string };
        const bytes = Buffer.from(JSON.stringify({
          outcome: 'delivered',
          tenantId: REQUEST.tenantId,
          occasionTaskId: REQUEST.occasionTaskId,
          controlDigest: requestBody.controlDigest,
          deliveryEvidenceId: 'delivery-001',
          deliveredAt: new Date().toISOString(),
          channel: 'feishu',
        }), 'utf8');
        const digest = createHash('sha256').update(bytes).digest('base64url');
        const signature = sign(
          null,
          Buffer.from(`gaoq-care-occasion-receipt-v1\nkey-001\n${digest}`, 'utf8'),
          privateKey,
        ).toString('base64url');
        return Promise.resolve(new Response(bytes, {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'x-gaoq-signing-key-id': 'key-001',
            'x-gaoq-signature': signature,
          },
        }));
      },
    ));
    const adapter = new CareOccasionNotificationHttpAdapter(config({
      CARE_OCCASION_NOTIFICATION_ENDPOINT: 'https://notification.example.com/',
      CARE_OCCASION_NOTIFICATION_BEARER_TOKEN: 't'.repeat(32),
      CARE_OCCASION_NOTIFICATION_SIGNING_KEY_ID: 'key-001',
      CARE_OCCASION_NOTIFICATION_SIGNING_PUBLIC_KEY_BASE64: publicKeyBase64,
    }));
    await expect(adapter.dispatch(REQUEST)).resolves.toMatchObject({
      outcome: 'delivered',
      deliveryEvidenceId: 'delivery-001',
      channel: 'feishu',
    });
    expect(sentBody).toContain('"controlDigest"');
    for (const forbidden of [
      'birthdayMonthDay',
      'birthDate',
      'phone',
      'emailAddress',
      'notificationBody',
    ]) expect(sentBody).not.toContain(forbidden);
  });

  it('拒绝不安全端点、非 JSON 响应和未绑定当前请求的回执', async () => {
    const unsafe = new CareOccasionNotificationHttpAdapter(config({
      CARE_OCCASION_NOTIFICATION_ENDPOINT: 'https://127.0.0.1/',
      CARE_OCCASION_NOTIFICATION_BEARER_TOKEN: 't'.repeat(32),
      CARE_OCCASION_NOTIFICATION_SIGNING_KEY_ID: 'key-001',
      CARE_OCCASION_NOTIFICATION_SIGNING_PUBLIC_KEY_BASE64: 'invalid',
    }));
    await expect(unsafe.dispatch(REQUEST)).rejects.toThrow(
      'CARE_OCCASION_GATEWAY_ENDPOINT_INVALID',
    );

    const { publicKey } = generateKeyPairSync('ed25519');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    })));
    const wrongType = new CareOccasionNotificationHttpAdapter(config({
      CARE_OCCASION_NOTIFICATION_ENDPOINT: 'https://notification.example.com/',
      CARE_OCCASION_NOTIFICATION_BEARER_TOKEN: 't'.repeat(32),
      CARE_OCCASION_NOTIFICATION_SIGNING_KEY_ID: 'key-001',
      CARE_OCCASION_NOTIFICATION_SIGNING_PUBLIC_KEY_BASE64:
        publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    }));
    await expect(wrongType.dispatch(REQUEST)).rejects.toThrow(
      'CARE_OCCASION_RECEIPT_INVALID',
    );
  });

  it('网关未成套配置时失败关闭', async () => {
    const adapter = new CareOccasionNotificationHttpAdapter(config({}));
    await expect(adapter.dispatch(REQUEST)).rejects.toThrow(
      'CARE_OCCASION_GATEWAY_UNAVAILABLE',
    );
  });

  it('签名拒绝回执只返回受控原因码', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(
      (_url: URL, init: RequestInit) => Promise.resolve(responseForRequest(
        init,
        { outcome: 'denied', denialCode: 'quiet_hours' },
      )),
    ));

    await expect(adapter().dispatch(REQUEST)).resolves.toEqual({
      outcome: 'denied',
      denialCode: 'quiet_hours',
    });
  });

  it('严格拒绝未知请求字段、重复渠道和无效摘要且不会外呼', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(adapter().dispatch({
      ...REQUEST,
      accessToken: 'forbidden',
    } as unknown as CareOccasionNotificationRequest)).rejects.toThrow(
      'CARE_OCCASION_REQUEST_INVALID',
    );
    await expect(adapter().dispatch({
      ...REQUEST,
      preferredChannels: ['feishu', 'feishu'],
    })).rejects.toThrow('CARE_OCCASION_REQUEST_INVALID');
    await expect(adapter().dispatch({
      ...REQUEST,
      sourceDigest: 'short',
    })).rejects.toThrow('CARE_OCCASION_REQUEST_INVALID');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('运行时拒绝无效端点、凭据、Key ID 和公钥且不会外呼', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    for (const [overrides, code] of [
      [{
        CARE_OCCASION_NOTIFICATION_ENDPOINT: 'not-a-url',
      }, 'CARE_OCCASION_GATEWAY_ENDPOINT_INVALID'],
      [{
        CARE_OCCASION_NOTIFICATION_ENDPOINT:
          'https://notification.example.com/path',
      }, 'CARE_OCCASION_GATEWAY_ENDPOINT_INVALID'],
      [{
        CARE_OCCASION_NOTIFICATION_BEARER_TOKEN: 'short',
      }, 'CARE_OCCASION_GATEWAY_CREDENTIAL_INVALID'],
      [{
        CARE_OCCASION_NOTIFICATION_SIGNING_KEY_ID: 'bad key',
      }, 'CARE_OCCASION_SIGNING_KEY_INVALID'],
      [{
        CARE_OCCASION_NOTIFICATION_SIGNING_PUBLIC_KEY_BASE64: 'AAAA',
      }, 'CARE_OCCASION_SIGNING_KEY_INVALID'],
    ] satisfies ReadonlyArray<
      readonly [Partial<Record<keyof AppEnvironment, unknown>>, string]
    >) {
      await expect(adapter(overrides).dispatch(REQUEST)).rejects.toThrow(code);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    'http://notification.example.com/',
    'https://user@notification.example.com/',
    'https://user:secret@notification.example.com/',
    'https://notification.example.com/path',
    'https://notification.example.com/?query=1',
    'https://notification.example.com/#fragment',
    'https://notification.example.com:8443/',
    'https://localhost/',
    'https://care.localhost/',
    'https://[::1]/',
  ])('拒绝非标准或不可独立信任的端点 %s', async (endpoint) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(adapter({
      CARE_OCCASION_NOTIFICATION_ENDPOINT: endpoint,
    }).dispatch(REQUEST)).rejects.toThrow(
      'CARE_OCCASION_GATEWAY_ENDPOINT_INVALID',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('拒绝非 Ed25519、公钥非规范编码和非字符串配置', async () => {
    const ecKeys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const ecPublicKey = ecKeys.publicKey.export({
      format: 'der',
      type: 'spki',
    }).toString('base64');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(adapter({
      CARE_OCCASION_NOTIFICATION_SIGNING_PUBLIC_KEY_BASE64: ecPublicKey,
    }).dispatch(REQUEST)).rejects.toThrow('CARE_OCCASION_SIGNING_KEY_INVALID');
    await expect(adapter({
      CARE_OCCASION_NOTIFICATION_SIGNING_PUBLIC_KEY_BASE64:
        `${SIGNING_PUBLIC_KEY_BASE64}=`,
    }).dispatch(REQUEST)).rejects.toThrow('CARE_OCCASION_SIGNING_KEY_INVALID');
    await expect(adapter({
      CARE_OCCASION_NOTIFICATION_BEARER_TOKEN: 123,
    }).dispatch(REQUEST)).rejects.toThrow('CARE_OCCASION_GATEWAY_UNAVAILABLE');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('网络失败、非成功响应、伪 JSON 和压缩响应均失败关闭', async () => {
    const compressed = signedResponse({});
    compressed.headers.set('content-encoding', 'gzip');
    vi.stubGlobal('fetch', vi.fn()
      .mockRejectedValueOnce(new Error('sensitive network detail'))
      .mockResolvedValueOnce(new Response('unavailable', {
        status: 503,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/jsonp' },
      }))
      .mockResolvedValueOnce(compressed));
    const subject = adapter();

    await expect(subject.dispatch(REQUEST))
      .rejects.toThrow('CARE_OCCASION_GATEWAY_FAILED');
    await expect(subject.dispatch(REQUEST))
      .rejects.toThrow('CARE_OCCASION_GATEWAY_FAILED');
    await expect(subject.dispatch(REQUEST))
      .rejects.toThrow('CARE_OCCASION_RECEIPT_INVALID');
    await expect(subject.dispatch(REQUEST))
      .rejects.toThrow('CARE_OCCASION_RECEIPT_INVALID');
  });

  it('Key ID、签名格式和签名正文错位均失败关闭', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockImplementationOnce((_url: URL, init: RequestInit) => {
        const receipt = responseForRequest(init, {
          outcome: 'denied',
          denialCode: 'unsubscribed',
        });
        receipt.headers.set('x-gaoq-signing-key-id', 'other-key');
        return Promise.resolve(receipt);
      })
      .mockImplementationOnce((_url: URL, init: RequestInit) => {
        const receipt = responseForRequest(init, {
          outcome: 'denied',
          denialCode: 'unsubscribed',
        });
        receipt.headers.set('x-gaoq-signature', 'not-a-signature');
        return Promise.resolve(receipt);
      })
      .mockImplementationOnce((_url: URL, init: RequestInit) => {
        const receipt = responseForRequest(init, {
          outcome: 'denied',
          denialCode: 'unsubscribed',
        });
        const signature = receipt.headers.get('x-gaoq-signature');
        if (signature === null) throw new Error('TEST_SIGNATURE_MISSING');
        receipt.headers.set(
          'x-gaoq-signature',
          `${signature.slice(0, -1)}${signature.endsWith('A') ? 'B' : 'A'}`,
        );
        return Promise.resolve(receipt);
      })
      .mockImplementationOnce((_url: URL, init: RequestInit) => {
        const receipt = responseForRequest(init, {
          outcome: 'denied',
          denialCode: 'unsubscribed',
        });
        const signature = receipt.headers.get('x-gaoq-signature');
        if (signature === null) throw new Error('TEST_SIGNATURE_MISSING');
        receipt.headers.set(
          'x-gaoq-signature',
          `${signature.slice(0, -1)}${signature.endsWith('B') ? 'C' : 'B'}`,
        );
        return Promise.resolve(receipt);
      }));
    const subject = adapter();

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(subject.dispatch(REQUEST))
        .rejects.toThrow('CARE_OCCASION_RECEIPT_SIGNATURE_INVALID');
    }
  });

  it('Content-Length 非规范、超限和截断均映射为稳定错误', async () => {
    const invalidLength = signedResponse({});
    invalidLength.headers.set('content-length', '01');
    const tooLarge = signedResponse({});
    tooLarge.headers.set('content-length', String(16 * 1024 + 1));
    const truncated = signedResponse({});
    truncated.headers.set(
      'content-length',
      String(Buffer.byteLength('{}', 'utf8') + 1),
    );
    const unsafeInteger = signedResponse({});
    unsafeInteger.headers.set('content-length', '9007199254740992');
    const longerThanDeclared = signedResponse({});
    longerThanDeclared.headers.set('content-length', '1');
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(invalidLength)
      .mockResolvedValueOnce(tooLarge)
      .mockResolvedValueOnce(truncated)
      .mockResolvedValueOnce(unsafeInteger)
      .mockResolvedValueOnce(longerThanDeclared));
    const subject = adapter();

    await expect(subject.dispatch(REQUEST))
      .rejects.toThrow('CARE_OCCASION_RESPONSE_LENGTH_INVALID');
    await expect(subject.dispatch(REQUEST))
      .rejects.toThrow('CARE_OCCASION_RECEIPT_TOO_LARGE');
    await expect(subject.dispatch(REQUEST))
      .rejects.toThrow('CARE_OCCASION_RESPONSE_LENGTH_INVALID');
    await expect(subject.dispatch(REQUEST))
      .rejects.toThrow('CARE_OCCASION_RESPONSE_LENGTH_INVALID');
    await expect(subject.dispatch(REQUEST))
      .rejects.toThrow('CARE_OCCASION_RESPONSE_LENGTH_INVALID');
  });

  it('空响应和不足两个字节的响应不会进入验签', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(null, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(signedResponse({}, {
        bytes: new Uint8Array([123]),
      })));
    const subject = adapter();

    await expect(subject.dispatch(REQUEST))
      .rejects.toThrow('CARE_OCCASION_RECEIPT_INVALID');
    await expect(subject.dispatch(REQUEST))
      .rejects.toThrow('CARE_OCCASION_RECEIPT_INVALID');
  });

  it('无界正文和流读取异常不会进入解析或验签', async () => {
    const oversized = new Response(Buffer.alloc(16 * 1024 + 1, 65), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    const broken = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('sensitive upstream stream failure'));
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(oversized)
      .mockResolvedValueOnce(broken));
    const subject = adapter();

    await expect(subject.dispatch(REQUEST))
      .rejects.toThrow('CARE_OCCASION_RECEIPT_TOO_LARGE');
    await expect(subject.dispatch(REQUEST))
      .rejects.toThrow('CARE_OCCASION_RESPONSE_READ_ERROR');
  });

  it('Fatal UTF-8、非法 JSON 和额外回执字段统一失败关闭', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(signedResponse({}, {
        bytes: new Uint8Array([0xc3, 0x28]),
      }))
      .mockResolvedValueOnce(signedResponse({}, {
        bytes: Buffer.from('{{', 'utf8'),
      }))
      .mockImplementationOnce((_url: URL, init: RequestInit) => Promise.resolve(
        responseForRequest(init, {
          outcome: 'denied',
          denialCode: 'unsubscribed',
          providerToken: 'forbidden',
        }),
      )));
    const subject = adapter();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(subject.dispatch(REQUEST))
        .rejects.toThrow('CARE_OCCASION_RECEIPT_INVALID');
    }
  });

  it('回执必须绑定当前租户、任务、摘要和允许渠道', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockImplementationOnce((_url: URL, init: RequestInit) => Promise.resolve(
        responseForRequest(init, {
          outcome: 'denied',
          tenantId: 'tenant-other',
          denialCode: 'unsubscribed',
        }),
      ))
      .mockImplementationOnce((_url: URL, init: RequestInit) => Promise.resolve(
        responseForRequest(init, {
          outcome: 'delivered',
          deliveryEvidenceId: 'delivery-002',
          deliveredAt: new Date().toISOString(),
          channel: 'sms',
        }),
      )));
    const subject = adapter();

    await expect(subject.dispatch(REQUEST))
      .rejects.toThrow('CARE_OCCASION_RECEIPT_CONTEXT_MISMATCH');
    await expect(subject.dispatch(REQUEST))
      .rejects.toThrow('CARE_OCCASION_RECEIPT_CHANNEL_MISMATCH');
  });

  it('送达时间不得早于计划时刻或超过当前时间窗口', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockImplementationOnce((_url: URL, init: RequestInit) => Promise.resolve(
        responseForRequest(init, {
          outcome: 'delivered',
          deliveryEvidenceId: 'delivery-003',
          deliveredAt: '2026-07-26T23:59:59.000Z',
          channel: 'feishu',
        }),
      ))
      .mockImplementationOnce((_url: URL, init: RequestInit) => Promise.resolve(
        responseForRequest(init, {
          outcome: 'delivered',
          deliveryEvidenceId: 'delivery-004',
          deliveredAt: '2099-01-01T00:00:00.000Z',
          channel: 'feishu',
        }),
      )));
    const subject = adapter();

    await expect(subject.dispatch(REQUEST))
      .rejects.toThrow('CARE_OCCASION_RECEIPT_INVALID');
    await expect(subject.dispatch(REQUEST))
      .rejects.toThrow('CARE_OCCASION_RECEIPT_INVALID');
  });
});

function config(
  values: Partial<Record<keyof AppEnvironment, unknown>>,
): ConfigService<AppEnvironment, true> {
  return {
    get: vi.fn((key: keyof AppEnvironment) => values[key]),
  } as unknown as ConfigService<AppEnvironment, true>;
}
