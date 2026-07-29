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
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';

import { AuditService } from '../../core/audit/audit.service.js';
import { RequiredScopes } from '../identity/auth.decorators.js';
import {
  CloseTalentTouchpointDto,
  CreateTalentTouchpointDto,
  ListTalentLifecycleDto,
} from './application/talent-lifecycle.dto.js';
import {
  TalentLifecycleService,
  toTalentLifecyclePublicDetail,
  toTalentLifecycleSummaryView,
  toTalentTouchpointMutationView,
  type TalentLifecyclePublicDetail,
  type TalentLifecycleSummary,
  type TalentTouchpointMutationView,
} from './application/talent-lifecycle.service.js';

const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const IF_MATCH_PATTERN = /^"([1-9][0-9]*)"$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const createTouchpointSchema = z.object({
  kind: z.enum([
    'candidate_outreach', 'interview_support', 'offer_support', 'onboarding_support',
    'employee_care', 'offboarding_support', 'alumni_engagement', 'rehire_contact',
  ]),
  channel: z.enum(['email', 'phone', 'wechat', 'meeting', 'portal', 'internal']),
  direction: z.enum(['inbound', 'outbound', 'internal']),
  outcome: z.enum([
    'contacted', 'no_response', 'follow_up_required', 'resolved',
    'declined', 'joined', 'departed', 'consent_withdrawn',
  ]),
  occurredAt: z.string().refine(isCanonicalInstant),
  nextActionAt: z.string().refine(isCanonicalInstant).optional(),
  note: z.string().max(1_000).optional(),
}).strict();
const closeTouchpointSchema = z.object({
  status: z.enum(['completed', 'cancelled']),
}).strict();

/** 人才全周期 REST：跨域只读全景，写操作仅限本模块服务触点。 */
@Controller('talent-lifecycle')
export class TalentLifecycleController {
  private readonly logger = new Logger(TalentLifecycleController.name);

  constructor(
    private readonly lifecycle: TalentLifecycleService,
    private readonly audit: AuditService,
  ) {}

  @Get('people')
  @RequiredScopes('erp:talent-lifecycle:read')
  async list(
    @Query() query: ListTalentLifecycleDto,
  ): Promise<{ readonly items: readonly TalentLifecycleSummary[] }> {
    const result = await this.lifecycle.list(query);
    return Object.freeze({
      items: Object.freeze(result.items.map(toTalentLifecycleSummaryView)),
    });
  }

  @Get('people/:candidateId')
  @RequiredScopes('erp:talent-lifecycle:read')
  async get(
    @Param('candidateId') candidateId: string,
  ): Promise<TalentLifecyclePublicDetail> {
    return toTalentLifecyclePublicDetail(
      await this.lifecycle.get(this.ulid(candidateId)),
    );
  }

  @Post('people/:candidateId/touchpoints')
  @RequiredScopes(
    'erp:talent-lifecycle:read',
    'erp:talent-lifecycle:touchpoint:write',
  )
  async createTouchpoint(
    @Param('candidateId') candidateId: unknown,
    @Headers('idempotency-key') key: unknown,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ readonly touchpoint: TalentTouchpointMutationView }> {
    const targetId = this.ulid(candidateId);
    const request = this.createRequest(body);
    const idempotencyKey = this.key(key);
    let result: { readonly touchpoint: TalentTouchpointMutationView };
    try {
      result = await this.lifecycle.createTouchpoint(
        targetId,
        idempotencyKey,
        request,
      );
    } catch (error) {
      await this.auditFailure(
        'talent.lifecycle.touchpoint.create',
        'talent_candidate',
        targetId,
      );
      throw error;
    }
    this.etag(response, result.touchpoint.version);
    await this.auditAfterCommit(
      'talent.lifecycle.touchpoint.create',
      result.touchpoint.id,
      {
        candidateId: result.touchpoint.candidateId,
        kind: result.touchpoint.kind,
        channel: result.touchpoint.channel,
        outcome: result.touchpoint.outcome,
        status: result.touchpoint.status,
      },
    );
    return Object.freeze({
      touchpoint: toTalentTouchpointMutationView(result.touchpoint),
    });
  }

  @Post('touchpoints/:id/close')
  @HttpCode(200)
  @RequiredScopes(
    'erp:talent-lifecycle:read',
    'erp:talent-lifecycle:touchpoint:write',
  )
  async closeTouchpoint(
    @Param('id') id: unknown,
    @Headers('if-match') ifMatch: unknown,
    @Headers('idempotency-key') key: unknown,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ readonly touchpoint: TalentTouchpointMutationView }> {
    const targetId = this.ulid(id);
    const request = this.closeRequest(body);
    const expectedVersion = this.version(ifMatch);
    const idempotencyKey = this.key(key);
    let result: { readonly touchpoint: TalentTouchpointMutationView };
    try {
      result = await this.lifecycle.closeTouchpoint(
        targetId,
        expectedVersion,
        idempotencyKey,
        request,
      );
    } catch (error) {
      await this.auditFailure(
        'talent.lifecycle.touchpoint.close',
        'talent_touchpoint',
        targetId,
      );
      throw error;
    }
    this.etag(response, result.touchpoint.version);
    await this.auditAfterCommit(
      'talent.lifecycle.touchpoint.close',
      result.touchpoint.id,
      {
        candidateId: result.touchpoint.candidateId,
        status: result.touchpoint.status,
        version: result.touchpoint.version,
      },
    );
    return Object.freeze({
      touchpoint: toTalentTouchpointMutationView(result.touchpoint),
    });
  }

  private createRequest(value: unknown): CreateTalentTouchpointDto {
    const parsed = createTouchpointSchema.safeParse(value);
    if (parsed.success) {
      const { nextActionAt, note, ...required } = parsed.data;
      return Object.freeze({
        ...required,
        ...(nextActionAt === undefined ? {} : { nextActionAt }),
        ...(note === undefined ? {} : { note }),
      });
    }
    throw new BadRequestException({
      code: 'TALENT_TOUCHPOINT_CREATE_REQUEST_INVALID',
      message: '服务触点创建请求结构无效',
    });
  }

  private closeRequest(value: unknown): CloseTalentTouchpointDto {
    const parsed = closeTouchpointSchema.safeParse(value);
    if (parsed.success) return Object.freeze(parsed.data);
    throw new BadRequestException({
      code: 'TALENT_TOUCHPOINT_CLOSE_REQUEST_INVALID',
      message: '服务触点关闭请求结构无效',
    });
  }

  private ulid(value: unknown): string {
    if (typeof value !== 'string' || !ULID_PATTERN.test(value)) {
      throw new BadRequestException({
        code: 'TALENT_LIFECYCLE_ID_INVALID',
        message: '人才全周期资源标识必须为严格 ULID',
      });
    }
    return value;
  }

  private key(value: unknown): string {
    if (typeof value !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(value)) {
      throw new BadRequestException({
        code: 'TALENT_LIFECYCLE_IDEMPOTENCY_KEY_INVALID',
        message: 'Idempotency-Key 必须为 8..128 位白名单字符',
      });
    }
    return value;
  }

  private version(value: unknown): number {
    const match = IF_MATCH_PATTERN.exec(typeof value === 'string' ? value : '');
    const version = Number(match?.[1]);
    if (match?.[1] === undefined || !Number.isSafeInteger(version)) {
      throw new BadRequestException({
        code: 'TALENT_LIFECYCLE_IF_MATCH_REQUIRED',
        message: '写接口必须提供强 If-Match 版本，例如 "3"',
      });
    }
    return version;
  }

  private etag(response: Response, version: number): void {
    response.setHeader('ETag', `"${version}"`);
  }

  private async auditFailure(
    action: string,
    resourceType: string,
    resourceId: string,
  ): Promise<void> {
    try {
      await this.audit.record({
        action,
        resourceType,
        resourceId,
        riskLevel: 'R2',
        outcome: 'failure',
        metadata: {},
      });
    } catch {
      this.logger.error({
        code: 'TALENT_LIFECYCLE_FAILURE_AUDIT_FAILED',
        action,
        resourceId,
      });
    }
  }

  private async auditAfterCommit(
    action: string,
    resourceId: string,
    metadata: Readonly<Record<string, string | number | boolean>>,
  ): Promise<void> {
    try {
      await this.audit.record({
        action,
        resourceType: 'talent_touchpoint',
        resourceId,
        riskLevel: 'R2',
        outcome: 'success',
        metadata,
      });
    } catch {
      this.logger.error({
        code: 'TALENT_LIFECYCLE_AUDIT_AFTER_COMMIT_FAILED',
        action,
        resourceId,
      });
    }
  }
}

function isCanonicalInstant(value: string): boolean {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}
