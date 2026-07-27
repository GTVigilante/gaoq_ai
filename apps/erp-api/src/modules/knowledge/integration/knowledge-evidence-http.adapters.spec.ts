import { createHash, generateKeyPairSync, sign } from 'node:crypto';

import type { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppEnvironment } from '../../../config/environment.js';
import type { CourseVersion } from '../domain/index.js';
import {
  HttpKnowledgeContentVerificationAdapter,
  HttpKnowledgeGradingAdapter,
  KnowledgeEvidenceHttpClient,
} from './knowledge-evidence-http.adapters.js';

const COURSE: CourseVersion = {
  id: 'course-version-001', tenantId: 'tenant-001', courseCode: 'SECURITY',
  revision: 1, title: '信息安全', contentRef: 'content-001',
  questionBankRef: 'question-bank-001', questionBankDigest: 'a'.repeat(43),
  passingScoreBps: 8_000,
  audienceMode: 'assigned_only',
  audienceDepartmentIds: [],
  audiencePositionIds: [],
  status: 'draft', version: 1,
  createdAt: '2026-07-21T00:00:00.000Z', updatedAt: '2026-07-21T00:00:00.000Z',
};
const GRADING_INPUT = {
  tenantId: 'tenant-001', assignmentId: 'assignment-001',
  courseVersionId: COURSE.id, questionBankRef: 'question-bank-001',
  questionBankDigest: 'a'.repeat(43), submissionRef: 'submission-001',
};
const SEARCH_INPUT = {
  tenantId: 'tenant-001',
  employeeId: 'employee-001',
  departmentIds: ['department-001'],
  positionIds: ['position-001'],
  allowedCourseVersionIds: [COURSE.id],
  authorizationDigest: 'c'.repeat(43),
  queryText: '信息 安全',
  cursor: null,
  limit: 10,
};
const SEARCH_INDEX_INPUT = {
  eventId: '01J8ZQK7V0A2M4N6P8R0T2W4Y0',
  tenantId: COURSE.tenantId,
  courseVersionId: COURSE.id,
  courseCode: COURSE.courseCode,
  revision: COURSE.revision,
  courseVersion: 2,
  contentRef: COURSE.contentRef,
  operation: 'upsert' as const,
  audienceMode: 'employment_scope' as const,
  audienceDepartmentIds: ['department-001'],
  audiencePositionIds: ['position-001'],
};
const SIGNING_KEY_ID = 'knowledge-key-001';
const signingKeys = generateKeyPairSync('ed25519');
const SIGNING_PUBLIC_KEY_BASE64 = signingKeys.publicKey.export({
  format: 'der',
  type: 'spki',
}).toString('base64');
const SEARCH_SIGNING_KEY_ID = 'knowledge-search-key-001';
const searchSigningKeys = generateKeyPairSync('ed25519');
const SEARCH_SIGNING_PUBLIC_KEY_BASE64 = searchSigningKeys.publicKey.export({
  format: 'der',
  type: 'spki',
}).toString('base64');

function config(overrides?: Readonly<Record<string, string>>) {
  const values: Readonly<Record<string, string>> = {
    KNOWLEDGE_EVIDENCE_GATEWAY_ENDPOINT: 'https://knowledge-evidence.example.internal',
    KNOWLEDGE_EVIDENCE_GATEWAY_BEARER_TOKEN:
      'knowledge-evidence-token-at-least-32-characters',
    KNOWLEDGE_EVIDENCE_GATEWAY_SIGNING_PUBLIC_KEY_BASE64: SIGNING_PUBLIC_KEY_BASE64,
    KNOWLEDGE_EVIDENCE_GATEWAY_SIGNING_KEY_ID: SIGNING_KEY_ID,
    KNOWLEDGE_SEARCH_GATEWAY_ENDPOINT: 'https://knowledge-search.example.internal',
    KNOWLEDGE_SEARCH_GATEWAY_BEARER_TOKEN:
      'knowledge-search-token-distinct-at-least-32-characters',
    KNOWLEDGE_SEARCH_GATEWAY_SIGNING_PUBLIC_KEY_BASE64:
      SEARCH_SIGNING_PUBLIC_KEY_BASE64,
    KNOWLEDGE_SEARCH_GATEWAY_SIGNING_KEY_ID: SEARCH_SIGNING_KEY_ID,
    ...overrides,
  };
  return { get: (key: string) => values[key] } as unknown as
    ConfigService<AppEnvironment, true>;
}

function response(
  body: unknown,
  status = 200,
  gateway: 'evidence' | 'search' = 'evidence',
): Response {
  const keyId = gateway === 'evidence' ? SIGNING_KEY_ID : SEARCH_SIGNING_KEY_ID;
  const privateKey = gateway === 'evidence'
    ? signingKeys.privateKey
    : searchSigningKeys.privateKey;
  const bytes = Buffer.from(JSON.stringify(body), 'utf8');
  const receiptHash = createHash('sha256').update(bytes).digest('base64url');
  const signature = sign(
    null,
    Buffer.from(
      `${gateway === 'evidence'
        ? 'knowledge-evidence-receipt-v1'
        : 'knowledge-search-receipt-v1'}\n${keyId}\n${receiptHash}`,
      'utf8',
    ),
    privateKey,
  ).toString('base64url');
  return new Response(bytes, {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      [gateway === 'evidence'
        ? 'x-knowledge-evidence-key-id'
        : 'x-knowledge-search-key-id']: keyId,
      [gateway === 'evidence'
        ? 'x-knowledge-evidence-signature'
        : 'x-knowledge-search-signature']: signature,
    },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('Knowledge 证据 HTTPS Adapters', () => {
  it('内容校验回执逐字段绑定课程且请求不包含题库正文', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({
      tenantId: COURSE.tenantId, courseVersionId: COURSE.id,
      contentRef: COURSE.contentRef, questionBankRef: COURSE.questionBankRef,
      questionBankDigest: COURSE.questionBankDigest,
      contentVerified: true, questionBankVerified: true,
      verificationEvidenceId: '01J8ZQK7V0A2M4N6P8R0T2W4K1',
    }));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new HttpKnowledgeContentVerificationAdapter(
      new KnowledgeEvidenceHttpClient(config()),
    );
    await expect(adapter.verify(COURSE)).resolves.toEqual({
      contentVerified: true, questionBankVerified: true,
    });
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const headers = call[1].headers as Readonly<Record<string, string>>;
    expect(call[0]).toBe('https://knowledge-evidence.example.internal/v1/courses/verify');
    expect(headers['idempotency-key']).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(headers.authorization).toBe(
      'Bearer knowledge-evidence-token-at-least-32-characters',
    );
    const rawBody = call[1].body;
    if (typeof rawBody !== 'string') throw new Error('测试请求正文必须为字符串');
    const body = JSON.parse(rawBody) as Record<string, unknown>;
    expect(body).toEqual({
      tenantId: COURSE.tenantId, courseVersionId: COURSE.id,
      contentRef: COURSE.contentRef, questionBankRef: COURSE.questionBankRef,
      questionBankDigest: COURSE.questionBankDigest,
    });
    expect(JSON.stringify(body)).not.toMatch(/answer|答案|标准答案/iu);
  });

  it('评分只返回绑定提交与题库摘要的服务端结果', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({
      tenantId: GRADING_INPUT.tenantId, assignmentId: GRADING_INPUT.assignmentId,
      courseVersionId: GRADING_INPUT.courseVersionId,
      submissionRef: GRADING_INPUT.submissionRef,
      questionBankRef: GRADING_INPUT.questionBankRef,
      questionBankDigest: GRADING_INPUT.questionBankDigest,
      questionSetDigest: 'b'.repeat(43),
      gradingEvidenceId: '01J8ZQK7V0A2M4N6P8R0T2W4K2', scoreBps: 8_500,
    })));
    const adapter = new HttpKnowledgeGradingAdapter(
      new KnowledgeEvidenceHttpClient(config()),
    );
    await expect(adapter.grade(GRADING_INPUT)).resolves.toEqual({
      scoreBps: 8_500, questionBankDigest: 'a'.repeat(43),
      questionSetDigest: 'b'.repeat(43),
      gradingEvidenceId: '01J8ZQK7V0A2M4N6P8R0T2W4K2',
    });
  });

  it('伪造、错位、额外字段和超大正文均失败关闭', async () => {
    const client = new KnowledgeEvidenceHttpClient(config());
    const forged = response({
      tenantId: GRADING_INPUT.tenantId, assignmentId: GRADING_INPUT.assignmentId,
      courseVersionId: GRADING_INPUT.courseVersionId,
      submissionRef: GRADING_INPUT.submissionRef,
      questionBankRef: GRADING_INPUT.questionBankRef,
      questionBankDigest: GRADING_INPUT.questionBankDigest,
      questionSetDigest: 'b'.repeat(43),
      gradingEvidenceId: '01J8ZQK7V0A2M4N6P8R0T2W4K2', scoreBps: 8_500,
    });
    forged.headers.set('x-knowledge-evidence-signature', 'A'.repeat(86));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(forged).mockResolvedValueOnce(response({
      tenantId: 'tenant-other', assignmentId: GRADING_INPUT.assignmentId,
      courseVersionId: GRADING_INPUT.courseVersionId,
      submissionRef: GRADING_INPUT.submissionRef,
      questionBankRef: GRADING_INPUT.questionBankRef,
      questionBankDigest: GRADING_INPUT.questionBankDigest,
      questionSetDigest: 'b'.repeat(43),
      gradingEvidenceId: '01J8ZQK7V0A2M4N6P8R0T2W4K2', scoreBps: 8_500,
    })).mockResolvedValueOnce(response({
      tenantId: COURSE.tenantId, courseVersionId: COURSE.id,
      contentRef: COURSE.contentRef, questionBankRef: COURSE.questionBankRef,
      questionBankDigest: COURSE.questionBankDigest,
      contentVerified: true, questionBankVerified: true,
      verificationEvidenceId: '01J8ZQK7V0A2M4N6P8R0T2W4K1',
      answers: ['forbidden'],
    })).mockResolvedValueOnce(new Response('x'.repeat(16 * 1024 + 1), {
      status: 200, headers: { 'content-type': 'application/json' },
    })));
    await expect(client.grade(GRADING_INPUT))
      .rejects.toThrow('KNOWLEDGE_EVIDENCE_RECEIPT_SIGNATURE_INVALID');
    await expect(client.grade(GRADING_INPUT))
      .rejects.toThrow('KNOWLEDGE_GRADING_RECEIPT_MISMATCH');
    await expect(client.verify(COURSE))
      .rejects.toThrow('KNOWLEDGE_VERIFICATION_RECEIPT_INVALID');
    await expect(client.verify(COURSE))
      .rejects.toThrow('KNOWLEDGE_EVIDENCE_RECEIPT_TOO_LARGE');
  });

  it('网关缺失时失败关闭，临时 503 只使用同一幂等键重试一次', async () => {
    const empty = { get: () => undefined } as unknown as ConfigService<AppEnvironment, true>;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(new KnowledgeEvidenceHttpClient(empty).grade(GRADING_INPUT))
      .rejects.toThrow('KNOWLEDGE_EVIDENCE_GATEWAY_UNAVAILABLE');
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce(response({}, 503)).mockResolvedValueOnce(response({
      tenantId: GRADING_INPUT.tenantId, assignmentId: GRADING_INPUT.assignmentId,
      courseVersionId: GRADING_INPUT.courseVersionId,
      submissionRef: GRADING_INPUT.submissionRef,
      questionBankRef: GRADING_INPUT.questionBankRef,
      questionBankDigest: GRADING_INPUT.questionBankDigest,
      questionSetDigest: 'b'.repeat(43),
      gradingEvidenceId: '01J8ZQK7V0A2M4N6P8R0T2W4K2', scoreBps: 8_500,
    }));
    await expect(new KnowledgeEvidenceHttpClient(config()).grade(GRADING_INPUT))
      .resolves.toMatchObject({ scoreBps: 8_500 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const second = fetchMock.mock.calls[1]?.[1] as RequestInit | undefined;
    expect((first?.headers as Record<string, string>)['idempotency-key'])
      .toBe((second?.headers as Record<string, string>)['idempotency-key']);
  });

  it('运行时再次拒绝本地或带路径的网关地址', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    for (const endpoint of [
      'https://localhost',
      'https://127.0.0.2',
      'https://[::1]',
      'https://knowledge-evidence.example.internal/path',
    ]) {
      await expect(new KnowledgeEvidenceHttpClient(config({
        KNOWLEDGE_EVIDENCE_GATEWAY_ENDPOINT: endpoint,
      })).grade(GRADING_INPUT)).rejects.toThrow(
        'KNOWLEDGE_EVIDENCE_GATEWAY_ENDPOINT_INVALID',
      );
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('全文检索仅发送可信授权投影并返回无 HTML 的偏移高亮', async () => {
    const queryDigest = createHash('sha256')
      .update(JSON.stringify(['search-query', SEARCH_INPUT.queryText]), 'utf8')
      .digest('base64url');
    const fetchMock = vi.fn().mockResolvedValue(response({
      tenantId: SEARCH_INPUT.tenantId,
      employeeId: SEARCH_INPUT.employeeId,
      authorizationDigest: SEARCH_INPUT.authorizationDigest,
      queryDigest,
      items: [{
        courseVersionId: COURSE.id,
        revision: COURSE.revision,
        snippetText: '企业信息安全基础',
        highlights: [{ start: 2, end: 6 }],
        scoreBps: 9_000,
        indexedAt: '2026-07-27T00:00:00.000Z',
      }],
      nextCursor: null,
      partial: false,
    }, 200, 'search'));
    vi.stubGlobal('fetch', fetchMock);
    const result = await new KnowledgeEvidenceHttpClient(config()).search(SEARCH_INPUT);
    expect(result).toEqual({
      items: [{
        courseVersionId: COURSE.id,
        revision: COURSE.revision,
        snippetText: '企业信息安全基础',
        highlights: [{ start: 2, end: 6 }],
        scoreBps: 9_000,
        indexedAt: '2026-07-27T00:00:00.000Z',
      }],
      nextCursor: null,
    });
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe('https://knowledge-search.example.internal/v1/search');
    const rawBody = call[1].body;
    if (typeof rawBody !== 'string') throw new Error('测试请求正文必须为字符串');
    const body = JSON.parse(rawBody) as Record<string, unknown>;
    expect(body).toEqual(SEARCH_INPUT);
    expect(body).not.toHaveProperty('tenantFilter');
    expect(body).not.toHaveProperty('queryDsl');
    expect(JSON.stringify(result)).not.toMatch(/[<>&]/u);
  });

  it('全文检索拒绝未授权课程、部分结果和越界高亮', async () => {
    const queryDigest = createHash('sha256')
      .update(JSON.stringify(['search-query', SEARCH_INPUT.queryText]), 'utf8')
      .digest('base64url');
    const base = {
      tenantId: SEARCH_INPUT.tenantId,
      employeeId: SEARCH_INPUT.employeeId,
      authorizationDigest: SEARCH_INPUT.authorizationDigest,
      queryDigest,
      nextCursor: null,
      partial: false,
    };
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(response({
        ...base,
        items: [{
          courseVersionId: 'course-version-other',
          revision: 1,
          snippetText: '不应返回',
          highlights: [],
          scoreBps: 8_000,
          indexedAt: '2026-07-27T00:00:00.000Z',
        }],
      }, 200, 'search'))
      .mockResolvedValueOnce(response({ ...base, items: [], partial: true }, 200, 'search'))
      .mockResolvedValueOnce(response({
        ...base,
        items: [{
          courseVersionId: COURSE.id,
          revision: 1,
          snippetText: '安全',
          highlights: [{ start: 0, end: 3 }],
          scoreBps: 8_000,
          indexedAt: '2026-07-27T00:00:00.000Z',
        }],
      }, 200, 'search')));
    const client = new KnowledgeEvidenceHttpClient(config());
    await expect(client.search(SEARCH_INPUT))
      .rejects.toThrow('KNOWLEDGE_SEARCH_RECEIPT_MISMATCH');
    await expect(client.search(SEARCH_INPUT))
      .rejects.toThrow('KNOWLEDGE_SEARCH_RECEIPT_INVALID');
    await expect(client.search(SEARCH_INPUT))
      .rejects.toThrow('KNOWLEDGE_SEARCH_RECEIPT_MISMATCH');
  });

  it('索引更新仅发送内容引用与授权投影并绑定签名回执', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({
      eventId: SEARCH_INDEX_INPUT.eventId,
      tenantId: SEARCH_INDEX_INPUT.tenantId,
      courseVersionId: SEARCH_INDEX_INPUT.courseVersionId,
      courseVersion: SEARCH_INDEX_INPUT.courseVersion,
      operation: SEARCH_INDEX_INPUT.operation,
      receiptId: 'search-index-receipt-001',
      indexedContentDigest: 'd'.repeat(43),
      indexedAt: '2026-07-27T00:00:00.000Z',
      partial: false,
    }, 200, 'search'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(new KnowledgeEvidenceHttpClient(config()).applySearchIndex(
      SEARCH_INDEX_INPUT,
    )).resolves.toEqual({
      receiptId: 'search-index-receipt-001',
      indexedContentDigest: 'd'.repeat(43),
      indexedAt: '2026-07-27T00:00:00.000Z',
    });
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe(
      'https://knowledge-search.example.internal/v1/indexes/courses/upsert',
    );
    const rawBody = call[1].body;
    if (typeof rawBody !== 'string') throw new Error('测试请求正文必须为字符串');
    expect(JSON.parse(rawBody)).toEqual(SEARCH_INDEX_INPUT);
    expect(rawBody).not.toMatch(/正文|answer|token|authorization/iu);
  });

  it('索引回执课程版本错位时失败关闭', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({
      eventId: SEARCH_INDEX_INPUT.eventId,
      tenantId: SEARCH_INDEX_INPUT.tenantId,
      courseVersionId: SEARCH_INDEX_INPUT.courseVersionId,
      courseVersion: 99,
      operation: SEARCH_INDEX_INPUT.operation,
      receiptId: 'search-index-receipt-001',
      indexedContentDigest: 'd'.repeat(43),
      indexedAt: '2026-07-27T00:00:00.000Z',
      partial: false,
    }, 200, 'search')));
    await expect(new KnowledgeEvidenceHttpClient(config()).applySearchIndex(
      SEARCH_INDEX_INPUT,
    )).rejects.toThrow('KNOWLEDGE_SEARCH_INDEX_RECEIPT_MISMATCH');
  });
});
