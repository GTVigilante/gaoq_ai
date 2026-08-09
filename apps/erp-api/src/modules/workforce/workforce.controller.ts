import { BadRequestException, Body, Controller, Get, Headers, Logger, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';

import { AuditService } from '../../core/audit/audit.service.js';
import { RequiredScopes } from '../identity/auth.decorators.js';
import { CreateHrbpAssignmentDto, CreateReportingLineDto } from './application/workforce.dto.js';
import { WorkforceService } from './application/workforce.service.js';

const KEY = /^[A-Za-z0-9._:-]{8,128}$/;

@Controller('workforce')
export class WorkforceController {
  private readonly logger = new Logger(WorkforceController.name);
  constructor(private readonly workforce: WorkforceService, private readonly audit: AuditService) {}

  @Post('reporting-lines')
  @RequiredScopes('erp:workforce:relationship:write')
  async assignReportingLine(@Headers('idempotency-key') key: string | undefined, @Body() body: CreateReportingLineDto, @Res({ passthrough: true }) response: Response) {
    const result = await this.workforce.assignReportingLine(this.key(key), body);
    response.setHeader('ETag', `"${result.reportingLine.version}"`);
    await this.success('workforce.reporting_line.assign', 'workforce_reporting_line', result.reportingLine.id, result.reportingLine.version);
    return result;
  }

  @Get('reporting-lines')
  @RequiredScopes('erp:workforce:relationship:read')
  async listReportingLines(@Query('asOf') asOf: string | undefined) {
    if (typeof asOf !== 'string') throw new BadRequestException({ code: 'WORKFORCE_AS_OF_REQUIRED', message: '必须提供 asOf 日期' });
    return { items: await this.workforce.listReportingLines(asOf) };
  }

  @Post('hrbp-assignments')
  @RequiredScopes('erp:workforce:hrbp:write')
  async assignHrbp(@Headers('idempotency-key') key: string | undefined, @Body() body: CreateHrbpAssignmentDto, @Res({ passthrough: true }) response: Response) {
    const result = await this.workforce.assignHrbp(this.key(key), body);
    response.setHeader('ETag', `"${result.assignment.version}"`);
    await this.success('workforce.hrbp.assign', 'workforce_hrbp_assignment', result.assignment.id, result.assignment.version);
    return result;
  }

  @Get('hrbp-assignments')
  @RequiredScopes('erp:workforce:hrbp:read')
  async listHrbp(@Query('asOf') asOf: string | undefined) {
    if (typeof asOf !== 'string') throw new BadRequestException({ code: 'WORKFORCE_AS_OF_REQUIRED', message: '必须提供 asOf 日期' });
    return { items: await this.workforce.listHrbpAssignments(asOf) };
  }

  private key(value: string | undefined): string {
    if (value === undefined || !KEY.test(value)) throw new BadRequestException({ code: 'IDEMPOTENCY_KEY_REQUIRED', message: '写接口必须提供 8–128 位白名单 Idempotency-Key' });
    return value;
  }

  private async success(action: string, resourceType: string, resourceId: string, version: number): Promise<void> {
    try {
      await this.audit.record({ action, resourceType, resourceId, riskLevel: 'R2', outcome: 'success', metadata: { version } });
    } catch {
      this.logger.error('WORKFORCE_COMMITTED_AUDIT_WRITE_FAILED');
    }
  }
}
