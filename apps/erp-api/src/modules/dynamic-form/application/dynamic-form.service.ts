import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { createEventId } from '@gaoq/shared-utils';
import type { ClientSession } from 'mongoose';

import { IdempotencyService } from '../../../core/idempotency/idempotency.service.js';
import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { parseFormDefinitionInput, parseRecordValues, relationEdges, type DynamicFormDefinition, type DynamicFormRecord } from '../domain/dynamic-form.js';
import { DynamicFormRepository } from '../persistence/dynamic-form.repository.js';
import { DynamicFormOutboxWriter } from '../persistence/dynamic-form-outbox.writer.js';
import type { BulkWriteDynamicFormRecordDto, CreateDynamicFormDto, UpdateDynamicFormDto, WriteDynamicFormRecordDto } from './dynamic-form.dto.js';

@Injectable()
export class DynamicFormService {
  constructor(
    private readonly context: TenantContextService,
    private readonly idempotency: IdempotencyService,
    private readonly repository: DynamicFormRepository,
    private readonly outbox: DynamicFormOutboxWriter,
  ) {}

  async create(key: string, input: CreateDynamicFormDto): Promise<{ readonly form: DynamicFormDefinition }> {
    this.scope('erp:forms:design');
    const definition = parseFormDefinitionInput({ ...input.definition, code: input.code });
    return this.idempotency.execute('dynamic-form.definition.create', key, definition, async (session) => {
      const now = new Date();
      const form: DynamicFormDefinition = Object.freeze({ ...definition, id: createEventId(now), tenantId: this.tenant(), status: 'draft', revision: 1, version: 1, createdByActorId: this.actor().actorId, publishedAt: null, createdAt: now.toISOString(), updatedAt: now.toISOString() });
      await this.validateDefinitionReferences(form, session, false);
      await this.repository.insertDefinition(form, session);
      await this.outbox.append({ aggregateType: 'definition', aggregateId: form.id, version: form.version, action: 'created', occurredAt: form.createdAt, data: { code: form.code, revision: form.revision } }, session);
      return { form };
    });
  }

  async update(id: string, expectedVersion: number, key: string, input: UpdateDynamicFormDto): Promise<{ readonly form: DynamicFormDefinition }> {
    this.scope('erp:forms:design');
    return this.idempotency.execute('dynamic-form.definition.update', key, { id, expectedVersion, definition: input.definition }, async (session) => {
      const current = await this.requiredForm(id, session);
      if (current.status !== 'draft' || current.version !== expectedVersion) throw new Error('FORM_DEFINITION_VERSION_CONFLICT');
      const parsed = parseFormDefinitionInput({ ...input.definition, code: current.code });
      const now = new Date();
      const form: DynamicFormDefinition = Object.freeze({ ...current, ...parsed, code: current.code, version: current.version + 1, updatedAt: now.toISOString() });
      await this.validateDefinitionReferences(form, session, false);
      await this.repository.replaceDraft(form, expectedVersion, session);
      await this.outbox.append({ aggregateType: 'definition', aggregateId: form.id, version: form.version, action: 'updated', occurredAt: form.updatedAt, data: { code: form.code, revision: form.revision } }, session);
      return { form };
    });
  }

  async publish(id: string, expectedVersion: number, key: string): Promise<{ readonly form: DynamicFormDefinition }> {
    this.scope('erp:forms:publish');
    return this.idempotency.execute('dynamic-form.definition.publish', key, { id, expectedVersion }, async (session) => {
      const current = await this.requiredForm(id, session);
      if (current.status !== 'draft' || current.version !== expectedVersion) throw new Error('FORM_DEFINITION_VERSION_CONFLICT');
      if (current.createdByActorId === this.actor().actorId) throw new ForbiddenException({ code: 'FORM_PUBLISH_SOD_REQUIRED', message: '创建者不能发布自己的表单草稿' });
      await this.validateDefinitionReferences(current, session, true);
      const now = new Date();
      const form: DynamicFormDefinition = Object.freeze({ ...current, status: 'published', publishedAt: now.toISOString(), version: current.version + 1, updatedAt: now.toISOString() });
      await this.repository.publish(form, expectedVersion, session);
      await this.outbox.append({ aggregateType: 'definition', aggregateId: form.id, version: form.version, action: 'published', occurredAt: form.updatedAt, data: { code: form.code, revision: form.revision } }, session);
      return { form };
    });
  }

  async list(): Promise<{ readonly items: readonly DynamicFormDefinition[] }> {
    this.scope('erp:forms:design');
    return { items: await this.repository.listDefinitions() };
  }

  /** MCP/外部只读目录：只返回已发布 Schema 的最小投影，不披露流程解析器。 */
  async listPublishedCatalog(): Promise<{ readonly items: readonly Record<string, unknown>[] }> {
    this.scope('erp:forms:data:read');
    const forms = (await this.repository.listDefinitions()).filter((form) => form.status === 'published');
    return { items: Object.freeze(forms.map((form) => Object.freeze({
      id: form.id, code: form.code, name: form.name, revision: form.revision,
      fields: Object.freeze(form.items.flatMap((item) => item.kind === 'field' ? [Object.freeze({ key: item.field.key, label: item.field.label, type: item.field.type, required: item.field.required, sensitivity: item.field.sensitivity })] : [])),
    }))) };
  }

  async get(id: string): Promise<DynamicFormDefinition> {
    this.scope('erp:forms:design');
    return this.requiredForm(id);
  }

  async createRecord(formId: string, key: string, input: WriteDynamicFormRecordDto): Promise<{ readonly record: DynamicFormRecord }> {
    this.scope('erp:forms:data:write');
    return this.idempotency.execute('dynamic-form.record.create', key, { formId, values: input.values }, async (session) => {
      const form = await this.requiredPublished(formId, session);
      const values = parseRecordValues(input.values, form);
      const edges = relationEdges(form, values);
      await this.validateRelationTargets(edges, session);
      const now = new Date();
      const record: DynamicFormRecord = Object.freeze({ id: createEventId(now), tenantId: this.tenant(), formId: form.id, formRevision: form.revision, values, version: 1, createdByActorId: this.actor().actorId, createdAt: now.toISOString(), updatedAt: now.toISOString() });
      await this.repository.insertRecord(record, session);
      await this.repository.replaceRelationsForForm(form.id, record.id, edges, session);
      await this.outbox.append({ aggregateType: 'record', aggregateId: record.id, version: record.version, action: 'created', occurredAt: record.createdAt, data: { formId: record.formId, formRevision: record.formRevision } }, session);
      return { record };
    });
  }

  async createRecords(formId: string, key: string, input: BulkWriteDynamicFormRecordDto): Promise<{ readonly records: readonly DynamicFormRecord[] }> {
    this.scope('erp:forms:data:write');
    if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 50) throw new Error('FORM_BULK_SIZE_INVALID');
    return this.idempotency.execute('dynamic-form.record.bulk-create', key, { formId, items: input.items }, async (session) => {
      const form = await this.requiredPublished(formId, session);
      const parsed = input.items.map((item) => parseRecordValues(item.values, form));
      const allEdges = parsed.map((values) => relationEdges(form, values));
      for (const edges of allEdges) await this.validateRelationTargets(edges, session);
      const records: DynamicFormRecord[] = [];
      for (const [index, values] of parsed.entries()) {
        const now = new Date(Date.now() + index);
        const record: DynamicFormRecord = Object.freeze({ id: createEventId(now), tenantId: this.tenant(), formId: form.id, formRevision: form.revision, values, version: 1, createdByActorId: this.actor().actorId, createdAt: now.toISOString(), updatedAt: now.toISOString() });
        await this.repository.insertRecord(record, session);
        await this.repository.replaceRelationsForForm(form.id, record.id, allEdges[index] ?? [], session);
        await this.outbox.append({ aggregateType: 'record', aggregateId: record.id, version: record.version, action: 'created', occurredAt: record.createdAt, data: { formId: record.formId, formRevision: record.formRevision } }, session);
        records.push(record);
      }
      return { records: Object.freeze(records) };
    });
  }

  async updateRecord(formId: string, recordId: string, expectedVersion: number, key: string, input: WriteDynamicFormRecordDto): Promise<{ readonly record: DynamicFormRecord }> {
    this.scope('erp:forms:data:write');
    return this.idempotency.execute('dynamic-form.record.update', key, { formId, recordId, expectedVersion, values: input.values }, async (session) => {
      const form = await this.requiredPublished(formId, session);
      const current = await this.requiredRecord(recordId, form, session);
      if (current.version !== expectedVersion) throw new Error('FORM_RECORD_VERSION_CONFLICT');
      const values = parseRecordValues(input.values, form);
      const edges = relationEdges(form, values);
      await this.validateRelationTargets(edges, session);
      const record: DynamicFormRecord = Object.freeze({ ...current, values, version: current.version + 1, updatedAt: new Date().toISOString() });
      await this.repository.replaceRecord(record, expectedVersion, session);
      await this.repository.replaceRelationsForForm(form.id, record.id, edges, session);
      await this.outbox.append({ aggregateType: 'record', aggregateId: record.id, version: record.version, action: 'updated', occurredAt: record.updatedAt, data: { formId: record.formId, formRevision: record.formRevision } }, session);
      return { record };
    });
  }

  async listRecords(formId: string, limit = 100): Promise<{ readonly form: DynamicFormDefinition; readonly items: readonly DynamicFormRecord[] }> {
    this.scope('erp:forms:data:read');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('FORM_RECORD_LIST_LIMIT_INVALID');
    const form = await this.requiredPublished(formId);
    return { form, items: await this.repository.listRecords(form, limit) };
  }

  async getRecord(formId: string, recordId: string): Promise<{ readonly record: DynamicFormRecord; readonly resolvedValues: Readonly<Record<string, unknown>> }> {
    this.scope('erp:forms:data:read');
    const form = await this.requiredPublished(formId);
    const record = await this.requiredRecord(recordId, form);
    const resolvedValues = await this.resolveRelatedProperties(form, record);
    return { record, resolvedValues };
  }

  /** MCP 安全投影只返回 L1/L2 字段；L3/L4 与附件引用永久留在专用业务界面。 */
  async getRecordForMcp(formId: string, recordId: string): Promise<Readonly<Record<string, unknown>>> {
    const result = await this.getRecord(formId, recordId);
    const form = await this.requiredPublished(formId);
    const allowed = new Set(form.items.flatMap((item) => item.kind === 'field' && ['L1', 'L2'].includes(item.field.sensitivity) && item.field.type !== 'attachment' ? [item.field.key] : []));
    return Object.freeze({ id: result.record.id, formId: result.record.formId, formRevision: result.record.formRevision, version: result.record.version, values: Object.freeze(Object.fromEntries(Object.entries(result.resolvedValues).filter(([key]) => allowed.has(key)))) });
  }

  async related(formId: string, recordId: string) {
    this.scope('erp:forms:data:read');
    const form = await this.requiredPublished(formId);
    await this.requiredRecord(recordId, form);
    return this.repository.related(recordId);
  }

  private async resolveRelatedProperties(form: DynamicFormDefinition, record: DynamicFormRecord): Promise<Readonly<Record<string, unknown>>> {
    const result: Record<string, unknown> = { ...record.values };
    let resolvedCount = 0;
    for (const item of form.items) {
      if (item.kind !== 'field' || item.field.type !== 'related_property' || item.field.relatedProperty === undefined) continue;
      const relationField = form.items.find((candidate) => candidate.kind === 'field' && candidate.field.key === item.field.relatedProperty?.relationFieldKey);
      if (relationField?.kind !== 'field' || relationField.field.relation === undefined) throw new Error('FORM_RELATED_PROPERTY_STATE_INVALID');
      const raw = record.values[relationField.field.key];
      const ids = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
      resolvedCount += ids.length;
      if (ids.length > 100 || resolvedCount > 100) throw new Error('FORM_RELATED_PROPERTY_LIMIT');
      const targetForm = await this.requiredPublished(relationField.field.relation.targetFormId);
      const values: unknown[] = [];
      for (const id of ids) {
        if (typeof id !== 'string') throw new Error('FORM_RELATED_PROPERTY_STATE_INVALID');
        const target = await this.requiredRecord(id, targetForm);
        values.push(target.values[item.field.relatedProperty.targetFieldKey] ?? null);
      }
      result[item.field.key] = relationField.field.type === 'relation_single' ? values[0] ?? null : Object.freeze(values);
    }
    return Object.freeze(result);
  }

  private async validateDefinitionReferences(form: DynamicFormDefinition, session: ClientSession, requirePublished: boolean): Promise<void> {
    const fields = form.items.flatMap((item) => item.kind === 'field' ? [item.field] : []);
    for (const field of fields) {
      if (field.relation !== undefined) {
        const target = await this.repository.findDefinition(field.relation.targetFormId, session);
        const targetField = target?.items.find((item) => item.kind === 'field' && item.field.key === field.relation?.displayFieldKey);
        if (target === null || targetField?.kind !== 'field' || (requirePublished && target.status !== 'published')) throw new Error('FORM_RELATION_DEFINITION_INVALID');
      }
      if (field.relatedProperty !== undefined) {
        const relation = fields.find((candidate) => candidate.key === field.relatedProperty?.relationFieldKey);
        if (relation?.relation === undefined) throw new Error('FORM_RELATED_PROPERTY_DEFINITION_INVALID');
        const target = await this.repository.findDefinition(relation.relation.targetFormId, session);
        const targetField = target?.items.find((item) => item.kind === 'field' && item.field.key === field.relatedProperty?.targetFieldKey);
        if (target === null || targetField?.kind !== 'field' || targetField.field.sensitivity === 'L4' || (requirePublished && target.status !== 'published')) throw new Error('FORM_RELATED_PROPERTY_DEFINITION_INVALID');
      }
    }
  }

  private async validateRelationTargets(edges: readonly { readonly targetFormId: string; readonly targetRecordId: string }[], session: ClientSession): Promise<void> {
    if (edges.length > 500) throw new Error('FORM_RELATION_EDGE_LIMIT');
    for (const edge of edges) await this.repository.assertTargetRecord(edge.targetFormId, edge.targetRecordId, session);
  }

  private async requiredPublished(id: string, session?: ClientSession): Promise<DynamicFormDefinition> {
    const form = await this.requiredForm(id, session);
    if (form.status !== 'published') throw new NotFoundException({ code: 'FORM_NOT_PUBLISHED', message: '表单尚未发布' });
    return form;
  }

  private async requiredForm(id: string, session?: ClientSession): Promise<DynamicFormDefinition> {
    const form = await this.repository.findDefinition(id, session);
    if (form === null) throw new NotFoundException({ code: 'FORM_NOT_FOUND', message: '表单不存在' });
    return form;
  }

  private async requiredRecord(id: string, form: DynamicFormDefinition, session?: ClientSession): Promise<DynamicFormRecord> {
    const record = await this.repository.findRecord(id, form, session);
    if (record === null) throw new NotFoundException({ code: 'FORM_RECORD_NOT_FOUND', message: '表单记录不存在' });
    return record;
  }

  private scope(scope: string): void { if (!this.actor().scopes.includes(scope)) throw new ForbiddenException({ code: 'FORM_ACCESS_DENIED', message: '当前身份无权访问动态表单' }); }
  private tenant(): string { return this.context.getTenantRequired().tenantId; }
  private actor() { return this.context.getActorRequired(); }
}
