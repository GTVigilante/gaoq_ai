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
const DIRECT_IDENTIFIER_PATTERN =
  /(?:\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b|\+?[0-9][0-9 ()-]{7,}[0-9]|\b[0-9]{17}[0-9Xx]\b)/u;

const sourceResponseSchema = z.object({
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
    const response = await fetch(endpoint, {
      method: 'POST',
      signal: AbortSignal.timeout(30_000),
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${credential}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(input),
    });
    if (!response.ok) throw new Error('RECRUITMENT_RESUME_SOURCE_FAILED');
    const parsed = sourceResponseSchema.parse(await response.json());
    if (
      parsed.candidateId !== input.candidateId ||
      parsed.resumeEvidenceId !== input.resumeEvidenceId ||
      DIRECT_IDENTIFIER_PATTERN.test(parsed.text)
    ) throw new Error('RECRUITMENT_RESUME_SOURCE_INTEGRITY_FAILED');
    return Object.freeze({
      candidateId: parsed.candidateId,
      resumeEvidenceId: parsed.resumeEvidenceId,
      sourceChecksum: parsed.sourceChecksum,
      mimeType: parsed.mimeType,
      text: parsed.text.normalize('NFKC'),
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
  }): Promise<RecruitmentResumeAiResult> {
    if (this.config.get('RECRUITMENT_RESUME_AI_PROVIDER', { infer: true }) !== 'openai') {
      throw new Error('RECRUITMENT_RESUME_AI_DISABLED');
    }
    const apiKey = this.config.get('OPENAI_RESUME_API_KEY', { infer: true });
    const model = this.config.get('OPENAI_RESUME_MODEL', { infer: true });
    if (apiKey === undefined || model === undefined) {
      throw new Error('RECRUITMENT_RESUME_AI_UNAVAILABLE');
    }
    const taxonomyCodes = input.taxonomy.map((item) => ({
      category: item.category, code: item.code, label: item.label,
    }));
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      signal: AbortSignal.timeout(45_000),
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        store: false,
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
      }),
    });
    if (!response.ok) throw new Error('RECRUITMENT_RESUME_AI_REQUEST_FAILED');
    const output = extractOutputText(await response.json());
    const parsed = aiOutputSchema.parse(JSON.parse(output) as unknown);
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
    output: z.array(z.object({
      type: z.string(),
      content: z.array(z.object({
        type: z.string(),
        text: z.string().optional(),
      }).passthrough()).optional(),
    }).passthrough()),
  }).passthrough();
  const parsed = responseSchema.parse(value);
  for (const item of parsed.output) {
    if (item.type !== 'message') continue;
    const text = item.content?.find((content) => content.type === 'output_text')?.text;
    if (text !== undefined) return text;
  }
  throw new Error('RECRUITMENT_RESUME_AI_RESPONSE_INVALID');
}

function containsDirectIdentifier(value: z.infer<typeof aiOutputSchema>): boolean {
  return DIRECT_IDENTIFIER_PATTERN.test(JSON.stringify(value));
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.normalize('NFKC').trim()).filter(Boolean))];
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
