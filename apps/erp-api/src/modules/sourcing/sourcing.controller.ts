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
  AwardSourcingDto,
  CancelSourcingDto,
  CreateSourcingDraftDto,
  EmptySourcingActionDto,
  RecordSourcingResponseDto,
  SourcingApprovalDto,
  SourcingSearchDto,
} from './application/sourcing.dto.js';
import { SourcingService } from './application/sourcing.service.js';

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const KEY = /^[A-Za-z0-9._:-]{8,128}$/u;
const ETAG = /^"([1-9][0-9]*)"$/u;
type WriteResult = {
  readonly request: { readonly id: string; readonly version: number; readonly status: string };
};

/** 寻源 REST 边界；事务提交后的审计故障只记录稳定告警。 */
@Controller('sourcing/requests')
export class SourcingController {
  private readonly logger = new Logger(SourcingController.name);

  constructor(
    private readonly sourcing: SourcingService,
    private readonly audit: AuditService,
  ) {}

  @Post()
  @RequiredScopes('erp:sourcing:management:write')
  create(
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: CreateSourcingDraftDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const idempotencyKey = this.key(key);
    return this.write(response, 'sourcing.request.create', 'R1', undefined, 'new', () =>
      this.sourcing.createDraft(idempotencyKey, body),
    );
  }

  @Get()
  @RequiredScopes('erp:sourcing:management:read')
  search(@Query() query: SourcingSearchDto) {
    return this.sourcing.search(query);
  }

  @Get(':id')
  @RequiredScopes('erp:sourcing:management:read')
  async get(
    @Param('id') id: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const request = await this.sourcing.get(this.id(id));
    this.etag(response, request.version);
    return { request };
  }

  @Post(':id/submit')
  @RequiredScopes('erp:sourcing:management:write')
  submit(
    @Param('id') id: string,
    @Headers('if-match') version: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: EmptySourcingActionDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.empty(body);
    return this.transition(response, id, version, key, 'sourcing.request.submit', 'R1',
      (resourceId, expected, idempotencyKey) =>
        this.sourcing.submit(resourceId, expected, idempotencyKey));
  }

  @Post(':id/publish')
  @RequiredScopes('erp:sourcing:management:decide')
  publish(
    @Param('id') id: string,
    @Headers('if-match') version: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: SourcingApprovalDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.transition(response, id, version, key, 'sourcing.request.publish', 'R2',
      (resourceId, expected, idempotencyKey) =>
        this.sourcing.publish(resourceId, expected, idempotencyKey, body));
  }

  @Post(':id/responses')
  @RequiredScopes('erp:sourcing:response:record')
  recordResponse(
    @Param('id') id: string,
    @Headers('if-match') version: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: RecordSourcingResponseDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.transition(response, id, version, key, 'sourcing.request.record_response', 'R1',
      (resourceId, expected, idempotencyKey) =>
        this.sourcing.recordResponse(resourceId, expected, idempotencyKey, body));
  }

  @Post(':id/start-evaluation')
  @RequiredScopes('erp:sourcing:management:decide')
  evaluate(
    @Param('id') id: string,
    @Headers('if-match') version: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: EmptySourcingActionDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.empty(body);
    return this.transition(response, id, version, key, 'sourcing.request.start_evaluation', 'R2',
      (resourceId, expected, idempotencyKey) =>
        this.sourcing.startEvaluation(resourceId, expected, idempotencyKey));
  }

  @Post(':id/award')
  @RequiredScopes('erp:sourcing:management:decide')
  award(
    @Param('id') id: string,
    @Headers('if-match') version: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: AwardSourcingDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.transition(response, id, version, key, 'sourcing.request.award', 'R2',
      (resourceId, expected, idempotencyKey) =>
        this.sourcing.award(resourceId, expected, idempotencyKey, body));
  }

  @Post(':id/cancel')
  @RequiredScopes('erp:sourcing:management:decide')
  cancel(
    @Param('id') id: string,
    @Headers('if-match') version: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: CancelSourcingDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.transition(response, id, version, key, 'sourcing.request.cancel', 'R2',
      (resourceId, expected, idempotencyKey) =>
        this.sourcing.cancel(resourceId, expected, idempotencyKey, body));
  }

  @Post(':id/close')
  @RequiredScopes('erp:sourcing:management:decide')
  close(
    @Param('id') id: string,
    @Headers('if-match') version: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: EmptySourcingActionDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.empty(body);
    return this.transition(response, id, version, key, 'sourcing.request.close', 'R2',
      (resourceId, expected, idempotencyKey) =>
        this.sourcing.close(resourceId, expected, idempotencyKey));
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
    this.etag(response, result.request.version);
    try {
      await this.audit.record({
        action,
        resourceType: 'sourcing_request',
        resourceId: result.request.id,
        riskLevel,
        outcome: 'success',
        metadata: { version: result.request.version, status: result.request.status },
      });
    } catch {
      this.logger.error({
        code: 'SOURCING_COMMITTED_AUDIT_WRITE_FAILED',
        action,
        resourceId: result.request.id,
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
        resourceType: 'sourcing_request',
        resourceId,
        riskLevel,
        outcome: 'failure',
        metadata: expectedVersion === undefined ? {} : { expectedVersion },
      });
    } catch {
      this.logger.error({ code: 'SOURCING_FAILURE_AUDIT_WRITE_FAILED', action, resourceId });
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
    const match = typeof value === 'string' ? ETAG.exec(value) : null;
    const parsed = Number(match?.[1]);
    if (match === null || !Number.isSafeInteger(parsed) || parsed >= Number.MAX_SAFE_INTEGER) {
      throw new BadRequestException({ code: 'SOURCING_IF_MATCH_REQUIRED', message: '写接口必须提供强 If-Match' });
    }
    return parsed;
  }

  private empty(value: unknown): void {
    if (value === undefined) return;
    let valid: boolean;
    try {
      const prototype: unknown = Object.getPrototypeOf(value);
      valid = typeof value === 'object' && value !== null && !Array.isArray(value) &&
        (prototype === Object.prototype || prototype === EmptySourcingActionDto.prototype) &&
        Reflect.ownKeys(value).length === 0;
    } catch {
      valid = false;
    }
    if (!valid) {
      throw new BadRequestException({ code: 'SOURCING_BODY_FORBIDDEN', message: '该操作不接受请求正文' });
    }
  }

  private etag(response: Response, version: number): void {
    response.setHeader('ETag', `"${version}"`);
  }
}
