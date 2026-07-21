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
  CreateRecruitmentPositionDto,
  CreateRecruitmentRequisitionDto,
  TransitionRecruitmentPositionDto,
} from './application/recruitment-management.dto.js';
import {
  RecruitmentManagementService,
  type RecruitmentPositionSummary,
  type RecruitmentRequisitionSummary,
} from './application/recruitment-management.service.js';

const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const IF_MATCH_PATTERN = /^"([1-9][0-9]*)"$/;

/** HC 与职位 REST 边界；所有写入强制幂等键和强 ETag。 */
@Controller('recruitment')
export class RecruitmentManagementController {
  constructor(
    private readonly recruitment: RecruitmentManagementService,
    private readonly audit: AuditService,
  ) {}

  @Post('requisitions')
  @RequiredScopes('erp:recruitment:requisition:create')
  async createRequisition(
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: CreateRecruitmentRequisitionDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ readonly requisition: RecruitmentRequisitionSummary }> {
    const result = await this.recruitment.createRequisition(this.requireKey(key), body);
    this.setVersion(response, result.requisition.version);
    await this.auditResult('recruitment.requisition.create', 'recruitment_requisition', result.requisition, 'R1');
    return result;
  }

  @Get('requisitions/:id')
  @RequiredScopes('erp:recruitment:management:read')
  async getRequisition(
    @Param('id') id: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<RecruitmentRequisitionSummary> {
    const result = await this.recruitment.getRequisition(this.requireUlid(id));
    this.setVersion(response, result.version);
    return result;
  }

  @Post('requisitions/:id/submit')
  @HttpCode(200)
  @RequiredScopes('erp:recruitment:requisition:submit')
  async submitRequisition(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ readonly requisition: RecruitmentRequisitionSummary }> {
    const result = await this.recruitment.submitRequisition(
      this.requireUlid(id), this.requireVersion(ifMatch), this.requireKey(key),
    );
    this.setVersion(response, result.requisition.version);
    await this.auditResult('recruitment.requisition.submit', 'recruitment_requisition', result.requisition, 'R2');
    return result;
  }

  @Post('requisitions/:id/sync-approval')
  @HttpCode(200)
  @RequiredScopes('erp:recruitment:requisition:sync_approval')
  async syncApproval(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ readonly requisition: RecruitmentRequisitionSummary }> {
    const result = await this.recruitment.syncRequisitionApproval(
      this.requireUlid(id), this.requireVersion(ifMatch), this.requireKey(key),
    );
    this.setVersion(response, result.requisition.version);
    await this.auditResult('recruitment.requisition.sync_approval', 'recruitment_requisition', result.requisition, 'R2');
    return result;
  }

  @Post('requisitions/:id/positions')
  @RequiredScopes('erp:recruitment:position:create')
  async createPosition(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: CreateRecruitmentPositionDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ readonly position: RecruitmentPositionSummary }> {
    const result = await this.recruitment.createPosition(
      this.requireUlid(id), this.requireVersion(ifMatch), this.requireKey(key), body,
    );
    this.setVersion(response, result.position.version);
    await this.auditResult('recruitment.position.create', 'recruitment_position', result.position, 'R1');
    return result;
  }

  @Get('positions/:id')
  @RequiredScopes('erp:recruitment:management:read')
  async getPosition(
    @Param('id') id: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<RecruitmentPositionSummary> {
    const result = await this.recruitment.getPosition(this.requireUlid(id));
    this.setVersion(response, result.version);
    return result;
  }

  @Post('positions/:id/status')
  @HttpCode(200)
  @RequiredScopes('erp:recruitment:position:transition')
  async transitionPosition(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: TransitionRecruitmentPositionDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ readonly position: RecruitmentPositionSummary }> {
    const result = await this.recruitment.transitionPosition(
      this.requireUlid(id), this.requireVersion(ifMatch), this.requireKey(key), body.targetStatus,
    );
    this.setVersion(response, result.position.version);
    await this.auditResult('recruitment.position.transition', 'recruitment_position', result.position, 'R1');
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
      code: 'RECRUITMENT_IF_MATCH_REQUIRED', message: '写接口必须提供强 If-Match 版本，例如 "3"',
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

  private async auditResult(
    action: string,
    resourceType: string,
    resource: RecruitmentRequisitionSummary | RecruitmentPositionSummary,
    riskLevel: 'R1' | 'R2',
  ): Promise<void> {
    await this.audit.record({
      action, resourceType, resourceId: resource.id, riskLevel, outcome: 'success',
      metadata: { version: resource.version, status: resource.status },
    });
  }
}
