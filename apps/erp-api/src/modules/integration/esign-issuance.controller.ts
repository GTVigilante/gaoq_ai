import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Logger,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ULID_PATTERN } from '@gaoq/shared-utils';

import {
  eSignIssuanceRequestSchema,
  eSignIssuanceResolutionRequestSchema,
} from '../../contracts/rest-request-contracts.js';
import { AuditService } from '../../core/audit/audit.service.js';
import { RequiredScopes } from '../identity/auth.decorators.js';
import {
  ESignIssuanceService,
  type ESignIssuanceResolutionReason,
} from './esign-issuance.service.js';

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

/**
 * eSign 发起与人工核验 REST。
 * 包含个人身份和外部副作用，永久禁止注册为 MCP Tool、Resource 或 Prompt。
 */
@Controller('integrations/esign/issuance-requests')
export class ESignIssuanceController {
  private readonly logger = new Logger(ESignIssuanceController.name);

  constructor(
    private readonly issuance: ESignIssuanceService,
    private readonly audit: AuditService,
  ) {}

  @Post()
  @HttpCode(202)
  @RequiredScopes('erp:integration:esign:initiate')
  async request(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    const input = this.parseRequest(body);
    const metadata = { offerId: input.offerId };
    try {
      const result = await this.issuance.request({
        ...input,
        idempotencyKey: this.requireIdempotencyKey(idempotencyKey),
      });
      await this.auditSafe({
        action: 'integration.esign.issuance.request',
        resourceId: result.request.id,
        outcome: 'success',
        metadata,
      });
      return result;
    } catch (error) {
      await this.auditSafe({
        action: 'integration.esign.issuance.request',
        resourceId: input.offerId,
        outcome: 'failure',
        metadata,
      });
      throw error;
    }
  }

  @Get()
  @RequiredScopes('erp:integration:esign:operate')
  list(
    @Query('status') status: string | undefined,
    @Query('before') before: string | undefined,
    @Query('limit') limit: string | undefined,
  ) {
    return this.issuance.listTerminal({
      status: this.requireStatus(status),
      ...(before === undefined ? {} : { beforeId: this.requireUlid(before) }),
      limit: this.requireLimit(limit),
    });
  }

  @Post(':requestId/resolutions')
  @HttpCode(200)
  @RequiredScopes('erp:integration:esign:operate')
  async resolve(
    @Param('requestId') requestId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    const parsedRequestId = this.requireUlid(requestId);
    const input = this.parseResolution(body);
    const metadata = {
      decision: input.decision,
      reason: input.reason,
      providerConfirmedNotCommitted: input.providerConfirmedNotCommitted,
      providerConfirmedMatchesRequest: input.providerConfirmedMatchesRequest,
    };
    try {
      const result = await this.issuance.resolve({
        requestId: parsedRequestId,
        ...input,
        idempotencyKey: this.requireIdempotencyKey(idempotencyKey),
      });
      await this.auditSafe({
        action: 'integration.esign.issuance.resolve',
        resourceId: parsedRequestId,
        outcome: 'success',
        metadata,
      });
      return result;
    } catch (error) {
      await this.auditSafe({
        action: 'integration.esign.issuance.resolve',
        resourceId: parsedRequestId,
        outcome: 'failure',
        metadata,
      });
      throw error;
    }
  }

  private parseRequest(body: unknown): {
    readonly offerId: string;
    readonly providerFileId: string;
    readonly expiresAt: string;
    readonly signaturePosition: {
      readonly page: number;
      readonly x: number;
      readonly y: number;
    };
  } {
    if (
      !hasExactKeys(body, ['offerId', 'providerFileId', 'expiresAt', 'signaturePosition']) ||
      !hasExactKeys(body.signaturePosition, ['page', 'x', 'y'])
    ) {
      throw new BadRequestException({
        code: 'ESIGN_ISSUANCE_REQUEST_INVALID',
        message: 'eSign 发起请求结构无效',
      });
    }
    const parsed = eSignIssuanceRequestSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException({
      code: 'ESIGN_ISSUANCE_REQUEST_INVALID',
      message: 'eSign 发起请求结构无效',
    });
    return parsed.data;
  }

  private parseResolution(body: unknown): {
    readonly decision: 'retry' | 'attach_external_flow';
    readonly reason: ESignIssuanceResolutionReason;
    readonly providerConfirmedNotCommitted: boolean;
    readonly providerConfirmedMatchesRequest: boolean;
    readonly externalFlowId?: string;
  } {
    if (
      !isPlainRecord(body) ||
      !Object.keys(body).every((key) => [
        'decision',
        'reason',
        'providerConfirmedNotCommitted',
        'providerConfirmedMatchesRequest',
        'externalFlowId',
      ].includes(key)) ||
      Object.keys(body).length < 4
    ) {
      throw new BadRequestException({
        code: 'ESIGN_ISSUANCE_RESOLUTION_INVALID',
        message: 'eSign 人工处置请求结构无效',
      });
    }
    const parsed = eSignIssuanceResolutionRequestSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException({
      code: 'ESIGN_ISSUANCE_RESOLUTION_INVALID',
      message: 'eSign 人工处置请求结构无效',
    });
    return {
      decision: parsed.data.decision,
      reason: parsed.data.reason,
      providerConfirmedNotCommitted: parsed.data.providerConfirmedNotCommitted,
      providerConfirmedMatchesRequest: parsed.data.providerConfirmedMatchesRequest,
      ...(parsed.data.externalFlowId === undefined
        ? {}
        : { externalFlowId: parsed.data.externalFlowId }),
    };
  }

  private requireStatus(value: string | undefined): 'manual_review' | 'dead' {
    if (value === 'manual_review' || value === 'dead') return value;
    throw new BadRequestException({
      code: 'ESIGN_ISSUANCE_STATUS_INVALID',
      message: 'status 必须为 manual_review 或 dead',
    });
  }

  private requireUlid(value: string): string {
    if (ULID_PATTERN.test(value)) return value;
    throw new BadRequestException({
      code: 'ESIGN_ISSUANCE_REQUEST_ID_INVALID',
      message: '请求标识必须为严格 ULID',
    });
  }

  private requireLimit(value: string | undefined): number {
    const parsed = value === undefined ? 50 : Number(value);
    if (Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 100) return parsed;
    throw new BadRequestException({
      code: 'ESIGN_ISSUANCE_LIMIT_INVALID',
      message: 'limit 必须为 1..100',
    });
  }

  private requireIdempotencyKey(value: string | undefined): string {
    if (value !== undefined && IDEMPOTENCY_KEY_PATTERN.test(value)) return value;
    throw new BadRequestException({
      code: 'IDEMPOTENCY_KEY_REQUIRED',
      message: '必须提供合法 Idempotency-Key',
    });
  }

  private async auditSafe(input: {
    readonly action: string;
    readonly resourceId: string;
    readonly outcome: 'success' | 'failure';
    readonly metadata: Readonly<Record<string, string | number | boolean>>;
  }): Promise<void> {
    try {
      await this.audit.record({
        action: input.action,
        resourceType: 'esign_issuance_request',
        resourceId: input.resourceId,
        riskLevel: 'R2',
        outcome: input.outcome,
        metadata: input.metadata,
      });
    } catch {
      this.logger.error({
        code: 'ESIGN_ISSUANCE_HTTP_AUDIT_FAILED',
        action: input.action,
        resourceId: input.resourceId,
        outcome: input.outcome,
      });
    }
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys<K extends string>(
  value: unknown,
  keys: readonly K[],
): value is Record<K, unknown> {
  if (!isPlainRecord(value)) return false;
  const ownKeys = Reflect.ownKeys(value);
  return ownKeys.length === keys.length &&
    ownKeys.every((key) => typeof key === 'string' && keys.includes(key as K)) &&
    keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable === true && 'value' in descriptor;
    });
}
