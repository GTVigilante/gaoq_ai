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
  KnowledgeExamOrchestrationPort,
  type KnowledgeExamFinalizationReceipt,
  type KnowledgeExamOrchestrationInput,
  type KnowledgeExamStartReceipt,
  type KnowledgeExamTimeoutReceipt,
  KnowledgeSearchPort,
  type KnowledgeSearchResult,
  KnowledgeSearchIndexPort,
  type KnowledgeSearchIndexReceipt,
} from '../application/knowledge-ports.js';
import type { CourseVersion } from '../domain/index.js';

const RESPONSE_LIMIT_BYTES = 16 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST = /^[A-Za-z0-9_-]{43}$/;
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/;
const CURSOR = /^[A-Za-z0-9_-]{16,256}$/;
const highlightSchema = z.object({
  start: z.number().int().min(0).max(512),
  end: z.number().int().min(1).max(512),
}).strict();
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
const examBindingSchema = z.object({
  runId: z.string().regex(ULID),
  tenantId: z.string().regex(SAFE_ID),
  assignmentId: z.string().regex(SAFE_ID),
  courseVersionId: z.string().regex(SAFE_ID),
  attemptNumber: z.number().int().min(1).max(10),
  questionBankRef: z.string().regex(SAFE_ID),
  questionBankDigest: z.string().regex(DIGEST),
  questionMode: z.enum(['objective', 'subjective', 'mixed']),
  gradingPolicyVersion: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$/u),
  passingRule: z.enum(['score_threshold', 'all_required_sections']),
  passingScoreBps: z.number().int().min(0).max(10_000),
  timeLimitMinutes: z.number().int().min(5).max(240),
  manualReviewRequired: z.boolean(),
  gradingSlaMinutes: z.number().int().min(1).max(60),
  manualReviewSlaMinutes: z.number().int().min(30).max(10_080),
});
const examStartReceiptSchema = examBindingSchema.extend({
  gatewaySessionRef: z.string().regex(SAFE_ID),
  questionSetDigest: z.string().regex(DIGEST),
  startedAt: z.string().datetime({ offset: true }),
  deadlineAt: z.string().datetime({ offset: true }),
}).strict();
const examTimeoutReceiptSchema = examBindingSchema.extend({
  gatewaySessionRef: z.string().regex(SAFE_ID),
  questionSetDigest: z.string().regex(DIGEST),
  deadlineAt: z.string().datetime({ offset: true }),
  submissionRef: z.string().regex(SAFE_ID),
  submittedAt: z.string().datetime({ offset: true }),
}).strict();
const examFinalizationReceiptSchema = examBindingSchema.extend({
  gatewaySessionRef: z.string().regex(SAFE_ID),
  questionSetDigest: z.string().regex(DIGEST),
  submissionRef: z.string().regex(SAFE_ID),
  timedOut: z.boolean(),
  submittedAt: z.string().datetime({ offset: true }),
  result: z.discriminatedUnion('status', [
    z.object({
      status: z.literal('pending_review'),
      reviewEvidenceId: z.string().regex(ULID),
      reviewRequestedAt: z.string().datetime({ offset: true }),
    }).strict(),
    z.object({
      status: z.literal('graded'),
      scoreBps: z.number().int().min(0).max(10_000),
      passed: z.boolean(),
      gradingEvidenceId: z.string().regex(ULID),
      gradedAt: z.string().datetime({ offset: true }),
    }).strict(),
  ]),
}).strict();
const searchReceiptSchema = z.object({
  tenantId: z.string().regex(SAFE_ID),
  employeeId: z.string().regex(SAFE_ID),
  authorizationDigest: z.string().regex(DIGEST),
  queryDigest: z.string().regex(DIGEST),
  items: z.array(z.object({
    courseVersionId: z.string().regex(SAFE_ID),
    revision: z.number().int().min(1),
    snippetText: z.string().min(1).max(512).refine(safeSnippetText),
    highlights: z.array(highlightSchema).max(8),
    scoreBps: z.number().int().min(0).max(10_000),
    indexedAt: z.string().datetime({ offset: true }),
  }).strict()).max(20),
  nextCursor: z.string().regex(CURSOR).nullable(),
  partial: z.literal(false),
}).strict();
const searchRequestSchema = z.object({
  tenantId: z.string().regex(SAFE_ID),
  employeeId: z.string().regex(SAFE_ID),
  departmentIds: z.array(z.string().regex(SAFE_ID)).min(1).max(500),
  positionIds: z.array(z.string().regex(SAFE_ID)).max(200),
  allowedCourseVersionIds: z.array(z.string().regex(SAFE_ID)).min(1).max(200),
  authorizationDigest: z.string().regex(DIGEST),
  queryText: z.string().min(2).max(128),
  cursor: z.string().regex(CURSOR).nullable(),
  limit: z.number().int().min(1).max(20),
}).strict();
const searchIndexRequestSchema = z.object({
  eventId: z.string().regex(ULID),
  tenantId: z.string().regex(SAFE_ID),
  courseVersionId: z.string().regex(SAFE_ID),
  courseCode: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  revision: z.number().int().min(1),
  courseVersion: z.number().int().min(1),
  contentRef: z.string().regex(SAFE_ID),
  operation: z.enum(['upsert', 'delete']),
  audienceMode: z.enum(['assigned_only', 'employment_scope']),
  audienceDepartmentIds: z.array(z.string().regex(SAFE_ID)).max(200),
  audiencePositionIds: z.array(z.string().regex(SAFE_ID)).max(200),
}).strict();
const searchIndexReceiptSchema = z.object({
  eventId: z.string().regex(ULID),
  tenantId: z.string().regex(SAFE_ID),
  courseVersionId: z.string().regex(SAFE_ID),
  courseVersion: z.number().int().min(1),
  operation: z.enum(['upsert', 'delete']),
  receiptId: z.string().regex(SAFE_ID),
  indexedContentDigest: z.string().regex(DIGEST),
  indexedAt: z.string().datetime({ offset: true }),
  partial: z.literal(false),
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
      'evidence',
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

  async startExam(
    input: KnowledgeExamOrchestrationInput,
  ): Promise<KnowledgeExamStartReceipt> {
    const parsed = examStartReceiptSchema.safeParse(await this.post(
      '/v1/exam-runs/start',
      input,
      digest(['exam-start', input.tenantId, input.runId, input.gradingPolicyVersion]),
      'evidence',
    ));
    if (!parsed.success || !matchesExamBinding(parsed.data, input)) {
      throw new Error('KNOWLEDGE_EXAM_START_RECEIPT_INVALID');
    }
    const startedAt = new Date(parsed.data.startedAt);
    const deadlineAt = new Date(parsed.data.deadlineAt);
    if (
      deadlineAt.getTime() - startedAt.getTime() !== input.timeLimitMinutes * 60_000 ||
      startedAt.getTime() < Date.now() - 5 * 60_000 ||
      startedAt.getTime() > Date.now() + 5 * 60_000
    ) throw new Error('KNOWLEDGE_EXAM_START_TIME_INVALID');
    return Object.freeze({
      gatewaySessionRef: parsed.data.gatewaySessionRef,
      questionSetDigest: parsed.data.questionSetDigest,
      startedAt: parsed.data.startedAt,
      deadlineAt: parsed.data.deadlineAt,
    });
  }

  async finalizeExam(
    input: KnowledgeExamOrchestrationInput & {
      readonly gatewaySessionRef: string;
      readonly questionSetDigest: string;
      readonly submissionRef: string;
      readonly timedOut: boolean;
      readonly submittedAt: string;
    },
  ): Promise<KnowledgeExamFinalizationReceipt> {
    return this.examFinalization('/v1/exam-runs/finalize', input);
  }

  async timeoutExam(
    input: KnowledgeExamOrchestrationInput & {
      readonly gatewaySessionRef: string;
      readonly questionSetDigest: string;
      readonly deadlineAt: string;
    },
  ): Promise<KnowledgeExamTimeoutReceipt> {
    const parsed = examTimeoutReceiptSchema.safeParse(await this.post(
      '/v1/exam-runs/timeout',
      input,
      digest([
        'exam-timeout',
        input.tenantId,
        input.runId,
        input.gatewaySessionRef,
        input.deadlineAt,
      ]),
      'evidence',
    ));
    if (
      !parsed.success ||
      !matchesExamBinding(parsed.data, input) ||
      parsed.data.gatewaySessionRef !== input.gatewaySessionRef ||
      parsed.data.questionSetDigest !== input.questionSetDigest ||
      parsed.data.deadlineAt !== input.deadlineAt ||
      parsed.data.submittedAt !== input.deadlineAt
    ) throw new Error('KNOWLEDGE_EXAM_TIMEOUT_RECEIPT_INVALID');
    return Object.freeze({
      submissionRef: parsed.data.submissionRef,
      submittedAt: parsed.data.submittedAt,
    });
  }

  async examStatus(
    input: KnowledgeExamOrchestrationInput & {
      readonly gatewaySessionRef: string;
      readonly questionSetDigest: string;
      readonly submissionRef: string;
      readonly reviewEvidenceId: string;
      readonly timedOut: boolean;
      readonly submittedAt: string;
    },
  ): Promise<KnowledgeExamFinalizationReceipt> {
    return this.examFinalization('/v1/exam-runs/status', input);
  }

  async search(
    input: Parameters<KnowledgeSearchPort['search']>[0],
  ): Promise<KnowledgeSearchResult> {
    const request = searchRequestSchema.safeParse(input);
    if (
      !request.success ||
      !unique(request.data.departmentIds) ||
      !unique(request.data.positionIds) ||
      !unique(request.data.allowedCourseVersionIds)
    ) throw new Error('KNOWLEDGE_SEARCH_REQUEST_INVALID');
    const queryDigest = digest(['search-query', request.data.queryText]);
    const parsed = searchReceiptSchema.safeParse(await this.post(
      '/v1/search',
      request.data,
      digest([
        'search', request.data.tenantId, request.data.employeeId,
        request.data.authorizationDigest, queryDigest, request.data.cursor ?? '',
        String(request.data.limit),
      ]),
      'search',
    ));
    if (!parsed.success) throw new Error('KNOWLEDGE_SEARCH_RECEIPT_INVALID');
    const receipt = parsed.data;
    if (
      receipt.tenantId !== request.data.tenantId ||
      receipt.employeeId !== request.data.employeeId ||
      receipt.authorizationDigest !== request.data.authorizationDigest ||
      receipt.queryDigest !== queryDigest ||
      receipt.items.length > request.data.limit ||
      new Set(receipt.items.map((item) => item.courseVersionId)).size !== receipt.items.length ||
      receipt.items.some(
        (item) => !request.data.allowedCourseVersionIds.includes(item.courseVersionId),
      ) ||
      receipt.items.some((item) => !validHighlights(item.snippetText, item.highlights))
    ) throw new Error('KNOWLEDGE_SEARCH_RECEIPT_MISMATCH');
    return Object.freeze({
      items: Object.freeze(receipt.items.map((item) => Object.freeze({
        ...item,
        highlights: Object.freeze(item.highlights.map((highlight) => Object.freeze(highlight))),
      }))),
      nextCursor: receipt.nextCursor,
    });
  }

  async applySearchIndex(
    input: Parameters<KnowledgeSearchIndexPort['apply']>[0],
  ): Promise<KnowledgeSearchIndexReceipt> {
    const request = searchIndexRequestSchema.safeParse(input);
    if (
      !request.success ||
      !unique(request.data.audienceDepartmentIds) ||
      !unique(request.data.audiencePositionIds) ||
      !validAudienceCombination(request.data)
    ) throw new Error('KNOWLEDGE_SEARCH_INDEX_REQUEST_INVALID');
    const path = request.data.operation === 'upsert'
      ? '/v1/indexes/courses/upsert'
      : '/v1/indexes/courses/delete';
    const parsed = searchIndexReceiptSchema.safeParse(await this.post(
      path,
      request.data,
      digest([
        'search-index',
        request.data.eventId,
        request.data.tenantId,
        request.data.courseVersionId,
        String(request.data.courseVersion),
        request.data.operation,
      ]),
      'search',
    ));
    if (!parsed.success) throw new Error('KNOWLEDGE_SEARCH_INDEX_RECEIPT_INVALID');
    const receipt = parsed.data;
    if (
      receipt.eventId !== request.data.eventId ||
      receipt.tenantId !== request.data.tenantId ||
      receipt.courseVersionId !== request.data.courseVersionId ||
      receipt.courseVersion !== request.data.courseVersion ||
      receipt.operation !== request.data.operation
    ) throw new Error('KNOWLEDGE_SEARCH_INDEX_RECEIPT_MISMATCH');
    return Object.freeze({
      receiptId: receipt.receiptId,
      indexedContentDigest: receipt.indexedContentDigest,
      indexedAt: receipt.indexedAt,
    });
  }

  private async post(
    path:
      | '/v1/courses/verify'
      | '/v1/exam-runs/start'
      | '/v1/exam-runs/timeout'
      | '/v1/exam-runs/finalize'
      | '/v1/exam-runs/status'
      | '/v1/search'
      | '/v1/indexes/courses/upsert'
      | '/v1/indexes/courses/delete',
    body: object,
    idempotencyKey: string,
    gateway: 'evidence' | 'search',
  ): Promise<unknown> {
    const endpoint = gateway === 'evidence'
      ? this.config.get('KNOWLEDGE_EVIDENCE_GATEWAY_ENDPOINT', { infer: true })
      : this.config.get('KNOWLEDGE_SEARCH_GATEWAY_ENDPOINT', { infer: true });
    const token = gateway === 'evidence'
      ? this.config.get('KNOWLEDGE_EVIDENCE_GATEWAY_BEARER_TOKEN', { infer: true })
      : this.config.get('KNOWLEDGE_SEARCH_GATEWAY_BEARER_TOKEN', { infer: true });
    const signingPublicKey = this.config.get(
      gateway === 'evidence'
        ? 'KNOWLEDGE_EVIDENCE_GATEWAY_SIGNING_PUBLIC_KEY_BASE64'
        : 'KNOWLEDGE_SEARCH_GATEWAY_SIGNING_PUBLIC_KEY_BASE64',
      { infer: true },
    );
    const signingKeyId = this.config.get(
      gateway === 'evidence'
        ? 'KNOWLEDGE_EVIDENCE_GATEWAY_SIGNING_KEY_ID'
        : 'KNOWLEDGE_SEARCH_GATEWAY_SIGNING_KEY_ID',
      { infer: true },
    );
    if (
      endpoint === undefined || token === undefined ||
      signingPublicKey === undefined || signingKeyId === undefined
    ) {
      throw new Error(`${gatewayPrefix(gateway)}_GATEWAY_UNAVAILABLE`);
    }
    const url = new URL(path, safeBaseUrl(endpoint, gateway)).toString();
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
    }, gateway);
    const bytes = await readBytes(response, gateway);
    verifyReceipt(bytes, response.headers, signingPublicKey, signingKeyId, gateway);
    return parseJson(bytes, gateway);
  }

  private async examFinalization(
    path: '/v1/exam-runs/finalize' | '/v1/exam-runs/status',
    input: KnowledgeExamOrchestrationInput & {
      readonly gatewaySessionRef: string;
      readonly questionSetDigest: string;
      readonly submissionRef: string;
      readonly timedOut: boolean;
      readonly submittedAt: string;
    },
  ): Promise<KnowledgeExamFinalizationReceipt> {
    const parsed = examFinalizationReceiptSchema.safeParse(await this.post(
      path,
      input,
      digest([
        'exam-finalize',
        path,
        input.tenantId,
        input.runId,
        input.gatewaySessionRef,
        input.submissionRef,
      ]),
      'evidence',
    ));
    if (
      !parsed.success ||
      !matchesExamBinding(parsed.data, input) ||
      parsed.data.gatewaySessionRef !== input.gatewaySessionRef ||
      parsed.data.questionSetDigest !== input.questionSetDigest ||
      parsed.data.submissionRef !== input.submissionRef ||
      parsed.data.timedOut !== input.timedOut ||
      parsed.data.submittedAt !== input.submittedAt
    ) throw new Error('KNOWLEDGE_EXAM_FINALIZATION_RECEIPT_INVALID');
    if (
      path === '/v1/exam-runs/status' &&
      parsed.data.result.status === 'pending_review' &&
      'reviewEvidenceId' in input &&
      parsed.data.result.reviewEvidenceId !== input.reviewEvidenceId
    ) throw new Error('KNOWLEDGE_EXAM_REVIEW_RECEIPT_MISMATCH');
    const resultTime = new Date(
      parsed.data.result.status === 'graded'
        ? parsed.data.result.gradedAt
        : parsed.data.result.reviewRequestedAt,
    );
    const submittedAt = new Date(input.submittedAt);
    if (
      resultTime.getTime() < submittedAt.getTime() ||
      resultTime.getTime() > Date.now() + 5 * 60_000 ||
      (
        parsed.data.result.status === 'graded' &&
        input.passingRule === 'score_threshold' &&
        parsed.data.result.passed !==
          (parsed.data.result.scoreBps >= input.passingScoreBps)
      )
    ) throw new Error('KNOWLEDGE_EXAM_FINALIZATION_RESULT_INVALID');
    return Object.freeze({ ...parsed.data.result });
  }
}

@Injectable()
export class HttpKnowledgeExamOrchestrationAdapter extends KnowledgeExamOrchestrationPort {
  constructor(private readonly client: KnowledgeEvidenceHttpClient) { super(); }

  override start(input: KnowledgeExamOrchestrationInput): Promise<KnowledgeExamStartReceipt> {
    return this.client.startExam(input);
  }

  override timeout(
    input: KnowledgeExamOrchestrationInput & {
      readonly gatewaySessionRef: string;
      readonly questionSetDigest: string;
      readonly deadlineAt: string;
    },
  ): Promise<KnowledgeExamTimeoutReceipt> {
    return this.client.timeoutExam(input);
  }

  override finalize(
    input: KnowledgeExamOrchestrationInput & {
      readonly gatewaySessionRef: string;
      readonly questionSetDigest: string;
      readonly submissionRef: string;
      readonly timedOut: boolean;
      readonly submittedAt: string;
    },
  ): Promise<KnowledgeExamFinalizationReceipt> {
    return this.client.finalizeExam(input);
  }

  override status(
    input: KnowledgeExamOrchestrationInput & {
      readonly gatewaySessionRef: string;
      readonly questionSetDigest: string;
      readonly submissionRef: string;
      readonly reviewEvidenceId: string;
      readonly timedOut: boolean;
      readonly submittedAt: string;
    },
  ): Promise<KnowledgeExamFinalizationReceipt> {
    return this.client.examStatus(input);
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

@Injectable()
export class HttpKnowledgeSearchAdapter extends KnowledgeSearchPort {
  constructor(private readonly client: KnowledgeEvidenceHttpClient) { super(); }

  override search(
    input: Parameters<KnowledgeSearchPort['search']>[0],
  ): Promise<KnowledgeSearchResult> {
    return this.client.search(input);
  }
}

@Injectable()
export class HttpKnowledgeSearchIndexAdapter extends KnowledgeSearchIndexPort {
  constructor(private readonly client: KnowledgeEvidenceHttpClient) { super(); }

  override apply(
    input: Parameters<KnowledgeSearchIndexPort['apply']>[0],
  ): Promise<KnowledgeSearchIndexReceipt> {
    return this.client.applySearchIndex(input);
  }
}

async function request(
  url: string,
  init: RequestInit,
  gateway: 'evidence' | 'search',
): Promise<Response> {
  const prefix = gatewayPrefix(gateway);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(url, { ...init, signal: AbortSignal.timeout(5_000) });
    } catch {
      if (attempt === 0) continue;
      throw new Error(`${prefix}_GATEWAY_UNAVAILABLE`);
    }
    if ([502, 503, 504].includes(response.status) && attempt === 0) {
      await response.body?.cancel().catch(() => undefined);
      continue;
    }
    if (response.status !== 200) {
      throw new Error(`${prefix}_GATEWAY_HTTP_${response.status}`);
    }
    if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
      throw new Error(`${prefix}_RECEIPT_INVALID`);
    }
    return response;
  }
  throw new Error(`${prefix}_GATEWAY_UNAVAILABLE`);
}

async function readBytes(
  response: Response,
  gateway: 'evidence' | 'search',
): Promise<Uint8Array> {
  const prefix = gatewayPrefix(gateway);
  if (response.body === null) throw new Error(`${prefix}_RECEIPT_INVALID`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      if (!(part.value instanceof Uint8Array)) {
        throw new Error(`${prefix}_RECEIPT_INVALID`);
      }
      total += part.value.byteLength;
      if (total > RESPONSE_LIMIT_BYTES) throw new Error(`${prefix}_RECEIPT_TOO_LARGE`);
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
  gateway: 'evidence' | 'search',
): void {
  const keyId = headers.get(
    gateway === 'evidence'
      ? 'x-knowledge-evidence-key-id'
      : 'x-knowledge-search-key-id',
  );
  const signature = headers.get(
    gateway === 'evidence'
      ? 'x-knowledge-evidence-signature'
      : 'x-knowledge-search-signature',
  );
  if (
    keyId !== expectedKeyId || !SAFE_ID.test(expectedKeyId) ||
    signature === null || !SIGNATURE.test(signature)
  ) throw new Error(`${gatewayPrefix(gateway)}_RECEIPT_SIGNATURE_INVALID`);
  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey({
      key: Buffer.from(publicKeyBase64, 'base64'),
      format: 'der',
      type: 'spki',
    });
  } catch {
    throw new Error(`${gatewayPrefix(gateway)}_SIGNING_KEY_INVALID`);
  }
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    throw new Error(`${gatewayPrefix(gateway)}_SIGNING_KEY_INVALID`);
  }
  const signed = Buffer.from(receiptSigningInput(gateway, keyId, bytes), 'utf8');
  if (!verifySignature(null, signed, publicKey, Buffer.from(signature, 'base64url'))) {
    throw new Error(`${gatewayPrefix(gateway)}_RECEIPT_SIGNATURE_INVALID`);
  }
}

function parseJson(bytes: Uint8Array, gateway: 'evidence' | 'search'): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new Error(`${gatewayPrefix(gateway)}_RECEIPT_INVALID`);
  }
}

function receiptSigningInput(
  gateway: 'evidence' | 'search',
  keyId: string,
  bytes: Uint8Array,
): string {
  return [
    gateway === 'evidence'
      ? 'knowledge-evidence-receipt-v1'
      : 'knowledge-search-receipt-v1',
    keyId,
    createHash('sha256').update(bytes).digest('base64url'),
  ].join('\n');
}

function validHighlights(
  text: string,
  highlights: readonly { readonly start: number; readonly end: number }[],
): boolean {
  let previousEnd = 0;
  for (const highlight of highlights) {
    if (
      highlight.start < previousEnd ||
      highlight.start >= highlight.end ||
      highlight.end > text.length
    ) return false;
    previousEnd = highlight.end;
  }
  return true;
}

function safeSnippetText(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (
      code === undefined ||
      code < 32 ||
      code === 127 ||
      character === '<' ||
      character === '>' ||
      character === '&'
    ) return false;
  }
  return true;
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function validAudienceCombination(input: {
  readonly audienceMode: 'assigned_only' | 'employment_scope';
  readonly audienceDepartmentIds: readonly string[];
  readonly audiencePositionIds: readonly string[];
}): boolean {
  return input.audienceMode === 'assigned_only'
    ? input.audienceDepartmentIds.length === 0 && input.audiencePositionIds.length === 0
    : input.audienceDepartmentIds.length > 0 || input.audiencePositionIds.length > 0;
}

function matchesExamBinding(
  receipt: {
    readonly runId: string;
    readonly tenantId: string;
    readonly assignmentId: string;
    readonly courseVersionId: string;
    readonly attemptNumber: number;
    readonly questionBankRef: string;
    readonly questionBankDigest: string;
    readonly questionMode: 'objective' | 'subjective' | 'mixed';
    readonly gradingPolicyVersion: string;
    readonly passingRule: 'score_threshold' | 'all_required_sections';
    readonly passingScoreBps: number;
    readonly timeLimitMinutes: number;
    readonly manualReviewRequired: boolean;
    readonly gradingSlaMinutes: number;
    readonly manualReviewSlaMinutes: number;
  },
  input: KnowledgeExamOrchestrationInput,
): boolean {
  return receipt.runId === input.runId &&
    receipt.tenantId === input.tenantId &&
    receipt.assignmentId === input.assignmentId &&
    receipt.courseVersionId === input.courseVersionId &&
    receipt.attemptNumber === input.attemptNumber &&
    receipt.questionBankRef === input.questionBankRef &&
    receipt.questionBankDigest === input.questionBankDigest &&
    receipt.questionMode === input.questionMode &&
    receipt.gradingPolicyVersion === input.gradingPolicyVersion &&
    receipt.passingRule === input.passingRule &&
    receipt.passingScoreBps === input.passingScoreBps &&
    receipt.timeLimitMinutes === input.timeLimitMinutes &&
    receipt.manualReviewRequired === input.manualReviewRequired &&
    receipt.gradingSlaMinutes === input.gradingSlaMinutes &&
    receipt.manualReviewSlaMinutes === input.manualReviewSlaMinutes;
}

function safeBaseUrl(value: string, gateway: 'evidence' | 'search'): string {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase().replace(/\.$/u, '')
    .replace(/^\[(.*)\]$/u, '$1');
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.pathname !== '/' || url.search !== '' || url.hash !== '' ||
    (url.port !== '' && url.port !== '443') || isLoopback(hostname)
  ) throw new Error(`${gatewayPrefix(gateway)}_GATEWAY_ENDPOINT_INVALID`);
  return url.toString();
}

function isLoopback(hostname: string): boolean {
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  if (isIP(hostname) === 4) return hostname.startsWith('127.');
  return isIP(hostname) === 6 && hostname === '::1';
}

function gatewayPrefix(gateway: 'evidence' | 'search'): string {
  return gateway === 'evidence' ? 'KNOWLEDGE_EVIDENCE' : 'KNOWLEDGE_SEARCH';
}

function digest(parts: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(parts), 'utf8').digest('base64url');
}
