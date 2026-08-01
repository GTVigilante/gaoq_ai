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
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

/** HC 与职位 REST 边界；所有写入强制幂等键和强 ETag。 */
@Controller('recruitment')
export class RecruitmentManagementController {
  private readonly logger = new Logger(RecruitmentManagementController.name);

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
    const idempotencyKey = this.requireKey(key);
    const result = await this.executeWrite(
      'recruitment.requisition.create',
      'organization_department',
      body.departmentId,
      undefined,
      'R1',
      () => this.recruitment.createRequisition(idempotencyKey, body),
    );
    this.setVersion(response, result.requisition.version);
    await this.auditSuccess(
      'recruitment.requisition.create',
      'recruitment_requisition',
      result.requisition,
      'R1',
    );
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
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ readonly requisition: RecruitmentRequisitionSummary }> {
    const resourceId = this.requireUlid(id);
    const expectedVersion = this.requireVersion(ifMatch);
    const idempotencyKey = this.requireKey(key);
    this.requireEmptyBody(body);
    const result = await this.executeWrite(
      'recruitment.requisition.submit',
      'recruitment_requisition',
      resourceId,
      expectedVersion,
      'R2',
      () => this.recruitment.submitRequisition(
        resourceId,
        expectedVersion,
        idempotencyKey,
      ),
    );
    this.setVersion(response, result.requisition.version);
    await this.auditSuccess(
      'recruitment.requisition.submit',
      'recruitment_requisition',
      result.requisition,
      'R2',
    );
    return result;
  }

  @Post('requisitions/:id/sync-approval')
  @HttpCode(200)
  @RequiredScopes('erp:recruitment:requisition:sync_approval')
  async syncApproval(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ readonly requisition: RecruitmentRequisitionSummary }> {
    const resourceId = this.requireUlid(id);
    const expectedVersion = this.requireVersion(ifMatch);
    const idempotencyKey = this.requireKey(key);
    this.requireEmptyBody(body);
    const result = await this.executeWrite(
      'recruitment.requisition.sync_approval',
      'recruitment_requisition',
      resourceId,
      expectedVersion,
      'R2',
      () => this.recruitment.syncRequisitionApproval(
        resourceId,
        expectedVersion,
        idempotencyKey,
      ),
    );
    this.setVersion(response, result.requisition.version);
    await this.auditSuccess(
      'recruitment.requisition.sync_approval',
      'recruitment_requisition',
      result.requisition,
      'R2',
    );
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
    const resourceId = this.requireUlid(id);
    const expectedVersion = this.requireVersion(ifMatch);
    const idempotencyKey = this.requireKey(key);
    const result = await this.executeWrite(
      'recruitment.position.create',
      'recruitment_requisition',
      resourceId,
      expectedVersion,
      'R1',
      () => this.recruitment.createPosition(
        resourceId,
        expectedVersion,
        idempotencyKey,
        body,
      ),
    );
    this.setVersion(response, result.position.version);
    await this.auditSuccess(
      'recruitment.position.create',
      'recruitment_position',
      result.position,
      'R1',
    );
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
    const resourceId = this.requireUlid(id);
    const expectedVersion = this.requireVersion(ifMatch);
    const idempotencyKey = this.requireKey(key);
    const result = await this.executeWrite(
      'recruitment.position.transition',
      'recruitment_position',
      resourceId,
      expectedVersion,
      'R1',
      () => this.recruitment.transitionPosition(
        resourceId,
        expectedVersion,
        idempotencyKey,
        body.targetStatus,
      ),
    );
    this.setVersion(response, result.position.version);
    await this.auditSuccess(
      'recruitment.position.transition',
      'recruitment_position',
      result.position,
      'R1',
    );
    return result;
  }

  private requireKey(value: unknown): string {
    if (typeof value !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(value)) {
      throw new BadRequestException({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        message: '写接口必须提供 Idempotency-Key',
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
        message: '写接口必须提供强 If-Match 版本，例如 "3"',
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
      code: 'RECRUITMENT_MANAGEMENT_BODY_FORBIDDEN',
      message: '该 HC 写接口不接受请求正文',
    });
  }

  private setVersion(response: Response, version: number): void {
    response.setHeader('ETag', `"${version}"`);
  }

  private async executeWrite<T>(
    action: string,
    resourceType: 'organization_department' | 'recruitment_requisition' | 'recruitment_position',
    resourceId: string,
    expectedVersion: number | undefined,
    riskLevel: 'R1' | 'R2',
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
          riskLevel,
          outcome: 'failure',
          metadata: expectedVersion === undefined ? {} : { expectedVersion },
        });
      } catch {
        this.logger.error({
          code: 'RECRUITMENT_MANAGEMENT_FAILURE_AUDIT_FAILED',
          action,
          resourceId,
        });
      }
      throw error;
    }
  }

  private async auditSuccess(
    action: string,
    resourceType: 'recruitment_requisition' | 'recruitment_position',
    resource: RecruitmentRequisitionSummary | RecruitmentPositionSummary,
    riskLevel: 'R1' | 'R2',
  ): Promise<void> {
    try {
      await this.audit.record({
        action,
        resourceType,
        resourceId: resource.id,
        riskLevel,
        outcome: 'success',
        metadata: { version: resource.version, status: resource.status },
      });
    } catch {
      this.logger.error({
        code: 'RECRUITMENT_MANAGEMENT_AUDIT_AFTER_COMMIT_FAILED',
        action,
        resourceId: resource.id,
      });
    }
  }
}
