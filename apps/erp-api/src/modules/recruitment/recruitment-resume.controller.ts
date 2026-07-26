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
  ListRecruitmentResumeAnalysesDto,
  RequestRecruitmentResumeAnalysisDto,
  ReviewRecruitmentResumeAnalysisDto,
} from './application/recruitment-resume.dto.js';
import {
  RecruitmentResumeService,
  type RecruitmentResumeAnalysisView,
} from './application/recruitment-resume.service.js';

const IF_MATCH_PATTERN = /^"([1-9][0-9]*)"$/;

/** 简历库 REST 边界；AI 只产出待审核建议，确认标签必须由独立 Scope 写入。 */
@Controller('recruitment/resume-library')
export class RecruitmentResumeController {
  constructor(
    private readonly resumes: RecruitmentResumeService,
    private readonly audit: AuditService,
  ) {}

  @Post('candidates/:candidateId/analyses')
  @RequiredScopes('erp:recruitment:resume:analyze')
  async request(
    @Param('candidateId') candidateId: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: RequestRecruitmentResumeAnalysisDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ readonly analysis: RecruitmentResumeAnalysisView }> {
    const result = await this.resumes.requestAnalysis(
      this.requireKey(key), candidateId, body,
    );
    this.setVersion(response, result.analysis.version);
    await this.audit.record({
      action: 'recruitment.resume.analysis.request',
      resourceType: 'recruitment_resume_analysis',
      resourceId: result.analysis.id,
      riskLevel: 'R1',
      outcome: 'success',
      metadata: {
        candidateId: result.analysis.candidateId,
        status: result.analysis.status,
        version: result.analysis.version,
      },
    });
    return result;
  }

  @Get('analyses')
  @RequiredScopes('erp:recruitment:resume:read')
  list(@Query() query: ListRecruitmentResumeAnalysesDto) {
    return this.resumes.listAnalyses(query);
  }

  @Get('analyses/:id')
  @RequiredScopes('erp:recruitment:resume:read')
  async get(
    @Param('id') id: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<RecruitmentResumeAnalysisView> {
    const result = await this.resumes.getAnalysis(id);
    this.setVersion(response, result.version);
    return result;
  }

  @Post('analyses/:id/review')
  @HttpCode(200)
  @RequiredScopes('erp:recruitment:resume:review')
  async review(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: ReviewRecruitmentResumeAnalysisDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ readonly analysis: RecruitmentResumeAnalysisView }> {
    const result = await this.resumes.review(
      this.requireKey(key), id, this.requireVersion(ifMatch), body,
    );
    this.setVersion(response, result.analysis.version);
    await this.audit.record({
      action: 'recruitment.resume.analysis.review',
      resourceType: 'recruitment_resume_analysis',
      resourceId: result.analysis.id,
      riskLevel: 'R2',
      outcome: 'success',
      metadata: {
        confirmedTagCount: result.analysis.tags.filter(
          (tag) => tag.status === 'confirmed',
        ).length,
        version: result.analysis.version,
      },
    });
    return result;
  }

  private requireKey(value: string | undefined): string {
    if (value === undefined || value.length === 0) throw new BadRequestException({
      code: 'IDEMPOTENCY_KEY_REQUIRED',
      message: '写接口必须提供 Idempotency-Key',
    });
    return value;
  }

  private requireVersion(value: string | undefined): number {
    const match = IF_MATCH_PATTERN.exec(value ?? '');
    const version = Number(match?.[1]);
    if (match?.[1] === undefined || !Number.isSafeInteger(version)) {
      throw new BadRequestException({
        code: 'RECRUITMENT_IF_MATCH_REQUIRED',
        message: '写接口必须提供强 If-Match 版本，例如 "3"',
      });
    }
    return version;
  }

  private setVersion(response: Response, version: number): void {
    response.setHeader('ETag', `"${version}"`);
  }
}
