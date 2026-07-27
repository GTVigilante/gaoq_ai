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
  KnowledgeApplicationService,
  type CourseSummary,
  type PersonalKnowledgeSearchResult,
  type PersonalTrainingAssignmentView,
  type TrainingAssignmentSummary,
} from './application/knowledge-application.service.js';
import {
  AssignCourseDto,
  CompleteTrainingAssignmentDto,
  CreateCourseVersionDto,
  RecordTrainingProgressDto,
  SearchMyKnowledgeDto,
} from './application/knowledge.dto.js';

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const IF_MATCH = /^"([1-9][0-9]*)"$/;

@Controller('knowledge')
export class KnowledgeController {
  constructor(
    private readonly knowledge: KnowledgeApplicationService,
    private readonly audit: AuditService,
  ) {}

  @Post('courses')
  @RequiredScopes('erp:knowledge:course:create')
  async createCourse(
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: CreateCourseVersionDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ readonly course: CourseSummary }> {
    const result = await this.knowledge.createCourse(this.key(key), body);
    this.etag(response, result.course.version);
    await this.auditResult('knowledge.course.create', 'knowledge_course', result.course.id, 'R2', {
      status: result.course.status, version: result.course.version,
    });
    return result;
  }

  @Post('courses/:id/publish')
  @HttpCode(200)
  @RequiredScopes('erp:knowledge:course:publish')
  async publishCourse(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ readonly course: CourseSummary }> {
    const result = await this.knowledge.publishCourse(
      this.id(id), this.version(ifMatch), this.key(key),
    );
    this.etag(response, result.course.version);
    await this.auditResult('knowledge.course.publish', 'knowledge_course', result.course.id, 'R2', {
      status: result.course.status, version: result.course.version,
    });
    return result;
  }

  @Post('courses/:id/retire')
  @HttpCode(200)
  @RequiredScopes('erp:knowledge:course:publish')
  async retireCourse(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ readonly course: CourseSummary }> {
    const result = await this.knowledge.retireCourse(
      this.id(id),
      this.version(ifMatch),
      this.key(key),
    );
    this.etag(response, result.course.version);
    await this.auditResult('knowledge.course.retire', 'knowledge_course', result.course.id, 'R2', {
      status: result.course.status,
      version: result.course.version,
    });
    return result;
  }

  @Get('courses/:id')
  @RequiredScopes('erp:knowledge:course:read')
  async getCourse(
    @Param('id') id: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CourseSummary> {
    const result = await this.knowledge.getCourse(this.id(id));
    this.etag(response, result.version);
    return result;
  }

  @Get('search')
  @RequiredScopes('erp:knowledge:search')
  async searchMyKnowledge(
    @Query() query: SearchMyKnowledgeDto,
  ): Promise<PersonalKnowledgeSearchResult> {
    const result = await this.knowledge.searchMyKnowledge(query);
    await this.auditResult(
      'knowledge.search.read',
      'knowledge_search_result',
      'mine',
      'R0',
      {
        count: result.items.length,
        limit: query.limit ?? 10,
        hasNextPage: result.nextCursor !== null,
      },
    );
    return result;
  }

  @Post('onboarding/:onboardingId/assignments')
  @RequiredScopes('erp:knowledge:assignment:create')
  async assignCourse(
    @Param('onboardingId') onboardingId: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: AssignCourseDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ readonly assignment: TrainingAssignmentSummary }> {
    const result = await this.knowledge.assignCourse(this.id(onboardingId), this.key(key), body);
    this.etag(response, result.assignment.version);
    await this.auditAssignment('knowledge.assignment.create', result.assignment, 'R1');
    return result;
  }

  @Get('onboarding/:onboardingId/assignments')
  @RequiredScopes('erp:knowledge:assignment:read')
  async listAssignments(
    @Param('onboardingId') onboardingId: string,
  ): Promise<{ readonly items: readonly TrainingAssignmentSummary[] }> {
    return this.knowledge.listOnboardingAssignments(this.id(onboardingId));
  }

  @Get('assignments/mine')
  @RequiredScopes('erp:knowledge:assignment:read')
  async listMyAssignments(): Promise<{ readonly items: readonly PersonalTrainingAssignmentView[] }> {
    const result = await this.knowledge.listMyAssignments();
    await this.auditResult(
      'knowledge.assignment.mine.read', 'knowledge_training_assignment_list', 'mine', 'R0',
      { count: result.items.length },
    );
    return result;
  }

  @Get('assignments/:id')
  @RequiredScopes('erp:knowledge:assignment:read')
  async getAssignment(
    @Param('id') id: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<TrainingAssignmentSummary> {
    const result = await this.knowledge.getAssignment(this.id(id));
    this.etag(response, result.version);
    return result;
  }

  @Post('assignments/:id/progress-events')
  @HttpCode(200)
  @RequiredScopes('erp:integration:knowledge:progress')
  async recordProgress(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: RecordTrainingProgressDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ readonly assignment: TrainingAssignmentSummary }> {
    const result = await this.knowledge.recordProgressForIntegration(
      this.id(id), this.version(ifMatch), this.key(key), body,
    );
    this.etag(response, result.assignment.version);
    await this.auditAssignment('knowledge.assignment.progress', result.assignment, 'R1');
    return result;
  }

  @Post('assignments/:id/complete')
  @HttpCode(200)
  @RequiredScopes('erp:knowledge:assignment:complete')
  async completeAssignment(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: CompleteTrainingAssignmentDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ readonly assignment: TrainingAssignmentSummary }> {
    const result = await this.knowledge.completeAssignment(
      this.id(id), this.version(ifMatch), this.key(key), body.passedExamAttemptId,
    );
    this.etag(response, result.assignment.version);
    await this.auditAssignment('knowledge.assignment.complete', result.assignment, 'R2');
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
    if (match?.[1] === undefined || !Number.isSafeInteger(version)) throw new BadRequestException({
      code: 'KNOWLEDGE_IF_MATCH_REQUIRED', message: '写接口必须提供强 If-Match，例如 "2"',
    });
    return version;
  }

  private etag(response: Response, version: number): void {
    response.setHeader('ETag', `"${version}"`);
  }

  private async auditAssignment(
    action: string,
    assignment: TrainingAssignmentSummary,
    riskLevel: 'R1' | 'R2',
  ): Promise<void> {
    await this.auditResult(action, 'knowledge_training_assignment', assignment.id, riskLevel, {
      status: assignment.status, version: assignment.version,
      onboardingInstanceId: assignment.onboardingInstanceId,
    });
  }

  private async auditResult(
    action: string,
    resourceType: string,
    resourceId: string,
    riskLevel: 'R0' | 'R1' | 'R2',
    metadata: Readonly<Record<string, string | number | boolean>>,
  ): Promise<void> {
    await this.audit.record({ action, resourceType, resourceId, riskLevel, outcome: 'success', metadata });
  }
}
