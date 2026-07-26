import type { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppEnvironment } from '../../../config/environment.js';
import { RECRUITMENT_RESUME_TAG_TAXONOMY } from '../application/recruitment-resume.taxonomy.js';
import {
  HttpRecruitmentResumeSourceGateway,
  OpenAiRecruitmentResumeAnalyzer,
} from './recruitment-resume.adapters.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('HttpRecruitmentResumeSourceGateway', () => {
  it('只接受归属一致、扫描干净且已脱敏的文本', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      candidateId: '01J8ZQK7V0A2M4N6P8R0T2W4E1',
      resumeEvidenceId: 'resume-evidence-001',
      sourceChecksum: 'a'.repeat(43),
      mimeType: 'application/pdf',
      malwareScanStatus: 'clean',
      piiRedacted: true,
      text: '具备五年 TypeScript 与 Node.js 后端研发经历。',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const gateway = new HttpRecruitmentResumeSourceGateway(config({
      RECRUITMENT_RESUME_SOURCE_ENDPOINT: 'https://resume-gateway.example.com/read',
      RECRUITMENT_RESUME_SOURCE_BEARER_TOKEN: 'x'.repeat(40),
    }));

    await expect(gateway.readRedactedText({
      tenantId: 'tenant-001',
      candidateId: '01J8ZQK7V0A2M4N6P8R0T2W4E1',
      resumeEvidenceId: 'resume-evidence-001',
    })).resolves.toMatchObject({
      sourceChecksum: 'a'.repeat(43),
      text: '具备五年 TypeScript 与 Node.js 后端研发经历。',
    });
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(request.headers).toMatchObject({
      authorization: `Bearer ${'x'.repeat(40)}`,
      'content-type': 'application/json',
    });
  });

  it('网关返回联系方式时失败关闭', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      candidateId: '01J8ZQK7V0A2M4N6P8R0T2W4E1',
      resumeEvidenceId: 'resume-evidence-001',
      sourceChecksum: 'a'.repeat(43),
      mimeType: 'text/plain',
      malwareScanStatus: 'clean',
      piiRedacted: true,
      text: '联系方式 candidate@example.com',
    }), { status: 200 })));
    const gateway = new HttpRecruitmentResumeSourceGateway(config({
      RECRUITMENT_RESUME_SOURCE_ENDPOINT: 'https://resume-gateway.example.com/read',
      RECRUITMENT_RESUME_SOURCE_BEARER_TOKEN: 'x'.repeat(40),
    }));
    await expect(gateway.readRedactedText({
      tenantId: 'tenant-001',
      candidateId: '01J8ZQK7V0A2M4N6P8R0T2W4E1',
      resumeEvidenceId: 'resume-evidence-001',
    })).rejects.toThrow('RECRUITMENT_RESUME_SOURCE_INTEGRITY_FAILED');
  });
});

describe('OpenAiRecruitmentResumeAnalyzer', () => {
  it('使用 store:false、严格 JSON Schema 和受控标签词表', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      output: [{
        type: 'message',
        content: [{
          type: 'output_text',
          text: JSON.stringify({
            headline: '高级后端研发',
            summary: '长期负责企业级后端系统。',
            yearsExperience: 5,
            educationLevel: 'bachelor',
            skills: ['TypeScript', 'Node.js'],
            jobTitles: ['后端工程师'],
            industries: ['SaaS'],
            languages: ['中文'],
            tags: [{
              code: 'role_engineering',
              confidence: 0.96,
              evidence: '五年后端研发经历',
            }],
          }),
        }],
      }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const analyzer = new OpenAiRecruitmentResumeAnalyzer(config({
      RECRUITMENT_RESUME_AI_PROVIDER: 'openai',
      OPENAI_RESUME_API_KEY: 'sk-test-'.padEnd(40, 'x'),
      OPENAI_RESUME_MODEL: 'gpt-5.6-luna',
    }));
    const result = await analyzer.analyze({
      redactedText: '五年 TypeScript 后端研发经历。',
      taxonomy: RECRUITMENT_RESUME_TAG_TAXONOMY,
    });

    expect(result.tags).toEqual([expect.objectContaining({ code: 'role_engineering' })]);
    const rawBody = (fetchMock.mock.calls[0]?.[1] as RequestInit).body;
    if (typeof rawBody !== 'string') throw new Error('测试请求体必须为字符串');
    const body = JSON.parse(rawBody) as {
      store: boolean;
      text: { format: { type: string; strict: boolean } };
      input: readonly { content: string }[];
    };
    expect(body.store).toBe(false);
    expect(body.text.format).toMatchObject({ type: 'json_schema', strict: true });
    expect(body.input[1]?.content).toContain('role_engineering');
    expect(body.input[0]?.content).toContain('禁止给出录用、淘汰');
  });

  it('拒绝模型生成词表外标签', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      output: [{
        type: 'message',
        content: [{
          type: 'output_text',
          text: JSON.stringify({
            headline: '研发',
            summary: '研发经历',
            yearsExperience: 2,
            educationLevel: 'unknown',
            skills: [],
            jobTitles: [],
            industries: [],
            languages: [],
            tags: [{ code: 'gender_male', confidence: 0.9, evidence: '非法推断' }],
          }),
        }],
      }],
    }), { status: 200 })));
    const analyzer = new OpenAiRecruitmentResumeAnalyzer(config({
      RECRUITMENT_RESUME_AI_PROVIDER: 'openai',
      OPENAI_RESUME_API_KEY: 'sk-test-'.padEnd(40, 'x'),
      OPENAI_RESUME_MODEL: 'gpt-5.6-luna',
    }));
    await expect(analyzer.analyze({
      redactedText: '研发经历',
      taxonomy: RECRUITMENT_RESUME_TAG_TAXONOMY,
    })).rejects.toThrow('RECRUITMENT_RESUME_AI_OUTPUT_INVALID');
  });
});

function config(values: Partial<AppEnvironment>): ConfigService<AppEnvironment, true> {
  return {
    get: (key: keyof AppEnvironment) => values[key],
  } as unknown as ConfigService<AppEnvironment, true>;
}
