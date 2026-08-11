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
  CreateEngagementDto,
  EmptyEngagementActionDto,
  EngagementDeliveryDto,
  EngagementEvidenceDto,
  EngagementReasonDto,
  EngagementSearchDto,
} from './application/engagement.dto.js';
import { EngagementService } from './application/engagement.service.js';

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const KEY = /^[A-Za-z0-9._:-]{8,128}$/u;
const ETAG = /^"([1-9][0-9]*)"$/u;
type WriteResult = {
  readonly engagement: { readonly id: string; readonly version: number; readonly status: string };
};

/** 履约 REST 边界；已提交的交付、验收和争议事实不受审计存储故障反向影响。 */
@Controller('engagements')
export class EngagementController {
  private readonly logger = new Logger(EngagementController.name);

  constructor(
    private readonly engagements: EngagementService,
    private readonly audit: AuditService,
  ) {}

  @Post()
  @RequiredScopes('erp:engagement:management:write')
  create(
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: CreateEngagementDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const idempotencyKey = this.key(key);
    return this.write(response, 'engagement.service.create', 'R1', undefined, 'new', () =>
      this.engagements.create(idempotencyKey, body),
    );
  }

  @Get()
  @RequiredScopes('erp:engagement:management:read')
  search(@Query() query: EngagementSearchDto) {
    return this.engagements.search(query);
  }

  @Get(':id')
  @RequiredScopes('erp:engagement:management:read')
  async get(@Param('id') id: string, @Res({ passthrough: true }) response: Response) {
    const engagement = await this.engagements.get(this.id(id));
    this.etag(response, engagement.version);
    return { engagement };
  }

  @Post(':id/submit')
  @RequiredScopes('erp:engagement:management:write')
  submit(
    @Param('id') id: string,
    @Headers('if-match') version: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: EmptyEngagementActionDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.empty(body);
    return this.transition(response, id, version, key, 'engagement.service.submit', 'R1',
      (resourceId, expected, idempotencyKey) =>
        this.engagements.submit(resourceId, expected, idempotencyKey));
  }

  @Post(':id/approve')
  @RequiredScopes('erp:engagement:management:decide')
  approve(
    @Param('id') id: string,
    @Headers('if-match') version: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: EngagementEvidenceDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.transition(response, id, version, key, 'engagement.service.approve', 'R2',
      (resourceId, expected, idempotencyKey) =>
        this.engagements.approve(resourceId, expected, idempotencyKey, body));
  }

  @Post(':id/activate')
  @RequiredScopes('erp:engagement:management:decide')
  activate(
    @Param('id') id: string,
    @Headers('if-match') version: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: EngagementEvidenceDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.transition(response, id, version, key, 'engagement.service.activate', 'R2',
      (resourceId, expected, idempotencyKey) =>
        this.engagements.activate(resourceId, expected, idempotencyKey, body));
  }

  @Post(':id/deliveries')
  @RequiredScopes('erp:engagement:delivery:record')
  deliver(
    @Param('id') id: string,
    @Headers('if-match') version: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: EngagementDeliveryDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.transition(response, id, version, key, 'engagement.service.deliver', 'R1',
      (resourceId, expected, idempotencyKey) =>
        this.engagements.deliver(resourceId, expected, idempotencyKey, body));
  }

  @Post(':id/accept')
  @RequiredScopes('erp:engagement:management:accept')
  accept(
    @Param('id') id: string,
    @Headers('if-match') version: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: EngagementEvidenceDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.transition(response, id, version, key, 'engagement.service.accept', 'R2',
      (resourceId, expected, idempotencyKey) =>
        this.engagements.accept(resourceId, expected, idempotencyKey, body));
  }

  @Post(':id/dispute')
  @RequiredScopes('erp:engagement:management:decide')
  dispute(
    @Param('id') id: string,
    @Headers('if-match') version: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: EngagementReasonDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.transition(response, id, version, key, 'engagement.service.dispute', 'R2',
      (resourceId, expected, idempotencyKey) =>
        this.engagements.dispute(resourceId, expected, idempotencyKey, body));
  }

  @Post(':id/cancel')
  @RequiredScopes('erp:engagement:management:decide')
  cancel(
    @Param('id') id: string,
    @Headers('if-match') version: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: EngagementReasonDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.transition(response, id, version, key, 'engagement.service.cancel', 'R2',
      (resourceId, expected, idempotencyKey) =>
        this.engagements.cancel(resourceId, expected, idempotencyKey, body));
  }

  private transition(
    response: Response,
    id: unknown,
    version: unknown,
    key: unknown,
    action: string,
    riskLevel: 'R1' | 'R2',
    operation: (resourceId: string, expected: number, idempotencyKey: string) => Promise<WriteResult>,
  ) {
    const resourceId = this.id(id);
    const expected = this.version(version);
    const idempotencyKey = this.key(key);
    return this.write(response, action, riskLevel, expected, resourceId, () =>
      operation(resourceId, expected, idempotencyKey),
    );
  }

  private async write(
    response: Response,
    action: string,
    riskLevel: 'R1' | 'R2',
    expectedVersion: number | undefined,
    resourceId: string,
    operation: () => Promise<WriteResult>,
  ) {
    let result: WriteResult;
    try {
      result = await operation();
    } catch (error) {
      await this.failureAudit(action, resourceId, riskLevel, expectedVersion);
      throw error;
    }
    this.etag(response, result.engagement.version);
    try {
      await this.audit.record({
        action,
        resourceType: 'service_engagement',
        resourceId: result.engagement.id,
        riskLevel,
        outcome: 'success',
        metadata: { version: result.engagement.version, status: result.engagement.status },
      });
    } catch {
      this.logger.error({
        code: 'ENGAGEMENT_COMMITTED_AUDIT_WRITE_FAILED',
        action,
        resourceId: result.engagement.id,
      });
    }
    return result;
  }

  private async failureAudit(
    action: string,
    resourceId: string,
    riskLevel: 'R1' | 'R2',
    expectedVersion: number | undefined,
  ): Promise<void> {
    try {
      await this.audit.record({
        action,
        resourceType: 'service_engagement',
        resourceId,
        riskLevel,
        outcome: 'failure',
        metadata: expectedVersion === undefined ? {} : { expectedVersion },
      });
    } catch {
      this.logger.error({ code: 'ENGAGEMENT_FAILURE_AUDIT_WRITE_FAILED', action, resourceId });
    }
  }

  private id(value: unknown): string {
    if (typeof value !== 'string' || !ULID.test(value)) {
      throw new BadRequestException({ code: 'ENGAGEMENT_ID_INVALID', message: '资源标识必须为严格 ULID' });
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
    const match = typeof value === 'string' ? ETAG.exec(value) : null;
    const parsed = Number(match?.[1]);
    if (match === null || !Number.isSafeInteger(parsed) || parsed >= Number.MAX_SAFE_INTEGER) {
      throw new BadRequestException({ code: 'ENGAGEMENT_IF_MATCH_REQUIRED', message: '写接口必须提供强 If-Match' });
    }
    return parsed;
  }

  private empty(value: unknown): void {
    if (value === undefined) return;
    let valid: boolean;
    try {
      const prototype: unknown = Object.getPrototypeOf(value);
      valid = typeof value === 'object' && value !== null && !Array.isArray(value) &&
        (prototype === Object.prototype || prototype === EmptyEngagementActionDto.prototype) &&
        Reflect.ownKeys(value).length === 0;
    } catch {
      valid = false;
    }
    if (!valid) {
      throw new BadRequestException({ code: 'ENGAGEMENT_BODY_FORBIDDEN', message: '该操作不接受正文' });
    }
  }

  private etag(response: Response, version: number): void {
    response.setHeader('ETag', `"${version}"`);
  }
}
