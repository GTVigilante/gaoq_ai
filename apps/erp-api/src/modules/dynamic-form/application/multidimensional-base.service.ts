import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { createEventId } from '@gaoq/shared-utils';

import { IdempotencyService } from '../../../core/idempotency/idempotency.service.js';
import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { parseMultidimensionalBaseInput, type MultidimensionalBase } from '../domain/multidimensional-base.js';
import { DynamicFormRepository } from '../persistence/dynamic-form.repository.js';
import { MultidimensionalBaseRepository } from '../persistence/multidimensional-base.repository.js';
import type { CreateMultidimensionalBaseDto, UpdateMultidimensionalBaseDto } from './dynamic-form.dto.js';

@Injectable()
export class MultidimensionalBaseService {
  constructor(private readonly context: TenantContextService, private readonly idempotency: IdempotencyService, private readonly bases: MultidimensionalBaseRepository, private readonly forms: DynamicFormRepository) {}

  async create(key: string, input: CreateMultidimensionalBaseDto): Promise<{ readonly base: MultidimensionalBase }> {
    this.scope('erp:bases:workspace:design');
    const parsed = parseMultidimensionalBaseInput({ ...input.definition, code: input.code });
    return this.idempotency.execute('multidimensional-base.create', key, parsed, async (session) => {
      await this.validate(parsed, session);
      const now = new Date();
      const base: MultidimensionalBase = Object.freeze({ ...parsed, id: createEventId(now), tenantId: this.tenant(), version: 1, createdByActorId: this.actor().actorId, createdAt: now.toISOString(), updatedAt: now.toISOString() });
      await this.bases.insert(base, session);
      return { base };
    });
  }

  async update(id: string, version: number, key: string, input: UpdateMultidimensionalBaseDto): Promise<{ readonly base: MultidimensionalBase }> {
    this.scope('erp:bases:workspace:design');
    return this.idempotency.execute('multidimensional-base.update', key, { id, version, input }, async (session) => {
      const current = await this.required(id, session);
      if (current.version !== version) throw new Error('BASE_VERSION_CONFLICT');
      const parsed = parseMultidimensionalBaseInput({ ...input.definition, code: current.code });
      await this.validate(parsed, session);
      const base: MultidimensionalBase = Object.freeze({ ...current, ...parsed, code: current.code, version: current.version + 1, updatedAt: new Date().toISOString() });
      await this.bases.replace(base, version, session);
      return { base };
    });
  }

  async list(): Promise<{ readonly items: readonly MultidimensionalBase[] }> { this.scope('erp:bases:workspace:read'); return { items: await this.bases.list() }; }
  async get(id: string): Promise<MultidimensionalBase> { this.scope('erp:bases:workspace:read'); return this.required(id); }

  /** MCP 目录不返回自动化动作、筛选值或成员权限，仅暴露可导航的 Base/Table/View 元数据。 */
  async listForMcp(): Promise<{ readonly items: readonly Readonly<Record<string, unknown>>[] }> {
    const result = await this.list();
    return { items: Object.freeze(result.items.map((base) => Object.freeze({
      id: base.id, code: base.code, name: base.name, version: base.version,
      tables: Object.freeze(base.tables.map((table) => Object.freeze({ formId: table.formId, name: table.name, primaryFieldKey: table.primaryFieldKey }))),
      views: Object.freeze(base.views.map((view) => Object.freeze({ id: view.id, tableId: view.tableId, name: view.name, type: view.type }))),
      automationCount: base.automations.length,
    }))) };
  }

  async assertTable(baseId: string, tableId: string): Promise<MultidimensionalBase> {
    this.scope('erp:bases:workspace:read');
    const base = await this.required(baseId);
    if (!base.tables.some((table) => table.formId === tableId)) throw new NotFoundException({ code: 'BASE_TABLE_NOT_FOUND', message: '数据表不属于当前 Base' });
    return base;
  }

  private async validate(input: ReturnType<typeof parseMultidimensionalBaseInput>, session: Parameters<DynamicFormRepository['findDefinition']>[1]): Promise<void> {
    const definitions = new Map();
    for (const table of input.tables) {
      const form = await this.forms.findDefinition(table.formId, session);
      if (form === null || form.status !== 'published') throw new Error('BASE_TABLE_NOT_PUBLISHED');
      const fields = new Set(form.items.flatMap((item) => item.kind === 'field' ? [item.field.key] : []));
      if (!fields.has(table.primaryFieldKey)) throw new Error('BASE_PRIMARY_FIELD_INVALID');
      definitions.set(table.formId, fields);
    }
    for (const view of input.views) {
      const fields = definitions.get(view.tableId) as Set<string> | undefined;
      const referenced = [...view.config.visibleFieldKeys, ...view.config.groups, ...view.config.sorts.map((sort) => sort.fieldKey), ...(view.config.filter?.conditions.map((condition) => condition.fieldKey) ?? [])];
      if (fields === undefined || referenced.some((field) => !fields.has(field))) throw new Error('BASE_VIEW_FIELD_INVALID');
    }
    for (const automation of input.automations) {
      const fields = definitions.get(automation.trigger.tableId) as Set<string> | undefined;
      const watched = automation.trigger.type === 'record_updated' ? automation.trigger.watchedFieldKeys : [];
      const conditional = automation.conditions?.items.map((condition) => condition.fieldKey) ?? [];
      if (fields === undefined || [...watched, ...conditional].some((field) => !fields.has(field))) throw new Error('BASE_AUTOMATION_FIELD_INVALID');
    }
  }

  private async required(id: string, session?: Parameters<MultidimensionalBaseRepository['find']>[1]): Promise<MultidimensionalBase> { const value = await this.bases.find(id, session); if (value === null) throw new NotFoundException({ code: 'BASE_NOT_FOUND', message: '多维表格不存在' }); return value; }
  private scope(value: string): void { if (!this.actor().scopes.includes(value)) throw new ForbiddenException({ code: 'BASE_ACCESS_DENIED', message: '当前身份无权访问多维表格' }); }
  private tenant(): string { return this.context.getTenantRequired().tenantId; }
  private actor() { return this.context.getActorRequired(); }
}
