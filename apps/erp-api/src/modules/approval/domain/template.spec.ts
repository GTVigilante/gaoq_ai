import { describe, expect, it } from 'vitest';

import { ApprovalDomainError } from './approval.errors.js';
import {
  createApprovalTemplateDraft,
  createNextApprovalTemplateRevision,
  hashApprovalJson,
  publishApprovalTemplate,
  restoreApprovalTemplateFromMigration,
  retireApprovalTemplate,
  snapshotApprovalTemplate,
  updateApprovalTemplateDraft,
  validateAndFreezeApprovalFormData,
  type ApprovalTemplate,
  type ApprovalTemplateDefinition,
} from './template.js';

const NOW = new Date('2026-07-21T00:00:00.000Z');
const LATER = new Date('2026-07-22T00:00:00.000Z');

function definition(): ApprovalTemplateDefinition {
  return {
    fields: [
      { key: 'amount', label: '金额', type: 'money_minor', required: true, sensitivity: 'L2' },
      { key: 'travel_date', label: '出发日期', type: 'date', required: true, sensitivity: 'L1' },
      {
        key: 'category', label: '类型', type: 'single_select', required: true, sensitivity: 'L1',
        options: [{ key: 'travel', label: '差旅' }, { key: 'purchase', label: '采购' }],
      },
      { key: 'department_id', label: '部门', type: 'department', required: true, sensitivity: 'L2' },
      { key: 'attachments', label: '附件', type: 'file_reference', required: false, sensitivity: 'L3' },
    ],
    nodes: [
      {
        id: 'manager', name: '直属经理', type: 'approval', approvalMode: 'all',
        resolver: { type: 'initiator_manager' },
      },
      {
        id: 'finance', name: '财务复核', type: 'approval', approvalMode: 'any',
        resolver: { type: 'roles', roleCodes: ['FINANCE_APPROVER'], scope: 'tenant' },
        condition: { op: 'gte', field: 'amount', value: 100_00 },
      },
    ],
  };
}

function draft(): ApprovalTemplate {
  return createApprovalTemplateDraft({
    id: 'template-001', tenantId: 'tenant-001', code: 'TRAVEL_EXPENSE', name: '差旅报销',
    riskLevel: 'R2', definition: definition(), actorId: 'editor-001',
  }, NOW);
}

describe('审批模板版本与发布', () => {
  it('创建草稿时规范化、冻结并生成确定性哈希', () => {
    const template = draft();
    expect(template).toMatchObject({ revision: 1, version: 1, status: 'draft', riskLevel: 'R2' });
    expect(template.definitionHash).toBe(hashApprovalJson(template.definition));
    expect(Object.isFrozen(template.definition)).toBe(true);
    expect(hashApprovalJson({ b: 2, a: 1 })).toBe(hashApprovalJson({ a: 1, b: 2 }));
  });

  it('发布强制编辑/审批职责分离，发布后生成完整不可变快照', () => {
    expect(() => publishApprovalTemplate(draft(), {
      tenantId: 'tenant-001', expectedVersion: 1, approverId: 'editor-001',
    }, LATER)).toThrowError(expect.objectContaining({ code: 'APPROVAL_TEMPLATE_SOD_REQUIRED' }));

    const published = publishApprovalTemplate(draft(), {
      tenantId: 'tenant-001', expectedVersion: 1, approverId: 'publisher-001',
    }, LATER);
    const snapshot = snapshotApprovalTemplate(published);
    expect(published).toMatchObject({ status: 'published', approvedBy: 'publisher-001', version: 2 });
    expect(snapshot).toMatchObject({
      templateId: 'template-001', revision: 1, definitionHash: published.definitionHash,
    });
    expect(Object.isFrozen(snapshot.definition.nodes)).toBe(true);
    expect(() => updateApprovalTemplateDraft(published, {
      tenantId: 'tenant-001', expectedVersion: 2, name: '篡改', riskLevel: 'R1',
      definition: definition(), actorId: 'editor-002',
    }, LATER)).toThrowError(expect.objectContaining({ code: 'APPROVAL_TEMPLATE_IMMUTABLE' }));
  });

  it('发布与生成快照时复核定义摘要，拒绝被篡改的聚合', () => {
    const current = draft();
    const tampered = { ...current, definitionHash: 'tampered' };
    expect(() => publishApprovalTemplate(tampered, {
      tenantId: 'tenant-001', expectedVersion: 1, approverId: 'publisher-001',
    }, LATER)).toThrowError(expect.objectContaining({ code: 'APPROVAL_TEMPLATE_INTEGRITY_INVALID' }));
  });

  it('下一修订不修改旧版本，退役只影响新发起', () => {
    const published = publishApprovalTemplate(draft(), {
      tenantId: 'tenant-001', expectedVersion: 1, approverId: 'publisher-001',
    }, LATER);
    const next = createNextApprovalTemplateRevision(published, {
      id: 'template-002', tenantId: 'tenant-001', name: '差旅报销新版', riskLevel: 'R1',
      definition: definition(), actorId: 'editor-002',
    }, LATER);
    const retired = retireApprovalTemplate(published, {
      tenantId: 'tenant-001', expectedVersion: 2, actorId: 'publisher-001',
    }, LATER);
    expect(next).toMatchObject({ revision: 2, status: 'draft', version: 1 });
    expect(published.status).toBe('published');
    expect(retired.status).toBe('retired');
  });

  it('拒绝跨租户、并发旧版本、未知字段和条件越权', () => {
    expect(() => updateApprovalTemplateDraft(draft(), {
      tenantId: 'tenant-002', expectedVersion: 1, name: '越权', riskLevel: 'R1',
      definition: definition(), actorId: 'editor-002',
    }, LATER)).toThrowError(expect.objectContaining({ code: 'APPROVAL_TENANT_MISMATCH' }));
    expect(() => updateApprovalTemplateDraft(draft(), {
      tenantId: 'tenant-001', expectedVersion: 2, name: '旧版本', riskLevel: 'R1',
      definition: definition(), actorId: 'editor-002',
    }, LATER)).toThrowError(expect.objectContaining({ code: 'APPROVAL_VERSION_CONFLICT' }));

    const baseDefinition = definition();
    const invalid: ApprovalTemplateDefinition = {
      ...baseDefinition,
      nodes: [{
        ...baseDefinition.nodes[0]!,
        condition: { op: 'eq', field: 'secret', value: true },
      }, ...baseDefinition.nodes.slice(1)],
    };
    expect(() => createApprovalTemplateDraft({
      id: 'template-002', tenantId: 'tenant-001', code: 'INVALID', name: '非法模板',
      riskLevel: 'R1', definition: invalid, actorId: 'editor-001',
    }, NOW)).toThrowError(expect.objectContaining({ code: 'APPROVAL_CONDITION_FIELD_DENIED' }));
  });

  it('迁移恢复模板版本时校验生命周期并重算定义摘要', () => {
    const restored = restoreApprovalTemplateFromMigration({
      id: 'template-legacy-001', tenantId: 'tenant-001', code: 'LEGACY_EXPENSE',
      name: '历史费用审批', riskLevel: 'R2', revision: 3, status: 'retired',
      definition: definition(), createdBy: 'actor-editor', updatedBy: 'actor-retirer',
      approvedBy: 'actor-approver', publishedAt: '2020-01-02T00:00:00.000Z',
      retiredAt: '2025-01-01T00:00:00.000Z',
      createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z',
    });
    expect(restored).toMatchObject({
      revision: 3, status: 'retired', version: 1, approvedBy: 'actor-approver',
    });
    expect(restored.definitionHash).toBe(hashApprovalJson(restored.definition));
    expect(() => restoreApprovalTemplateFromMigration({
      ...restored,
      id: 'template-legacy-002',
      status: 'published',
    })).toThrowError(expect.objectContaining({
      code: 'APPROVAL_TEMPLATE_MIGRATION_STATE_INVALID',
    }));
  });
});

describe('审批表单白名单', () => {
  it('接受严格类型并复制冻结，外部数组不能影响快照', () => {
    const attachments = ['file-001'];
    const form = validateAndFreezeApprovalFormData(definition(), {
      amount: 123_45, travel_date: '2026-07-31', category: 'travel',
      department_id: 'department-001', attachments,
    });
    attachments.push('file-002');
    expect(form.attachments).toEqual(['file-001']);
    expect(Object.isFrozen(form.attachments)).toBe(true);
  });

  it('拒绝未知字段、金额浮点、伪日期和非法选项', () => {
    const base = {
      amount: 123_45, travel_date: '2026-07-31', category: 'travel',
      department_id: 'department-001',
    };
    for (const form of [
      { ...base, password: 'secret' },
      { ...base, amount: 12.34 },
      { ...base, travel_date: '2026-02-31' },
      { ...base, category: 'other' },
    ]) {
      expect(() => validateAndFreezeApprovalFormData(definition(), form)).toThrowError(
        ApprovalDomainError,
      );
    }
  });

  it('规范化哈希拒绝循环引用和过深数据', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => hashApprovalJson(cyclic)).toThrowError(
      expect.objectContaining({ code: 'APPROVAL_JSON_CYCLE' }),
    );
    let deep: unknown = null;
    for (let index = 0; index < 102; index += 1) deep = { child: deep };
    expect(() => hashApprovalJson(deep)).toThrowError(
      expect.objectContaining({ code: 'APPROVAL_JSON_TOO_COMPLEX' }),
    );
  });
});
