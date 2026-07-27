import {
  createHash,
  createPublicKey,
  verify,
} from 'node:crypto';
import { isIP } from 'node:net';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';

import type { AppEnvironment } from '../../../config/environment.js';
import {
  CareOccasionNotificationPort,
  type CareOccasionNotificationReceipt,
  type CareOccasionNotificationRequest,
} from './care-occasion-notification.port.js';

const receiptSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('delivered'),
    tenantId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
    occasionTaskId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
    controlDigest: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    deliveryEvidenceId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
    deliveredAt: z.iso.datetime({ offset: true }),
    channel: z.enum(['email', 'sms', 'feishu', 'dingtalk']),
  }).strict(),
  z.object({
    outcome: z.literal('denied'),
    tenantId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
    occasionTaskId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
    controlDigest: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    denialCode: z.enum([
      'unsubscribed',
      'no_authorized_channel',
      'purpose_restricted',
      'quiet_hours',
    ]),
  }).strict(),
]);

/** 关怀通知 HTTP 适配器：最小化出站字段，并验证 Ed25519 终态回执。 */
@Injectable()
export class CareOccasionNotificationHttpAdapter extends CareOccasionNotificationPort {
  constructor(private readonly config: ConfigService<AppEnvironment, true>) {
    super();
  }

  override async dispatch(
    request: CareOccasionNotificationRequest,
  ): Promise<CareOccasionNotificationReceipt> {
    const endpoint = safeDispatchUrl(
      this.required('CARE_OCCASION_NOTIFICATION_ENDPOINT'),
    );
    const token = this.required('CARE_OCCASION_NOTIFICATION_BEARER_TOKEN');
    const expectedKeyId = this.required('CARE_OCCASION_NOTIFICATION_SIGNING_KEY_ID');
    const publicKeyBase64 = this.required(
      'CARE_OCCASION_NOTIFICATION_SIGNING_PUBLIC_KEY_BASE64',
    );
    const payload = {
      tenantId: request.tenantId,
      occasionTaskId: request.occasionTaskId,
      employeeId: request.employeeId,
      occasionType: request.occasionType,
      purpose: request.purpose,
      templateCode: request.templateCode,
      policyVersion: request.policyVersion,
      scheduledAt: request.scheduledAt,
      preferredChannels: request.preferredChannels,
      sourceDigest: request.sourceDigest,
    };
    const controlDigest = createHash('sha256')
      .update(JSON.stringify(payload), 'utf8')
      .digest('base64url');
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'idempotency-key': request.idempotencyKey,
      },
      body: JSON.stringify({ ...payload, controlDigest }),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    if (response?.ok !== true) throw new Error('CARE_OCCASION_GATEWAY_FAILED');
    if (response.headers.get('content-type')?.split(';', 1)[0] !== 'application/json') {
      throw new Error('CARE_OCCASION_RECEIPT_INVALID');
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length < 2 || bytes.length > 16_384) {
      throw new Error('CARE_OCCASION_RECEIPT_INVALID');
    }
    const keyId = response.headers.get('x-gaoq-signing-key-id');
    const signatureValue = response.headers.get('x-gaoq-signature');
    if (
      keyId !== expectedKeyId ||
      signatureValue === null ||
      !/^[A-Za-z0-9_-]{86}$/.test(signatureValue)
    ) throw new Error('CARE_OCCASION_RECEIPT_SIGNATURE_INVALID');
    const publicKey = this.publicKey(publicKeyBase64);
    const digest = createHash('sha256').update(bytes).digest('base64url');
    const signingInput = Buffer.from(
      `gaoq-care-occasion-receipt-v1\n${keyId}\n${digest}`,
      'utf8',
    );
    if (!verify(null, signingInput, publicKey, Buffer.from(signatureValue, 'base64url'))) {
      throw new Error('CARE_OCCASION_RECEIPT_SIGNATURE_INVALID');
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(bytes.toString('utf8')) as unknown;
    } catch {
      throw new Error('CARE_OCCASION_RECEIPT_INVALID');
    }
    const receipt = receiptSchema.parse(decoded);
    if (
      receipt.tenantId !== request.tenantId ||
      receipt.occasionTaskId !== request.occasionTaskId ||
      receipt.controlDigest !== controlDigest
    ) throw new Error('CARE_OCCASION_RECEIPT_CONTEXT_MISMATCH');
    if (
      receipt.outcome === 'delivered' &&
      !request.preferredChannels.includes(receipt.channel)
    ) throw new Error('CARE_OCCASION_RECEIPT_CHANNEL_MISMATCH');
    if (
      receipt.outcome === 'delivered' &&
      Date.parse(receipt.deliveredAt) > Date.now() + 5 * 60_000
    ) throw new Error('CARE_OCCASION_RECEIPT_INVALID');
    return receipt.outcome === 'delivered'
      ? Object.freeze({
          outcome: receipt.outcome,
          deliveryEvidenceId: receipt.deliveryEvidenceId,
          deliveredAt: new Date(receipt.deliveredAt).toISOString(),
          channel: receipt.channel,
        })
      : Object.freeze({
          outcome: receipt.outcome,
          denialCode: receipt.denialCode,
        });
  }

  private required<Key extends keyof AppEnvironment>(key: Key): string {
    const value = this.config.get(key, { infer: true });
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error('CARE_OCCASION_GATEWAY_UNAVAILABLE');
    }
    return value;
  }

  private publicKey(value: string) {
    try {
      const decoded = Buffer.from(value, 'base64');
      if (decoded.toString('base64') !== value) throw new Error('INVALID');
      const key = createPublicKey({ key: decoded, format: 'der', type: 'spki' });
      if (key.asymmetricKeyType !== 'ed25519') throw new Error('INVALID');
      return key;
    } catch {
      throw new Error('CARE_OCCASION_SIGNING_KEY_INVALID');
    }
  }
}

function safeDispatchUrl(value: string): URL {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase().replace(/\.$/u, '')
    .replace(/^\[(.*)\]$/u, '$1');
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    (url.port !== '' && url.port !== '443') ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    isIP(hostname) !== 0
  ) throw new Error('CARE_OCCASION_GATEWAY_ENDPOINT_INVALID');
  return new URL('/v1/employee-care/dispatch', url);
}
