import { BadRequestException, Body, Controller, Get, Headers, Logger, Param, ParseIntPipe, Post, Put, Query, Res } from '@nestjs/common';
import { ULID_PATTERN } from '@gaoq/shared-utils';
import type { Response } from 'express';

import { AuditService } from '../../core/audit/audit.service.js';
import { RequiredScopes } from '../identity/auth.decorators.js';
import { BulkWriteDynamicFormRecordDto, CreateDynamicFormDto, EmptyDynamicFormActionDto, UpdateDynamicFormDto, WriteDynamicFormRecordDto } from './application/dynamic-form.dto.js';
import { DynamicFormService } from './application/dynamic-form.service.js';

const KEY = /^[A-Za-z0-9._:-]{8,128}$/;
const ETAG = /^"([1-9][0-9]*)"$/;

/** 动态表单 REST Interface；所有写操作均要求幂等键和强版本。 */
@Controller('dynamic-forms')
export class DynamicFormController {
  private readonly logger = new Logger(DynamicFormController.name);
  constructor(private readonly forms: DynamicFormService, private readonly audit: AuditService) {}

  @Get() @RequiredScopes('erp:forms:design')
  async list() { return this.forms.list(); }

  @Get(':id') @RequiredScopes('erp:forms:design')
  async get(@Param('id') id: string, @Res({ passthrough: true }) response: Response) {
    const form = await this.forms.get(this.id(id)); this.etag(response, form.version); return form;
  }

  @Post() @RequiredScopes('erp:forms:design')
  async create(@Headers('idempotency-key') key: string | undefined, @Body() body: CreateDynamicFormDto, @Res({ passthrough: true }) response: Response) {
    const result = await this.forms.create(this.key(key), body); this.etag(response, result.form.version); await this.committed('dynamic_form.definition.create', 'dynamic_form_definition', result.form.id, result.form.version, 'R1'); return result;
  }

  @Put(':id') @RequiredScopes('erp:forms:design')
  async update(@Param('id') id: string, @Headers('if-match') version: string | undefined, @Headers('idempotency-key') key: string | undefined, @Body() body: UpdateDynamicFormDto, @Res({ passthrough: true }) response: Response) {
    const result = await this.forms.update(this.id(id), this.version(version), this.key(key), body); this.etag(response, result.form.version); await this.committed('dynamic_form.definition.update', 'dynamic_form_definition', result.form.id, result.form.version, 'R1'); return result;
  }

  @Post(':id/publish') @RequiredScopes('erp:forms:publish')
  async publish(@Param('id') id: string, @Headers('if-match') version: string | undefined, @Headers('idempotency-key') key: string | undefined, @Body() body: EmptyDynamicFormActionDto, @Res({ passthrough: true }) response: Response) {
    this.empty(body); const result = await this.forms.publish(this.id(id), this.version(version), this.key(key)); this.etag(response, result.form.version); await this.committed('dynamic_form.definition.publish', 'dynamic_form_definition', result.form.id, result.form.version, 'R2'); return result;
  }

  @Post(':formId/records') @RequiredScopes('erp:forms:data:write')
  async createRecord(@Param('formId') formId: string, @Headers('idempotency-key') key: string | undefined, @Body() body: WriteDynamicFormRecordDto, @Res({ passthrough: true }) response: Response) {
    const result = await this.forms.createRecord(this.id(formId), this.key(key), body); this.etag(response, result.record.version); await this.committed('dynamic_form.record.create', 'dynamic_form_record', result.record.id, result.record.version, 'R2'); return result;
  }

  @Post(':formId/records/bulk') @RequiredScopes('erp:forms:data:write')
  async createRecords(@Param('formId') formId: string, @Headers('idempotency-key') key: string | undefined, @Body() body: BulkWriteDynamicFormRecordDto) {
    const result = await this.forms.createRecords(this.id(formId), this.key(key), body);
    await this.committed('dynamic_form.record.bulk_create', 'dynamic_form_definition', formId, result.records.length, 'R2');
    return result;
  }

  @Get(':formId/records') @RequiredScopes('erp:forms:data:read')
  async listRecords(@Param('formId') formId: string, @Query('limit', new ParseIntPipe({ optional: true })) limit?: number) {
    const result = await this.forms.listRecords(this.id(formId), limit ?? 100);
    await this.audit.record({ action: 'dynamic_form.record.list', resourceType: 'dynamic_form_definition', resourceId: formId, riskLevel: 'R2', outcome: 'success', metadata: { count: result.items.length } });
    return result;
  }

  @Get(':formId/records/:recordId') @RequiredScopes('erp:forms:data:read')
  async getRecord(@Param('formId') formId: string, @Param('recordId') recordId: string, @Res({ passthrough: true }) response: Response) {
    const result = await this.forms.getRecord(this.id(formId), this.id(recordId)); this.etag(response, result.record.version); await this.audit.record({ action: 'dynamic_form.record.read', resourceType: 'dynamic_form_record', resourceId: result.record.id, riskLevel: 'R2', outcome: 'success', metadata: { version: result.record.version, formId: result.record.formId } }); return result;
  }

  @Put(':formId/records/:recordId') @RequiredScopes('erp:forms:data:write')
  async updateRecord(@Param('formId') formId: string, @Param('recordId') recordId: string, @Headers('if-match') version: string | undefined, @Headers('idempotency-key') key: string | undefined, @Body() body: WriteDynamicFormRecordDto, @Res({ passthrough: true }) response: Response) {
    const result = await this.forms.updateRecord(this.id(formId), this.id(recordId), this.version(version), this.key(key), body); this.etag(response, result.record.version); await this.committed('dynamic_form.record.update', 'dynamic_form_record', result.record.id, result.record.version, 'R2'); return result;
  }

  @Get(':formId/records/:recordId/related') @RequiredScopes('erp:forms:data:read')
  async related(@Param('formId') formId: string, @Param('recordId') recordId: string) { return this.forms.related(this.id(formId), this.id(recordId)); }

  private id(value: string): string { if (!ULID_PATTERN.test(value)) throw new BadRequestException({ code: 'FORM_ID_INVALID', message: '资源标识必须为严格 ULID' }); return value; }
  private key(value: string | undefined): string { if (value === undefined || !KEY.test(value)) throw new BadRequestException({ code: 'IDEMPOTENCY_KEY_REQUIRED', message: '写接口必须提供 8–128 位白名单 Idempotency-Key' }); return value; }
  private version(value: string | undefined): number { const match = ETAG.exec(value ?? ''); const version = Number(match?.[1]); if (match === null || !Number.isSafeInteger(version) || version >= Number.MAX_SAFE_INTEGER) throw new BadRequestException({ code: 'FORM_IF_MATCH_REQUIRED', message: '写接口必须提供强 If-Match 版本' }); return version; }
  private empty(value: unknown): void { if (value === undefined) return; if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== 0) throw new BadRequestException({ code: 'FORM_BODY_FORBIDDEN', message: '该操作不接受请求正文' }); }
  private etag(response: Response, version: number): void { response.setHeader('ETag', `"${version}"`); }
  private async committed(action: string, resourceType: string, resourceId: string, version: number, riskLevel: 'R1' | 'R2'): Promise<void> { try { await this.audit.record({ action, resourceType, resourceId, riskLevel, outcome: 'success', metadata: { version } }); } catch { this.logger.error('DYNAMIC_FORM_COMMITTED_AUDIT_WRITE_FAILED'); } }
}
