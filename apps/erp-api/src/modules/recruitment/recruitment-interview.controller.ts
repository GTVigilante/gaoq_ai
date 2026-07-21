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
  ScheduleRecruitmentInterviewDto,
  SubmitRecruitmentInterviewFeedbackDto,
} from './application/recruitment-interview.dto.js';
import {
  RecruitmentInterviewService,
  type RecruitmentFeedbackReceipt,
  type RecruitmentInterviewSummary,
} from './application/recruitment-interview.service.js';

const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const IF_MATCH_PATTERN = /^"([1-9][0-9]*)"$/;

/** 面试 REST 边界；不返回会议地点或评价内容。 */
@Controller('recruitment')
export class RecruitmentInterviewController {
  constructor(
    private readonly interviews: RecruitmentInterviewService,
    private readonly audit: AuditService,
  ) {}

  @Post('applications/:id/interviews')
  @RequiredScopes('erp:recruitment:interview:schedule')
  async schedule(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: ScheduleRecruitmentInterviewDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ readonly interview: RecruitmentInterviewSummary }> {
    const result = await this.interviews.schedule(
      this.requireUlid(id), this.requireVersion(ifMatch), this.requireKey(key), body,
    );
    this.setVersion(response, result.interview.version);
    await this.auditInterview('recruitment.interview.schedule', result.interview);
    return result;
  }

  @Get('interviews/:id')
  @RequiredScopes('erp:recruitment:interview:read')
  async get(
    @Param('id') id: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<RecruitmentInterviewSummary> {
    const result = await this.interviews.get(this.requireUlid(id));
    this.setVersion(response, result.version);
    return result;
  }

  @Post('interviews/:id/feedback')
  @RequiredScopes('erp:recruitment:interview:feedback')
  async submitFeedback(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: SubmitRecruitmentInterviewFeedbackDto,
  ): Promise<{ readonly feedback: RecruitmentFeedbackReceipt }> {
    const result = await this.interviews.submitFeedback(
      this.requireUlid(id), this.requireVersion(ifMatch), this.requireKey(key), body,
    );
    await this.audit.record({
      action: 'recruitment.interview.feedback.submit', resourceType: 'recruitment_interview',
      resourceId: result.feedback.interviewId, riskLevel: 'R1', outcome: 'success',
      metadata: { feedbackId: result.feedback.id },
    });
    return result;
  }

  @Post('interviews/:id/complete')
  @HttpCode(200)
  @RequiredScopes('erp:recruitment:interview:complete')
  async complete(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ readonly interview: RecruitmentInterviewSummary }> {
    return this.transition('complete', id, ifMatch, key, response);
  }

  @Post('interviews/:id/cancel')
  @HttpCode(200)
  @RequiredScopes('erp:recruitment:interview:cancel')
  async cancel(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ readonly interview: RecruitmentInterviewSummary }> {
    return this.transition('cancel', id, ifMatch, key, response);
  }

  private async transition(
    action: 'complete' | 'cancel',
    id: string,
    ifMatch: string | undefined,
    key: string | undefined,
    response: Response,
  ): Promise<{ readonly interview: RecruitmentInterviewSummary }> {
    const result = await this.interviews[action](
      this.requireUlid(id), this.requireVersion(ifMatch), this.requireKey(key),
    );
    this.setVersion(response, result.interview.version);
    await this.auditInterview(`recruitment.interview.${action}`, result.interview);
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
    if (match?.[1] === undefined || !Number.isSafeInteger(version)) throw new BadRequestException({
      code: 'RECRUITMENT_IF_MATCH_REQUIRED', message: '写接口必须提供强 If-Match 版本',
    });
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

  private async auditInterview(
    action: string,
    interview: RecruitmentInterviewSummary,
  ): Promise<void> {
    await this.audit.record({
      action, resourceType: 'recruitment_interview', resourceId: interview.id,
      riskLevel: 'R1', outcome: 'success',
      metadata: { version: interview.version, status: interview.status },
    });
  }
}
