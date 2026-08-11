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
  BindTreasuryInstructionDto,
  EmptyPayableActionDto,
  MaterializePayableDto,
  PayableEvidenceDto,
  PayableSearchDto,
  SettlePayableDto,
} from './application/payable.dto.js';
import { PayableService } from './application/payable.service.js';

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const KEY = /^[A-Za-z0-9._:-]{8,128}$/u;
const ETAG = /^"([1-9][0-9]*)"$/u;
type WriteResult = {
  readonly payable: { readonly id: string; readonly version: number; readonly status: string };
};

/** 应付 REST 边界；资金终态提交后的审计故障不得反向改变响应。 */
@Controller('payables')
export class PayableController {
  private readonly logger = new Logger(PayableController.name);

  constructor(
    private readonly payables: PayableService,
    private readonly audit: AuditService,
  ) {}

  @Post('materialize')
  @RequiredScopes('erp:payables:materialize')
  materialize(
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: MaterializePayableDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const idempotencyKey = this.key(key);
    return this.write(response, 'payables.item.materialize', 'R2', undefined, 'new', () =>
      this.payables.materialize(idempotencyKey, body),
    );
  }

  @Get()
  @RequiredScopes('erp:payables:management:read')
  search(@Query() query: PayableSearchDto) {
    return this.payables.search(query);
  }

  @Get(':id')
  @RequiredScopes('erp:payables:management:read')
  async get(@Param('id') id: string, @Res({ passthrough: true }) response: Response) {
    const payable = await this.payables.get(this.id(id));
    this.etag(response, payable.version);
    return { payable };
  }

  @Post(':id/submit')
  @RequiredScopes('erp:payables:management:write')
  submit(
    @Param('id') id: string,
    @Headers('if-match') version: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: EmptyPayableActionDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.empty(body);
    return this.transition(response, id, version, key, 'payables.item.submit', 'R2',
      (resourceId, expected, idempotencyKey) =>
        this.payables.submit(resourceId, expected, idempotencyKey));
  }

  @Post(':id/approve')
  @RequiredScopes('erp:payables:management:decide')
  approve(
    @Param('id') id: string,
    @Headers('if-match') version: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: PayableEvidenceDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.transition(response, id, version, key, 'payables.item.approve', 'R2',
      (resourceId, expected, idempotencyKey) =>
        this.payables.approve(resourceId, expected, idempotencyKey, body));
  }

  @Post(':id/treasury-instruction')
  @RequiredScopes('erp:payables:treasury:bind')
  bind(
    @Param('id') id: string,
    @Headers('if-match') version: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: BindTreasuryInstructionDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.transition(response, id, version, key, 'payables.item.bind_treasury', 'R3',
      (resourceId, expected, idempotencyKey) =>
        this.payables.bindTreasury(resourceId, expected, idempotencyKey, body));
  }

  @Post(':id/settlements')
  @RequiredScopes('erp:payables:treasury:settle')
  settle(
    @Param('id') id: string,
    @Headers('if-match') version: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: SettlePayableDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.transition(response, id, version, key, 'payables.item.settle', 'R3',
      (resourceId, expected, idempotencyKey) =>
        this.payables.settle(resourceId, expected, idempotencyKey, body));
  }

  private transition(
    response: Response,
    id: unknown,
    version: unknown,
    key: unknown,
    action: string,
    riskLevel: 'R2' | 'R3',
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
    riskLevel: 'R2' | 'R3',
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
    this.etag(response, result.payable.version);
    try {
      await this.audit.record({
        action,
        resourceType: 'supplier_payable',
        resourceId: result.payable.id,
        riskLevel,
        outcome: 'success',
        metadata: { version: result.payable.version, status: result.payable.status },
      });
    } catch {
      this.logger.error({
        code: 'PAYABLE_COMMITTED_AUDIT_WRITE_FAILED',
        action,
        resourceId: result.payable.id,
      });
    }
    return result;
  }

  private async failureAudit(
    action: string,
    resourceId: string,
    riskLevel: 'R2' | 'R3',
    expectedVersion: number | undefined,
  ): Promise<void> {
    try {
      await this.audit.record({
        action,
        resourceType: 'supplier_payable',
        resourceId,
        riskLevel,
        outcome: 'failure',
        metadata: expectedVersion === undefined ? {} : { expectedVersion },
      });
    } catch {
      this.logger.error({ code: 'PAYABLE_FAILURE_AUDIT_WRITE_FAILED', action, resourceId });
    }
  }

  private id(value: unknown): string {
    if (typeof value !== 'string' || !ULID.test(value)) {
      throw new BadRequestException({ code: 'PAYABLE_ID_INVALID', message: '资源标识必须为严格 ULID' });
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
      throw new BadRequestException({ code: 'PAYABLE_IF_MATCH_REQUIRED', message: '写接口必须提供强 If-Match' });
    }
    return parsed;
  }

  private empty(value: unknown): void {
    if (value === undefined) return;
    let valid: boolean;
    try {
      const prototype: unknown = Object.getPrototypeOf(value);
      valid = typeof value === 'object' && value !== null && !Array.isArray(value) &&
        (prototype === Object.prototype || prototype === EmptyPayableActionDto.prototype) &&
        Reflect.ownKeys(value).length === 0;
    } catch {
      valid = false;
    }
    if (!valid) {
      throw new BadRequestException({ code: 'PAYABLE_BODY_FORBIDDEN', message: '该操作不接受正文' });
    }
  }

  private etag(response: Response, version: number): void {
    response.setHeader('ETag', `"${version}"`);
  }
}
