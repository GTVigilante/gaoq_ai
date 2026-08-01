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
const REQUEST_LIMIT_BYTES = 128 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST = /^[A-Za-z0-9_-]{43}$/;
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/;
const CURSOR = /^[A-Za-z0-9_-]{16,256}$/;
const TOKEN = /^[\x21-\x7e]{32,512}$/;
const JSON_CONTENT_TYPE =
  /^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json(?:\s*;\s*charset=utf-8)?$/iu;
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
}).strict();
const examStartRequestSchema = examBindingSchema;
const examTimeoutRequestSchema = examBindingSchema.extend({
  gatewaySessionRef: z.string().regex(SAFE_ID),
  questionSetDigest: z.string().regex(DIGEST),
  deadlineAt: z.string().datetime({ offset: true }),
}).strict();
const examFinalizationRequestSchema = examBindingSchema.extend({
  gatewaySessionRef: z.string().regex(SAFE_ID),
  questionSetDigest: z.string().regex(DIGEST),
  submissionRef: z.string().regex(SAFE_ID),
  timedOut: z.boolean(),
  submittedAt: z.string().datetime({ offset: true }),
}).strict();
const examStatusRequestSchema = examFinalizationRequestSchema.extend({
  reviewEvidenceId: z.string().regex(ULID),
}).strict();
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
      reviewEvidenceId: z.string().regex(ULID).nullable(),
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
  queryText: z.string().min(2).max(128).refine(safeSearchQuery),
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
    const request = {
      tenantId: course.tenantId,
      courseVersionId: course.id,
      contentRef: course.contentRef,
      questionBankRef: course.questionBankRef,
      questionBankDigest: course.questionBankDigest,
    };
    const parsed = verificationReceiptSchema.safeParse(await this.post(
      '/v1/courses/verify',
      request,
      requestDigest('/v1/courses/verify', request),
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
    const request = examStartRequestSchema.safeParse(input);
    if (!request.success || !validExamPolicy(request.data)) {
      throw new Error('KNOWLEDGE_EXAM_START_REQUEST_INVALID');
    }
    const parsed = examStartReceiptSchema.safeParse(await this.post(
      '/v1/exam-runs/start',
      request.data,
      requestDigest('/v1/exam-runs/start', request.data),
      'evidence',
    ));
    if (!parsed.success || !matchesExamBinding(parsed.data, request.data)) {
      throw new Error('KNOWLEDGE_EXAM_START_RECEIPT_INVALID');
    }
    const startedAt = new Date(parsed.data.startedAt);
    const deadlineAt = new Date(parsed.data.deadlineAt);
    if (
      deadlineAt.getTime() - startedAt.getTime() !==
        request.data.timeLimitMinutes * 60_000 ||
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
    const request = examTimeoutRequestSchema.safeParse(input);
    if (!request.success || !validExamPolicy(request.data)) {
      throw new Error('KNOWLEDGE_EXAM_TIMEOUT_REQUEST_INVALID');
    }
    const parsed = examTimeoutReceiptSchema.safeParse(await this.post(
      '/v1/exam-runs/timeout',
      request.data,
      requestDigest('/v1/exam-runs/timeout', request.data),
      'evidence',
    ));
    if (
      !parsed.success ||
      !matchesExamBinding(parsed.data, request.data) ||
      parsed.data.gatewaySessionRef !== request.data.gatewaySessionRef ||
      parsed.data.questionSetDigest !== request.data.questionSetDigest ||
      parsed.data.deadlineAt !== request.data.deadlineAt ||
      parsed.data.submittedAt !== request.data.deadlineAt
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
      !uniqueIds(request.data.departmentIds) ||
      !uniqueIds(request.data.positionIds) ||
      !uniqueIds(request.data.allowedCourseVersionIds)
    ) throw new Error('KNOWLEDGE_SEARCH_REQUEST_INVALID');
    const queryDigest = digest(['search-query', request.data.queryText]);
    const parsed = searchReceiptSchema.safeParse(await this.post(
      '/v1/search',
      request.data,
      requestDigest('/v1/search', request.data),
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
      !uniqueIds(request.data.audienceDepartmentIds) ||
      !uniqueIds(request.data.audiencePositionIds) ||
      !validAudienceCombination(request.data)
    ) throw new Error('KNOWLEDGE_SEARCH_INDEX_REQUEST_INVALID');
    const path = request.data.operation === 'upsert'
      ? '/v1/indexes/courses/upsert'
      : '/v1/indexes/courses/delete';
    const parsed = searchIndexReceiptSchema.safeParse(await this.post(
      path,
      request.data,
      requestDigest(path, request.data),
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
    assertGatewayRuntimeConfig(
      this.config,
      gateway,
      endpoint,
      token,
      signingPublicKey,
      signingKeyId,
    );
    const url = new URL(path, safeBaseUrl(endpoint, gateway)).toString();
    const payload = JSON.stringify(body);
    if (Buffer.byteLength(payload) > REQUEST_LIMIT_BYTES) {
      throw new Error(`${gatewayPrefix(gateway)}_REQUEST_TOO_LARGE`);
    }
    const response = await request(url, {
      method: 'POST', redirect: 'error',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json', 'accept-encoding': 'identity',
        'cache-control': 'no-store',
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
    const request = path === '/v1/exam-runs/status'
      ? examStatusRequestSchema.safeParse(input)
      : examFinalizationRequestSchema.safeParse(input);
    if (!request.success || !validExamPolicy(request.data)) {
      throw new Error('KNOWLEDGE_EXAM_FINALIZATION_REQUEST_INVALID');
    }
    const parsed = examFinalizationReceiptSchema.safeParse(await this.post(
      path,
      request.data,
      requestDigest(path, request.data),
      'evidence',
    ));
    if (
      !parsed.success ||
      !matchesExamBinding(parsed.data, request.data) ||
      parsed.data.gatewaySessionRef !== request.data.gatewaySessionRef ||
      parsed.data.questionSetDigest !== request.data.questionSetDigest ||
      parsed.data.submissionRef !== request.data.submissionRef ||
      parsed.data.timedOut !== request.data.timedOut ||
      parsed.data.submittedAt !== request.data.submittedAt
    ) throw new Error('KNOWLEDGE_EXAM_FINALIZATION_RECEIPT_INVALID');
    if (
      path === '/v1/exam-runs/status' &&
      (
        !('reviewEvidenceId' in request.data) ||
        parsed.data.result.reviewEvidenceId !== request.data.reviewEvidenceId
      )
    ) throw new Error('KNOWLEDGE_EXAM_REVIEW_RECEIPT_MISMATCH');
    if (
      path === '/v1/exam-runs/finalize' &&
      (
        (
          request.data.manualReviewRequired &&
          parsed.data.result.status !== 'pending_review'
        ) ||
        (
          !request.data.manualReviewRequired &&
          (
            parsed.data.result.status !== 'graded' ||
            parsed.data.result.reviewEvidenceId !== null
          )
        )
      )
    ) throw new Error('KNOWLEDGE_EXAM_REVIEW_POLICY_MISMATCH');
    const resultTime = new Date(
      parsed.data.result.status === 'graded'
        ? parsed.data.result.gradedAt
        : parsed.data.result.reviewRequestedAt,
    );
    const submittedAt = new Date(request.data.submittedAt);
    if (
      resultTime.getTime() < submittedAt.getTime() ||
      resultTime.getTime() > Date.now() + 5 * 60_000 ||
      (
        parsed.data.result.status === 'graded' &&
        request.data.passingRule === 'score_threshold' &&
        parsed.data.result.passed !==
          (parsed.data.result.scoreBps >= request.data.passingScoreBps)
      )
    ) throw new Error('KNOWLEDGE_EXAM_FINALIZATION_RESULT_INVALID');
    return parsed.data.result.status === 'pending_review'
      ? Object.freeze({
          status: parsed.data.result.status,
          reviewEvidenceId: parsed.data.result.reviewEvidenceId,
          reviewRequestedAt: parsed.data.result.reviewRequestedAt,
        })
      : Object.freeze({
          status: parsed.data.result.status,
          scoreBps: parsed.data.result.scoreBps,
          passed: parsed.data.result.passed,
          gradingEvidenceId: parsed.data.result.gradingEvidenceId,
          gradedAt: parsed.data.result.gradedAt,
        });
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
      cancelResponseBody(response);
      continue;
    }
    if (response.status !== 200) {
      cancelResponseBody(response);
      throw new Error(`${prefix}_GATEWAY_HTTP_${response.status}`);
    }
    if (!JSON_CONTENT_TYPE.test(response.headers.get('content-type')?.trim() ?? '')) {
      cancelResponseBody(response);
      throw new Error(`${prefix}_RECEIPT_INVALID`);
    }
    const contentEncoding = response.headers.get('content-encoding');
    if (
      contentEncoding !== null &&
      contentEncoding.trim().toLowerCase() !== 'identity'
    ) {
      cancelResponseBody(response);
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
  let expectedLength: number | null;
  try {
    expectedLength = responseLength(response.headers.get('content-length'), gateway);
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
        throw new Error(`${prefix}_RESPONSE_READ_ERROR`);
      }
      if (part.done) break;
      if (!(part.value instanceof Uint8Array)) {
        cancelReader(reader);
        throw new Error(`${prefix}_RESPONSE_READ_ERROR`);
      }
      total += part.value.byteLength;
      if (
        total > RESPONSE_LIMIT_BYTES ||
        (expectedLength !== null && total > expectedLength)
      ) {
        cancelReader(reader);
        throw new Error(
          total > RESPONSE_LIMIT_BYTES
            ? `${prefix}_RECEIPT_TOO_LARGE`
            : `${prefix}_RESPONSE_LENGTH_INVALID`,
        );
      }
      chunks.push(part.value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // 读取器清理是尽力操作，不得覆盖已确定的网关结果。
    }
  }
  if (expectedLength !== null && total !== expectedLength) {
    throw new Error(`${prefix}_RESPONSE_LENGTH_INVALID`);
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
  let publicKeyBytes: Buffer;
  try {
    publicKeyBytes = canonicalBase64(publicKeyBase64);
    publicKey = createPublicKey({
      key: publicKeyBytes,
      format: 'der',
      type: 'spki',
    });
  } catch {
    throw new Error(`${gatewayPrefix(gateway)}_SIGNING_KEY_INVALID`);
  }
  let signatureBytes: Buffer;
  try {
    signatureBytes = canonicalBase64Url(signature);
  } catch {
    throw new Error(`${gatewayPrefix(gateway)}_RECEIPT_SIGNATURE_INVALID`);
  }
  const exported = publicKey.export({ format: 'der', type: 'spki' });
  if (
    publicKey.asymmetricKeyType !== 'ed25519' ||
    !Buffer.isBuffer(exported) ||
    !exported.equals(publicKeyBytes) ||
    signatureBytes.byteLength !== 64
  ) {
    throw new Error(`${gatewayPrefix(gateway)}_SIGNING_KEY_INVALID`);
  }
  const signed = Buffer.from(receiptSigningInput(gateway, keyId, bytes), 'utf8');
  if (!verifySignature(null, signed, publicKey, signatureBytes)) {
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

function uniqueIds(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function safeSearchQuery(value: string): boolean {
  return value.normalize('NFKC') === value &&
    value.trim() === value &&
    /^[\p{L}\p{M}\p{N}._-]+(?: [\p{L}\p{M}\p{N}._-]+)*$/u.test(value);
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

function validExamPolicy(input: KnowledgeExamOrchestrationInput): boolean {
  return input.manualReviewRequired ===
    (input.questionMode === 'subjective' || input.questionMode === 'mixed');
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
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${gatewayPrefix(gateway)}_GATEWAY_ENDPOINT_INVALID`);
  }
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

function assertGatewayRuntimeConfig(
  config: ConfigService<AppEnvironment, true>,
  gateway: 'evidence' | 'search',
  endpoint: string,
  token: string,
  signingPublicKey: string,
  signingKeyId: string,
): void {
  const prefix = gatewayPrefix(gateway);
  if (!TOKEN.test(token)) throw new Error(`${prefix}_GATEWAY_CREDENTIAL_INVALID`);
  if (!SAFE_ID.test(signingKeyId)) throw new Error(`${prefix}_SIGNING_KEY_INVALID`);
  assertSigningPublicKey(signingPublicKey, gateway);
  const activeOrigin = new URL(safeBaseUrl(endpoint, gateway)).origin;
  const otherGateway = gateway === 'evidence' ? 'search' : 'evidence';
  const otherEndpoint = config.get(
    otherGateway === 'evidence'
      ? 'KNOWLEDGE_EVIDENCE_GATEWAY_ENDPOINT'
      : 'KNOWLEDGE_SEARCH_GATEWAY_ENDPOINT',
    { infer: true },
  );
  const otherToken = config.get(
    otherGateway === 'evidence'
      ? 'KNOWLEDGE_EVIDENCE_GATEWAY_BEARER_TOKEN'
      : 'KNOWLEDGE_SEARCH_GATEWAY_BEARER_TOKEN',
    { infer: true },
  );
  const otherPublicKey = config.get(
    otherGateway === 'evidence'
      ? 'KNOWLEDGE_EVIDENCE_GATEWAY_SIGNING_PUBLIC_KEY_BASE64'
      : 'KNOWLEDGE_SEARCH_GATEWAY_SIGNING_PUBLIC_KEY_BASE64',
    { infer: true },
  );
  const otherKeyId = config.get(
    otherGateway === 'evidence'
      ? 'KNOWLEDGE_EVIDENCE_GATEWAY_SIGNING_KEY_ID'
      : 'KNOWLEDGE_SEARCH_GATEWAY_SIGNING_KEY_ID',
    { infer: true },
  );
  const sharesOrigin = otherEndpoint !== undefined &&
    new URL(safeBaseUrl(otherEndpoint, otherGateway)).origin === activeOrigin;
  if (
    sharesOrigin ||
    otherToken === token ||
    otherPublicKey === signingPublicKey ||
    otherKeyId === signingKeyId
  ) throw new Error(`${prefix}_GATEWAY_TRUST_DOMAIN_INVALID`);
}

function assertSigningPublicKey(
  value: string,
  gateway: 'evidence' | 'search',
): void {
  try {
    const bytes = canonicalBase64(value);
    const key = createPublicKey({ key: bytes, format: 'der', type: 'spki' });
    const exported = key.export({ format: 'der', type: 'spki' });
    if (
      key.asymmetricKeyType !== 'ed25519' ||
      !Buffer.isBuffer(exported) ||
      !exported.equals(bytes)
    ) throw new Error('KEY_INVALID');
  } catch {
    throw new Error(`${gatewayPrefix(gateway)}_SIGNING_KEY_INVALID`);
  }
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

function responseLength(
  value: string | null,
  gateway: 'evidence' | 'search',
): number | null {
  if (value === null) return null;
  const prefix = gatewayPrefix(gateway);
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error(`${prefix}_RESPONSE_LENGTH_INVALID`);
  }
  const length = Number(value);
  if (!Number.isSafeInteger(length)) {
    throw new Error(`${prefix}_RESPONSE_LENGTH_INVALID`);
  }
  if (length > RESPONSE_LIMIT_BYTES) {
    throw new Error(`${prefix}_RECEIPT_TOO_LARGE`);
  }
  return length;
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    void reader.cancel().catch(() => undefined);
  } catch {
    // 取消是尽力操作，禁止覆盖本域稳定错误码。
  }
}

function cancelResponseBody(response: Response): void {
  try {
    void response.body?.cancel().catch(() => undefined);
  } catch {
    // 释放是尽力操作，禁止覆盖已确定的 HTTP 结果。
  }
}

function requestDigest(path: string, body: object): string {
  return digest(['knowledge-gateway-request-v1', path, JSON.stringify(body)]);
}

function digest(parts: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(parts), 'utf8').digest('base64url');
}
