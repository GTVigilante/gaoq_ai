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
});

function config(
  values: Partial<Record<keyof AppEnvironment, unknown>>,
): ConfigService<AppEnvironment, true> {
  return {
    get: vi.fn((key: keyof AppEnvironment) => values[key]),
  } as unknown as ConfigService<AppEnvironment, true>;
}
