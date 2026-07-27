import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';

import { AuditService } from '../../core/audit/audit.service.js';
import { RequiredScopes } from '../identity/auth.decorators.js';
import {
  CloseTalentTouchpointDto,
  CreateTalentTouchpointDto,
  ListTalentLifecycleDto,
} from './application/talent-lifecycle.dto.js';
import {
  TalentLifecycleService,
  type TalentLifecycleDetail,
  type TalentLifecycleSummary,
  type TalentTouchpointMutationView,
} from './application/talent-lifecycle.service.js';

const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const IF_MATCH_PATTERN = /^"([1-9][0-9]*)"$/;

/** 人才全周期 REST：跨域只读全景，写操作仅限本模块服务触点。 */
@Controller('talent-lifecycle')
export class TalentLifecycleController {
  constructor(
    private readonly lifecycle: TalentLifecycleService,
    private readonly audit: AuditService,
  ) {}

  @Get('people')
  @RequiredScopes('erp:talent-lifecycle:read')
  list(
    @Query() query: ListTalentLifecycleDto,
  ): Promise<{ readonly items: readonly TalentLifecycleSummary[] }> {
    return this.lifecycle.list(query);
  }

  @Get('people/:candidateId')
  @RequiredScopes('erp:talent-lifecycle:read')
  get(
    @Param('candidateId') candidateId: string,
  ): Promise<TalentLifecycleDetail> {
    return this.lifecycle.get(this.ulid(candidateId));
  }

  @Post('people/:candidateId/touchpoints')
  @RequiredScopes(
    'erp:talent-lifecycle:read',
    'erp:talent-lifecycle:touchpoint:write',
  )
  async createTouchpoint(
    @Param('candidateId') candidateId: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: CreateTalentTouchpointDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ readonly touchpoint: TalentTouchpointMutationView }> {
    const result = await this.lifecycle.createTouchpoint(
      this.ulid(candidateId),
      this.key(key),
      body,
    );
    this.etag(response, result.touchpoint.version);
    await this.audit.record({
      action: 'talent.lifecycle.touchpoint.create',
      resourceType: 'talent_touchpoint',
      resourceId: result.touchpoint.id,
      riskLevel: 'R2',
      outcome: 'success',
      metadata: {
        candidateId: result.touchpoint.candidateId,
        kind: result.touchpoint.kind,
        channel: result.touchpoint.channel,
        outcome: result.touchpoint.outcome,
        status: result.touchpoint.status,
      },
    });
    return result;
  }

  @Post('touchpoints/:id/close')
  @HttpCode(200)
  @RequiredScopes(
    'erp:talent-lifecycle:read',
    'erp:talent-lifecycle:touchpoint:write',
  )
  async closeTouchpoint(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: CloseTalentTouchpointDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ readonly touchpoint: TalentTouchpointMutationView }> {
    const result = await this.lifecycle.closeTouchpoint(
      this.ulid(id),
      this.version(ifMatch),
      this.key(key),
      body,
    );
    this.etag(response, result.touchpoint.version);
    await this.audit.record({
      action: 'talent.lifecycle.touchpoint.close',
      resourceType: 'talent_touchpoint',
      resourceId: result.touchpoint.id,
      riskLevel: 'R2',
      outcome: 'success',
      metadata: {
        candidateId: result.touchpoint.candidateId,
        status: result.touchpoint.status,
        version: result.touchpoint.version,
      },
    });
    return result;
  }

  private ulid(value: string): string {
    if (!ULID_PATTERN.test(value)) throw new BadRequestException({
      code: 'TALENT_LIFECYCLE_ID_INVALID',
      message: '人才全周期资源标识必须为严格 ULID',
    });
    return value;
  }

  private key(value: string | undefined): string {
    if (value === undefined || value.length === 0) throw new BadRequestException({
      code: 'IDEMPOTENCY_KEY_REQUIRED',
      message: '写接口必须提供 Idempotency-Key',
    });
    return value;
  }

  private version(value: string | undefined): number {
    const match = IF_MATCH_PATTERN.exec(value ?? '');
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
}
