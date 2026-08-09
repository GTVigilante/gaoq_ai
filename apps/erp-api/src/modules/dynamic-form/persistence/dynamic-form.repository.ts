import { ConflictException, Injectable } from '@nestjs/common';
import { createEventId } from '@gaoq/shared-utils';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { parseFormDefinitionInput, parseRecordValues, type DynamicFormDefinition, type DynamicFormRecord } from '../domain/dynamic-form.js';
import { DynamicFormDataCryptoService, type ProtectedDynamicFormData } from './dynamic-form-data-crypto.service.js';
import { DynamicFormDataRecord, type DynamicFormDataDocument, DynamicFormDefinitionRecord, type DynamicFormDefinitionDocument, DynamicFormRelationRecord, type DynamicFormRelationDocument } from './dynamic-form.schemas.js';

@Injectable()
export class DynamicFormRepository {
  constructor(
    private readonly context: TenantContextService,
    private readonly crypto: DynamicFormDataCryptoService,
    @InjectModel(DynamicFormDefinitionRecord.name) private readonly definitions: Model<DynamicFormDefinitionDocument>,
    @InjectModel(DynamicFormDataRecord.name) private readonly records: Model<DynamicFormDataDocument>,
    @InjectModel(DynamicFormRelationRecord.name) private readonly relations: Model<DynamicFormRelationDocument>,
  ) {}

  async insertDefinition(value: DynamicFormDefinition, session: ClientSession): Promise<void> {
    await this.definitions.create([{ ...value, items: structuredClone(value.items), workflow: value.workflow === undefined ? null : structuredClone(value.workflow), publishedAt: null, createdAt: new Date(value.createdAt), updatedAt: new Date(value.updatedAt) }], { session });
  }

  async findDefinition(id: string, session?: ClientSession): Promise<DynamicFormDefinition | null> {
    const query = this.definitions.findOne({ tenantId: this.tenant(), id }).select('-_id').lean();
    if (session !== undefined) query.session(session);
    const row = await query.exec();
    return row === null ? null : definition(row, this.tenant(), id);
  }

  async listDefinitions(): Promise<readonly DynamicFormDefinition[]> {
    const rows = await this.definitions.find({ tenantId: this.tenant() }).sort({ updatedAt: -1, id: 1 }).limit(201).select('-_id').lean().exec();
    if (rows.length > 200) throw new Error('FORM_DEFINITION_LIST_LIMIT');
    return Object.freeze(rows.map((row) => definition(row, this.tenant(), row.id)));
  }

  async replaceDraft(value: DynamicFormDefinition, expectedVersion: number, session: ClientSession): Promise<void> {
    const result = await this.definitions.updateOne({ tenantId: this.tenant(), id: value.id, status: 'draft', version: expectedVersion }, { $set: { name: value.name, description: value.description, items: structuredClone(value.items), workflow: value.workflow === undefined ? null : structuredClone(value.workflow), version: value.version, updatedAt: new Date(value.updatedAt) } }, { session, timestamps: false, runValidators: true });
    if (result.matchedCount !== 1) conflict('FORM_DEFINITION_VERSION_CONFLICT', '表单草稿版本已变化');
  }

  async publish(value: DynamicFormDefinition, expectedVersion: number, session: ClientSession): Promise<void> {
    const result = await this.definitions.updateOne({ tenantId: this.tenant(), id: value.id, status: 'draft', version: expectedVersion }, { $set: { status: 'published', publishedAt: new Date(value.publishedAt!), version: value.version, updatedAt: new Date(value.updatedAt) } }, { session, timestamps: false, runValidators: true });
    if (result.matchedCount !== 1) conflict('FORM_DEFINITION_VERSION_CONFLICT', '表单草稿版本已变化');
  }

  async insertRecord(value: DynamicFormRecord, session: ClientSession): Promise<void> {
    const protectedData = this.crypto.protect({ tenantId: this.tenant(), formId: value.formId, recordId: value.id, formRevision: value.formRevision }, value.values);
    await this.records.create([{ id: value.id, tenantId: value.tenantId, formId: value.formId, formRevision: value.formRevision, ...protectedData, version: value.version, createdByActorId: value.createdByActorId, createdAt: new Date(value.createdAt), updatedAt: new Date(value.updatedAt) }], { session });
  }

  async findRecord(id: string, definition: DynamicFormDefinition, session?: ClientSession): Promise<DynamicFormRecord | null> {
    const query = this.records.findOne({ tenantId: this.tenant(), id, formId: definition.id }).select('-_id').lean();
    if (session !== undefined) query.session(session);
    const row = await query.exec();
    if (row === null) return null;
    return record(row, definition, this.tenant(), id, this.crypto);
  }

  async listRecords(definition: DynamicFormDefinition, limit: number): Promise<readonly DynamicFormRecord[]> {
    const rows = await this.records.find({ tenantId: this.tenant(), formId: definition.id })
      .sort({ updatedAt: -1, id: 1 }).limit(limit + 1).select('-_id').lean().exec();
    if (rows.length > limit) throw new Error('FORM_RECORD_LIST_LIMIT');
    return Object.freeze(rows.map((row) => record(row, definition, this.tenant(), row.id, this.crypto)));
  }

  async replaceRecord(value: DynamicFormRecord, expectedVersion: number, session: ClientSession): Promise<void> {
    const protectedData = this.crypto.protect({ tenantId: this.tenant(), formId: value.formId, recordId: value.id, formRevision: value.formRevision }, value.values);
    const result = await this.records.updateOne({ tenantId: this.tenant(), id: value.id, formId: value.formId, version: expectedVersion }, { $set: { ...protectedData, version: value.version, updatedAt: new Date(value.updatedAt) } }, { session, timestamps: false, runValidators: true });
    if (result.matchedCount !== 1) conflict('FORM_RECORD_VERSION_CONFLICT', '表单记录版本已变化');
  }

  async assertTargetRecord(targetFormId: string, targetRecordId: string, session: ClientSession): Promise<void> {
    const found = await this.records.exists({ tenantId: this.tenant(), formId: targetFormId, id: targetRecordId }).session(session);
    if (found === null) conflict('FORM_RELATION_TARGET_NOT_FOUND', '关联的目标记录不存在');
  }

  async replaceRelationsForForm(sourceFormId: string, sourceRecordId: string, edges: readonly { readonly fieldKey: string; readonly targetFormId: string; readonly targetRecordId: string }[], session: ClientSession): Promise<void> {
    await this.relations.deleteMany({ tenantId: this.tenant(), sourceRecordId }).session(session);
    if (edges.length === 0) return;
    await this.relations.insertMany(edges.map((edge, index) => ({ id: createEventId(new Date(Date.now() + index)), tenantId: this.tenant(), sourceFormId, sourceRecordId, ...edge })), { session });
  }

  async related(recordId: string): Promise<{ readonly outgoing: readonly RelationSummary[]; readonly incoming: readonly RelationSummary[] }> {
    const [outgoing, incoming] = await Promise.all([
      this.relations.find({ tenantId: this.tenant(), sourceRecordId: recordId }).sort({ fieldKey: 1, targetRecordId: 1 }).limit(501).select('-_id id sourceFormId sourceRecordId fieldKey targetFormId targetRecordId').lean().exec(),
      this.relations.find({ tenantId: this.tenant(), targetRecordId: recordId }).sort({ sourceFormId: 1, fieldKey: 1, sourceRecordId: 1 }).limit(501).select('-_id id sourceFormId sourceRecordId fieldKey targetFormId targetRecordId').lean().exec(),
    ]);
    if (outgoing.length > 500 || incoming.length > 500) throw new Error('FORM_RELATION_LIST_LIMIT');
    return Object.freeze({ outgoing: Object.freeze(outgoing.map(relation)), incoming: Object.freeze(incoming.map(relation)) });
  }

  private tenant(): string { return this.context.getTenantRequired().tenantId; }
}

export interface RelationSummary {
  readonly id: string;
  readonly sourceFormId: string;
  readonly sourceRecordId: string;
  readonly fieldKey: string;
  readonly targetFormId: string;
  readonly targetRecordId: string;
}

function definition(row: DynamicFormDefinitionRecord, tenantId: string, id: string): DynamicFormDefinition {
  if (row.tenantId !== tenantId || row.id !== id || !['draft', 'published', 'retired'].includes(row.status)) throw new Error('FORM_DEFINITION_STATE_INVALID');
  const parsed = parseFormDefinitionInput({ code: row.code, name: row.name, description: row.description, items: row.items, ...(row.workflow === null ? {} : { workflow: row.workflow }) });
  return Object.freeze({ ...parsed, id: row.id, tenantId: row.tenantId, status: row.status, revision: row.revision, version: row.version, createdByActorId: row.createdByActorId, publishedAt: row.publishedAt?.toISOString() ?? null, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() });
}

function record(row: DynamicFormDataRecord, form: DynamicFormDefinition, tenantId: string, id: string, crypto: DynamicFormDataCryptoService): DynamicFormRecord {
  if (row.tenantId !== tenantId || row.id !== id || row.formId !== form.id || row.formRevision !== form.revision) throw new Error('FORM_RECORD_STATE_INVALID');
  const values = parseRecordValues(crypto.unprotect({ tenantId, formId: row.formId, recordId: row.id, formRevision: row.formRevision }, ciphertext(row)), form);
  return Object.freeze({ id: row.id, tenantId: row.tenantId, formId: row.formId, formRevision: row.formRevision, values, version: row.version, createdByActorId: row.createdByActorId, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() });
}

function ciphertext(row: DynamicFormDataRecord): ProtectedDynamicFormData {
  return { keyId: row.keyId, iv: row.iv, ciphertext: row.ciphertext, authTag: row.authTag };
}

function relation(row: DynamicFormRelationRecord): RelationSummary {
  return Object.freeze({ id: row.id, sourceFormId: row.sourceFormId, sourceRecordId: row.sourceRecordId, fieldKey: row.fieldKey, targetFormId: row.targetFormId, targetRecordId: row.targetRecordId });
}

function conflict(code: string, message: string): never { throw new ConflictException({ code, message }); }
