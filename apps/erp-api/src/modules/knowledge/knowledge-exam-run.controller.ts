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
  KnowledgeExamRunService,
  type KnowledgeExamRunSummary,
} from './application/knowledge-exam-run.service.js';
import { SubmitExamRunDto } from './application/knowledge.dto.js';

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const IF_MATCH = /^"([1-9][0-9]*)"$/;

@Controller('knowledge')
export class KnowledgeExamRunController {
  constructor(
    private readonly runs: KnowledgeExamRunService,
    private readonly audit: AuditService,
  ) {}

  @Post('assignments/:id/exam-runs')
  @HttpCode(202)
  @RequiredScopes('erp:knowledge:exam:start')
  async start(
    @Param('id') assignmentId: string,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ readonly examRun: KnowledgeExamRunSummary }> {
    const result = await this.runs.start(this.id(assignmentId), this.key(key));
    response.setHeader('ETag', `"${result.examRun.version}"`);
    response.setHeader('Retry-After', '2');
    await this.audit.record({
      action: 'knowledge.exam.run.start',
      resourceType: 'knowledge_exam_run',
      resourceId: result.examRun.id,
      riskLevel: 'R1',
      outcome: 'success',
      metadata: {
        assignmentId: result.examRun.assignmentId,
        attemptNumber: result.examRun.attemptNumber,
        status: result.examRun.status,
      },
    });
    return result;
  }

  @Post('exam-runs/:id/submit')
  @HttpCode(202)
  @RequiredScopes('erp:knowledge:exam:submit')
  async submit(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: SubmitExamRunDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ readonly examRun: KnowledgeExamRunSummary }> {
    const result = await this.runs.submit(
      this.id(id),
      this.version(ifMatch),
      this.key(key),
      body.submissionRef,
    );
    response.setHeader('ETag', `"${result.examRun.version}"`);
    response.setHeader('Retry-After', '2');
    await this.audit.record({
      action: 'knowledge.exam.run.submit',
      resourceType: 'knowledge_exam_run',
      resourceId: result.examRun.id,
      riskLevel: 'R2',
      outcome: 'success',
      metadata: {
        assignmentId: result.examRun.assignmentId,
        attemptNumber: result.examRun.attemptNumber,
        status: result.examRun.status,
      },
    });
    return result;
  }

  @Get('exam-runs/:id')
  @RequiredScopes('erp:knowledge:exam:read')
  async get(
    @Param('id') id: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<KnowledgeExamRunSummary> {
    const result = await this.runs.get(this.id(id));
    response.setHeader('ETag', `"${result.version}"`);
    await this.audit.record({
      action: 'knowledge.exam.run.read',
      resourceType: 'knowledge_exam_run',
      resourceId: result.id,
      riskLevel: 'R0',
      outcome: 'success',
      metadata: { status: result.status, version: result.version },
    });
    return result;
  }

  private id(value: string): string {
    if (!ULID.test(value)) throw new BadRequestException({
      code: 'KNOWLEDGE_ID_INVALID', message: '资源标识必须为严格 ULID',
    });
    return value;
  }

  private key(value: string | undefined): string {
    if (value === undefined || value.length === 0) throw new BadRequestException({
      code: 'IDEMPOTENCY_KEY_REQUIRED', message: '写接口必须提供 Idempotency-Key',
    });
    return value;
  }

  private version(value: string | undefined): number {
    const match = IF_MATCH.exec(value ?? '');
    const version = Number(match?.[1]);
    if (match?.[1] === undefined || !Number.isSafeInteger(version)) {
      throw new BadRequestException({
        code: 'KNOWLEDGE_IF_MATCH_REQUIRED', message: '写接口必须提供强 If-Match，例如 "2"',
      });
    }
    return version;
  }
}
