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
      tenantId: 'tenant-001',
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
      tenantId: 'tenant-001',
      candidateId: '01J8ZQK7V0A2M4N6P8R0T2W4E1',
      resumeEvidenceId: 'resume-evidence-001',
      sourceChecksum: 'a'.repeat(43),
      mimeType: 'text/plain',
      malwareScanStatus: 'clean',
      piiRedacted: true,
      text: '联系方式 candidate@example.com',
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
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

  it.each([
    [{ RECRUITMENT_RESUME_SOURCE_BEARER_TOKEN: 'x'.repeat(40) }],
    [{ RECRUITMENT_RESUME_SOURCE_ENDPOINT: 'https://resume.example.com/read' }],
  ])('网关配置不完整时明确报告不可用：%o', async (values) => {
    const gateway = new HttpRecruitmentResumeSourceGateway(config(values));
    await expect(gateway.readRedactedText(sourceInput()))
      .rejects.toThrow('RECRUITMENT_RESUME_SOURCE_UNAVAILABLE');
  });

  it.each([
    'not-a-url',
    'http://resume.example.com/read',
    'https://user@resume.example.com/read',
    'https://resume.example.com:8443/read',
    'https://resume.example.com/read?tenant=1',
    'https://resume.example.com/read#fragment',
  ])('拒绝不安全的简历源地址：%s', async (endpoint) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const gateway = sourceGateway(endpoint);
    await expect(gateway.readRedactedText(sourceInput()))
      .rejects.toThrow('RECRUITMENT_RESUME_SOURCE_ENDPOINT_INVALID');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('网络故障和非成功状态转换为稳定错误码', async () => {
    const network = sourceGateway();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('socket secret')));
    await expect(network.readRedactedText(sourceInput()))
      .rejects.toThrow('RECRUITMENT_RESUME_SOURCE_NETWORK_ERROR');

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', {
      status: 503,
      headers: { 'content-type': 'application/json' },
    })));
    await expect(sourceGateway().readRedactedText(sourceInput()))
      .rejects.toThrow('RECRUITMENT_RESUME_SOURCE_FAILED');
  });

  it.each([
    [{ tenantId: 'tenant-other' }, 'RECRUITMENT_RESUME_SOURCE_INTEGRITY_FAILED'],
    [{ candidateId: '01J8ZQK7V0A2M4N6P8R0T2W4E3' }, 'RECRUITMENT_RESUME_SOURCE_INTEGRITY_FAILED'],
    [{ resumeEvidenceId: 'evidence-other' }, 'RECRUITMENT_RESUME_SOURCE_INTEGRITY_FAILED'],
    [{ malwareScanStatus: 'infected' }, 'RECRUITMENT_RESUME_SOURCE_RESPONSE_INVALID'],
    [{ piiRedacted: false }, 'RECRUITMENT_RESUME_SOURCE_RESPONSE_INVALID'],
  ])('拒绝来源边界不一致或未完成安全处理：%o', async (overrides, code) => {
    mockJsonResponse(sourcePayload(overrides));
    await expect(sourceGateway().readRedactedText(sourceInput())).rejects.toThrow(code);
  });

  it('先做 NFKC 规范化再检查全角直接身份信息', async () => {
    mockJsonResponse(sourcePayload({ text: '邮箱：ｕｓｅｒ＠ｅｘａｍｐｌｅ．ｃｏｍ' }));
    await expect(sourceGateway().readRedactedText(sourceInput()))
      .rejects.toThrow('RECRUITMENT_RESUME_SOURCE_INTEGRITY_FAILED');
  });

  it.each([
    [new Response('{}', { status: 200 }), 'RECRUITMENT_RESUME_SOURCE_RESPONSE_INVALID'],
    [new Response('{}', {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'content-length': '999999',
      },
    }), 'RECRUITMENT_RESUME_SOURCE_RESPONSE_TOO_LARGE'],
    [new Response('{}', {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'content-length': '-1',
      },
    }), 'RECRUITMENT_RESUME_SOURCE_RESPONSE_TOO_LARGE'],
    [new Response(null, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }), 'RECRUITMENT_RESUME_SOURCE_RESPONSE_INVALID'],
    [new Response('{bad-json', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }), 'RECRUITMENT_RESUME_SOURCE_RESPONSE_INVALID'],
  ])('有界 JSON 读取器拒绝不合规响应：%s', async (response, code) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    await expect(sourceGateway().readRedactedText(sourceInput())).rejects.toThrow(code);
  });

  it('拒绝未声明长度的超大响应和非法 UTF-8', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      'x'.repeat(256 * 1024 + 1),
      { headers: { 'content-type': 'application/json' } },
    )));
    await expect(sourceGateway().readRedactedText(sourceInput()))
      .rejects.toThrow('RECRUITMENT_RESUME_SOURCE_RESPONSE_TOO_LARGE');

    const invalidUtf8 = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0xc3, 0x28]));
        controller.close();
      },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(invalidUtf8, {
      headers: { 'content-type': 'application/json' },
    })));
    await expect(sourceGateway().readRedactedText(sourceInput()))
      .rejects.toThrow('RECRUITMENT_RESUME_SOURCE_RESPONSE_INVALID');
  });
});

describe('OpenAiRecruitmentResumeAnalyzer', () => {
  it('使用 store:false、严格 JSON Schema 和受控标签词表', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      status: 'completed',
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
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const analyzer = new OpenAiRecruitmentResumeAnalyzer(config({
      RECRUITMENT_RESUME_AI_PROVIDER: 'openai',
      OPENAI_RESUME_API_KEY: 'sk-test-'.padEnd(40, 'x'),
      OPENAI_RESUME_MODEL: 'gpt-5.6-luna',
    }));
    const result = await analyzer.analyze({
      redactedText: '五年 TypeScript 后端研发经历。',
      taxonomy: RECRUITMENT_RESUME_TAG_TAXONOMY,
      safetyIdentifier: 's'.repeat(43),
    });

    expect(result.tags).toEqual([expect.objectContaining({ code: 'role_engineering' })]);
    const rawBody = (fetchMock.mock.calls[0]?.[1] as RequestInit).body;
    if (typeof rawBody !== 'string') throw new Error('测试请求体必须为字符串');
    const body = JSON.parse(rawBody) as {
      store: boolean;
      max_output_tokens: number;
      safety_identifier: string;
      text: { format: { type: string; strict: boolean } };
      input: readonly { content: string }[];
    };
    expect(body.store).toBe(false);
    expect(body).toMatchObject({
      max_output_tokens: 4096,
      safety_identifier: 's'.repeat(43),
    });
    expect(body.text.format).toMatchObject({ type: 'json_schema', strict: true });
    expect(body.input[1]?.content).toContain('role_engineering');
    expect(body.input[0]?.content).toContain('禁止给出录用、淘汰');
  });

  it('拒绝模型生成词表外标签', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      status: 'completed',
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
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    const analyzer = new OpenAiRecruitmentResumeAnalyzer(config({
      RECRUITMENT_RESUME_AI_PROVIDER: 'openai',
      OPENAI_RESUME_API_KEY: 'sk-test-'.padEnd(40, 'x'),
      OPENAI_RESUME_MODEL: 'gpt-5.6-luna',
    }));
    await expect(analyzer.analyze({
      redactedText: '研发经历',
      taxonomy: RECRUITMENT_RESUME_TAG_TAXONOMY,
      safetyIdentifier: 's'.repeat(43),
    })).rejects.toThrow('RECRUITMENT_RESUME_AI_OUTPUT_INVALID');
  });

  it.each([
    [{ RECRUITMENT_RESUME_AI_PROVIDER: 'disabled' }, 'RECRUITMENT_RESUME_AI_DISABLED'],
    [{
      RECRUITMENT_RESUME_AI_PROVIDER: 'openai',
      OPENAI_RESUME_MODEL: 'gpt-5.6-luna',
    }, 'RECRUITMENT_RESUME_AI_UNAVAILABLE'],
    [{
      RECRUITMENT_RESUME_AI_PROVIDER: 'openai',
      OPENAI_RESUME_API_KEY: 'sk-test'.padEnd(40, 'x'),
    }, 'RECRUITMENT_RESUME_AI_UNAVAILABLE'],
  ])('拒绝禁用或不完整的 AI 配置：%o', async (values, code) => {
    const analyzer = new OpenAiRecruitmentResumeAnalyzer(
      config(values as Partial<AppEnvironment>),
    );
    await expect(analyzer.analyze(aiInput())).rejects.toThrow(code);
  });

  it('拒绝原始业务标识作为 safety_identifier', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(openAiAnalyzer().analyze({
      ...aiInput(),
      safetyIdentifier: 'candidate-001',
    })).rejects.toThrow('RECRUITMENT_RESUME_AI_SAFETY_IDENTIFIER_INVALID');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('模型网络故障与非成功状态转换为稳定错误码', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('api secret')));
    await expect(openAiAnalyzer().analyze(aiInput()))
      .rejects.toThrow('RECRUITMENT_RESUME_AI_NETWORK_ERROR');

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', {
      status: 429,
      headers: { 'content-type': 'application/json' },
    })));
    await expect(openAiAnalyzer().analyze(aiInput()))
      .rejects.toThrow('RECRUITMENT_RESUME_AI_REQUEST_FAILED');
  });

  it.each([
    [{ status: 'in_progress', output: [] }, 'RECRUITMENT_RESUME_AI_RESPONSE_INCOMPLETE'],
    [{ status: 'completed', output: 'invalid' }, 'RECRUITMENT_RESUME_AI_RESPONSE_INVALID'],
    [{
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'policy' }] }],
    }, 'RECRUITMENT_RESUME_AI_REFUSED'],
    [{ status: 'completed', output: [] }, 'RECRUITMENT_RESUME_AI_RESPONSE_INVALID'],
    [{
      status: 'completed',
      output: [
        { type: 'message', content: [{ type: 'output_text', text: '{}' }] },
        { type: 'message', content: [{ type: 'output_text', text: '{}' }] },
      ],
    }, 'RECRUITMENT_RESUME_AI_RESPONSE_INVALID'],
  ])('拒绝未完成、拒答或非单一结构输出：%o', async (payload, code) => {
    mockJsonResponse(payload);
    await expect(openAiAnalyzer().analyze(aiInput())).rejects.toThrow(code);
  });

  it.each([
    ['{bad-json'],
    [JSON.stringify({ ...aiPayload(), headline: '' })],
    [JSON.stringify({ ...aiPayload(), summary: '联系 candidate@example.com' })],
    [JSON.stringify({ ...aiPayload(), summary: '联系 ｕｓｅｒ＠ｅｘａｍｐｌｅ．ｃｏｍ' })],
  ])('本地二次校验拒绝非法模型内容', async (outputText) => {
    mockJsonResponse(aiResponse(outputText));
    await expect(openAiAnalyzer().analyze(aiInput()))
      .rejects.toThrow('RECRUITMENT_RESUME_AI_OUTPUT_INVALID');
  });

  it('规范化并去重模型字符串且忽略非 message 输出项', async () => {
    const payload = aiPayload({
      headline: '　高级后端研发　',
      skills: [' TypeScript ', 'ＴｙｐｅＳｃｒｉｐｔ'],
      jobTitles: ['后端工程师', '后端工程师'],
    });
    mockJsonResponse({
      status: 'completed',
      output: [
        { type: 'reasoning', content: [] },
        {
          type: 'message',
          content: [
            { type: 'metadata' },
            { type: 'output_text', text: JSON.stringify(payload) },
          ],
        },
      ],
    });
    await expect(openAiAnalyzer().analyze(aiInput())).resolves.toMatchObject({
      headline: '高级后端研发',
      skills: ['TypeScript'],
      jobTitles: ['后端工程师'],
    });
  });

  it('模型响应同样受内容类型与大小边界保护', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    await expect(openAiAnalyzer().analyze(aiInput()))
      .rejects.toThrow('RECRUITMENT_RESUME_AI_RESPONSE_INVALID');

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', {
      headers: {
        'content-type': 'application/json',
        'content-length': '999999',
      },
    })));
    await expect(openAiAnalyzer().analyze(aiInput()))
      .rejects.toThrow('RECRUITMENT_RESUME_AI_RESPONSE_TOO_LARGE');
  });
});

function sourceGateway(
  endpoint = 'https://resume-gateway.example.com/read',
): HttpRecruitmentResumeSourceGateway {
  return new HttpRecruitmentResumeSourceGateway(config({
    RECRUITMENT_RESUME_SOURCE_ENDPOINT: endpoint,
    RECRUITMENT_RESUME_SOURCE_BEARER_TOKEN: 'x'.repeat(40),
  }));
}

function sourceInput() {
  return {
    tenantId: 'tenant-001',
    candidateId: '01J8ZQK7V0A2M4N6P8R0T2W4E1',
    resumeEvidenceId: 'resume-evidence-001',
  } as const;
}

function sourcePayload(overrides: Record<string, unknown> = {}) {
  return {
    ...sourceInput(),
    sourceChecksum: 'a'.repeat(43),
    mimeType: 'application/pdf',
    malwareScanStatus: 'clean',
    piiRedacted: true,
    text: '具备五年 TypeScript 与 Node.js 后端研发经历。',
    ...overrides,
  };
}

function openAiAnalyzer(): OpenAiRecruitmentResumeAnalyzer {
  return new OpenAiRecruitmentResumeAnalyzer(config({
    RECRUITMENT_RESUME_AI_PROVIDER: 'openai',
    OPENAI_RESUME_API_KEY: 'sk-test-'.padEnd(40, 'x'),
    OPENAI_RESUME_MODEL: 'gpt-5.6-luna',
  }));
}

function aiInput() {
  return {
    redactedText: '五年 TypeScript 后端研发经历。',
    taxonomy: RECRUITMENT_RESUME_TAG_TAXONOMY,
    safetyIdentifier: 's'.repeat(43),
  } as const;
}

function aiPayload(overrides: Record<string, unknown> = {}) {
  return {
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
    ...overrides,
  };
}

function aiResponse(outputText: string) {
  return {
    status: 'completed',
    output: [{
      type: 'message',
      content: [{ type: 'output_text', text: outputText }],
    }],
  };
}

function mockJsonResponse(value: unknown): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })));
}

function config(values: Partial<AppEnvironment>): ConfigService<AppEnvironment, true> {
  return {
    get: (key: keyof AppEnvironment) => values[key],
  } as unknown as ConfigService<AppEnvironment, true>;
}
