import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';

import { AuditService } from '../../core/audit/audit.service.js';
import { RequiredScopes } from '../identity/auth.decorators.js';
import {
  RecruitmentApplicationService,
  type CandidateApplicationSummary,
} from './application/recruitment-application.service.js';
import {
  CreateCandidateApplicationDto,
  TransitionCandidateApplicationDto,
} from './application/recruitment.dto.js';

const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const IF_MATCH_PATTERN = /^"([1-9][0-9]*)"$/;

/** 招聘 REST 接口；响应只提供申请摘要，候选人身份字段由专用目的接口另行授权。 */
@Controller('recruitment/applications')
export class RecruitmentController {
  constructor(
    private readonly recruitment: RecruitmentApplicationService,
    private readonly audit: AuditService,
  ) {}

  @Post()
  @RequiredScopes('erp:recruitment:application:create')
  async create(
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: CreateCandidateApplicationDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ readonly application: CandidateApplicationSummary }> {
    const result = await this.recruitment.createApplication(this.requireKey(key), body);
    this.setVersion(response, result.application.version);
    await this.auditSuccess('recruitment.application.create', result.application);
    return result;
  }

  @Get(':id')
  @RequiredScopes('erp:recruitment:application:read')
  async get(
    @Param('id') id: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CandidateApplicationSummary> {
    const result = await this.recruitment.getApplication(this.requireUlid(id));
    this.setVersion(response, result.version);
    return result;
  }

  @Post(':id/stage')
  @HttpCode(200)
  @RequiredScopes('erp:recruitment:application:transition')
  async transition(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: TransitionCandidateApplicationDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ readonly application: CandidateApplicationSummary }> {
    const result = await this.recruitment.transitionApplication(
      this.requireUlid(id), this.requireVersion(ifMatch), this.requireKey(key), body,
    );
    this.setVersion(response, result.application.version);
    await this.auditSuccess('recruitment.application.transition', result.application);
    return result;
  }

  private requireKey(value: string | undefined): string {
    if (value === undefined || value.length === 0) throw new BadRequestException({
      code: 'IDEMPOTENCY_KEY_REQUIRED', message: '写接口必须提供 Idempotency-Key',
    });
    return value;
  }

  private requireVersion(value: string | undefined): number {
    const match = IF_MATCH_PATTERN.exec(value ?? '');
    const version = Number(match?.[1]);
    if (match?.[1] === undefined || !Number.isSafeInteger(version)) {
      throw new BadRequestException({
        code: 'RECRUITMENT_IF_MATCH_REQUIRED', message: '写接口必须提供强 If-Match 版本，例如 "3"',
      });
    }
    return version;
  }

  private requireUlid(value: string): string {
    if (!ULID_PATTERN.test(value)) throw new BadRequestException({
      code: 'RECRUITMENT_INVALID_ID', message: '招聘资源标识必须为严格 ULID',
    });
    return value;
  }

  private setVersion(response: Response, version: number): void {
    response.setHeader('ETag', `"${version}"`);
  }

  private async auditSuccess(
    action: string,
    application: CandidateApplicationSummary,
  ): Promise<void> {
    await this.audit.record({
      action,
      resourceType: 'recruitment_application',
      resourceId: application.id,
      riskLevel: 'R1',
      outcome: 'success',
      metadata: { version: application.version, stage: application.stage },
    });
  }
}
