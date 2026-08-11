import { BadRequestException, Body, Controller, Get, Headers, Logger, Put, Res } from '@nestjs/common';
import type { Response } from 'express';

import { AuditService } from '../../core/audit/audit.service.js';
import { RequiredScopes } from '../identity/auth.decorators.js';
import { ReplaceSupplierCapabilitiesDto, ReplaceSupplierRatesDto } from './application/supplier.dto.js';
import { SupplierService } from './application/supplier.service.js';

const KEY = /^[A-Za-z0-9._:-]{8,128}$/u;
const ETAG = /^"([1-9][0-9]*)"$/u;
type WriteResult = { readonly supplier: { readonly id: string; readonly version: number; readonly status: string } };

/** 供应方本人入口；供应方标识只从可信 actor 成员关系解析，不接受客户端上报。 */
@Controller('supplier-self')
export class SupplierSelfController {
  private readonly logger = new Logger(SupplierSelfController.name);
  constructor(private readonly suppliers: SupplierService, private readonly audit: AuditService) {}

  @Get('profile')
  @RequiredScopes('erp:supplier:self:read')
  async profile(@Res({ passthrough: true }) response: Response) {
    const supplier = await this.suppliers.getSelf();
    response.setHeader('ETag', `"${supplier.version}"`);
    return { supplier };
  }

  @Put('capabilities')
  @RequiredScopes('erp:supplier:self:catalog:write')
  capabilities(
    @Headers('if-match') version: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: ReplaceSupplierCapabilitiesDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const expected = this.version(version); const idempotencyKey = this.key(key);
    return this.write(response, 'supplier.self.capabilities.replace', expected,
      () => this.suppliers.replaceCapabilitiesSelf(expected, idempotencyKey, body));
  }

  @Put('rates')
  @RequiredScopes('erp:supplier:self:catalog:write')
  rates(
    @Headers('if-match') version: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: ReplaceSupplierRatesDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const expected = this.version(version); const idempotencyKey = this.key(key);
    return this.write(response, 'supplier.self.rates.replace', expected,
      () => this.suppliers.replaceRatesSelf(expected, idempotencyKey, body));
  }

  private async write(
    response: Response, action: string, expectedVersion: number,
    operation: () => Promise<WriteResult>,
  ) {
    let result: WriteResult;
    try { result = await operation(); } catch (error) {
      try {
        await this.audit.record({
          action, resourceType: 'supplier_relationship', resourceId: 'self',
          riskLevel: 'R1', outcome: 'failure', metadata: { expectedVersion },
        });
      } catch { this.logger.error({ code: 'SUPPLIER_SELF_FAILURE_AUDIT_FAILED', action }); }
      throw error;
    }
    response.setHeader('ETag', `"${result.supplier.version}"`);
    try {
      await this.audit.record({
        action, resourceType: 'supplier_relationship', resourceId: result.supplier.id,
        riskLevel: 'R1', outcome: 'success',
        metadata: { version: result.supplier.version, status: result.supplier.status },
      });
    } catch {
      this.logger.error({ code: 'SUPPLIER_SELF_COMMITTED_AUDIT_FAILED', action, resourceId: result.supplier.id });
    }
    return result;
  }

  private key(value: unknown): string {
    if (typeof value !== 'string' || !KEY.test(value)) {
      throw new BadRequestException({ code: 'IDEMPOTENCY_KEY_REQUIRED', message: '写接口必须提供规范幂等键' });
    }
    return value;
  }
  private version(value: unknown): number {
    const match = typeof value === 'string' ? ETAG.exec(value) : null;
    const parsed = Number(match?.[1]);
    if (match === null || !Number.isSafeInteger(parsed) || parsed >= Number.MAX_SAFE_INTEGER) {
      throw new BadRequestException({ code: 'SUPPLIER_SELF_IF_MATCH_REQUIRED', message: '写接口必须提供强 If-Match' });
    }
    return parsed;
  }
}
