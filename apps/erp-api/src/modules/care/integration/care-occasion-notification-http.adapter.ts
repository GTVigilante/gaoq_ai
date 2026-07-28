import {
  createHash,
  createPublicKey,
  type KeyObject,
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

const RESPONSE_LIMIT_BYTES = 16 * 1024;
const REQUEST_LIMIT_BYTES = 128 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CODE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DIGEST = /^[A-Za-z0-9_-]{43}$/;
const TOKEN = /^[\x21-\x7e]{32,512}$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const JSON_CONTENT_TYPE =
  /^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json(?:\s*;\s*charset=utf-8)?$/iu;
const requestSchema = z.object({
  tenantId: z.string().regex(SAFE_ID),
  occasionTaskId: z.string().regex(SAFE_ID),
  employeeId: z.string().regex(SAFE_ID),
  occasionType: z.enum(['birthday', 'employment_anniversary']),
  purpose: z.literal('employee_care'),
  templateCode: z.string().regex(CODE),
  policyVersion: z.string().regex(CODE),
  scheduledAt: z.iso.datetime({ offset: true }),
  preferredChannels: z.array(
    z.enum(['email', 'sms', 'feishu', 'dingtalk']),
  ).min(1).max(4),
  sourceDigest: z.string().regex(DIGEST),
  idempotencyKey: z.string().regex(DIGEST),
}).strict();
const receiptSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('delivered'),
    tenantId: z.string().regex(SAFE_ID),
    occasionTaskId: z.string().regex(SAFE_ID),
    controlDigest: z.string().regex(DIGEST),
    deliveryEvidenceId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
    deliveredAt: z.iso.datetime({ offset: true }),
    channel: z.enum(['email', 'sms', 'feishu', 'dingtalk']),
  }).strict(),
  z.object({
    outcome: z.literal('denied'),
    tenantId: z.string().regex(SAFE_ID),
    occasionTaskId: z.string().regex(SAFE_ID),
    controlDigest: z.string().regex(DIGEST),
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
    const parsedRequest = requestSchema.safeParse(request);
    if (
      !parsedRequest.success ||
      new Set(parsedRequest.data.preferredChannels).size !==
        parsedRequest.data.preferredChannels.length
    ) throw new Error('CARE_OCCASION_REQUEST_INVALID');
    const endpoint = safeDispatchUrl(
      this.required('CARE_OCCASION_NOTIFICATION_ENDPOINT'),
    );
    const token = this.required('CARE_OCCASION_NOTIFICATION_BEARER_TOKEN');
    const expectedKeyId = this.required('CARE_OCCASION_NOTIFICATION_SIGNING_KEY_ID');
    const publicKeyBase64 = this.required(
      'CARE_OCCASION_NOTIFICATION_SIGNING_PUBLIC_KEY_BASE64',
    );
    if (!TOKEN.test(token)) {
      throw new Error('CARE_OCCASION_GATEWAY_CREDENTIAL_INVALID');
    }
    if (!KEY_ID.test(expectedKeyId)) {
      throw new Error('CARE_OCCASION_SIGNING_KEY_INVALID');
    }
    const publicKey = this.publicKey(publicKeyBase64);
    const payload = {
      tenantId: parsedRequest.data.tenantId,
      occasionTaskId: parsedRequest.data.occasionTaskId,
      employeeId: parsedRequest.data.employeeId,
      occasionType: parsedRequest.data.occasionType,
      purpose: parsedRequest.data.purpose,
      templateCode: parsedRequest.data.templateCode,
      policyVersion: parsedRequest.data.policyVersion,
      scheduledAt: parsedRequest.data.scheduledAt,
      preferredChannels: parsedRequest.data.preferredChannels,
      sourceDigest: parsedRequest.data.sourceDigest,
    };
    const controlDigest = createHash('sha256')
      .update(JSON.stringify(payload), 'utf8')
      .digest('base64url');
    const body = JSON.stringify({ ...payload, controlDigest });
    const bodyLength = Buffer.byteLength(body, 'utf8');
    if (bodyLength > REQUEST_LIMIT_BYTES) {
      throw new Error('CARE_OCCASION_REQUEST_INVALID');
    }
    const response = await requestGateway(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        'accept-encoding': 'identity',
        'cache-control': 'no-store',
        'content-type': 'application/json',
        'content-length': String(bodyLength),
        'idempotency-key': parsedRequest.data.idempotencyKey,
      },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    const bytes = await readResponseBytes(response);
    const keyId = response.headers.get('x-gaoq-signing-key-id');
    const signatureValue = response.headers.get('x-gaoq-signature');
    if (
      keyId !== expectedKeyId ||
      signatureValue === null ||
      !/^[A-Za-z0-9_-]{86}$/.test(signatureValue)
    ) throw new Error('CARE_OCCASION_RECEIPT_SIGNATURE_INVALID');
    let signature: Buffer;
    try {
      signature = canonicalBase64Url(signatureValue);
    } catch {
      throw new Error('CARE_OCCASION_RECEIPT_SIGNATURE_INVALID');
    }
    if (signature.byteLength !== 64) {
      throw new Error('CARE_OCCASION_RECEIPT_SIGNATURE_INVALID');
    }
    const digest = createHash('sha256').update(bytes).digest('base64url');
    const signingInput = Buffer.from(
      `gaoq-care-occasion-receipt-v1\n${keyId}\n${digest}`,
      'utf8',
    );
    if (!verify(null, signingInput, publicKey, signature)) {
      throw new Error('CARE_OCCASION_RECEIPT_SIGNATURE_INVALID');
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      ) as unknown;
    } catch {
      throw new Error('CARE_OCCASION_RECEIPT_INVALID');
    }
    const parsedReceipt = receiptSchema.safeParse(decoded);
    if (!parsedReceipt.success) throw new Error('CARE_OCCASION_RECEIPT_INVALID');
    const receipt = parsedReceipt.data;
    if (
      receipt.tenantId !== parsedRequest.data.tenantId ||
      receipt.occasionTaskId !== parsedRequest.data.occasionTaskId ||
      receipt.controlDigest !== controlDigest
    ) throw new Error('CARE_OCCASION_RECEIPT_CONTEXT_MISMATCH');
    if (
      receipt.outcome === 'delivered' &&
      !parsedRequest.data.preferredChannels.includes(receipt.channel)
    ) throw new Error('CARE_OCCASION_RECEIPT_CHANNEL_MISMATCH');
    if (
      receipt.outcome === 'delivered' &&
      (
        Date.parse(receipt.deliveredAt) <
          Date.parse(parsedRequest.data.scheduledAt) ||
        Date.parse(receipt.deliveredAt) > Date.now() + 5 * 60_000
      )
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

  private publicKey(value: string): KeyObject {
    try {
      const decoded = canonicalBase64(value);
      const key = createPublicKey({ key: decoded, format: 'der', type: 'spki' });
      const exported = key.export({ format: 'der', type: 'spki' });
      if (
        key.asymmetricKeyType !== 'ed25519' ||
        !Buffer.isBuffer(exported) ||
        !exported.equals(decoded)
      ) throw new Error('INVALID');
      return key;
    } catch {
      throw new Error('CARE_OCCASION_SIGNING_KEY_INVALID');
    }
  }
}

async function requestGateway(url: URL, init: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    throw new Error('CARE_OCCASION_GATEWAY_FAILED');
  }
  if (!response.ok) {
    cancelResponseBody(response);
    throw new Error('CARE_OCCASION_GATEWAY_FAILED');
  }
  if (
    !JSON_CONTENT_TYPE.test(
      response.headers.get('content-type')?.trim() ?? '',
    )
  ) {
    cancelResponseBody(response);
    throw new Error('CARE_OCCASION_RECEIPT_INVALID');
  }
  const encoding = response.headers.get('content-encoding');
  if (
    encoding !== null &&
    encoding.trim().toLowerCase() !== 'identity'
  ) {
    cancelResponseBody(response);
    throw new Error('CARE_OCCASION_RECEIPT_INVALID');
  }
  return response;
}

async function readResponseBytes(response: Response): Promise<Uint8Array> {
  if (response.body === null) throw new Error('CARE_OCCASION_RECEIPT_INVALID');
  let expectedLength: number | null;
  try {
    expectedLength = responseLength(response.headers.get('content-length'));
  } catch (error) {
    cancelResponseBody(response);
    throw error;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      let part: { readonly done: boolean; readonly value?: Uint8Array };
      try {
        part = await reader.read();
      } catch {
        cancelReader(reader);
        throw new Error('CARE_OCCASION_RESPONSE_READ_ERROR');
      }
      if (part.done) break;
      if (!(part.value instanceof Uint8Array)) {
        cancelReader(reader);
        throw new Error('CARE_OCCASION_RESPONSE_READ_ERROR');
      }
      total += part.value.byteLength;
      if (
        total > RESPONSE_LIMIT_BYTES ||
        (expectedLength !== null && total > expectedLength)
      ) {
        cancelReader(reader);
        throw new Error(
          total > RESPONSE_LIMIT_BYTES
            ? 'CARE_OCCASION_RECEIPT_TOO_LARGE'
            : 'CARE_OCCASION_RESPONSE_LENGTH_INVALID',
        );
      }
      chunks.push(part.value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // 清理失败不得覆盖已确定的通知网关结果。
    }
  }
  if (total < 2) throw new Error('CARE_OCCASION_RECEIPT_INVALID');
  if (expectedLength !== null && total !== expectedLength) {
    throw new Error('CARE_OCCASION_RESPONSE_LENGTH_INVALID');
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function responseLength(value: string | null): number | null {
  if (value === null) return null;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error('CARE_OCCASION_RESPONSE_LENGTH_INVALID');
  }
  const length = Number(value);
  if (!Number.isSafeInteger(length)) {
    throw new Error('CARE_OCCASION_RESPONSE_LENGTH_INVALID');
  }
  if (length > RESPONSE_LIMIT_BYTES) {
    throw new Error('CARE_OCCASION_RECEIPT_TOO_LARGE');
  }
  return length;
}

function canonicalBase64(value: string): Buffer {
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u
      .test(value)
  ) throw new Error('BASE64_INVALID');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.byteLength === 0 || bytes.toString('base64') !== value) {
    throw new Error('BASE64_INVALID');
  }
  return bytes;
}

function canonicalBase64Url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error('BASE64URL_INVALID');
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.byteLength === 0 || bytes.toString('base64url') !== value) {
    throw new Error('BASE64URL_INVALID');
  }
  return bytes;
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    void reader.cancel().catch(() => undefined);
  } catch {
    // 取消是尽力操作，不得覆盖稳定错误码。
  }
}

function cancelResponseBody(response: Response): void {
  try {
    void response.body?.cancel().catch(() => undefined);
  } catch {
    // 释放是尽力操作，不得覆盖稳定错误码。
  }
}

function safeDispatchUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('CARE_OCCASION_GATEWAY_ENDPOINT_INVALID');
  }
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
