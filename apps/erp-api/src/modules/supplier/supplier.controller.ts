import {
  BadRequestException, Body, Controller, Get, Headers, Logger, Param, Post, Put, Query, Res,
} from '@nestjs/common';
import type { Response } from 'express';

import { AuditService } from '../../core/audit/audit.service.js';
import { RequiredScopes } from '../identity/auth.decorators.js';
import {
  ChangeSupplierStatusDto, CreateSupplierDraftDto, DecideSupplierDto, EmptySupplierActionDto,
  ReactivateSupplierDto, ReplaceSupplierCapabilitiesDto, ReplaceSupplierRatesDto,
  SupplierEligibilityDto, SupplierSearchDto, UpdateSupplierDraftDto,
} from './application/supplier.dto.js';
import { SupplierService } from './application/supplier.service.js';

const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const IF_MATCH_PATTERN = /^"([1-9][0-9]*)"$/;
type WriteResult = { readonly supplier: { readonly id: string; readonly version: number; readonly status: string } };

/** 供应方关系 REST 边界；写入统一强制幂等键、强 ETag 与提交后审计隔离。 */
@Controller('suppliers')
export class SupplierController {
  private readonly logger = new Logger(SupplierController.name);

  constructor(private readonly suppliers: SupplierService, private readonly audit: AuditService) {}

  @Post()
  @RequiredScopes('erp:supplier:relationship:write')
  async create(@Headers('idempotency-key') key: string | undefined, @Body() body: CreateSupplierDraftDto, @Res({ passthrough: true }) response: Response): Promise<WriteResult> {
    return this.write(response, 'supplier.relationship.create', 'R1', undefined, () => this.suppliers.createDraft(this.key(key), body));
  }

  @Get()
  @RequiredScopes('erp:supplier:relationship:read')
  async search(@Query() query: SupplierSearchDto) { return this.suppliers.search(query); }

  @Get(':id')
  @RequiredScopes('erp:supplier:relationship:read')
  async get(@Param('id') id: string, @Res({ passthrough: true }) response: Response) {
    const supplier = await this.suppliers.get(this.id(id));
    this.etag(response, supplier.version);
    return { supplier };
  }

  @Put(':id/draft')
  @RequiredScopes('erp:supplier:relationship:write')
  async update(@Param('id') id: string, @Headers('if-match') version: string | undefined, @Headers('idempotency-key') key: string | undefined, @Body() body: UpdateSupplierDraftDto, @Res({ passthrough: true }) response: Response): Promise<WriteResult> {
    const resourceId = this.id(id); const expectedVersion = this.version(version); const idempotencyKey = this.key(key);
    return this.write(response, 'supplier.relationship.update_draft', 'R1', expectedVersion, () => this.suppliers.updateDraft(resourceId, expectedVersion, idempotencyKey, body), resourceId);
  }

  @Put(':id/capabilities')
  @RequiredScopes('erp:supplier:catalog:write')
  async replaceCapabilities(@Param('id') id: string, @Headers('if-match') version: string | undefined, @Headers('idempotency-key') key: string | undefined, @Body() body: ReplaceSupplierCapabilitiesDto, @Res({ passthrough: true }) response: Response): Promise<WriteResult> {
    const resourceId = this.id(id); const expectedVersion = this.version(version); const idempotencyKey = this.key(key);
    return this.write(response, 'supplier.capabilities.replace', 'R1', expectedVersion, () => this.suppliers.replaceCapabilities(resourceId, expectedVersion, idempotencyKey, body), resourceId);
  }

  @Put(':id/rates')
  @RequiredScopes('erp:supplier:catalog:write')
  async replaceRates(@Param('id') id: string, @Headers('if-match') version: string | undefined, @Headers('idempotency-key') key: string | undefined, @Body() body: ReplaceSupplierRatesDto, @Res({ passthrough: true }) response: Response): Promise<WriteResult> {
    const resourceId = this.id(id); const expectedVersion = this.version(version); const idempotencyKey = this.key(key);
    return this.write(response, 'supplier.rates.replace', 'R1', expectedVersion, () => this.suppliers.replaceRates(resourceId, expectedVersion, idempotencyKey, body), resourceId);
  }

  @Post(':id/submit')
  @RequiredScopes('erp:supplier:relationship:write')
  async submit(@Param('id') id: string, @Headers('if-match') version: string | undefined, @Headers('idempotency-key') key: string | undefined, @Body() body: EmptySupplierActionDto, @Res({ passthrough: true }) response: Response): Promise<WriteResult> {
    const resourceId = this.id(id); const expectedVersion = this.version(version); const idempotencyKey = this.key(key); this.empty(body);
    return this.write(response, 'supplier.relationship.submit', 'R1', expectedVersion, () => this.suppliers.submit(resourceId, expectedVersion, idempotencyKey), resourceId);
  }

  @Post(':id/decisions')
  @RequiredScopes('erp:supplier:relationship:decide')
  async decide(@Param('id') id: string, @Headers('if-match') version: string | undefined, @Headers('idempotency-key') key: string | undefined, @Body() body: DecideSupplierDto, @Res({ passthrough: true }) response: Response): Promise<WriteResult> {
    const resourceId = this.id(id); const expectedVersion = this.version(version); const idempotencyKey = this.key(key);
    return this.write(response, 'supplier.relationship.decide', 'R2', expectedVersion, () => this.suppliers.decide(resourceId, expectedVersion, idempotencyKey, body), resourceId);
  }

  @Post(':id/suspend')
  @RequiredScopes('erp:supplier:relationship:decide')
  async statusSuspend(@Param('id') id: string, @Headers('if-match') version: string | undefined, @Headers('idempotency-key') key: string | undefined, @Body() body: ChangeSupplierStatusDto, @Res({ passthrough: true }) response: Response): Promise<WriteResult> {
    const resourceId = this.id(id); const expectedVersion = this.version(version); const idempotencyKey = this.key(key);
    return this.write(response, 'supplier.relationship.suspend', 'R2', expectedVersion, () => this.suppliers.suspend(resourceId, expectedVersion, idempotencyKey, body), resourceId);
  }

  @Post(':id/reactivate')
  @RequiredScopes('erp:supplier:relationship:decide')
  async statusReactivate(@Param('id') id: string, @Headers('if-match') version: string | undefined, @Headers('idempotency-key') key: string | undefined, @Body() body: ReactivateSupplierDto, @Res({ passthrough: true }) response: Response): Promise<WriteResult> {
    const resourceId = this.id(id); const expectedVersion = this.version(version); const idempotencyKey = this.key(key);
    return this.write(response, 'supplier.relationship.reactivate', 'R2', expectedVersion, () => this.suppliers.reactivate(resourceId, expectedVersion, idempotencyKey, body), resourceId);
  }

  @Post(':id/close')
  @RequiredScopes('erp:supplier:relationship:decide')
  async statusClose(@Param('id') id: string, @Headers('if-match') version: string | undefined, @Headers('idempotency-key') key: string | undefined, @Body() body: ChangeSupplierStatusDto, @Res({ passthrough: true }) response: Response): Promise<WriteResult> {
    const resourceId = this.id(id); const expectedVersion = this.version(version); const idempotencyKey = this.key(key);
    return this.write(response, 'supplier.relationship.close', 'R2', expectedVersion, () => this.suppliers.close(resourceId, expectedVersion, idempotencyKey, body), resourceId);
  }

  @Get(':id/eligibility')
  @RequiredScopes('erp:supplier:eligibility:read')
  async eligibility(@Param('id') id: string, @Query() query: SupplierEligibilityDto) { return this.suppliers.resolveEligibility(this.id(id), query); }

  private id(value: unknown): string {
    if (typeof value !== 'string' || !ULID_PATTERN.test(value)) throw new BadRequestException({ code: 'SUPPLIER_ID_INVALID', message: '资源标识必须为严格 ULID' });
    return value;
  }

  private key(value: unknown): string {
    if (typeof value !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(value)) throw new BadRequestException({ code: 'IDEMPOTENCY_KEY_REQUIRED', message: '写接口必须提供 8–128 位白名单 Idempotency-Key' });
    return value;
  }

  private version(value: unknown): number {
    const match = typeof value === 'string' ? IF_MATCH_PATTERN.exec(value) : null; const parsed = Number(match?.[1]);
    if (match === null || !Number.isSafeInteger(parsed) || parsed >= Number.MAX_SAFE_INTEGER) throw new BadRequestException({ code: 'SUPPLIER_IF_MATCH_REQUIRED', message: '写接口必须提供强 If-Match 版本' });
    return parsed;
  }

  private empty(value: unknown): void {
    if (value === undefined) return;
    let valid: boolean;
    try { const prototype: unknown = Object.getPrototypeOf(value); valid = typeof value === 'object' && value !== null && !Array.isArray(value) && (prototype === Object.prototype || prototype === EmptySupplierActionDto.prototype) && Reflect.ownKeys(value).length === 0; } catch { valid = false; }
    if (!valid) throw new BadRequestException({ code: 'SUPPLIER_BODY_FORBIDDEN', message: '该操作不接受请求正文' });
  }

  private etag(response: Response, version: number): void { response.setHeader('ETag', `"${version}"`); }

  private async write(response: Response, action: string, riskLevel: 'R1' | 'R2', expectedVersion: number | undefined, operation: () => Promise<WriteResult>, resourceId = 'new'): Promise<WriteResult> {
    let result: WriteResult;
    try { result = await operation(); } catch (error) { await this.failureAudit(action, resourceId, riskLevel, expectedVersion); throw error; }
    this.etag(response, result.supplier.version);
    try { await this.audit.record({ action, resourceType: 'supplier_relationship', resourceId: result.supplier.id, riskLevel, outcome: 'success', metadata: { version: result.supplier.version, status: result.supplier.status } }); }
    catch { this.logger.error({ code: 'SUPPLIER_COMMITTED_AUDIT_WRITE_FAILED', action, resourceId: result.supplier.id }); }
    return result;
  }

  private async failureAudit(action: string, resourceId: string, riskLevel: 'R1' | 'R2', expectedVersion: number | undefined): Promise<void> {
    try { await this.audit.record({ action, resourceType: 'supplier_relationship', resourceId, riskLevel, outcome: 'failure', metadata: expectedVersion === undefined ? {} : { expectedVersion } }); }
    catch { this.logger.error({ code: 'SUPPLIER_FAILURE_AUDIT_WRITE_FAILED', action, resourceId }); }
  }
}
