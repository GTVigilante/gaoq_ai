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
  snapshotApprovalTemplateForMigration,
  updateApprovalTemplateDraft,
  validateAndFreezeApprovalFormData,
  validateAndFreezeApprovalTemplateDefinition,
  type ApprovalFormField,
  type ApprovalProcessNode,
  type ApprovalTemplate,
  type ApprovalTemplateDefinition,
  type RestoreApprovalTemplateFromMigrationInput,
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

function migrationInput(
  overrides: Partial<RestoreApprovalTemplateFromMigrationInput> = {},
): RestoreApprovalTemplateFromMigrationInput {
  return {
    id: 'template-legacy-001',
    tenantId: 'tenant-001',
    code: 'LEGACY_EXPENSE',
    name: '历史费用审批',
    riskLevel: 'R2',
    revision: 3,
    status: 'retired',
    definition: definition(),
    createdBy: 'actor-editor',
    updatedBy: 'actor-retirer',
    approvedBy: 'actor-approver',
    publishedAt: '2020-01-02T00:00:00.000Z',
    retiredAt: '2025-01-01T00:00:00.000Z',
    createdAt: '2020-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function expectCode(operation: () => unknown, code: string): void {
  expect(operation).toThrowError(expect.objectContaining({ code }));
}

function definitionWith(
  fields: readonly ApprovalFormField[],
  nodes: readonly ApprovalProcessNode[] = [{
    id: 'approve',
    name: '审批',
    type: 'approval',
    approvalMode: 'all',
    resolver: { type: 'initiator_manager' },
  }],
): ApprovalTemplateDefinition {
  return { fields, nodes };
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
    const restored = restoreApprovalTemplateFromMigration(migrationInput());
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

  it('拒绝对不满足状态前置条件的模板执行发布、修订、退役或在线快照', () => {
    const published = publishApprovalTemplate(draft(), {
      tenantId: 'tenant-001', expectedVersion: 1, approverId: 'publisher-001',
    }, LATER);
    const retired = retireApprovalTemplate(published, {
      tenantId: 'tenant-001', expectedVersion: 2, actorId: 'retirer-001',
    }, new Date('2026-07-23T00:00:00.000Z'));

    expectCode(() => publishApprovalTemplate(published, {
      tenantId: 'tenant-001', expectedVersion: 2, approverId: 'publisher-002',
    }, LATER), 'APPROVAL_TEMPLATE_NOT_DRAFT');
    expectCode(() => createNextApprovalTemplateRevision(draft(), {
      id: 'template-002', tenantId: 'tenant-001', name: '新版本', riskLevel: 'R1',
      definition: definition(), actorId: 'editor-002',
    }, LATER), 'APPROVAL_TEMPLATE_DRAFT_EXISTS');
    expectCode(() => retireApprovalTemplate(draft(), {
      tenantId: 'tenant-001', expectedVersion: 1, actorId: 'retirer-001',
    }, LATER), 'APPROVAL_TEMPLATE_NOT_PUBLISHED');
    expectCode(() => snapshotApprovalTemplate(draft()), 'APPROVAL_TEMPLATE_NOT_PUBLISHED');
    expectCode(
      () => snapshotApprovalTemplate({ ...published, retiredAt: retired.retiredAt }),
      'APPROVAL_TEMPLATE_NOT_PUBLISHED',
    );
    expectCode(
      () => snapshotApprovalTemplate({ ...published, definitionHash: 'tampered' }),
      'APPROVAL_TEMPLATE_INTEGRITY_INVALID',
    );
  });

  it('迁移恢复拒绝非法状态组合与生命周期时间', () => {
    const invalidCases: ReadonlyArray<{
      readonly overrides: Partial<RestoreApprovalTemplateFromMigrationInput>;
      readonly code: string;
    }> = [
      {
        overrides: { status: 'unknown' as 'retired' },
        code: 'APPROVAL_TEMPLATE_STATUS_INVALID',
      },
      {
        overrides: {
          status: 'draft', approvedBy: null, publishedAt: null, retiredAt: null,
          updatedAt: '2019-12-31T00:00:00.000Z',
        },
        code: 'APPROVAL_TEMPLATE_MIGRATION_TIME_INVALID',
      },
      {
        overrides: { status: 'draft', approvedBy: 'actor-approver' },
        code: 'APPROVAL_TEMPLATE_MIGRATION_STATE_INVALID',
      },
      {
        overrides: { status: 'published', approvedBy: null, retiredAt: null },
        code: 'APPROVAL_TEMPLATE_MIGRATION_STATE_INVALID',
      },
      {
        overrides: {
          status: 'published', retiredAt: null, publishedAt: '2019-12-31T00:00:00.000Z',
        },
        code: 'APPROVAL_TEMPLATE_MIGRATION_TIME_INVALID',
      },
      {
        overrides: {
          status: 'published', retiredAt: null, publishedAt: '2025-01-02T00:00:00.000Z',
        },
        code: 'APPROVAL_TEMPLATE_MIGRATION_TIME_INVALID',
      },
      {
        overrides: { status: 'retired', retiredAt: null },
        code: 'APPROVAL_TEMPLATE_MIGRATION_TIME_INVALID',
      },
      {
        overrides: { status: 'retired', retiredAt: '2020-01-01T00:00:00.000Z' },
        code: 'APPROVAL_TEMPLATE_MIGRATION_TIME_INVALID',
      },
      {
        overrides: { status: 'retired', retiredAt: '2025-01-02T00:00:00.000Z' },
        code: 'APPROVAL_TEMPLATE_MIGRATION_TIME_INVALID',
      },
      {
        overrides: { status: 'published', retiredAt: '2025-01-01T00:00:00.000Z' },
        code: 'APPROVAL_TEMPLATE_MIGRATION_STATE_INVALID',
      },
      {
        overrides: { createdAt: 'invalid-date' },
        code: 'APPROVAL_INVALID_DATE',
      },
    ];
    for (const item of invalidCases) {
      expectCode(
        () => restoreApprovalTemplateFromMigration(migrationInput(item.overrides)),
        item.code,
      );
    }
    expectCode(
      () => restoreApprovalTemplateFromMigration(migrationInput({
        createdAt: 1 as unknown as string,
      })),
      'APPROVAL_INVALID_DATE',
    );
  });

  it('迁移快照只接受与模板状态一致且处于发布窗口内的实例', () => {
    const retired = restoreApprovalTemplateFromMigration(migrationInput());
    expect(snapshotApprovalTemplateForMigration(
      retired,
      '2024-01-01T00:00:00.000Z',
    )).toMatchObject({ templateId: retired.id, revision: 3 });

    const published = restoreApprovalTemplateFromMigration(migrationInput({
      status: 'published',
      retiredAt: null,
      updatedAt: '2025-01-01T00:00:00.000Z',
    }));
    expect(snapshotApprovalTemplateForMigration(
      published,
      '2024-01-01T00:00:00.000Z',
    )).toMatchObject({ templateId: published.id });

    const invalidTemplates: readonly ApprovalTemplate[] = [
      draft(),
      { ...published, approvedBy: null },
      { ...published, publishedAt: null },
      { ...published, retiredAt: '2025-01-01T00:00:00.000Z' },
      { ...retired, retiredAt: null },
    ];
    for (const template of invalidTemplates) {
      expectCode(
        () => snapshotApprovalTemplateForMigration(template, '2024-01-01T00:00:00.000Z'),
        'APPROVAL_MIGRATION_INSTANCE_TEMPLATE_LIFECYCLE_INVALID',
      );
    }
    for (const createdAt of [
      '2019-01-01T00:00:00.000Z',
      '2025-01-02T00:00:00.000Z',
    ]) {
      expectCode(
        () => snapshotApprovalTemplateForMigration(retired, createdAt),
        'APPROVAL_MIGRATION_INSTANCE_TEMPLATE_LIFECYCLE_INVALID',
      );
    }
  });
});

describe('审批模板定义白名单', () => {
  const textField: ApprovalFormField = {
    key: 'reason',
    label: '原因',
    type: 'text',
    required: true,
    sensitivity: 'L1',
    maximumLength: 100,
  };

  it('接受全部解析器类型并规范化标签与条件', () => {
    const normalized = validateAndFreezeApprovalTemplateDefinition(definitionWith(
      [
        textField,
        {
          key: 'department_id', label: ' 部门 ', type: 'department',
          required: true, sensitivity: 'L2',
        },
      ],
      [
        {
          id: 'employees', name: ' 固定审批 ', type: 'approval', approvalMode: 'all',
          resolver: { type: 'employees', employeeIds: ['employee-001'] },
        },
        {
          id: 'roles', name: '角色审批', type: 'approval', approvalMode: 'any',
          resolver: {
            type: 'roles', roleCodes: ['FINANCE_APPROVER'], scope: 'initiator_department',
          },
        },
        {
          id: 'manager', name: '直属经理', type: 'approval', approvalMode: 'all',
          resolver: { type: 'initiator_manager' },
          condition: { op: 'is_empty', field: 'reason' },
        },
        {
          id: 'department', name: '部门经理', type: 'copy',
          resolver: { type: 'department_manager', departmentField: 'department_id' },
        },
      ],
    ));
    expect(normalized.fields[1]?.label).toBe('部门');
    expect(normalized.nodes[0]?.name).toBe('固定审批');
    expect(Object.isFrozen(normalized.nodes)).toBe(true);
  });

  it('拒绝非纯对象、字段和节点数量越界以及没有审批节点', () => {
    const validNode: ApprovalProcessNode = {
      id: 'approve', name: '审批', type: 'approval', approvalMode: 'all',
      resolver: { type: 'initiator_manager' },
    };
    const invalidDefinitions: readonly unknown[] = [
      [],
      { fields: 'invalid', nodes: [validNode] },
      { fields: [], nodes: [validNode] },
      { fields: Array.from({ length: 101 }, () => textField), nodes: [validNode] },
      { fields: [textField], nodes: 'invalid' },
      { fields: [textField], nodes: [] },
      { fields: [textField], nodes: Array.from({ length: 51 }, () => validNode) },
      {
        fields: [textField],
        nodes: [{
          id: 'copy', name: '抄送', type: 'copy',
          resolver: { type: 'initiator_manager' },
        }],
      },
    ];
    for (const invalid of invalidDefinitions) {
      expect(() => validateAndFreezeApprovalTemplateDefinition(
        invalid as ApprovalTemplateDefinition,
      )).toThrowError(ApprovalDomainError);
    }
  });

  it('拒绝非法字段定义、选项和最大长度', () => {
    const selection: ApprovalFormField = {
      key: 'category',
      label: '类型',
      type: 'single_select',
      required: true,
      sensitivity: 'L1',
      options: [{ key: 'travel', label: '差旅' }],
    };
    const invalidFields: readonly unknown[] = [
      [],
      { ...textField, key: 'Invalid-Key' },
      { ...textField, label: '' },
      { ...textField, type: 'script' },
      { ...textField, required: 'true' },
      { ...textField, sensitivity: 'L5' },
      { ...selection, options: undefined },
      { ...selection, options: [] },
      { ...selection, options: Array.from({ length: 201 }, () => ({ key: 'item', label: '项' })) },
      { ...textField, options: [{ key: 'unexpected', label: '非法' }] },
      { ...selection, options: [[]] },
      { ...selection, options: [{ key: 'invalid key', label: '非法' }] },
      { ...selection, options: [{ key: 'valid', label: '' }] },
      {
        ...selection,
        options: [{ key: 'duplicate', label: '甲' }, { key: 'duplicate', label: '乙' }],
      },
      { ...textField, maximumLength: 0 },
      { ...textField, maximumLength: 10_001 },
      { ...textField, maximumLength: 1.5 },
      { ...selection, maximumLength: 10 },
    ];
    for (const field of invalidFields) {
      expect(() => validateAndFreezeApprovalTemplateDefinition(
        definitionWith([field as ApprovalFormField]),
      )).toThrowError(ApprovalDomainError);
    }
    expectCode(
      () => validateAndFreezeApprovalTemplateDefinition(definitionWith([textField, textField])),
      'APPROVAL_DUPLICATE_VALUE',
    );
  });

  it('拒绝非法节点、审批模式和重复节点', () => {
    const invalidNodes: readonly unknown[] = [
      [],
      {
        id: 'Invalid Id', name: '审批', type: 'approval', approvalMode: 'all',
        resolver: { type: 'initiator_manager' },
      },
      {
        id: 'approve', name: '', type: 'approval', approvalMode: 'all',
        resolver: { type: 'initiator_manager' },
      },
      {
        id: 'approve', name: '审批', type: 'script', approvalMode: 'all',
        resolver: { type: 'initiator_manager' },
      },
      {
        id: 'approve', name: '审批', type: 'approval',
        resolver: { type: 'initiator_manager' },
      },
      {
        id: 'copy', name: '抄送', type: 'copy', approvalMode: 'all',
        resolver: { type: 'initiator_manager' },
      },
    ];
    for (const node of invalidNodes) {
      expect(() => validateAndFreezeApprovalTemplateDefinition(
        definitionWith([textField], [node as ApprovalProcessNode]),
      )).toThrowError(ApprovalDomainError);
    }
    const duplicate: ApprovalProcessNode = {
      id: 'duplicate', name: '审批', type: 'approval', approvalMode: 'all',
      resolver: { type: 'initiator_manager' },
    };
    expectCode(
      () => validateAndFreezeApprovalTemplateDefinition(
        definitionWith([textField], [duplicate, duplicate]),
      ),
      'APPROVAL_DUPLICATE_VALUE',
    );
  });

  it('拒绝非法审批人解析器及越权部门字段', () => {
    const invalidResolvers: readonly unknown[] = [
      [],
      { type: 'employees', employeeIds: [] },
      { type: 'employees', employeeIds: Array.from({ length: 101 }, () => 'employee-001') },
      { type: 'employees', employeeIds: ['invalid id'] },
      { type: 'employees', employeeIds: ['employee-001', 'employee-001'] },
      { type: 'roles', roleCodes: [], scope: 'tenant' },
      {
        type: 'roles',
        roleCodes: Array.from({ length: 51 }, () => 'FINANCE_APPROVER'),
        scope: 'tenant',
      },
      { type: 'roles', roleCodes: ['FINANCE APPROVER'], scope: 'tenant' },
      { type: 'roles', roleCodes: ['FINANCE_APPROVER'], scope: 'global' },
      {
        type: 'roles',
        roleCodes: ['FINANCE_APPROVER', 'FINANCE_APPROVER'],
        scope: 'tenant',
      },
      { type: 'department_manager', departmentField: 'unknown_department' },
      { type: 'department_manager', departmentField: 'reason' },
      { type: 'script' },
    ];
    for (const resolver of invalidResolvers) {
      expect(() => validateAndFreezeApprovalTemplateDefinition(definitionWith(
        [textField],
        [{
          id: 'approve', name: '审批', type: 'approval', approvalMode: 'all',
          resolver: resolver as ApprovalProcessNode['resolver'],
        }],
      ))).toThrowError(ApprovalDomainError);
    }
    expectCode(
      () => validateAndFreezeApprovalTemplateDefinition(definitionWith(
        [textField],
        [{
          id: 'approve',
          name: '审批',
          type: 'approval',
          approvalMode: 'all',
          resolver: { type: 'department_manager', departmentField: 'reason' },
        }],
      )),
      'APPROVAL_RESOLVER_FIELD_TYPE_INVALID',
    );
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

  it('接受全部字段类型并保留可选空值', () => {
    const allTypes = definitionWith([
      {
        key: 'text_value', label: '文本', type: 'text', required: true,
        sensitivity: 'L1', maximumLength: 10,
      },
      { key: 'number_value', label: '数字', type: 'number', required: true, sensitivity: 'L1' },
      { key: 'money_value', label: '金额', type: 'money_minor', required: true, sensitivity: 'L2' },
      { key: 'flag', label: '布尔', type: 'boolean', required: true, sensitivity: 'L1' },
      { key: 'date_value', label: '日期', type: 'date', required: true, sensitivity: 'L1' },
      {
        key: 'single_value', label: '单选', type: 'single_select', required: true,
        sensitivity: 'L1', options: [{ key: 'one', label: '一' }],
      },
      {
        key: 'multi_value', label: '多选', type: 'multi_select', required: true,
        sensitivity: 'L1', options: [{ key: 'one', label: '一' }, { key: 'two', label: '二' }],
      },
      { key: 'employee_id', label: '员工', type: 'employee', required: true, sensitivity: 'L2' },
      {
        key: 'department_id', label: '部门', type: 'department',
        required: true, sensitivity: 'L2',
      },
      {
        key: 'file_ids', label: '文件', type: 'file_reference',
        required: true, sensitivity: 'L3',
      },
      {
        key: 'optional_text', label: '可选文本', type: 'text',
        required: false, sensitivity: 'L1',
      },
      {
        key: 'optional_files', label: '可选文件', type: 'file_reference',
        required: false, sensitivity: 'L3',
      },
    ]);
    const normalized = validateAndFreezeApprovalFormData(allTypes, {
      text_value: '出差',
      number_value: 1.5,
      money_value: 123_45,
      flag: false,
      date_value: '2026-07-31',
      single_value: 'one',
      multi_value: ['one', 'two'],
      employee_id: 'employee-001',
      department_id: 'department-001',
      file_ids: ['file-001', 'file-002'],
      optional_text: '',
      optional_files: [],
    });
    expect(normalized).toMatchObject({
      flag: false,
      optional_text: '',
      optional_files: [],
    });
    expect(Object.getPrototypeOf(normalized)).toBeNull();
  });

  it('拒绝非纯对象、必填空值及各字段类型漂移', () => {
    const fields: readonly ApprovalFormField[] = [
      {
        key: 'text_value', label: '文本', type: 'text', required: true,
        sensitivity: 'L1', maximumLength: 3,
      },
      { key: 'number_value', label: '数字', type: 'number', required: true, sensitivity: 'L1' },
      { key: 'money_value', label: '金额', type: 'money_minor', required: true, sensitivity: 'L2' },
      { key: 'flag', label: '布尔', type: 'boolean', required: true, sensitivity: 'L1' },
      { key: 'date_value', label: '日期', type: 'date', required: true, sensitivity: 'L1' },
      {
        key: 'single_value', label: '单选', type: 'single_select', required: true,
        sensitivity: 'L1', options: [{ key: 'one', label: '一' }],
      },
      {
        key: 'multi_value', label: '多选', type: 'multi_select', required: true,
        sensitivity: 'L1', options: [{ key: 'one', label: '一' }, { key: 'two', label: '二' }],
      },
      { key: 'employee_id', label: '员工', type: 'employee', required: true, sensitivity: 'L2' },
      {
        key: 'department_id', label: '部门', type: 'department',
        required: true, sensitivity: 'L2',
      },
      {
        key: 'file_ids', label: '文件', type: 'file_reference',
        required: true, sensitivity: 'L3',
      },
    ];
    const valid = {
      text_value: 'abc',
      number_value: 1,
      money_value: 100,
      flag: true,
      date_value: '2026-07-31',
      single_value: 'one',
      multi_value: ['one'],
      employee_id: 'employee-001',
      department_id: 'department-001',
      file_ids: ['file-001'],
    };
    const invalidValues: ReadonlyArray<readonly [keyof typeof valid, unknown]> = [
      ['text_value', 1],
      ['text_value', 'toolong'],
      ['number_value', '1'],
      ['number_value', Number.POSITIVE_INFINITY],
      ['money_value', 1.5],
      ['flag', 'true'],
      ['date_value', 20260731],
      ['date_value', '2026-02-31'],
      ['single_value', 1],
      ['single_value', 'unknown'],
      ['multi_value', 'one'],
      ['multi_value', Array.from({ length: 201 }, () => 'one')],
      ['multi_value', ['unknown']],
      ['multi_value', ['one', 'one']],
      ['employee_id', 1],
      ['employee_id', 'invalid id'],
      ['department_id', 1],
      ['department_id', 'invalid id'],
      ['file_ids', 'file-001'],
      ['file_ids', Array.from({ length: 21 }, (_, index) => `file-${index}`)],
      ['file_ids', [1]],
      ['file_ids', ['file-001', 'file-001']],
      ['file_ids', ['invalid id']],
    ];
    for (const [field, value] of invalidValues) {
      expect(() => validateAndFreezeApprovalFormData(
        definitionWith(fields),
        { ...valid, [field]: value },
      )).toThrowError(ApprovalDomainError);
    }

    for (const empty of [undefined, null, '', []]) {
      const form = { ...valid, text_value: empty };
      expectCode(
        () => validateAndFreezeApprovalFormData(
          definitionWith(fields),
          form as unknown as typeof valid,
        ),
        'APPROVAL_FORM_REQUIRED',
      );
    }
    expectCode(
      () => validateAndFreezeApprovalFormData(
        definitionWith(fields),
        [] as unknown as typeof valid,
      ),
      'APPROVAL_FORM_INVALID',
    );
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

  it('规范化哈希支持数组与空原型对象，并拒绝非有限数和非纯 JSON 对象', () => {
    const nullPrototype = Object.create(null) as Record<string, unknown>;
    nullPrototype.values = [null, true, 'text', 1];
    expect(hashApprovalJson(nullPrototype)).toBe(hashApprovalJson({
      values: [null, true, 'text', 1],
    }));

    for (const invalid of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      new Date('2026-07-31T00:00:00.000Z'),
    ]) {
      expect(() => hashApprovalJson(invalid)).toThrowError(ApprovalDomainError);
    }

    const accessor = {};
    Object.defineProperty(accessor, 'secret', {
      enumerable: true,
      get: () => 'secret',
    });
    expectCode(() => hashApprovalJson(accessor), 'APPROVAL_JSON_INVALID');

    const hidden = {};
    Object.defineProperty(hidden, 'secret', {
      enumerable: false,
      value: 'secret',
    });
    expectCode(() => hashApprovalJson(hidden), 'APPROVAL_JSON_INVALID');
  });
});
