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
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

/** 面试 REST 边界；不返回会议地点或评价内容。 */
@Controller('recruitment')
export class RecruitmentInterviewController {
  private readonly logger = new Logger(RecruitmentInterviewController.name);

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
    const resourceId = this.requireUlid(id);
    const expectedVersion = this.requireVersion(ifMatch);
    const idempotencyKey = this.requireKey(key);
    const result = await this.executeWrite(
      'recruitment.interview.schedule',
      'recruitment_application',
      resourceId,
      expectedVersion,
      () => this.interviews.schedule(
        resourceId,
        expectedVersion,
        idempotencyKey,
        body,
      ),
    );
    this.setVersion(response, result.interview.version);
    await this.auditInterviewSuccess('recruitment.interview.schedule', result.interview);
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
    const resourceId = this.requireUlid(id);
    const expectedVersion = this.requireVersion(ifMatch);
    const idempotencyKey = this.requireKey(key);
    const result = await this.executeWrite(
      'recruitment.interview.feedback.submit',
      'recruitment_interview',
      resourceId,
      expectedVersion,
      () => this.interviews.submitFeedback(
        resourceId,
        expectedVersion,
        idempotencyKey,
        body,
      ),
    );
    await this.auditFeedbackSuccess(result.feedback);
    return result;
  }

  @Post('interviews/:id/complete')
  @HttpCode(200)
  @RequiredScopes('erp:recruitment:interview:complete')
  async complete(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ readonly interview: RecruitmentInterviewSummary }> {
    return this.transition('complete', id, ifMatch, key, body, response);
  }

  @Post('interviews/:id/cancel')
  @HttpCode(200)
  @RequiredScopes('erp:recruitment:interview:cancel')
  async cancel(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ readonly interview: RecruitmentInterviewSummary }> {
    return this.transition('cancel', id, ifMatch, key, body, response);
  }

  private async transition(
    action: 'complete' | 'cancel',
    id: string,
    ifMatch: string | undefined,
    key: string | undefined,
    body: unknown,
    response: Response,
  ): Promise<{ readonly interview: RecruitmentInterviewSummary }> {
    const resourceId = this.requireUlid(id);
    const expectedVersion = this.requireVersion(ifMatch);
    const idempotencyKey = this.requireKey(key);
    this.requireEmptyBody(body);
    const auditAction = `recruitment.interview.${action}`;
    const result = await this.executeWrite(
      auditAction,
      'recruitment_interview',
      resourceId,
      expectedVersion,
      () => this.interviews[action](
        resourceId,
        expectedVersion,
        idempotencyKey,
      ),
    );
    this.setVersion(response, result.interview.version);
    await this.auditInterviewSuccess(auditAction, result.interview);
    return result;
  }

  private requireKey(value: unknown): string {
    if (typeof value !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(value)) {
      throw new BadRequestException({
        code: 'IDEMPOTENCY_KEY_REQUIRED', message: '写接口必须提供 Idempotency-Key',
      });
    }
    return value;
  }

  private requireVersion(value: unknown): number {
    const match = typeof value === 'string' ? IF_MATCH_PATTERN.exec(value) : null;
    const version = Number(match?.[1]);
    if (
      match?.[1] === undefined ||
      !Number.isSafeInteger(version) ||
      version >= Number.MAX_SAFE_INTEGER
    ) {
      throw new BadRequestException({
        code: 'RECRUITMENT_IF_MATCH_REQUIRED',
        message: '写接口必须提供强 If-Match 版本',
      });
    }
    return version;
  }

  private requireUlid(value: unknown): string {
    if (typeof value !== 'string' || !ULID_PATTERN.test(value)) throw new BadRequestException({
      code: 'RECRUITMENT_INVALID_ID', message: '招聘资源标识必须为严格 ULID',
    });
    return value;
  }

  private requireEmptyBody(value: unknown): void {
    if (value === undefined) return;
    let emptyOrdinaryObject: boolean;
    try {
      emptyOrdinaryObject =
        typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value) &&
        Object.getPrototypeOf(value) === Object.prototype &&
        Reflect.ownKeys(value).length === 0;
    } catch {
      emptyOrdinaryObject = false;
    }
    if (!emptyOrdinaryObject) throw new BadRequestException({
      code: 'RECRUITMENT_INTERVIEW_BODY_FORBIDDEN',
      message: '面试完成或取消不接受请求正文',
    });
  }

  private setVersion(response: Response, version: number): void {
    response.setHeader('ETag', `"${version}"`);
  }

  private async executeWrite<T>(
    action: string,
    resourceType: 'recruitment_application' | 'recruitment_interview',
    resourceId: string,
    expectedVersion: number,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      try {
        await this.audit.record({
          action,
          resourceType,
          resourceId,
          riskLevel: 'R1',
          outcome: 'failure',
          metadata: { expectedVersion },
        });
      } catch {
        this.logger.error({
          code: 'RECRUITMENT_INTERVIEW_FAILURE_AUDIT_FAILED',
          action,
          resourceId,
        });
      }
      throw error;
    }
  }

  private async auditInterviewSuccess(
    action: string,
    interview: RecruitmentInterviewSummary,
  ): Promise<void> {
    try {
      await this.audit.record({
        action, resourceType: 'recruitment_interview', resourceId: interview.id,
        riskLevel: 'R1', outcome: 'success',
        metadata: { version: interview.version, status: interview.status },
      });
    } catch {
      this.logger.error({
        code: 'RECRUITMENT_INTERVIEW_AUDIT_AFTER_COMMIT_FAILED',
        action,
        resourceId: interview.id,
      });
    }
  }

  private async auditFeedbackSuccess(
    feedback: RecruitmentFeedbackReceipt,
  ): Promise<void> {
    try {
      await this.audit.record({
        action: 'recruitment.interview.feedback.submit',
        resourceType: 'recruitment_interview',
        resourceId: feedback.interviewId,
        riskLevel: 'R1',
        outcome: 'success',
        metadata: { feedbackId: feedback.id },
      });
    } catch {
      this.logger.error({
        code: 'RECRUITMENT_INTERVIEW_AUDIT_AFTER_COMMIT_FAILED',
        action: 'recruitment.interview.feedback.submit',
        resourceId: feedback.interviewId,
      });
    }
  }
}
