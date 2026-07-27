import { randomBytes } from 'node:crypto';
import { model } from 'mongoose';
import { describe, expect, it } from 'vitest';
import {
  MarketingContentRecordSchema,
  MarketingContentRevisionRecordSchema,
  MarketingLeadRecordSchema,
  MarketingSideEffectRecordSchema,
} from './marketing-cms.schemas.js';

const Content = model('MarketingContentSchemaSpec', MarketingContentRecordSchema);
const Revision = model('MarketingRevisionSchemaSpec', MarketingContentRevisionRecordSchema);
const Lead = model('MarketingLeadSchemaSpec', MarketingLeadRecordSchema);
const SideEffect = model('MarketingSideEffectSchemaSpec', MarketingSideEffectRecordSchema);

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

  it('副作用 Outbox 唯一键含租户、类型、聚合版本与渠道', () => {
    expect(MarketingSideEffectRecordSchema.indexes()).toContainEqual([
      { tenantId: 1, kind: 1, aggregateId: 1, aggregateVersion: 1, channel: 1 },
      { unique: true },
    ]);
  });

  it('仅接受真实长度且为规范 base64url 的联系人保护字段', async () => {
    const valid = {
      id: 'lead-001',
      tenantId: 'tenant-001',
      siteId: 'gaoq',
      audience: 'creator',
      name: '测试',
      contactIv: randomBytes(12).toString('base64url'),
      contactCiphertext: Buffer.from('creator@example.com').toString('base64url'),
      contactAuthTag: randomBytes(16).toString('base64url'),
      requestSummary: '需要完整内容服务',
      dedupeDigest: randomBytes(32).toString('base64url'),
      consentedAt: new Date(),
    };
    await expect(new Lead(valid).validate()).resolves.toBeUndefined();
    await expect(new Lead({
      ...valid,
      id: 'lead-002',
      contactAuthTag: `${'A'.repeat(21)}B`,
    }).validate()).rejects.toThrow('保护字段编码或长度非法');
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
    await expect(new SideEffect({
      eventId: '01J8ZQK7V0A2M4N6P8R0T2W4Y',
      tenantId: 'tenant-001',
      kind: 'scheduled_publish',
      aggregateId: 'content-001',
      aggregateVersion: 1,
      channel: 'email',
      dueAt: new Date(),
      nextAttemptAt: new Date(),
    }).validate()).rejects.toThrow('渠道与类型不匹配');
  });
});
