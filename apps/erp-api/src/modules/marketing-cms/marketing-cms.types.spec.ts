import { describe, expect, it } from 'vitest';
import {
  MARKETING_PUBLISHED_EVENT_TYPE,
  parseContentInput,
} from './marketing-cms.types.js';

const valid = () => ({
  siteId: 'gaoq',
  type: 'page',
  locale: 'zh-CN',
  slug: 'creator-services',
  title: '创作者服务',
  summary: '以专业团队支持创作者长期经营。',
  blocks: [{ type: 'hero', data: { title: '让创作者专注创造' } }],
  seo: { title: '创作者服务', description: '内容、设计、商务与运营支持' },
});

describe('Marketing CMS 内容契约', () => {
  it('接受中英文受控区块内容并冻结顶层结果', () => {
    const result = parseContentInput(valid());
    expect(result.locale).toBe('zh-CN');
    expect(result.blocks[0]?.type).toBe('hero');
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('拒绝未知区块与任意字段', () => {
    expect(() => parseContentInput({
      ...valid(), blocks: [{ type: 'raw_html', data: {} }],
    })).toThrowError(/页面区块不在白名单内/u);
    expect(() => parseContentInput({ ...valid(), tenantId: 'client-controlled' }))
      .toThrowError(/未允许字段/u);
  });

  it('拒绝脚本、事件属性和 javascript 协议', () => {
    for (const body of [
      '<script>alert(1)</script>',
      '<img src=x onerror=alert(1)>',
      '[click](javascript:alert(1))',
    ]) {
      expect(() => parseContentInput({
        ...valid(), blocks: [{ type: 'rich_text', data: { body } }],
      })).toThrowError(/不安全/u);
    }
  });

  it('锁定发布事件协议名称', () => {
    expect(MARKETING_PUBLISHED_EVENT_TYPE)
      .toBe('cn.gaoq.erp.marketing.content.published.v1');
  });
});
