import {
  createHash,
  createPublicKey,
  type KeyObject,
  verify as verifySignature,
} from 'node:crypto';
import { isIP } from 'node:net';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';

import type { AppEnvironment } from '../../../config/environment.js';
import {
  KnowledgeContentVerificationPort,
  KnowledgeGradingPort,
  type KnowledgeGradingResult,
} from '../application/knowledge-ports.js';
import type { CourseVersion } from '../domain/index.js';

const RESPONSE_LIMIT_BYTES = 16 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST = /^[A-Za-z0-9_-]{43}$/;
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/;
const verificationReceiptSchema = z.object({
  tenantId: z.string().regex(SAFE_ID),
  courseVersionId: z.string().regex(SAFE_ID),
  contentRef: z.string().regex(SAFE_ID),
  questionBankRef: z.string().regex(SAFE_ID).nullable(),
  questionBankDigest: z.string().regex(DIGEST).nullable(),
  contentVerified: z.boolean(),
  questionBankVerified: z.boolean(),
  verificationEvidenceId: z.string().regex(ULID),
}).strict();
const gradingReceiptSchema = z.object({
  tenantId: z.string().regex(SAFE_ID),
  assignmentId: z.string().regex(SAFE_ID),
  courseVersionId: z.string().regex(SAFE_ID),
  submissionRef: z.string().regex(SAFE_ID),
  questionBankRef: z.string().regex(SAFE_ID),
  questionBankDigest: z.string().regex(DIGEST),
  questionSetDigest: z.string().regex(DIGEST),
  gradingEvidenceId: z.string().regex(ULID),
  scoreBps: z.number().int().min(0).max(10_000),
}).strict();

@Injectable()
export class KnowledgeEvidenceHttpClient {
  constructor(private readonly config: ConfigService<AppEnvironment, true>) {}

  async verify(course: CourseVersion): Promise<{
    readonly contentVerified: boolean;
    readonly questionBankVerified: boolean;
  }> {
    const parsed = verificationReceiptSchema.safeParse(await this.post(
      '/v1/courses/verify',
      {
        tenantId: course.tenantId, courseVersionId: course.id,
        contentRef: course.contentRef, questionBankRef: course.questionBankRef,
        questionBankDigest: course.questionBankDigest,
      },
      digest(['verify', course.tenantId, course.id, String(course.version)]),
    ));
    if (!parsed.success) throw new Error('KNOWLEDGE_VERIFICATION_RECEIPT_INVALID');
    const receipt = parsed.data;
    if (
      receipt.tenantId !== course.tenantId ||
      receipt.courseVersionId !== course.id ||
      receipt.contentRef !== course.contentRef ||
      receipt.questionBankRef !== course.questionBankRef ||
      receipt.questionBankDigest !== course.questionBankDigest
    ) throw new Error('KNOWLEDGE_VERIFICATION_RECEIPT_MISMATCH');
    return Object.freeze({
      contentVerified: receipt.contentVerified,
      questionBankVerified: receipt.questionBankVerified,
    });
  }

  async grade(input: {
    readonly tenantId: string;
    readonly assignmentId: string;
    readonly courseVersionId: string;
    readonly questionBankRef: string;
    readonly questionBankDigest: string;
    readonly submissionRef: string;
  }): Promise<KnowledgeGradingResult> {
    const parsed = gradingReceiptSchema.safeParse(await this.post(
      '/v1/submissions/grade',
      input,
      digest([
        'grade', input.tenantId, input.assignmentId, input.courseVersionId,
        input.questionBankRef, input.questionBankDigest, input.submissionRef,
      ]),
    ));
    if (!parsed.success) throw new Error('KNOWLEDGE_GRADING_RECEIPT_INVALID');
    const receipt = parsed.data;
    if (
      receipt.tenantId !== input.tenantId ||
      receipt.assignmentId !== input.assignmentId ||
      receipt.courseVersionId !== input.courseVersionId ||
      receipt.submissionRef !== input.submissionRef ||
      receipt.questionBankRef !== input.questionBankRef ||
      receipt.questionBankDigest !== input.questionBankDigest
    ) throw new Error('KNOWLEDGE_GRADING_RECEIPT_MISMATCH');
    return Object.freeze({
      scoreBps: receipt.scoreBps,
      questionBankDigest: receipt.questionBankDigest,
      questionSetDigest: receipt.questionSetDigest,
      gradingEvidenceId: receipt.gradingEvidenceId,
    });
  }

  private async post(
    path: '/v1/courses/verify' | '/v1/submissions/grade',
    body: Readonly<Record<string, unknown>>,
    idempotencyKey: string,
  ): Promise<unknown> {
    const endpoint = this.config.get('KNOWLEDGE_EVIDENCE_GATEWAY_ENDPOINT', { infer: true });
    const token = this.config.get('KNOWLEDGE_EVIDENCE_GATEWAY_BEARER_TOKEN', { infer: true });
    const signingPublicKey = this.config.get(
      'KNOWLEDGE_EVIDENCE_GATEWAY_SIGNING_PUBLIC_KEY_BASE64',
      { infer: true },
    );
    const signingKeyId = this.config.get(
      'KNOWLEDGE_EVIDENCE_GATEWAY_SIGNING_KEY_ID',
      { infer: true },
    );
    if (
      endpoint === undefined || token === undefined ||
      signingPublicKey === undefined || signingKeyId === undefined
    ) {
      throw new Error('KNOWLEDGE_EVIDENCE_GATEWAY_UNAVAILABLE');
    }
    const url = new URL(path, safeBaseUrl(endpoint)).toString();
    const payload = JSON.stringify(body);
    const response = await request(url, {
      method: 'POST', redirect: 'error',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json', 'cache-control': 'no-store',
        'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)),
        'idempotency-key': idempotencyKey,
      },
      body: payload,
    });
    const bytes = await readBytes(response);
    verifyReceipt(bytes, response.headers, signingPublicKey, signingKeyId);
    return parseJson(bytes);
  }
}

@Injectable()
export class HttpKnowledgeGradingAdapter extends KnowledgeGradingPort {
  constructor(private readonly client: KnowledgeEvidenceHttpClient) { super(); }

  override grade(
    input: Parameters<KnowledgeGradingPort['grade']>[0],
  ): Promise<KnowledgeGradingResult> {
    return this.client.grade(input);
  }
}

@Injectable()
export class HttpKnowledgeContentVerificationAdapter extends KnowledgeContentVerificationPort {
  constructor(private readonly client: KnowledgeEvidenceHttpClient) { super(); }

  override verify(course: CourseVersion): Promise<{
    readonly contentVerified: boolean;
    readonly questionBankVerified: boolean;
  }> {
    return this.client.verify(course);
  }
}

async function request(url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(url, { ...init, signal: AbortSignal.timeout(5_000) });
    } catch {
      if (attempt === 0) continue;
      throw new Error('KNOWLEDGE_EVIDENCE_GATEWAY_UNAVAILABLE');
    }
    if ([502, 503, 504].includes(response.status) && attempt === 0) {
      await response.body?.cancel().catch(() => undefined);
      continue;
    }
    if (response.status !== 200) {
      throw new Error(`KNOWLEDGE_EVIDENCE_GATEWAY_HTTP_${response.status}`);
    }
    if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
      throw new Error('KNOWLEDGE_EVIDENCE_RECEIPT_INVALID');
    }
    return response;
  }
  throw new Error('KNOWLEDGE_EVIDENCE_GATEWAY_UNAVAILABLE');
}

async function readBytes(response: Response): Promise<Uint8Array> {
  if (response.body === null) throw new Error('KNOWLEDGE_EVIDENCE_RECEIPT_INVALID');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      if (!(part.value instanceof Uint8Array)) {
        throw new Error('KNOWLEDGE_EVIDENCE_RECEIPT_INVALID');
      }
      total += part.value.byteLength;
      if (total > RESPONSE_LIMIT_BYTES) throw new Error('KNOWLEDGE_EVIDENCE_RECEIPT_TOO_LARGE');
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function verifyReceipt(
  bytes: Uint8Array,
  headers: Headers,
  publicKeyBase64: string,
  expectedKeyId: string,
): void {
  const keyId = headers.get('x-knowledge-evidence-key-id');
  const signature = headers.get('x-knowledge-evidence-signature');
  if (
    keyId !== expectedKeyId || !SAFE_ID.test(expectedKeyId) ||
    signature === null || !SIGNATURE.test(signature)
  ) throw new Error('KNOWLEDGE_EVIDENCE_RECEIPT_SIGNATURE_INVALID');
  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey({
      key: Buffer.from(publicKeyBase64, 'base64'),
      format: 'der',
      type: 'spki',
    });
  } catch {
    throw new Error('KNOWLEDGE_EVIDENCE_SIGNING_KEY_INVALID');
  }
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('KNOWLEDGE_EVIDENCE_SIGNING_KEY_INVALID');
  }
  const signed = Buffer.from(receiptSigningInput(keyId, bytes), 'utf8');
  if (!verifySignature(null, signed, publicKey, Buffer.from(signature, 'base64url'))) {
    throw new Error('KNOWLEDGE_EVIDENCE_RECEIPT_SIGNATURE_INVALID');
  }
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new Error('KNOWLEDGE_EVIDENCE_RECEIPT_INVALID');
  }
}

function receiptSigningInput(keyId: string, bytes: Uint8Array): string {
  return [
    'knowledge-evidence-receipt-v1',
    keyId,
    createHash('sha256').update(bytes).digest('base64url'),
  ].join('\n');
}

function safeBaseUrl(value: string): string {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase().replace(/\.$/u, '')
    .replace(/^\[(.*)\]$/u, '$1');
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.pathname !== '/' || url.search !== '' || url.hash !== '' ||
    (url.port !== '' && url.port !== '443') || isLoopback(hostname)
  ) throw new Error('KNOWLEDGE_EVIDENCE_GATEWAY_ENDPOINT_INVALID');
  return url.toString();
}

function isLoopback(hostname: string): boolean {
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  if (isIP(hostname) === 4) return hostname.startsWith('127.');
  return isIP(hostname) === 6 && hostname === '::1';
}

function digest(parts: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(parts), 'utf8').digest('base64url');
}
