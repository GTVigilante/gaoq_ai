import {
  BadRequestException, Body, Controller, Get, Headers, Logger, Param, Post, Query, Res,
} from '@nestjs/common';
import type { Response } from 'express';

import { AuditService } from '../../core/audit/audit.service.js';
import { RequiredScopes } from '../identity/auth.decorators.js';
import {
  SupplierSelfDeliveryDto, SupplierSelfEngagementSearchDto,
} from './application/engagement.dto.js';
import { EngagementService } from './application/engagement.service.js';

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const KEY = /^[A-Za-z0-9._:-]{8,128}$/u;
const ETAG = /^"([1-9][0-9]*)"$/u;

/** 本人履约入口；供应方和履约者均从当前成员授权解析。 */
@Controller('supplier-self/engagements')
export class SupplierSelfEngagementController {
  private readonly logger = new Logger(SupplierSelfEngagementController.name);
  constructor(private readonly engagements: EngagementService, private readonly audit: AuditService) {}

  @Get()
  @RequiredScopes('erp:supplier:self:engagements:read')
  list(@Query() query: SupplierSelfEngagementSearchDto) { return this.engagements.listSelf(query); }

  @Post(':id/deliveries')
  @RequiredScopes('erp:supplier:self:delivery:write')
  deliver(
    @Param('id') id: string, @Headers('if-match') version: string | undefined,
    @Headers('idempotency-key') key: string | undefined, @Body() body: SupplierSelfDeliveryDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.body(body); const resourceId = this.id(id); const expected = this.version(version);
    const idempotencyKey = this.key(key);
    return this.write(response, resourceId, expected, () =>
      this.engagements.deliverSelf(resourceId, expected, idempotencyKey, body));
  }

  private async write(
    response: Response, resourceId: string, expectedVersion: number,
    operation: () => Promise<{ readonly engagement: { readonly id: string; readonly version: number; readonly status: string } }>,
  ) {
    let result: Awaited<ReturnType<typeof operation>>;
    try { result = await operation(); } catch (error) {
      try {
        await this.audit.record({
          action: 'engagement.self.deliver', resourceType: 'service_engagement', resourceId,
          riskLevel: 'R1', outcome: 'failure', metadata: { expectedVersion },
        });
      } catch { this.logger.error({ code: 'ENGAGEMENT_SELF_FAILURE_AUDIT_FAILED', resourceId }); }
      throw error;
    }
    response.setHeader('ETag', `"${result.engagement.version}"`);
    try {
      await this.audit.record({
        action: 'engagement.self.deliver', resourceType: 'service_engagement',
        resourceId: result.engagement.id, riskLevel: 'R1', outcome: 'success',
        metadata: { version: result.engagement.version, status: result.engagement.status },
      });
    } catch {
      this.logger.error({
        code: 'ENGAGEMENT_SELF_COMMITTED_AUDIT_FAILED', resourceId: result.engagement.id,
      });
    }
    return result;
  }

  private body(value: unknown): void {
    let valid: boolean;
    try {
      const prototype: unknown = Object.getPrototypeOf(value);
      valid = typeof value === 'object' && value !== null && !Array.isArray(value) &&
        (prototype === Object.prototype || prototype === SupplierSelfDeliveryDto.prototype) &&
        Reflect.ownKeys(value).length === 1 && Object.hasOwn(value, 'artifactRef');
    } catch { valid = false; }
    if (!valid) throw new BadRequestException({
      code: 'ENGAGEMENT_SELF_DELIVERY_BODY_INVALID', message: '交付正文只能包含受控成果引用',
    });
  }
  private id(value: unknown): string {
    if (typeof value !== 'string' || !ULID.test(value)) throw new BadRequestException({ code: 'ENGAGEMENT_ID_INVALID', message: '资源标识必须为严格 ULID' }); return value;
  }
  private key(value: unknown): string {
    if (typeof value !== 'string' || !KEY.test(value)) throw new BadRequestException({ code: 'IDEMPOTENCY_KEY_REQUIRED', message: '写接口必须提供规范幂等键' }); return value;
  }
  private version(value: unknown): number {
    const matched = typeof value === 'string' ? ETAG.exec(value) : null;
    const parsed = Number(matched?.[1]);
    if (matched === null || !Number.isSafeInteger(parsed) || parsed >= Number.MAX_SAFE_INTEGER) throw new BadRequestException({ code: 'ENGAGEMENT_IF_MATCH_REQUIRED', message: '写接口必须提供强 If-Match' }); return parsed;
  }
}
