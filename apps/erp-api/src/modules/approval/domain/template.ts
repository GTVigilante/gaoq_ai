import { createHash } from 'node:crypto';

import type {
  ApprovalCondition,
  ApprovalFormData,
  ApprovalFormValue,
  ApprovalScalar,
} from './condition.js';
import { validateApprovalCondition } from './condition.js';
import { ApprovalDomainError } from './approval.errors.js';
import {
  assertApprovalCode,
  assertApprovalId,
  assertFieldKey,
  assertLabel,
  assertPositiveVersion,
  assertSameTenant,
  assertUnique,
  toApprovalIso,
} from './approval.validation.js';

export type ApprovalTemplateStatus = 'draft' | 'published' | 'retired';
export type ApprovalFieldSensitivity = 'L1' | 'L2' | 'L3' | 'L4';
export type ApprovalFormFieldType =
  | 'text'
  | 'number'
  | 'money_minor'
  | 'boolean'
  | 'date'
  | 'single_select'
  | 'multi_select'
  | 'employee'
  | 'department'
  | 'file_reference';

export interface ApprovalFieldOption {
  readonly key: string;
  readonly label: string;
}

export interface ApprovalFormField {
  readonly key: string;
  readonly label: string;
  readonly type: ApprovalFormFieldType;
  readonly required: boolean;
  readonly sensitivity: ApprovalFieldSensitivity;
  readonly options?: readonly ApprovalFieldOption[];
  readonly maximumLength?: number;
}

export type ApprovalActorResolver =
  | { readonly type: 'employees'; readonly employeeIds: readonly string[] }
  | { readonly type: 'roles'; readonly roleCodes: readonly string[]; readonly scope: 'tenant' | 'initiator_department' }
  | { readonly type: 'initiator_manager' }
  | { readonly type: 'department_manager'; readonly departmentField: string };

export interface ApprovalProcessNode {
  readonly id: string;
  readonly name: string;
  readonly type: 'approval' | 'copy';
  readonly approvalMode?: 'all' | 'any';
  readonly resolver: ApprovalActorResolver;
  readonly condition?: ApprovalCondition;
}

export interface ApprovalTemplateDefinition {
  readonly fields: readonly ApprovalFormField[];
  readonly nodes: readonly ApprovalProcessNode[];
}

export interface ApprovalTemplate {
  readonly id: string;
  readonly tenantId: string;
  readonly code: string;
  readonly name: string;
  readonly riskLevel: 'R1' | 'R2';
  readonly revision: number;
  readonly status: ApprovalTemplateStatus;
  readonly definition: ApprovalTemplateDefinition;
  readonly definitionHash: string;
  readonly approvedBy: string | null;
  readonly publishedAt: string | null;
  readonly retiredAt: string | null;
  readonly version: number;
  readonly createdBy: string;
  readonly updatedBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ApprovalTemplateSnapshot {
  readonly templateId: string;
  readonly templateCode: string;
  readonly templateName: string;
  readonly riskLevel: 'R1' | 'R2';
  readonly revision: number;
  readonly definition: ApprovalTemplateDefinition;
  readonly definitionHash: string;
  readonly approvedBy: string;
  readonly publishedAt: string;
}

export interface CreateApprovalTemplateInput {
  readonly id: string;
  readonly tenantId: string;
  readonly code: string;
  readonly name: string;
  readonly riskLevel: 'R1' | 'R2';
  readonly definition: ApprovalTemplateDefinition;
  readonly actorId: string;
}

export interface RestoreApprovalTemplateFromMigrationInput {
  readonly id: string;
  readonly tenantId: string;
  readonly code: string;
  readonly name: string;
  readonly riskLevel: 'R1' | 'R2';
  readonly revision: number;
  readonly status: ApprovalTemplateStatus;
  readonly definition: ApprovalTemplateDefinition;
  readonly createdBy: string;
  readonly updatedBy: string;
  readonly approvedBy: string | null;
  readonly publishedAt: string | null;
  readonly retiredAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const MAX_FIELDS = 100;
const MAX_NODES = 50;
const MAX_OPTIONS = 200;
const MAX_STATIC_APPROVERS = 100;
const MAX_ROLE_CODES = 50;
const MAX_TEXT_LENGTH = 10_000;
const MAX_CANONICAL_DEPTH = 100;
const MAX_CANONICAL_NODES = 20_000;

/** 创建审批模板草稿；模板定义即时执行完整白名单校验。 */
export function createApprovalTemplateDraft(
  input: CreateApprovalTemplateInput,
  now: Date,
): ApprovalTemplate {
  validateTemplateIdentity(input);
  const definition = normalizeAndValidateDefinition(input.definition);
  const occurredAt = toApprovalIso(now);
  return Object.freeze({
    id: input.id,
    tenantId: input.tenantId,
    code: input.code,
    name: input.name.trim(),
    riskLevel: input.riskLevel,
    revision: 1,
    status: 'draft',
    definition,
    definitionHash: hashDefinition(definition),
    approvedBy: null,
    publishedAt: null,
    retiredAt: null,
    version: 1,
    createdBy: input.actorId,
    updatedBy: input.actorId,
    createdAt: occurredAt,
    updatedAt: occurredAt,
  });
}

/** 数据迁移专用：恢复模板版本事实，不重放发布或退役业务动作。 */
export function restoreApprovalTemplateFromMigration(
  input: RestoreApprovalTemplateFromMigrationInput,
): ApprovalTemplate {
  validateTemplateIdentity({
    id: input.id,
    tenantId: input.tenantId,
    code: input.code,
    name: input.name,
    riskLevel: input.riskLevel,
    definition: input.definition,
    actorId: input.createdBy,
  });
  assertApprovalId(input.updatedBy, 'updatedBy');
  assertPositiveVersion(input.revision, 'revision');
  if (!['draft', 'published', 'retired'].includes(input.status)) {
    throw new ApprovalDomainError('APPROVAL_TEMPLATE_STATUS_INVALID', '模板迁移状态无效');
  }
  const definition = normalizeAndValidateDefinition(input.definition);
  const createdAt = migrationIso(input.createdAt, 'createdAt');
  const updatedAt = migrationIso(input.updatedAt, 'updatedAt');
  if (updatedAt < createdAt) throw new ApprovalDomainError(
    'APPROVAL_TEMPLATE_MIGRATION_TIME_INVALID', '模板更新时间早于创建时间',
  );
  const publishedAt = input.publishedAt === null
    ? null
    : migrationIso(input.publishedAt, 'publishedAt');
  const retiredAt = input.retiredAt === null
    ? null
    : migrationIso(input.retiredAt, 'retiredAt');
  if (input.status === 'draft') {
    if (input.approvedBy !== null || publishedAt !== null || retiredAt !== null) {
      throw new ApprovalDomainError(
        'APPROVAL_TEMPLATE_MIGRATION_STATE_INVALID', '草稿模板不能包含发布或退役事实',
      );
    }
  } else {
    if (input.approvedBy === null || publishedAt === null) throw new ApprovalDomainError(
      'APPROVAL_TEMPLATE_MIGRATION_STATE_INVALID', '已发布模板缺少审批人与发布时间',
    );
    assertApprovalId(input.approvedBy, 'approvedBy');
    if (publishedAt < createdAt || publishedAt > updatedAt) throw new ApprovalDomainError(
      'APPROVAL_TEMPLATE_MIGRATION_TIME_INVALID', '模板发布时间不在版本生命周期内',
    );
    if (input.status === 'retired') {
      if (retiredAt === null || retiredAt < publishedAt || retiredAt > updatedAt) {
        throw new ApprovalDomainError(
          'APPROVAL_TEMPLATE_MIGRATION_TIME_INVALID', '模板退役时间不在版本生命周期内',
        );
      }
    } else if (retiredAt !== null) throw new ApprovalDomainError(
      'APPROVAL_TEMPLATE_MIGRATION_STATE_INVALID', '已发布模板不能包含退役时间',
    );
  }
  return deepFreeze({
    id: input.id,
    tenantId: input.tenantId,
    code: input.code,
    name: input.name.trim(),
    riskLevel: input.riskLevel,
    revision: input.revision,
    status: input.status,
    definition,
    definitionHash: hashDefinition(definition),
    approvedBy: input.approvedBy,
    publishedAt,
    retiredAt,
    version: 1,
    createdBy: input.createdBy,
    updatedBy: input.updatedBy,
    createdAt,
    updatedAt,
  });
}

/** 更新未发布草稿；已发布或退役版本永久不可改。 */
export function updateApprovalTemplateDraft(
  template: ApprovalTemplate,
  input: {
    readonly tenantId: string;
    readonly expectedVersion: number;
    readonly name: string;
    readonly riskLevel: 'R1' | 'R2';
    readonly definition: ApprovalTemplateDefinition;
    readonly actorId: string;
  },
  now: Date,
): ApprovalTemplate {
  assertSameTenant(template.tenantId, input.tenantId);
  assertExpectedVersion(template.version, input.expectedVersion);
  if (template.status !== 'draft') {
    throw new ApprovalDomainError('APPROVAL_TEMPLATE_IMMUTABLE', '已发布或退役模板不可修改');
  }
  assertLabel(input.name, 'name');
  assertApprovalId(input.actorId, 'actorId');
  assertRiskLevel(input.riskLevel);
  const definition = normalizeAndValidateDefinition(input.definition);
  return Object.freeze({
    ...template,
    name: input.name.trim(),
    riskLevel: input.riskLevel,
    definition,
    definitionHash: hashDefinition(definition),
    version: template.version + 1,
    updatedBy: input.actorId,
    updatedAt: toApprovalIso(now),
  });
}

/** 独立审批人发布模板；发布后定义冻结并可供实例快照。 */
export function publishApprovalTemplate(
  template: ApprovalTemplate,
  input: { readonly tenantId: string; readonly expectedVersion: number; readonly approverId: string },
  now: Date,
): ApprovalTemplate {
  assertSameTenant(template.tenantId, input.tenantId);
  assertExpectedVersion(template.version, input.expectedVersion);
  assertApprovalId(input.approverId, 'approverId');
  if (template.status !== 'draft') {
    throw new ApprovalDomainError('APPROVAL_TEMPLATE_NOT_DRAFT', '只有草稿模板可以发布');
  }
  if (input.approverId === template.updatedBy) {
    throw new ApprovalDomainError('APPROVAL_TEMPLATE_SOD_REQUIRED', '模板发布人与最后编辑人必须分离');
  }
  assertTemplateDefinitionIntegrity(template);
  const occurredAt = toApprovalIso(now);
  return Object.freeze({
    ...template,
    status: 'published',
    approvedBy: input.approverId,
    publishedAt: occurredAt,
    version: template.version + 1,
    updatedBy: input.approverId,
    updatedAt: occurredAt,
  });
}

/** 从已发布/退役版本创建下一修订草稿，旧版本保持不可变。 */
export function createNextApprovalTemplateRevision(
  template: ApprovalTemplate,
  input: {
    readonly id: string;
    readonly tenantId: string;
    readonly name: string;
    readonly riskLevel: 'R1' | 'R2';
    readonly definition: ApprovalTemplateDefinition;
    readonly actorId: string;
  },
  now: Date,
): ApprovalTemplate {
  assertSameTenant(template.tenantId, input.tenantId);
  if (template.status === 'draft') {
    throw new ApprovalDomainError('APPROVAL_TEMPLATE_DRAFT_EXISTS', '当前版本仍是草稿');
  }
  const created = createApprovalTemplateDraft({
    ...input,
    code: template.code,
  }, now);
  return Object.freeze({ ...created, revision: template.revision + 1 });
}

/** 退役已发布模板；只影响新发起，历史实例快照不变。 */
export function retireApprovalTemplate(
  template: ApprovalTemplate,
  input: { readonly tenantId: string; readonly expectedVersion: number; readonly actorId: string },
  now: Date,
): ApprovalTemplate {
  assertSameTenant(template.tenantId, input.tenantId);
  assertExpectedVersion(template.version, input.expectedVersion);
  assertApprovalId(input.actorId, 'actorId');
  if (template.status !== 'published') {
    throw new ApprovalDomainError('APPROVAL_TEMPLATE_NOT_PUBLISHED', '只有已发布模板可以退役');
  }
  const occurredAt = toApprovalIso(now);
  return Object.freeze({
    ...template,
    status: 'retired',
    retiredAt: occurredAt,
    version: template.version + 1,
    updatedBy: input.actorId,
    updatedAt: occurredAt,
  });
}

/** 生成实例使用的完整不可变模板快照。 */
export function snapshotApprovalTemplate(template: ApprovalTemplate): ApprovalTemplateSnapshot {
  if (
    template.status !== 'published' || template.approvedBy === null || template.publishedAt === null
  ) throw new ApprovalDomainError('APPROVAL_TEMPLATE_NOT_PUBLISHED', '模板尚未发布');
  assertTemplateDefinitionIntegrity(template);
  return deepFreeze(structuredClone({
    templateId: template.id,
    templateCode: template.code,
    templateName: template.name,
    riskLevel: template.riskLevel,
    revision: template.revision,
    definition: template.definition,
    definitionHash: template.definitionHash,
    approvedBy: template.approvedBy,
    publishedAt: template.publishedAt,
  }));
}

/**
 * 数据迁移专用：按实例创建时点截取曾发布的模板版本。
 * 允许当前已退役模板，但实例创建时间必须落在其发布生命周期内。
 */
export function snapshotApprovalTemplateForMigration(
  template: ApprovalTemplate,
  instanceCreatedAt: string,
): ApprovalTemplateSnapshot {
  const createdAt = migrationIso(instanceCreatedAt, 'instanceCreatedAt');
  if (
    !['published', 'retired'].includes(template.status) ||
    template.approvedBy === null || template.publishedAt === null ||
    createdAt < template.publishedAt ||
    (template.retiredAt !== null && createdAt > template.retiredAt)
  ) throw new ApprovalDomainError(
    'APPROVAL_MIGRATION_INSTANCE_TEMPLATE_LIFECYCLE_INVALID',
    '迁移审批实例的创建时间不在模板发布生命周期内',
  );
  assertTemplateDefinitionIntegrity(template);
  return deepFreeze(structuredClone({
    templateId: template.id,
    templateCode: template.code,
    templateName: template.name,
    riskLevel: template.riskLevel,
    revision: template.revision,
    definition: template.definition,
    definitionHash: template.definitionHash,
    approvedBy: template.approvedBy,
    publishedAt: template.publishedAt,
  }));
}

/** 按模板字段白名单校验并冻结表单数据，拒绝未知字段和类型漂移。 */
export function validateAndFreezeApprovalFormData(
  definition: ApprovalTemplateDefinition,
  formData: ApprovalFormData,
): ApprovalFormData {
  if (!isPlainObject(formData)) {
    throw new ApprovalDomainError('APPROVAL_FORM_INVALID', '表单数据必须为纯对象');
  }
  const fields = new Map(definition.fields.map((field) => [field.key, field]));
  for (const key of Object.keys(formData)) {
    if (!fields.has(key)) {
      throw new ApprovalDomainError('APPROVAL_FORM_UNKNOWN_FIELD', `表单包含未知字段 ${key}`);
    }
  }
  const normalized: Record<string, ApprovalFormValue> = Object.create(null) as Record<string, ApprovalFormValue>;
  for (const field of definition.fields) {
    const value = Object.hasOwn(formData, field.key) ? formData[field.key] : undefined;
    if (value === undefined || value === null || value === '' ||
      (isScalarArray(value) && value.length === 0)) {
      if (field.required) {
        throw new ApprovalDomainError('APPROVAL_FORM_REQUIRED', `字段 ${field.key} 必填`);
      }
      if (value !== undefined) normalized[field.key] = cloneFormValue(value);
      continue;
    }
    assertValueMatchesField(field, value);
    normalized[field.key] = cloneFormValue(value);
  }
  return deepFreeze(normalized);
}

export function hashApprovalJson(value: unknown): string {
  return createHash('sha256').update(canonicalize(value, 0, {
    nodeCount: 0,
    ancestors: new WeakSet<object>(),
  })).digest('base64url');
}

function validateTemplateIdentity(input: CreateApprovalTemplateInput): void {
  assertApprovalId(input.id, 'id');
  assertApprovalId(input.tenantId, 'tenantId');
  assertApprovalCode(input.code, 'code');
  assertLabel(input.name, 'name');
  assertRiskLevel(input.riskLevel);
  assertApprovalId(input.actorId, 'actorId');
}

function assertRiskLevel(value: unknown): asserts value is 'R1' | 'R2' {
  if (value !== 'R1' && value !== 'R2') {
    throw new ApprovalDomainError('APPROVAL_TEMPLATE_RISK_INVALID', '模板风险等级只允许 R1/R2');
  }
}

function migrationIso(value: string, field: string): string {
  if (typeof value !== 'string') {
    throw new ApprovalDomainError('APPROVAL_INVALID_DATE', `${field} 时间无效`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new ApprovalDomainError('APPROVAL_INVALID_DATE', `${field} 时间无效`);
  }
  return parsed.toISOString();
}

function normalizeAndValidateDefinition(
  definition: ApprovalTemplateDefinition,
): ApprovalTemplateDefinition {
  if (!isPlainObject(definition)) {
    throw new ApprovalDomainError('APPROVAL_TEMPLATE_INVALID', '模板定义必须为纯对象');
  }
  if (
    !isArray(definition.fields) || definition.fields.length < 1 ||
    definition.fields.length > MAX_FIELDS
  ) throw new ApprovalDomainError('APPROVAL_TEMPLATE_FIELDS_INVALID', '表单字段数量必须为 1..100');
  if (
    !isArray(definition.nodes) || definition.nodes.length < 1 ||
    definition.nodes.length > MAX_NODES
  ) throw new ApprovalDomainError('APPROVAL_TEMPLATE_NODES_INVALID', '流程节点数量必须为 1..50');
  const fields = definition.fields.map((field) => normalizeField(field));
  assertUnique(fields.map((field) => field.key), 'fields.key');
  const allowedFields = new Set(fields.map((field) => field.key));
  const nodes = definition.nodes.map((node) => normalizeNode(node, allowedFields));
  assertUnique(nodes.map((node) => node.id), 'nodes.id');
  if (!nodes.some((node) => node.type === 'approval')) {
    throw new ApprovalDomainError('APPROVAL_TEMPLATE_NO_APPROVAL_NODE', '流程至少需要一个审批节点');
  }
  return deepFreeze({ fields, nodes });
}

/** 持久化/迁移边界复核模板定义；返回重新规范化并深冻结的定义。 */
export function validateAndFreezeApprovalTemplateDefinition(
  definition: ApprovalTemplateDefinition,
): ApprovalTemplateDefinition {
  return normalizeAndValidateDefinition(definition);
}

function normalizeField(field: ApprovalFormField): ApprovalFormField {
  if (!isPlainObject(field)) throw new ApprovalDomainError('APPROVAL_FIELD_INVALID', '字段定义必须为纯对象');
  assertFieldKey(field.key, 'field.key');
  assertLabel(field.label, 'field.label');
  if (![
    'text', 'number', 'money_minor', 'boolean', 'date', 'single_select', 'multi_select',
    'employee', 'department', 'file_reference',
  ].includes(field.type)) throw new ApprovalDomainError('APPROVAL_FIELD_TYPE_INVALID', '字段类型不受支持');
  if (typeof field.required !== 'boolean' || !['L1', 'L2', 'L3', 'L4'].includes(field.sensitivity)) {
    throw new ApprovalDomainError('APPROVAL_FIELD_INVALID', '字段 required/sensitivity 无效');
  }
  const selection = field.type === 'single_select' || field.type === 'multi_select';
  if (selection) {
    if (
      field.options === undefined || !isArray(field.options) ||
      field.options.length < 1 || field.options.length > MAX_OPTIONS
    ) {
      throw new ApprovalDomainError('APPROVAL_FIELD_OPTIONS_INVALID', '选择字段选项数量必须为 1..200');
    }
  } else if (field.options !== undefined) {
    throw new ApprovalDomainError('APPROVAL_FIELD_OPTIONS_INVALID', '非选择字段不能声明 options');
  }
  const options = field.options?.map((option) => {
    if (!isPlainObject(option)) {
      throw new ApprovalDomainError('APPROVAL_FIELD_OPTIONS_INVALID', '字段选项必须为纯对象');
    }
    assertApprovalCode(option.key, 'option.key');
    assertLabel(option.label, 'option.label');
    return Object.freeze({ key: option.key, label: option.label.trim() });
  });
  if (options !== undefined) assertUnique(options.map((option) => option.key), 'options.key');
  if (
    field.maximumLength !== undefined &&
    (!Number.isInteger(field.maximumLength) || field.maximumLength < 1 ||
      field.maximumLength > MAX_TEXT_LENGTH || field.type !== 'text')
  ) throw new ApprovalDomainError('APPROVAL_FIELD_LENGTH_INVALID', 'maximumLength 仅适用于 text 且范围为 1..10000');
  return Object.freeze({
    key: field.key,
    label: field.label.trim(),
    type: field.type,
    required: field.required,
    sensitivity: field.sensitivity,
    ...(options === undefined ? {} : { options }),
    ...(field.maximumLength === undefined ? {} : { maximumLength: field.maximumLength }),
  });
}

function normalizeNode(
  node: ApprovalProcessNode,
  allowedFields: ReadonlySet<string>,
): ApprovalProcessNode {
  if (!isPlainObject(node)) throw new ApprovalDomainError('APPROVAL_NODE_INVALID', '节点定义必须为纯对象');
  assertApprovalCode(node.id, 'node.id');
  assertLabel(node.name, 'node.name');
  if (node.type !== 'approval' && node.type !== 'copy') {
    throw new ApprovalDomainError('APPROVAL_NODE_TYPE_INVALID', '节点类型只允许 approval/copy');
  }
  if (node.type === 'approval' && node.approvalMode !== 'all' && node.approvalMode !== 'any') {
    throw new ApprovalDomainError('APPROVAL_NODE_MODE_INVALID', '审批节点必须声明 all/any');
  }
  if (node.type === 'copy' && node.approvalMode !== undefined) {
    throw new ApprovalDomainError('APPROVAL_NODE_MODE_INVALID', '抄送节点不能声明审批模式');
  }
  const resolver = normalizeResolver(node.resolver, allowedFields);
  if (node.condition !== undefined) validateApprovalCondition(node.condition, allowedFields);
  return deepFreeze({
    id: node.id,
    name: node.name.trim(),
    type: node.type,
    ...(node.approvalMode === undefined ? {} : { approvalMode: node.approvalMode }),
    resolver,
    ...(node.condition === undefined ? {} : { condition: structuredClone(node.condition) }),
  });
}

function normalizeResolver(
  resolver: ApprovalActorResolver,
  allowedFields: ReadonlySet<string>,
): ApprovalActorResolver {
  if (!isPlainObject(resolver)) {
    throw new ApprovalDomainError('APPROVAL_RESOLVER_INVALID', '审批人解析器必须为纯对象');
  }
  switch (resolver.type) {
    case 'employees':
      if (
        !isArray(resolver.employeeIds) || resolver.employeeIds.length < 1 ||
        resolver.employeeIds.length > MAX_STATIC_APPROVERS
      ) throw new ApprovalDomainError('APPROVAL_RESOLVER_INVALID', '固定审批人数量必须为 1..100');
      for (const id of resolver.employeeIds) assertApprovalId(id, 'resolver.employeeId');
      assertUnique(resolver.employeeIds, 'resolver.employeeIds');
      return deepFreeze({ type: 'employees', employeeIds: [...resolver.employeeIds] });
    case 'roles':
      if (
        !isArray(resolver.roleCodes) || resolver.roleCodes.length < 1 ||
        resolver.roleCodes.length > MAX_ROLE_CODES ||
        !['tenant', 'initiator_department'].includes(resolver.scope)
      ) throw new ApprovalDomainError('APPROVAL_RESOLVER_INVALID', '角色审批人解析器无效');
      for (const code of resolver.roleCodes) assertApprovalCode(code, 'resolver.roleCode');
      assertUnique(resolver.roleCodes, 'resolver.roleCodes');
      return deepFreeze({ type: 'roles', roleCodes: [...resolver.roleCodes], scope: resolver.scope });
    case 'initiator_manager':
      return Object.freeze({ type: 'initiator_manager' });
    case 'department_manager':
      assertFieldKey(resolver.departmentField, 'resolver.departmentField');
      if (!allowedFields.has(resolver.departmentField)) {
        throw new ApprovalDomainError('APPROVAL_RESOLVER_FIELD_DENIED', '部门负责人解析器引用了未声明字段');
      }
      return Object.freeze({ type: 'department_manager', departmentField: resolver.departmentField });
    default:
      throw new ApprovalDomainError('APPROVAL_RESOLVER_INVALID', '审批人解析器类型不受支持');
  }
}

function assertValueMatchesField(field: ApprovalFormField, value: ApprovalFormValue): void {
  switch (field.type) {
    case 'text':
      if (
        typeof value !== 'string' || value.length > (field.maximumLength ?? MAX_TEXT_LENGTH)
      ) throw new ApprovalDomainError('APPROVAL_FORM_TYPE_INVALID', `字段 ${field.key} 必须为文本`);
      return;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) invalidField(field.key, '有限数');
      return;
    case 'money_minor':
      if (!Number.isSafeInteger(value)) invalidField(field.key, '整数分');
      return;
    case 'boolean':
      if (typeof value !== 'boolean') invalidField(field.key, '布尔值');
      return;
    case 'date':
      if (typeof value !== 'string' || !isValidIsoDate(value)) invalidField(field.key, '有效 ISO 日期');
      return;
    case 'single_select':
      if (typeof value !== 'string' || !field.options?.some((item) => item.key === value)) {
        invalidField(field.key, '合法单选值');
      }
      return;
    case 'multi_select':
      if (
        !isScalarArray(value) || value.length > 200 ||
        value.some((item) => typeof item !== 'string' || !field.options?.some((option) => option.key === item)) ||
        new Set(value).size !== value.length
      ) invalidField(field.key, '合法且不重复的多选值');
      return;
    case 'employee':
    case 'department':
      if (typeof value !== 'string') invalidField(field.key, '标识字符串');
      assertApprovalId(value, field.key);
      return;
    case 'file_reference':
      if (
        !isScalarArray(value) || value.length > 20 ||
        value.some((item) => typeof item !== 'string') || new Set(value).size !== value.length
      ) invalidField(field.key, '不重复的文件引用数组');
      for (const item of value) assertApprovalId(item, field.key);
  }
}

function invalidField(field: string, expected: string): never {
  throw new ApprovalDomainError('APPROVAL_FORM_TYPE_INVALID', `字段 ${field} 必须为${expected}`);
}

function cloneFormValue(value: ApprovalFormValue): ApprovalFormValue {
  return isScalarArray(value) ? [...value] : value;
}

function hashDefinition(definition: ApprovalTemplateDefinition): string {
  return hashApprovalJson(definition);
}

function assertTemplateDefinitionIntegrity(template: ApprovalTemplate): void {
  assertRiskLevel(template.riskLevel);
  const normalized = normalizeAndValidateDefinition(template.definition);
  if (hashDefinition(normalized) !== template.definitionHash) {
    throw new ApprovalDomainError('APPROVAL_TEMPLATE_INTEGRITY_INVALID', '审批模板定义完整性校验失败');
  }
}

function canonicalize(
  value: unknown,
  depth: number,
  state: { nodeCount: number; ancestors: WeakSet<object> },
): string {
  state.nodeCount += 1;
  if (depth > MAX_CANONICAL_DEPTH || state.nodeCount > MAX_CANONICAL_NODES) {
    throw new ApprovalDomainError('APPROVAL_JSON_TOO_COMPLEX', 'JSON 超过复杂度限制');
  }
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ApprovalDomainError('APPROVAL_JSON_INVALID', 'JSON 数值必须有限');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return withAncestor(value, state.ancestors, () =>
      `[${value.map((item) => canonicalize(item, depth + 1, state)).join(',')}]`);
  }
  if (!isPlainObject(value)) throw new ApprovalDomainError('APPROVAL_JSON_INVALID', '只允许纯 JSON 对象');
  const objectValue = value as Readonly<Record<string, unknown>>;
  return withAncestor(objectValue, state.ancestors, () => {
    const entries = Object.entries(objectValue)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${entries.map(([key, item]) =>
      `${JSON.stringify(key)}:${canonicalize(item, depth + 1, state)}`).join(',')}}`;
  });
}

function withAncestor<T>(value: object, ancestors: WeakSet<object>, operation: () => T): T {
  if (ancestors.has(value)) {
    throw new ApprovalDomainError('APPROVAL_JSON_CYCLE', 'JSON 不能包含循环引用');
  }
  ancestors.add(value);
  try {
    return operation();
  } finally {
    ancestors.delete(value);
  }
}

function isValidIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
}

function isPlainObject(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(Object.getOwnPropertyDescriptors(value)).every(
    (descriptor) => 'value' in descriptor && descriptor.enumerable,
  );
}

function isScalarArray(value: ApprovalFormValue | undefined): value is readonly ApprovalScalar[] {
  return Array.isArray(value);
}

function isArray(value: unknown): boolean {
  return Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

function assertExpectedVersion(actual: number, expected: number): void {
  assertPositiveVersion(expected, 'expectedVersion');
  if (actual !== expected) {
    throw new ApprovalDomainError('APPROVAL_VERSION_CONFLICT', '审批模板版本冲突');
  }
}
