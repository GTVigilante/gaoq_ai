import { Logger, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import type { Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../../core/audit/audit.service.js';
import type { ErpRequest } from '../../core/http/request-context.js';
import { REQUIRED_SCOPES_KEY } from '../identity/auth.decorators.js';
import {
  MarketingCmsController,
  MarketingPublicController,
} from './marketing-cms.controller.js';
import type { MarketingCmsService } from './marketing-cms.service.js';
import type { MarketingPublicProtectionService } from './marketing-public-protection.service.js';

const KEY = 'marketing-key-001';
const IF_MATCH = '"1"';
const CONTENT_ID = 'content-001';
const content = {
  id: CONTENT_ID,
  tenantId: 'tenant-001',
  siteId: 'gaoq',
  type: 'page',
  locale: 'zh-CN',
  slug: 'home',
  title: '首页',
  summary: '首页摘要',
  blocks: [{ type: 'hero', data: { title: '首页' } }],
  seo: { title: '首页' },
  status: 'draft',
  revision: 2,
  version: 2,
  publishedAt: null,
  scheduledAt: null,
};
const contentSummary = {
  id: CONTENT_ID,
  siteId: 'gaoq',
  type: 'page',
  locale: 'zh-CN',
  slug: 'home',
  title: '首页',
  summary: '首页摘要',
  status: 'draft',
  revision: 2,
  version: 2,
};
const contentDetail = {
  ...contentSummary,
  blocks: content.blocks,
  seo: content.seo,
  publishedAt: null,
  scheduledAt: null,
};

function fixture() {
  const cms = {
    create: vi.fn().mockResolvedValue({ content }),
    list: vi.fn().mockResolvedValue({ items: [content] }),
    get: vi.fn().mockResolvedValue(content),
    revisionsFor: vi.fn().mockResolvedValue({ items: [] }),
    update: vi.fn().mockResolvedValue({ content }),
    transition: vi.fn().mockImplementation((
      _id: string,
      _version: number,
      _key: string,
      target: string,
    ) => Promise.resolve({ content: { ...content, status: target } })),
    schedule: vi.fn().mockResolvedValue({ content: { ...content, status: 'scheduled' } }),
    rollback: vi.fn().mockResolvedValue({ content }),
    listLeads: vi.fn().mockResolvedValue({ items: [] }),
    exportLeadsCsv: vi.fn().mockResolvedValue('\uFEFFid\n'),
    updateLeadStatus: vi.fn().mockResolvedValue({
      id: 'lead-001', status: 'qualified', version: 2,
    }),
    assignLead: vi.fn().mockResolvedValue({
      id: 'lead-001', assigneeId: 'actor-002', version: 2,
    }),
    addLeadNote: vi.fn().mockResolvedValue({
      id: 'lead-001', note: { body: '已联系' }, version: 2,
    }),
    replaySideEffect: vi.fn().mockResolvedValue({
      eventId: 'event-001', kind: 'lead_notification', status: 'pending',
    }),
    getSideEffectStatus: vi.fn().mockResolvedValue({
      eventId: 'event-001', status: 'pending',
    }),
    createMediaUpload: vi.fn().mockResolvedValue({
      id: 'media-001',
      uploadUrl: 'https://upload.example.invalid/signed',
      expiresAt: '2026-07-29T00:00:00.000Z',
      version: 1,
    }),
    verifyMedia: vi.fn().mockResolvedValue({
      id: 'media-001', status: 'ready', version: 2,
    }),
    listMedia: vi.fn().mockResolvedValue({ items: [] }),
    generateAiDraft: vi.fn().mockResolvedValue({
      id: 'generation-001', status: 'pending_review', output: { title: '草稿' },
    }),
    reviewAiDraft: vi.fn().mockResolvedValue({
      id: 'generation-001', contentId: CONTENT_ID, action: 'translate', status: 'accepted',
    }),
    publicList: vi.fn().mockResolvedValue({ items: [content] }),
    publicContent: vi.fn().mockResolvedValue(content),
    submitLead: vi.fn().mockResolvedValue({ leadId: 'lead-public-001', duplicate: false }),
  };
  const record = vi.fn().mockResolvedValue(undefined);
  const recordSystem = vi.fn().mockResolvedValue(undefined);
  const protection = { assertAllowed: vi.fn().mockResolvedValue(undefined) };
  const setHeader = vi.fn();
  const send = vi.fn();
  const response = { setHeader, send } as unknown as Response;
  const controller = new MarketingCmsController(
    cms as unknown as MarketingCmsService,
    { record } as unknown as AuditService,
  );
  const publicController = new MarketingPublicController(
    cms as unknown as MarketingCmsService,
    protection as unknown as MarketingPublicProtectionService,
    { recordSystem } as unknown as AuditService,
    {
      get: vi.fn().mockReturnValue('tenant-marketing'),
    } as never,
  );
  return {
    cms,
    record,
    recordSystem,
    protection,
    setHeader,
    send,
    response,
    controller,
    publicController,
  };
}

const routeCases = [
  ['create', 'contents', RequestMethod.POST, ['erp:marketing:content:create']],
  ['list', 'contents', RequestMethod.GET, ['erp:marketing:content:read']],
  ['get', 'contents/:id', RequestMethod.GET, ['erp:marketing:content:read']],
  ['revisions', 'contents/:id/revisions', RequestMethod.GET, ['erp:marketing:content:read']],
  ['update', 'contents/:id', RequestMethod.PATCH, ['erp:marketing:content:update']],
  ['submit', 'contents/:id/submit', RequestMethod.POST, ['erp:marketing:content:submit']],
  ['approve', 'contents/:id/approve', RequestMethod.POST, ['erp:marketing:content:approve']],
  ['publish', 'contents/:id/publish', RequestMethod.POST, ['erp:marketing:content:publish']],
  ['schedule', 'contents/:id/schedule', RequestMethod.POST, ['erp:marketing:content:publish']],
  ['withdraw', 'contents/:id/withdraw', RequestMethod.POST, ['erp:marketing:content:publish']],
  ['restore', 'contents/:id/restore', RequestMethod.POST, ['erp:marketing:content:update']],
  ['rollback', 'contents/:id/rollback', RequestMethod.POST, ['erp:marketing:content:rollback']],
  ['leads', 'leads', RequestMethod.GET, ['erp:marketing:lead:read']],
  ['exportLeads', 'leads-export.csv', RequestMethod.GET, ['erp:marketing:lead:export']],
  ['updateLead', 'leads/:id/status', RequestMethod.PATCH, ['erp:marketing:lead:update']],
  ['assignLead', 'leads/:id/assignee', RequestMethod.PATCH, ['erp:marketing:lead:update']],
  ['addLeadNote', 'leads/:id/notes', RequestMethod.POST, ['erp:marketing:lead:update']],
  ['replaySideEffect', 'side-effects/:id/replay', RequestMethod.POST, ['erp:marketing:operations:replay']],
  ['getSideEffect', 'side-effects/:id', RequestMethod.GET, ['erp:marketing:operations:read']],
  ['createMedia', 'media/uploads', RequestMethod.POST, ['erp:marketing:media:create']],
  ['verifyMedia', 'media/:id/verify', RequestMethod.POST, ['erp:marketing:media:create']],
  ['media', 'media', RequestMethod.GET, ['erp:marketing:media:read']],
  ['aiDraft', 'contents/:id/ai-drafts', RequestMethod.POST, ['erp:marketing:ai:generate']],
  ['reviewAiDraft', 'ai-drafts/:id/review', RequestMethod.POST, ['erp:marketing:ai:review']],
] as const;

describe('MarketingCmsController', () => {
  it('固定营销后台全部路由、HTTP 方法与最小 Scope', () => {
    expect(Reflect.getMetadata(PATH_METADATA, MarketingCmsController)).toBe('marketing-cms');
    for (const [name, path, method, scopes] of routeCases) {
      const handler = Object.getOwnPropertyDescriptor(
        MarketingCmsController.prototype,
        name,
      )?.value as object;
      expect(Reflect.getMetadata(PATH_METADATA, handler), name).toBe(path);
      expect(Reflect.getMetadata(METHOD_METADATA, handler), name).toBe(method);
      expect(Reflect.getMetadata(REQUIRED_SCOPES_KEY, handler), name).toEqual(scopes);
    }
  });

  it('委托全部内容入口、强制幂等与乐观锁并返回强 ETag', async () => {
    const store = fixture();

    await store.controller.create(KEY, { title: '首页' }, store.response);
    await expect(store.controller.list()).resolves.toEqual({ items: [contentSummary] });
    await expect(store.controller.get(CONTENT_ID)).resolves.toEqual(contentDetail);
    await expect(store.controller.revisions(CONTENT_ID)).resolves.toEqual({ items: [] });
    await store.controller.update(CONTENT_ID, IF_MATCH, KEY, { title: '新首页' }, store.response);
    await store.controller.submit(CONTENT_ID, IF_MATCH, KEY, store.response);
    await store.controller.approve(CONTENT_ID, IF_MATCH, KEY, store.response);
    await store.controller.publish(CONTENT_ID, IF_MATCH, KEY, store.response);
    await store.controller.schedule(
      CONTENT_ID,
      IF_MATCH,
      KEY,
      { scheduledAt: '2026-08-01T00:00:00.000Z' },
      store.response,
    );
    await store.controller.withdraw(CONTENT_ID, IF_MATCH, KEY, store.response);
    await store.controller.restore(CONTENT_ID, IF_MATCH, KEY, store.response);
    await store.controller.rollback(
      CONTENT_ID,
      IF_MATCH,
      KEY,
      { revision: 1 },
      store.response,
    );

    expect(store.cms.create).toHaveBeenCalledWith(KEY, { title: '首页' });
    expect(store.cms.update).toHaveBeenCalledWith(
      CONTENT_ID, 1, KEY, { title: '新首页' },
    );
    expect(store.cms.transition).toHaveBeenNthCalledWith(
      1, CONTENT_ID, 1, KEY, 'in_review',
    );
    expect(store.cms.transition).toHaveBeenNthCalledWith(
      2, CONTENT_ID, 1, KEY, 'approved',
    );
    expect(store.cms.transition).toHaveBeenNthCalledWith(
      3, CONTENT_ID, 1, KEY, 'published',
    );
    expect(store.cms.transition).toHaveBeenNthCalledWith(
      4, CONTENT_ID, 1, KEY, 'archived',
    );
    expect(store.cms.transition).toHaveBeenNthCalledWith(
      5, CONTENT_ID, 1, KEY, 'draft',
    );
    expect(store.cms.schedule).toHaveBeenCalledWith(
      CONTENT_ID, 1, KEY, '2026-08-01T00:00:00.000Z',
    );
    expect(store.cms.rollback).toHaveBeenCalledWith(CONTENT_ID, 1, 1, KEY);
    expect(store.setHeader).toHaveBeenCalledWith('ETag', '"2"');
    expect(store.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'marketing.content.publish',
      riskLevel: 'R2',
      resourceId: CONTENT_ID,
    }));
  });

  it('委托线索、可靠性、媒体与 AI 写入口且审计不泄露敏感内容', async () => {
    const store = fixture();

    await expect(store.controller.leads()).resolves.toEqual({ items: [] });
    await store.controller.updateLead(
      'lead-001', IF_MATCH, KEY, { status: 'qualified' }, store.response,
    );
    await store.controller.assignLead(
      'lead-001', IF_MATCH, KEY, { assigneeId: 'actor-002' }, store.response,
    );
    await store.controller.addLeadNote(
      'lead-001', IF_MATCH, KEY, { body: '已联系，包含私密讨论' }, store.response,
    );
    await store.controller.replaySideEffect('event-001', KEY);
    await expect(store.controller.getSideEffect('event-001')).resolves.toMatchObject({
      status: 'pending',
    });
    await store.controller.createMedia(KEY, { fileName: 'hero.png' }, store.response);
    await store.controller.verifyMedia('media-001', IF_MATCH, KEY, store.response);
    await expect(store.controller.media()).resolves.toEqual({ items: [] });
    await store.controller.aiDraft(CONTENT_ID, KEY, { instruction: '私密提示词' });
    await store.controller.reviewAiDraft(
      'generation-001', KEY, { decision: 'accepted' },
    );

    expect(store.cms.updateLeadStatus).toHaveBeenCalledWith(
      KEY, 'lead-001', 'qualified', 1,
    );
    expect(store.cms.assignLead).toHaveBeenCalledWith(
      KEY, 'lead-001', 'actor-002', 1,
    );
    expect(store.cms.addLeadNote).toHaveBeenCalledWith(
      KEY, 'lead-001', '已联系，包含私密讨论', 1,
    );
    expect(store.cms.replaySideEffect).toHaveBeenCalledWith(KEY, 'event-001');
    expect(store.cms.createMediaUpload).toHaveBeenCalledWith(
      KEY, { fileName: 'hero.png' },
    );
    expect(store.cms.verifyMedia).toHaveBeenCalledWith(KEY, 'media-001', 1);
    expect(store.cms.generateAiDraft).toHaveBeenCalledWith(
      KEY, CONTENT_ID, { instruction: '私密提示词' },
    );
    expect(store.cms.reviewAiDraft).toHaveBeenCalledWith(
      KEY, 'generation-001', 'accepted',
    );
    const auditPayload = JSON.stringify(store.record.mock.calls);
    expect(auditPayload).not.toContain('已联系，包含私密讨论');
    expect(auditPayload).not.toContain('私密提示词');
    expect(auditPayload).not.toContain('upload.example.invalid');
  });

  it('后台 REST 只返回显式公开视图并剥离租户、对象引用和 AI 内部元数据', async () => {
    const store = fixture();
    store.cms.listLeads.mockResolvedValue({
      items: [{
        id: 'lead-001',
        tenantId: 'tenant-001',
        audience: 'brand',
        name: '品牌联系人',
        contact: 'brand@example.com',
        requestSummary: '需要完整品牌营销与内容合作方案',
        status: 'new',
        attribution: { utmSource: 'private' },
        consentedAt: new Date('2026-07-29T00:00:00.000Z'),
        assigneeId: 'actor-002',
        notes: [{ body: '内部备注' }],
        version: 1,
        createdAt: new Date('2026-07-29T00:00:00.000Z'),
      }],
    });
    store.cms.listMedia.mockResolvedValue({
      items: [{
        id: 'media-001',
        tenantId: 'tenant-001',
        fileName: 'hero.png',
        mimeType: 'image/png',
        status: 'ready',
        version: 2,
        variants: { thumb: 'https://cdn.example.invalid/thumb.png' },
        objectRef: 'private/object',
        checksum: 'private-checksum',
        scanEvidenceId: 'private-evidence',
        altText: { 'zh-CN': '内部文案' },
        copyrightSource: 'private-source',
      }],
    });
    store.cms.verifyMedia.mockResolvedValue({
      id: 'media-001',
      fileName: 'hero.png',
      mimeType: 'image/png',
      status: 'ready',
      version: 2,
      variants: {},
      objectRef: 'private/object',
      checksum: 'private-checksum',
      scanEvidenceId: 'private-evidence',
    });
    store.cms.generateAiDraft.mockResolvedValue({
      id: 'generation-001',
      status: 'pending_review',
      output: { title: '草稿' },
      modelId: 'private-model',
      promptVersion: 'private-prompt',
    });
    store.cms.reviewAiDraft.mockResolvedValue({
      id: 'generation-001',
      contentId: CONTENT_ID,
      action: 'translate',
      status: 'accepted',
      output: { title: '草稿' },
      modelId: 'private-model',
      promptVersion: 'private-prompt',
    });

    const leads = await store.controller.leads();
    const mediaList = await store.controller.media();
    const verified = await store.controller.verifyMedia(
      'media-001', IF_MATCH, KEY, store.response,
    );
    const generated = await store.controller.aiDraft(CONTENT_ID, KEY, {});
    const reviewed = await store.controller.reviewAiDraft(
      'generation-001', KEY, { decision: 'accepted' },
    );

    expect(leads).toEqual({ items: [{
      id: 'lead-001',
      audience: 'brand',
      name: '品牌联系人',
      contact: 'brand@example.com',
      requestSummary: '需要完整品牌营销与内容合作方案',
      status: 'new',
      version: 1,
      createdAt: '2026-07-29T00:00:00.000Z',
    }] });
    expect(mediaList).toEqual({ items: [{
      id: 'media-001',
      fileName: 'hero.png',
      mimeType: 'image/png',
      status: 'ready',
      version: 2,
      variants: { thumb: 'https://cdn.example.invalid/thumb.png' },
    }] });
    expect(verified).toEqual({
      id: 'media-001',
      fileName: 'hero.png',
      mimeType: 'image/png',
      status: 'ready',
      version: 2,
      variants: {},
    });
    expect(generated).toEqual({
      id: 'generation-001',
      status: 'pending_review',
      output: { title: '草稿' },
    });
    expect(reviewed).toEqual({
      id: 'generation-001',
      contentId: CONTENT_ID,
      action: 'translate',
      status: 'accepted',
    });
    const payload = JSON.stringify({ leads, mediaList, verified, generated, reviewed });
    for (const secret of [
      'tenant-001',
      'private/object',
      'private-checksum',
      'private-evidence',
      'private-model',
      'private-prompt',
      '内部备注',
    ]) expect(payload).not.toContain(secret);
  });

  it('线索 CSV 导出先审计再发送受控下载响应', async () => {
    const store = fixture();

    await store.controller.exportLeads(store.response);

    expect(store.record).toHaveBeenCalledWith({
      action: 'marketing.lead.export',
      resourceType: 'marketing_lead_list',
      resourceId: 'all',
      riskLevel: 'R2',
      outcome: 'success',
      metadata: { format: 'csv' },
    });
    expect(store.setHeader).toHaveBeenCalledWith(
      'content-type', 'text/csv; charset=utf-8',
    );
    expect(store.setHeader).toHaveBeenCalledWith(
      'content-disposition', 'attachment; filename="marketing-leads.csv"',
    );
    expect(store.send).toHaveBeenCalledWith('\uFEFFid\n');
  });

  it.each([undefined, '', 'short', 'bad key value', 'a'.repeat(129)])(
    '所有写入口拒绝非法幂等键 %s',
    async (key) => {
      const store = fixture();

      await expect(store.controller.create(key, {}, store.response))
        .rejects.toMatchObject({ response: { code: 'IDEMPOTENCY_KEY_REQUIRED' } });

      expect(store.cms.create).not.toHaveBeenCalled();
    },
  );

  it.each(['bad', '_content-001', `a${'b'.repeat(128)}`])(
    '拒绝非法资源标识 %s',
    async (id) => {
      const store = fixture();

      await expect(store.controller.get(id))
        .rejects.toMatchObject({ response: { code: 'CMS_ID_INVALID' } });

      expect(store.cms.get).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, '', '1', 'W/"1"', '"0"', '"01"', '"1.0"'])(
    '拒绝非强 If-Match %s',
    async (ifMatch) => {
      const store = fixture();

      await expect(store.controller.update(
        CONTENT_ID, ifMatch, KEY, {}, store.response,
      )).rejects.toMatchObject({ response: { code: 'CMS_IF_MATCH_REQUIRED' } });

      expect(store.cms.update).not.toHaveBeenCalled();
    },
  );

  it.each([
    null,
    [],
    { scheduledAt: 'date', extra: true },
    { scheduledAt: 1 },
  ])('拒绝非单字段字符串请求 %#', async (body) => {
    const store = fixture();

    await expect(store.controller.schedule(
      CONTENT_ID, IF_MATCH, KEY, body, store.response,
    )).rejects.toMatchObject({ response: { code: 'CMS_REQUEST_INVALID' } });

    expect(store.cms.schedule).not.toHaveBeenCalled();
  });

  it.each([
    null,
    [],
    { revision: 1, extra: true },
    { revision: '1' },
    { revision: 1.5 },
    { revision: 0 },
  ])('拒绝非单字段正整数回滚请求 %#', async (body) => {
    const store = fixture();

    await expect(store.controller.rollback(
      CONTENT_ID, IF_MATCH, KEY, body, store.response,
    )).rejects.toMatchObject({ response: { code: 'CMS_REQUEST_INVALID' } });

    expect(store.cms.rollback).not.toHaveBeenCalled();
  });

  it('拒绝非法 AI 审核决定', async () => {
    const store = fixture();

    await expect(store.controller.reviewAiDraft(
      'generation-001', KEY, { decision: 'auto_accept' },
    )).rejects.toMatchObject({ response: { code: 'CMS_REQUEST_INVALID' } });

    expect(store.cms.reviewAiDraft).not.toHaveBeenCalled();
  });

  it.each([undefined, null, [], '2', 1.5, 0])(
    '写响应缺失合法版本时失败关闭 %#',
    async (version) => {
      const store = fixture();
      store.cms.create.mockResolvedValue({
        content: version === null ? null : { ...content, version },
      });

      await expect(store.controller.create(KEY, {}, store.response))
        .rejects.toThrow('MARKETING_VERSION_MISSING');

      expect(store.record).not.toHaveBeenCalled();
    },
  );

  it('事务提交后的审计故障不反向暴露写失败且只记录稳定告警', async () => {
    const store = fixture();
    store.record.mockRejectedValue(new Error('audit payload with secret'));
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    await expect(store.controller.create(KEY, {}, store.response))
      .resolves.toEqual({ content: contentSummary });

    expect(error).toHaveBeenCalledWith({
      code: 'MARKETING_AUDIT_AFTER_COMMIT_FAILED',
      action: 'marketing.content.create',
      resourceId: CONTENT_ID,
    });
    expect(JSON.stringify(error.mock.calls)).not.toContain('audit payload with secret');
    error.mockRestore();
  });

  it('草稿、媒体、线索与可靠性读取在审计不可用时失败关闭', async () => {
    const store = fixture();
    const auditFailure = new Error('audit unavailable');
    store.record.mockRejectedValue(auditFailure);

    await expect(store.controller.list()).rejects.toBe(auditFailure);
    await expect(store.controller.get(CONTENT_ID)).rejects.toBe(auditFailure);
    await expect(store.controller.revisions(CONTENT_ID)).rejects.toBe(auditFailure);
    await expect(store.controller.leads()).rejects.toBe(auditFailure);
    await expect(store.controller.getSideEffect('event-001')).rejects.toBe(auditFailure);
    await expect(store.controller.media()).rejects.toBe(auditFailure);
  });
});

describe('MarketingPublicController', () => {
  const validRequest = {
    audience: 'brand',
    name: '测试联系人',
    contact: 'contact@example.com',
    requestSummary: '需要完整营销咨询与交付方案',
    privacyAccepted: true,
    website: '',
    captchaToken: 'captcha-token-0001',
  };

  it('公开读取固定站点内容并在防滥用校验后携带幂等键提交线索', async () => {
    const store = fixture();
    const request = {
      ip: '203.0.113.10',
      socket: { remoteAddress: '203.0.113.20' },
      traceId: 'trace-public-001',
    } as unknown as ErpRequest;

    await expect(store.publicController.list('zh-CN', 'page'))
      .resolves.toEqual({ items: [content] });
    await expect(store.publicController.get('zh-CN', 'page', 'home'))
      .resolves.toBe(content);
    await expect(store.publicController.submitLead(KEY, validRequest, request))
      .resolves.toEqual({ leadId: 'lead-public-001', duplicate: false });

    expect(store.protection.assertAllowed).toHaveBeenCalledWith(
      '203.0.113.10', 'captcha-token-0001',
    );
    expect(store.cms.submitLead).toHaveBeenCalledWith(KEY, {
      audience: 'brand',
      name: '测试联系人',
      contact: 'contact@example.com',
      requestSummary: '需要完整营销咨询与交付方案',
      privacyAccepted: true,
      website: '',
    });
    expect(store.recordSystem).toHaveBeenCalledWith(
      'tenant-marketing',
      {
        traceId: 'trace-public-001',
        action: 'marketing.lead.submit',
        resourceType: 'marketing_lead',
        resourceId: 'lead-public-001',
        riskLevel: 'R1',
        outcome: 'success',
        metadata: { duplicate: false },
      },
    );
  });

  it('缺少 Express IP 时按远端地址和 unknown 顺序降级', async () => {
    const store = fixture();
    await store.publicController.submitLead(
      KEY,
      validRequest,
      { socket: { remoteAddress: '203.0.113.30' } } as unknown as ErpRequest,
    );
    await store.publicController.submitLead(
      KEY,
      validRequest,
      { socket: {} } as unknown as ErpRequest,
    );

    expect(store.protection.assertAllowed).toHaveBeenNthCalledWith(
      1, '203.0.113.30', 'captcha-token-0001',
    );
    expect(store.protection.assertAllowed).toHaveBeenNthCalledWith(
      2, 'unknown', 'captcha-token-0001',
    );
  });

  it.each([
    null,
    [],
    { captchaToken: 1 },
    { captchaToken: 'short' },
    { captchaToken: 'a'.repeat(4097) },
  ])('公开线索入口拒绝非法验证码封装 %#', async (body) => {
    const store = fixture();

    await expect(store.publicController.submitLead(
      KEY,
      body,
      { socket: {} } as unknown as ErpRequest,
    )).rejects.toMatchObject({ response: { code: 'CMS_REQUEST_INVALID' } });

    expect(store.protection.assertAllowed).not.toHaveBeenCalled();
    expect(store.cms.submitLead).not.toHaveBeenCalled();
  });

  it('公开线索入口同样强制合法幂等键', async () => {
    const store = fixture();

    await expect(store.publicController.submitLead(
      undefined,
      validRequest,
      { socket: {} } as unknown as ErpRequest,
    )).rejects.toMatchObject({ response: { code: 'IDEMPOTENCY_KEY_REQUIRED' } });

    expect(store.protection.assertAllowed).not.toHaveBeenCalled();
    expect(store.cms.submitLead).not.toHaveBeenCalled();
  });

  it('公开线索提交后的审计故障不反向暴露失败', async () => {
    const store = fixture();
    store.recordSystem.mockRejectedValue(new Error('audit secret'));
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    await expect(store.publicController.submitLead(
      KEY,
      validRequest,
      {
        traceId: 'trace-public-002',
        socket: {},
      } as unknown as ErpRequest,
    )).resolves.toEqual({ leadId: 'lead-public-001', duplicate: false });

    expect(error).toHaveBeenCalledWith({
      code: 'MARKETING_AUDIT_AFTER_COMMIT_FAILED',
      action: 'marketing.lead.submit',
      resourceId: 'lead-public-001',
    });
    expect(JSON.stringify(error.mock.calls)).not.toContain('audit secret');
    error.mockRestore();
  });
});
