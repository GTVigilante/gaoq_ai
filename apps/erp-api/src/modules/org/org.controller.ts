import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';

import { AuditService } from '../../core/audit/audit.service.js';
import { RequiredScopes } from '../identity/auth.decorators.js';
import { OrgApplicationService, type OrgChart } from './application/org-application.service.js';
import {
  CreateDepartmentDto,
  CreateEmployeeDto,
  CreateJobLevelDto,
  CreatePositionDto,
  TransitionEmployeeStatusDto,
  UpdateDepartmentDto,
  UpdateEmployeeDto,
  UpdateJobLevelDto,
  UpdatePositionDto,
} from './application/org.dto.js';
import type { Department, Employee, JobLevel, Position } from './domain/index.js';

const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const IF_MATCH_PATTERN = /^"([1-9][0-9]*)"$/;

/** 组织主数据 REST 契约；请求租户永远由已验证访问令牌派生。 */
@Controller('org')
export class OrgController {
  constructor(
    private readonly organization: OrgApplicationService,
    private readonly audit: AuditService,
  ) {}

  @Get('chart')
  @RequiredScopes('org:read')
  async getChart(): Promise<OrgChart> {
    return this.organization.getOrgChart();
  }

  @Post('departments')
  @RequiredScopes('org:write')
  async createDepartment(
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: CreateDepartmentDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ readonly department: Department }> {
    const result = await this.organization.createDepartment(this.requireIdempotencyKey(key), body);
    this.setVersion(response, result.department.version);
    await this.auditSuccess('org.department.create', 'org_department', result.department.id);
    return result;
  }

  @Patch('departments/:id')
  @RequiredScopes('org:write')
  async updateDepartment(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: UpdateDepartmentDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ readonly department: Department }> {
    const result = await this.organization.updateDepartment(
      this.requireUlid(id),
      this.requireVersion(ifMatch),
      this.requireIdempotencyKey(key),
      body,
    );
    this.setVersion(response, result.department.version);
    await this.auditSuccess('org.department.update', 'org_department', result.department.id);
    return result;
  }

  @Post('positions')
  @RequiredScopes('org:write')
  async createPosition(
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: CreatePositionDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ readonly position: Position }> {
    const result = await this.organization.createPosition(this.requireIdempotencyKey(key), body);
    this.setVersion(response, result.position.version);
    await this.auditSuccess('org.position.create', 'org_position', result.position.id);
    return result;
  }

  @Patch('positions/:id')
  @RequiredScopes('org:write')
  async updatePosition(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: UpdatePositionDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ readonly position: Position }> {
    const result = await this.organization.updatePosition(
      this.requireUlid(id),
      this.requireVersion(ifMatch),
      this.requireIdempotencyKey(key),
      body,
    );
    this.setVersion(response, result.position.version);
    await this.auditSuccess('org.position.update', 'org_position', result.position.id);
    return result;
  }

  @Post('job-levels')
  @RequiredScopes('org:write')
  async createJobLevel(
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: CreateJobLevelDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ readonly jobLevel: JobLevel }> {
    const result = await this.organization.createJobLevel(this.requireIdempotencyKey(key), body);
    this.setVersion(response, result.jobLevel.version);
    await this.auditSuccess('org.job_level.create', 'org_job_level', result.jobLevel.id);
    return result;
  }

  @Patch('job-levels/:id')
  @RequiredScopes('org:write')
  async updateJobLevel(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: UpdateJobLevelDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ readonly jobLevel: JobLevel }> {
    const result = await this.organization.updateJobLevel(
      this.requireUlid(id),
      this.requireVersion(ifMatch),
      this.requireIdempotencyKey(key),
      body,
    );
    this.setVersion(response, result.jobLevel.version);
    await this.auditSuccess('org.job_level.update', 'org_job_level', result.jobLevel.id);
    return result;
  }

  @Post('employees')
  @RequiredScopes('org:write')
  async createEmployee(
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: CreateEmployeeDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ readonly employee: Employee }> {
    const result = await this.organization.createEmployee(this.requireIdempotencyKey(key), body);
    this.setVersion(response, result.employee.version);
    await this.auditSuccess('org.employee.create', 'org_employee', result.employee.id);
    return result;
  }

  @Patch('employees/:id')
  @RequiredScopes('org:write')
  async updateEmployee(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: UpdateEmployeeDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ readonly employee: Employee }> {
    const result = await this.organization.updateEmployee(
      this.requireUlid(id),
      this.requireVersion(ifMatch),
      this.requireIdempotencyKey(key),
      body,
    );
    this.setVersion(response, result.employee.version);
    await this.auditSuccess('org.employee.update', 'org_employee', result.employee.id);
    return result;
  }

  @Post('employees/:id/status-transitions')
  @HttpCode(200)
  @RequiredScopes('org:write')
  async transitionEmployeeStatus(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: TransitionEmployeeStatusDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ readonly employee: Employee }> {
    const result = await this.organization.transitionEmployeeStatus(
      this.requireUlid(id),
      this.requireVersion(ifMatch),
      this.requireIdempotencyKey(key),
      body,
    );
    this.setVersion(response, result.employee.version);
    await this.auditSuccess('org.employee.status_transition', 'org_employee', result.employee.id);
    return result;
  }

  private requireIdempotencyKey(value: string | undefined): string {
    if (value === undefined || value.length === 0) {
      throw new BadRequestException({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        message: '写接口必须提供 Idempotency-Key',
      });
    }
    return value;
  }

  private requireVersion(value: string | undefined): number {
    const match = IF_MATCH_PATTERN.exec(value ?? '');
    if (match?.[1] === undefined) {
      throw new BadRequestException({
        code: 'ORG_IF_MATCH_REQUIRED',
        message: '更新接口必须提供强 If-Match 版本，例如 "3"',
      });
    }
    const version = Number(match[1]);
    if (!Number.isSafeInteger(version)) {
      throw new BadRequestException({ code: 'ORG_INVALID_VERSION', message: 'If-Match 版本非法' });
    }
    return version;
  }

  private requireUlid(value: string): string {
    if (!ULID_PATTERN.test(value)) {
      throw new BadRequestException({ code: 'ORG_INVALID_ID', message: '资源标识必须为严格 ULID' });
    }
    return value;
  }

  private setVersion(response: Response, version: number): void {
    response.setHeader('ETag', `"${version}"`);
  }

  private async auditSuccess(action: string, resourceType: string, resourceId: string): Promise<void> {
    await this.audit.record({
      action,
      resourceType,
      resourceId,
      riskLevel: 'R1',
      outcome: 'success',
    });
  }
}
