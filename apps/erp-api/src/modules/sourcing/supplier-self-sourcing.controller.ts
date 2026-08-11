import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Logger,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';

import { AuditService } from '../../core/audit/audit.service.js';
import { RequiredScopes } from '../identity/auth.decorators.js';
import {
  SupplierSelfOpportunitySearchDto,
  SupplierSelfSourcingResponseDto,
} from './application/sourcing.dto.js';
import { SourcingService } from './application/sourcing.service.js';

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const KEY = /^[A-Za-z0-9._:-]{8,128}$/u;
const ETAG = /^"([1-9][0-9]*)"$/u;

/** 供应方本人商机入口；供应方标识完全由可信成员关系解析。 */
@Controller('supplier-self/opportunities')
export class SupplierSelfSourcingController {
  private readonly logger = new Logger(SupplierSelfSourcingController.name);

  constructor(
    private readonly sourcing: SourcingService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequiredScopes('erp:supplier:self:opportunities:read')
  list(@Query() query: SupplierSelfOpportunitySearchDto) {
    return this.sourcing.listSelfOpportunities(query);
  }

  @Post(':id/responses')
  @RequiredScopes('erp:supplier:self:response:write')
  response(
    @Param('id') id: string,
    @Headers('if-match') version: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: SupplierSelfSourcingResponseDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.exactBody(body);
    const resourceId = this.id(id);
    const expected = this.version(version);
    const idempotencyKey = this.key(key);
    return this.write(response, resourceId, expected, () =>
      this.sourcing.recordSelfResponse(resourceId, expected, idempotencyKey, body),
    );
  }

  private async write(
    response: Response,
    resourceId: string,
    expectedVersion: number,
    operation: () => Promise<{
      readonly request: { readonly id: string; readonly version: number; readonly status: string };
    }>,
  ) {
    let result: Awaited<ReturnType<typeof operation>>;
    try {
      result = await operation();
    } catch (error) {
      try {
        await this.audit.record({
          action: 'sourcing.self.response.record', resourceType: 'sourcing_request',
          resourceId, riskLevel: 'R1', outcome: 'failure', metadata: { expectedVersion },
        });
      } catch {
        this.logger.error({
          code: 'SOURCING_SELF_FAILURE_AUDIT_WRITE_FAILED',
          action: 'sourcing.self.response.record', resourceId,
        });
      }
      throw error;
    }
    response.setHeader('ETag', `"${result.request.version}"`);
    try {
      await this.audit.record({
        action: 'sourcing.self.response.record', resourceType: 'sourcing_request',
        resourceId: result.request.id, riskLevel: 'R1', outcome: 'success',
        metadata: { version: result.request.version, status: result.request.status },
      });
    } catch {
      this.logger.error({
        code: 'SOURCING_SELF_COMMITTED_AUDIT_WRITE_FAILED',
        action: 'sourcing.self.response.record', resourceId: result.request.id,
      });
    }
    return result;
  }

  private exactBody(value: unknown): void {
    let valid: boolean;
    try {
      const prototype: unknown = Object.getPrototypeOf(value);
      valid = typeof value === 'object' && value !== null && !Array.isArray(value) &&
        (prototype === Object.prototype || prototype === SupplierSelfSourcingResponseDto.prototype) &&
        Reflect.ownKeys(value).length === 2 &&
        Object.hasOwn(value, 'quotationMinor') && Object.hasOwn(value, 'proposalRef');
    } catch { valid = false; }
    if (!valid) {
      throw new BadRequestException({
        code: 'SOURCING_SELF_RESPONSE_BODY_INVALID',
        message: '响应正文必须只包含报价和方案证据引用',
      });
    }
  }

  private id(value: unknown): string {
    if (typeof value !== 'string' || !ULID.test(value)) {
      throw new BadRequestException({ code: 'SOURCING_ID_INVALID', message: '资源标识必须为严格 ULID' });
    }
    return value;
  }

  private key(value: unknown): string {
    if (typeof value !== 'string' || !KEY.test(value)) {
      throw new BadRequestException({ code: 'IDEMPOTENCY_KEY_REQUIRED', message: '写接口必须提供规范幂等键' });
    }
    return value;
  }

  private version(value: unknown): number {
    const matched = typeof value === 'string' ? ETAG.exec(value) : null;
    const parsed = Number(matched?.[1]);
    if (matched === null || !Number.isSafeInteger(parsed) || parsed >= Number.MAX_SAFE_INTEGER) {
      throw new BadRequestException({
        code: 'SOURCING_IF_MATCH_REQUIRED', message: '写接口必须提供强 If-Match',
      });
    }
    return parsed;
  }
}
