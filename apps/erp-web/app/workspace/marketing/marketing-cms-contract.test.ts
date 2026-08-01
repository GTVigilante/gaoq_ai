import { describe, expect, it } from 'vitest';

import type { IdentityProfileView } from '../../lib/approval-contract.js';
import {
  buildMarketingContentInput,
  canRetryMarketingWrite,
  hasMarketingPermission,
  marketingPermissions,
  parseMarketingAiDraft,
  parseMarketingAiReview,
  parseMarketingContentList,
  parseMarketingContentMutation,
  parseMarketingLeadList,
  parseMarketingLeadMutation,
  parseMarketingMediaList,
  parseMarketingMediaMutation,
  parseMarketingUploadTicket,
} from '../../lib/marketing-cms-contract.js';

const content = {
  id: 'content-001',
  siteId: 'gaoq',
  type: 'page',
  locale: 'zh-CN',
  slug: 'creator-services',
  title: '创作者服务',
  summary: '服务摘要',
  status: 'draft',
  revision: 1,
  version: 1,
};

const lead = {
  id: 'lead-001',
  audience: 'creator',
  name: '测试联系人',
  contact: 'contact@example.com',
  requestSummary: '需要完整营销咨询与交付方案',
  status: 'new',
  version: 1,
  createdAt: '2026-07-29T00:00:00.000Z',
};

const media = {
  id: 'media-001',
  fileName: 'hero.png',
  mimeType: 'image/png',
  status: 'ready',
  version: 2,
  variants: { thumb: 'https://cdn.example.invalid/thumb.png' },
};

const profile: IdentityProfileView = Object.freeze({
  actorId: 'actor-001',
  actorType: 'user',
  roleCodes: Object.freeze([]),
  scopes: Object.freeze([
    marketingPermissions.contentRead,
    marketingPermissions.contentCreate,
  ]),
  departmentIds: Object.freeze([]),
});

describe('marketing-cms-contract', () => {
  it('构造规范化且深冻结的内容创建快照', () => {
    const result = buildMarketingContentInput({
      siteId: ' gaoq ',
      type: ' page ',
      locale: 'zh-CN',
      slug: ' creator-services ',
      title: ' 创作者服务 ',
      summary: ' 服务摘要 ',
      heroTitle: ' 专业服务 ',
      heroBody: ' 面向创作者的完整服务。 ',
    });

    expect(result).toEqual({
      siteId: 'gaoq',
      type: 'page',
      locale: 'zh-CN',
      slug: 'creator-services',
      title: '创作者服务',
      summary: '服务摘要',
      blocks: [{
        type: 'hero',
        data: { title: '专业服务', body: '面向创作者的完整服务。' },
      }],
      seo: { title: '创作者服务', description: '服务摘要' },
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.blocks[0].data)).toBe(true);
  });

  it.each([
    { title: '<script>alert(1)</script>' },
    { heroBody: '<img src=x onerror=alert(1)>' },
    { slug: '../admin' },
    { type: 'custom' },
    { siteId: 'bad site' },
  ])('拒绝非法或可执行内容输入 %#', (override) => {
    expect(() => buildMarketingContentInput({
      siteId: 'gaoq',
      type: 'page',
      locale: 'zh-CN',
      slug: 'home',
      title: '首页',
      heroTitle: '首页',
      heroBody: '欢迎访问。',
      ...override,
    })).toThrow('MARKETING_CONTENT_INPUT_INVALID');
  });

  it('只接受内容列表和写结果的逐字最小契约', () => {
    expect(parseMarketingContentList({ items: [content] })).toEqual([content]);
    expect(parseMarketingContentMutation({ content })).toEqual(content);
    expect(Object.isFrozen(parseMarketingContentList({ items: [content] })[0])).toBe(true);
    expect(() => parseMarketingContentList({
      items: [{ ...content, tenantId: 'tenant-001' }],
    })).toThrow('MARKETING_CONTENT_INVALID');
    expect(() => parseMarketingContentMutation({
      content: { ...content, blocks: [] },
    })).toThrow('MARKETING_CONTENT_INVALID');
    expect(() => parseMarketingContentList({ items: [content], count: 1 }))
      .toThrow('MARKETING_CONTENT_LIST_INVALID');
  });

  it('线索视图拒绝归因、备注、负责人和内部租户字段', () => {
    expect(parseMarketingLeadList({ items: [lead] })).toEqual([lead]);
    expect(parseMarketingLeadMutation({
      id: lead.id,
      status: 'qualified',
      version: 2,
    })).toEqual({ id: lead.id, status: 'qualified', version: 2 });
    for (const extra of ['tenantId', 'attribution', 'notes', 'assigneeId', 'consentedAt']) {
      expect(() => parseMarketingLeadList({
        items: [{ ...lead, [extra]: 'secret' }],
      }), extra).toThrow('MARKETING_LEAD_INVALID');
    }
    expect(() => parseMarketingLeadList({
      items: [{ ...lead, requestSummary: '<img onerror=alert(1)>' }],
    })).toThrow('MARKETING_LEAD_INVALID');
  });

  it('媒体视图拒绝对象引用、扫描证据和不安全衍生 URL', () => {
    expect(parseMarketingMediaList({ items: [media] })).toEqual([media]);
    expect(parseMarketingMediaMutation(media)).toEqual(media);
    expect(() => parseMarketingMediaList({
      items: [{ ...media, objectRef: 'tenant/key' }],
    })).toThrow('MARKETING_MEDIA_INVALID');
    expect(() => parseMarketingMediaList({
      items: [{ ...media, variants: { thumb: 'http://cdn.example.invalid/a.png' } }],
    })).toThrow('MARKETING_MEDIA_INVALID');
    expect(() => parseMarketingMediaMutation({
      ...media,
      variants: { constructor: 'https://cdn.example.invalid/a.png' },
    })).toThrow('MARKETING_MEDIA_INVALID');
  });

  it('上传票据只接受短期无凭据 HTTPS 能力 URL', () => {
    const now = Date.parse('2026-07-29T00:00:00.000Z');
    const ticket = {
      id: 'media-001',
      uploadUrl: 'https://uploads.example.invalid/signed?token=opaque',
      expiresAt: '2026-07-29T00:10:00.000Z',
      version: 1,
    };
    expect(parseMarketingUploadTicket(ticket, now)).toEqual(ticket);
    expect(() => parseMarketingUploadTicket({
      ...ticket,
      uploadUrl: 'http://uploads.example.invalid/signed',
    }, now)).toThrow('MARKETING_UPLOAD_TICKET_INVALID');
    expect(() => parseMarketingUploadTicket({
      ...ticket,
      uploadUrl: 'https://user:secret@uploads.example.invalid/signed',
    }, now)).toThrow('MARKETING_UPLOAD_TICKET_INVALID');
    expect(() => parseMarketingUploadTicket({
      ...ticket,
      expiresAt: '2026-07-28T23:59:59.000Z',
    }, now)).toThrow('MARKETING_UPLOAD_TICKET_INVALID');
  });

  it('AI 草稿只接受有界纯 JSON 并深冻结克隆', () => {
    const source = { title: '英文标题', sections: [{ body: '正文' }] };
    const result = parseMarketingAiDraft({
      id: 'generation-001',
      status: 'pending_review',
      output: source,
    });
    expect(result.output).toEqual(source);
    expect(result.output).not.toBe(source);
    expect(Object.isFrozen(result.output)).toBe(true);
    expect(Object.isFrozen(result.output.sections)).toBe(true);
    expect(() => parseMarketingAiDraft({
      id: 'generation-001',
      status: 'pending_review',
      output: { html: '<script>alert(1)</script>' },
    })).toThrow('MARKETING_AI_DRAFT_INVALID');
    expect(() => parseMarketingAiDraft({
      id: 'generation-001',
      status: 'pending_review',
      output: new (class UnsafeOutput {
        readonly title = 'x';
      })(),
    })).toThrow('MARKETING_AI_DRAFT_INVALID');
    const polluted: Record<string, unknown> = {};
    Object.defineProperty(polluted, '__proto__', { value: 'bad', enumerable: true });
    expect(() => parseMarketingAiDraft({
      id: 'generation-001',
      status: 'pending_review',
      output: polluted,
    })).toThrow('MARKETING_AI_DRAFT_INVALID');
  });

  it('AI 人工复核结果拒绝模型、提示词和原始输出', () => {
    const review = {
      id: 'generation-001',
      contentId: 'content-001',
      action: 'translate',
      status: 'accepted',
    };
    expect(parseMarketingAiReview(review)).toEqual(review);
    expect(() => parseMarketingAiReview({ ...review, modelId: 'internal-model' }))
      .toThrow('MARKETING_AI_REVIEW_INVALID');
    expect(() => parseMarketingAiReview({ ...review, status: 'auto_accepted' }))
      .toThrow('MARKETING_AI_REVIEW_INVALID');
  });

  it('入口显隐和原请求重试要求读取权限、动作权限与同一主体', () => {
    expect(hasMarketingPermission(
      profile,
      marketingPermissions.contentCreate,
      marketingPermissions.contentRead,
    )).toBe(true);
    expect(hasMarketingPermission(
      profile,
      marketingPermissions.contentPublish,
      marketingPermissions.contentRead,
    )).toBe(false);
    expect(canRetryMarketingWrite(
      profile,
      'actor-001',
      marketingPermissions.contentCreate,
    )).toBe(true);
    expect(canRetryMarketingWrite(
      profile,
      'actor-002',
      marketingPermissions.contentCreate,
    )).toBe(false);
    expect(canRetryMarketingWrite(
      profile,
      'actor-001',
      marketingPermissions.contentPublish,
    )).toBe(false);
  });
});
