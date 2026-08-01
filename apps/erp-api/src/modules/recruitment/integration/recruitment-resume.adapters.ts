import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppEnvironment } from '../../../config/environment.js';
import { z } from 'zod';

import {
  RecruitmentResumeAiAnalyzer,
  RecruitmentResumeSourceGateway,
  type RecruitmentResumeAiResult,
  type RedactedResumeText,
} from '../application/recruitment-resume.ports.js';
import type {
  RecruitmentResumeTagDefinition,
} from '../application/recruitment-resume.taxonomy.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HASH_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_GATEWAY_RESPONSE_BYTES = 256 * 1024;
const DIRECT_IDENTIFIER_PATTERN =
  /(?:\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b|\+?[0-9][0-9 ()-]{7,}[0-9]|\b[0-9]{17}[0-9Xx]\b)/u;

const sourceResponseSchema = z.object({
  tenantId: z.string().regex(ID_PATTERN),
  candidateId: z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/),
  resumeEvidenceId: z.string().regex(ID_PATTERN),
  sourceChecksum: z.string().regex(HASH_PATTERN),
  mimeType: z.enum([
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/plain',
  ]),
  malwareScanStatus: z.literal('clean'),
  piiRedacted: z.literal(true),
  text: z.string().min(1).max(120_000),
}).strict();

const aiOutputSchema = z.object({
  headline: z.string().min(1).max(200),
  summary: z.string().min(1).max(800),
  yearsExperience: z.number().min(0).max(80),
  educationLevel: z.enum([
    'unknown', 'high_school', 'associate', 'bachelor', 'master', 'doctorate',
  ]),
  skills: z.array(z.string().min(1).max(64)).max(40),
  jobTitles: z.array(z.string().min(1).max(96)).max(20),
  industries: z.array(z.string().min(1).max(64)).max(20),
  languages: z.array(z.string().min(1).max(64)).max(20),
  tags: z.array(z.object({
    code: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
    confidence: z.number().min(0).max(1),
    evidence: z.string().min(1).max(160),
  }).strict()).min(1).max(30),
}).strict();

/**
 * 简历附件隔离网关。
 *
 * ERP 只发送不可解释证据 ID；网关负责对象读取、归属校验、病毒扫描、文本提取与 PII 去除。
 */
@Injectable()
export class HttpRecruitmentResumeSourceGateway extends RecruitmentResumeSourceGateway {
  constructor(private readonly config: ConfigService<AppEnvironment, true>) { super(); }

  override async readRedactedText(input: {
    readonly tenantId: string;
    readonly candidateId: string;
    readonly resumeEvidenceId: string;
  }): Promise<RedactedResumeText> {
    const endpoint = this.config.get('RECRUITMENT_RESUME_SOURCE_ENDPOINT', { infer: true });
    const credential = this.config.get(
      'RECRUITMENT_RESUME_SOURCE_BEARER_TOKEN',
      { infer: true },
    );
    if (endpoint === undefined || credential === undefined) {
      throw new Error('RECRUITMENT_RESUME_SOURCE_UNAVAILABLE');
    }
    const target = safeGatewayEndpoint(endpoint);
    const body = JSON.stringify(input);
    let response: Response;
    try {
      response = await fetch(target, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${credential}`,
          'content-length': String(Buffer.byteLength(body)),
          'content-type': 'application/json',
        },
        body,
      });
    } catch (error) {
      throw new Error('RECRUITMENT_RESUME_SOURCE_NETWORK_ERROR', { cause: error });
    }
    if (!response.ok) throw new Error('RECRUITMENT_RESUME_SOURCE_FAILED');
    let parsed: z.infer<typeof sourceResponseSchema>;
    try {
      parsed = sourceResponseSchema.parse(await readBoundedJson(
        response,
        'RECRUITMENT_RESUME_SOURCE',
      ));
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith('RECRUITMENT_RESUME_SOURCE_RESPONSE_')
      ) throw error;
      throw new Error('RECRUITMENT_RESUME_SOURCE_RESPONSE_INVALID', { cause: error });
    }
    const text = parsed.text.normalize('NFKC');
    if (
      parsed.tenantId !== input.tenantId ||
      parsed.candidateId !== input.candidateId ||
      parsed.resumeEvidenceId !== input.resumeEvidenceId ||
      DIRECT_IDENTIFIER_PATTERN.test(text)
    ) throw new Error('RECRUITMENT_RESUME_SOURCE_INTEGRITY_FAILED');
    return Object.freeze({
      candidateId: parsed.candidateId,
      resumeEvidenceId: parsed.resumeEvidenceId,
      sourceChecksum: parsed.sourceChecksum,
      mimeType: parsed.mimeType,
      text,
    });
  }
}

/**
 * OpenAI Responses API 适配器。
 *
 * 使用严格 JSON Schema 和 store:false；响应在进入领域层前仍需本地 Zod 与词表双重校验。
 */
@Injectable()
export class OpenAiRecruitmentResumeAnalyzer extends RecruitmentResumeAiAnalyzer {
  constructor(private readonly config: ConfigService<AppEnvironment, true>) { super(); }

  override async analyze(input: {
    readonly redactedText: string;
    readonly taxonomy: readonly RecruitmentResumeTagDefinition[];
    readonly safetyIdentifier: string;
  }): Promise<RecruitmentResumeAiResult> {
    if (this.config.get('RECRUITMENT_RESUME_AI_PROVIDER', { infer: true }) !== 'openai') {
      throw new Error('RECRUITMENT_RESUME_AI_DISABLED');
    }
    const apiKey = this.config.get('OPENAI_RESUME_API_KEY', { infer: true });
    const model = this.config.get('OPENAI_RESUME_MODEL', { infer: true });
    if (apiKey === undefined || model === undefined) {
      throw new Error('RECRUITMENT_RESUME_AI_UNAVAILABLE');
    }
    if (!HASH_PATTERN.test(input.safetyIdentifier)) {
      throw new Error('RECRUITMENT_RESUME_AI_SAFETY_IDENTIFIER_INVALID');
    }
    const taxonomyCodes = input.taxonomy.map((item) => ({
      category: item.category, code: item.code, label: item.label,
    }));
    const body = JSON.stringify({
      model,
      store: false,
      max_output_tokens: 4_096,
      safety_identifier: input.safetyIdentifier,
      input: [
        {
          role: 'system',
          content: [
            '你是简历结构化助手。只提取材料中明确出现的职业信息。',
            '禁止推断或输出姓名、联系方式、年龄、性别、民族、婚育、宗教、健康、照片、证件信息。',
            '禁止给出录用、淘汰、适配度或候选人排序建议。',
            '标签只能从给定词表选择；证据仅概述对应职业经历，不复制直接身份信息。',
          ].join(''),
        },
        {
          role: 'user',
          content: `受控标签词表：${JSON.stringify(taxonomyCodes)}\n已脱敏简历正文：\n${input.redactedText}`,
        },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'recruitment_resume_analysis',
          strict: true,
          schema: resumeJsonSchema(),
        },
      },
    });
    let response: Response;
    try {
      response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(45_000),
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${apiKey}`,
          'content-length': String(Buffer.byteLength(body)),
          'content-type': 'application/json',
        },
        body,
      });
    } catch (error) {
      throw new Error('RECRUITMENT_RESUME_AI_NETWORK_ERROR', { cause: error });
    }
    if (!response.ok) throw new Error('RECRUITMENT_RESUME_AI_REQUEST_FAILED');
    const output = extractOutputText(await readBoundedJson(
      response,
      'RECRUITMENT_RESUME_AI',
    ));
    let parsed: z.infer<typeof aiOutputSchema>;
    try {
      const raw = aiOutputSchema.parse(JSON.parse(output) as unknown);
      parsed = aiOutputSchema.parse({
        ...raw,
        headline: raw.headline.normalize('NFKC').trim(),
        summary: raw.summary.normalize('NFKC').trim(),
        skills: unique(raw.skills),
        jobTitles: unique(raw.jobTitles),
        industries: unique(raw.industries),
        languages: unique(raw.languages),
        tags: raw.tags.map((item) => ({
          ...item,
          evidence: item.evidence.normalize('NFKC').trim(),
        })),
      });
    } catch (error) {
      throw new Error('RECRUITMENT_RESUME_AI_OUTPUT_INVALID', { cause: error });
    }
    const allowedCodes = new Set(input.taxonomy.map((item) => item.code));
    if (
      parsed.tags.some((item) => !allowedCodes.has(item.code)) ||
      containsDirectIdentifier(parsed)
    ) throw new Error('RECRUITMENT_RESUME_AI_OUTPUT_INVALID');
    return Object.freeze({
      model,
      headline: parsed.headline,
      summary: parsed.summary,
      yearsExperience: parsed.yearsExperience,
      educationLevel: parsed.educationLevel,
      skills: Object.freeze(unique(parsed.skills)),
      jobTitles: Object.freeze(unique(parsed.jobTitles)),
      industries: Object.freeze(unique(parsed.industries)),
      languages: Object.freeze(unique(parsed.languages)),
      tags: Object.freeze(parsed.tags.map((item) => Object.freeze({ ...item }))),
    });
  }
}

function extractOutputText(value: unknown): string {
  const responseSchema = z.object({
    status: z.string(),
    output: z.array(z.object({
      type: z.string(),
      content: z.array(z.object({
        type: z.string(),
        text: z.string().optional(),
        refusal: z.string().optional(),
      }).passthrough()).optional(),
    }).passthrough()),
  }).passthrough();
  let parsed: z.infer<typeof responseSchema>;
  try {
    parsed = responseSchema.parse(value);
  } catch (error) {
    throw new Error('RECRUITMENT_RESUME_AI_RESPONSE_INVALID', { cause: error });
  }
  if (parsed.status !== 'completed') {
    throw new Error('RECRUITMENT_RESUME_AI_RESPONSE_INCOMPLETE');
  }
  const outputTexts: string[] = [];
  for (const item of parsed.output) {
    if (item.type !== 'message') continue;
    for (const content of item.content ?? []) {
      if (content.type === 'refusal') {
        throw new Error('RECRUITMENT_RESUME_AI_REFUSED');
      }
      if (content.type === 'output_text' && content.text !== undefined) {
        outputTexts.push(content.text);
      }
    }
  }
  if (outputTexts.length === 1) return outputTexts[0] as string;
  throw new Error('RECRUITMENT_RESUME_AI_RESPONSE_INVALID');
}

function containsDirectIdentifier(value: z.infer<typeof aiOutputSchema>): boolean {
  return DIRECT_IDENTIFIER_PATTERN.test(JSON.stringify(value).normalize('NFKC'));
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.normalize('NFKC').trim()).filter(Boolean))];
}

function safeGatewayEndpoint(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error('RECRUITMENT_RESUME_SOURCE_ENDPOINT_INVALID', { cause: error });
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    (url.port !== '' && url.port !== '443')
  ) throw new Error('RECRUITMENT_RESUME_SOURCE_ENDPOINT_INVALID');
  return url;
}

async function readBoundedJson(response: Response, prefix: string): Promise<unknown> {
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim()
    .toLowerCase();
  if (contentType !== 'application/json') {
    throw new Error(`${prefix}_RESPONSE_INVALID`);
  }
  const declaredLength = response.headers.get('content-length');
  if (
    declaredLength !== null &&
    (
      !/^(?:0|[1-9][0-9]*)$/.test(declaredLength) ||
      Number(declaredLength) > MAX_GATEWAY_RESPONSE_BYTES
    )
  ) throw new Error(`${prefix}_RESPONSE_TOO_LARGE`);
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error(`${prefix}_RESPONSE_INVALID`);
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      const chunk: unknown = part.value;
      if (!(chunk instanceof Uint8Array)) {
        throw new Error(`${prefix}_RESPONSE_INVALID`);
      }
      totalBytes += chunk.byteLength;
      if (totalBytes > MAX_GATEWAY_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error(`${prefix}_RESPONSE_TOO_LARGE`);
      }
      chunks.push(chunk);
    }
    const text = new TextDecoder('utf-8', { fatal: true })
      .decode(Buffer.concat(chunks, totalBytes));
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (
      error instanceof Error &&
      (
        error.message === `${prefix}_RESPONSE_TOO_LARGE` ||
        error.message === `${prefix}_RESPONSE_INVALID`
      )
    ) throw error;
    throw new Error(`${prefix}_RESPONSE_INVALID`, { cause: error });
  } finally {
    reader.releaseLock();
  }
}

function resumeJsonSchema(): Readonly<Record<string, unknown>> {
  const stringArray = (maxItems: number, maxLength: number) => ({
    type: 'array',
    maxItems,
    items: { type: 'string', minLength: 1, maxLength },
  });
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      headline: { type: 'string', minLength: 1, maxLength: 200 },
      summary: { type: 'string', minLength: 1, maxLength: 800 },
      yearsExperience: { type: 'number', minimum: 0, maximum: 80 },
      educationLevel: {
        type: 'string',
        enum: ['unknown', 'high_school', 'associate', 'bachelor', 'master', 'doctorate'],
      },
      skills: stringArray(40, 64),
      jobTitles: stringArray(20, 96),
      industries: stringArray(20, 64),
      languages: stringArray(20, 64),
      tags: {
        type: 'array',
        minItems: 1,
        maxItems: 30,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            code: { type: 'string', pattern: '^[a-z][a-z0-9_]{1,63}$' },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            evidence: { type: 'string', minLength: 1, maxLength: 160 },
          },
          required: ['code', 'confidence', 'evidence'],
        },
      },
    },
    required: [
      'headline', 'summary', 'yearsExperience', 'educationLevel',
      'skills', 'jobTitles', 'industries', 'languages', 'tags',
    ],
  };
}
