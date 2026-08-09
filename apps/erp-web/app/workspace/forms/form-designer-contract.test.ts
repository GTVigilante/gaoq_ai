import { describe, expect, it } from 'vitest';

import { createDesignerItem, createUlid, itemId, moveItem, PALETTE, type DesignerItem } from './form-designer-contract';

describe('form-designer contract', () => {
  it('生成严格 ULID，并为附件与关联字段装配安全默认值', () => {
    expect(createUlid(0)).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u);
    const attachment = createDesignerItem(PALETTE.find((entry) => entry.type === 'attachment')!, []);
    expect(attachment.kind).toBe('field');
    if (attachment.kind === 'field') expect(attachment.field.attachment).toEqual({ maxCount: 5, maxSizeMb: 20, accept: ['image', 'document', 'spreadsheet', 'pdf'] });
    const relation = createDesignerItem(PALETTE.find((entry) => entry.type === 'relation_single')!, [attachment]);
    if (relation.kind === 'field') expect(relation.field.relation).toEqual({ targetFormId: '', displayFieldKey: '', allowCreate: false });
  });

  it('排序产生新数组并保持组件身份', () => {
    const items: readonly DesignerItem[] = [
      { kind: 'layout', layout: { id: '01K00000000000000000000001', type: 'section', title: '一', description: '' } },
      { kind: 'layout', layout: { id: '01K00000000000000000000002', type: 'section', title: '二', description: '' } },
      { kind: 'layout', layout: { id: '01K00000000000000000000003', type: 'section', title: '三', description: '' } },
    ];
    const moved = moveItem(items, 0, 2);
    expect(moved.map(itemId)).toEqual(['01K00000000000000000000002', '01K00000000000000000000003', '01K00000000000000000000001']);
    expect(items.map(itemId)).toEqual(['01K00000000000000000000001', '01K00000000000000000000002', '01K00000000000000000000003']);
  });
});
