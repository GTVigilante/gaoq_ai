import { model } from 'mongoose';
import { describe, expect, it } from 'vitest';
import {
  MarketingContentRecordSchema,
  MarketingContentRevisionRecordSchema,
  MarketingLeadRecordSchema,
} from './marketing-cms.schemas.js';

const Content = model('MarketingContentSchemaSpec', MarketingContentRecordSchema);
const Revision = model('MarketingRevisionSchemaSpec', MarketingContentRevisionRecordSchema);
const Lead = model('MarketingLeadSchemaSpec', MarketingLeadRecordSchema);

describe('Marketing CMS 数据隔离约束', () => {
  it('内容唯一键包含租户、站点、语言、类型与 slug', () => {
    expect(MarketingContentRecordSchema.indexes()).toContainEqual([
      { tenantId: 1, siteId: 1, locale: 1, type: 1, slug: 1 },
      { unique: true },
    ]);
  });

  it('版本快照按租户、内容和 revision 不可重复', () => {
    expect(MarketingContentRevisionRecordSchema.indexes()).toContainEqual([
      { tenantId: 1, contentId: 1, revision: 1 },
      { unique: true },
    ]);
  });

  it('拒绝非法状态、语言和受众', async () => {
    await expect(new Content({
      id: 'content-001', tenantId: 'tenant-001', siteId: 'gaoq', type: 'page',
      locale: 'fr', slug: 'home', title: '首页', blocks: [], status: 'draft',
      revision: 1, version: 1, updatedBy: 'actor-001',
    }).validate()).rejects.toThrow();
    await expect(new Revision({
      tenantId: 'tenant-001', contentId: 'content-001', revision: 0,
      snapshot: {}, actorId: 'actor-001',
    }).validate()).rejects.toThrow();
    await expect(new Lead({
      id: 'lead-001', tenantId: 'tenant-001', siteId: 'gaoq', audience: 'unknown',
      name: '测试', contact: 'test@example.com', requestSummary: '需要完整内容服务',
      dedupeDigest: 'a'.repeat(64), consentedAt: new Date(),
    }).validate()).rejects.toThrow();
  });
});
