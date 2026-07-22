import { BadRequestException, Body, Controller, Get, Param, Post } from '@nestjs/common';

import { AuditService } from '../../core/audit/audit.service.js';
import { RequiredScopes } from '../identity/auth.decorators.js';
import { DataMigrationService } from './application/data-migration.service.js';
import { ApplyDataMigrationRecordDto, CreateDataMigrationRunDto } from './data-migration.dto.js';

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

/** 迁移控制面仅接收受信任服务身份；业务目标写入仍由领域应用服务完成。 */
@Controller('data-migrations')
export class DataMigrationController {
  constructor(
    private readonly migrations: DataMigrationService,
    private readonly audit: AuditService,
  ) {}

  @Post('runs')
  @RequiredScopes('erp:migration:execute', 'erp:org:master:write')
  async start(@Body() body: CreateDataMigrationRunDto) {
    const run = await this.migrations.start(body);
    await this.audit.record({
      action: 'data_migration.run.start', resourceType: 'data_migration_run',
      resourceId: run.id, riskLevel: 'R2', outcome: 'success',
      metadata: { sourceSystem: run.sourceSystem, mode: run.mode, scope: run.scope },
    });
    return run;
  }

  @Post('runs/:id/records')
  @RequiredScopes('erp:migration:execute', 'erp:org:master:write')
  async apply(@Param('id') id: string, @Body() body: ApplyDataMigrationRecordDto) {
    const item = await this.migrations.apply(requireRunId(id), body);
    await this.audit.record({
      action: 'data_migration.record.apply', resourceType: 'data_migration_run',
      resourceId: id, riskLevel: 'R2', outcome: item.status === 'rejected' ? 'failure' : 'success',
      metadata: { sequence: item.sequence, entityType: item.entityType, status: item.status },
    });
    return item;
  }

  @Post('runs/:id/complete')
  @RequiredScopes('erp:migration:execute', 'erp:org:master:write')
  async complete(@Param('id') id: string) {
    const report = await this.migrations.complete(requireRunId(id));
    await this.audit.record({
      action: 'data_migration.run.complete', resourceType: 'data_migration_run',
      resourceId: id, riskLevel: 'R2', outcome: report.phaseSixEligible ? 'success' : 'failure',
      metadata: {
        applied: report.counts.applied, duplicate: report.counts.duplicate,
        rejected: report.counts.rejected, differenceCount: report.differences.length,
      },
    });
    return report;
  }

  @Get('runs/:id/report')
  @RequiredScopes('erp:migration:read')
  async report(@Param('id') id: string) {
    const report = await this.migrations.report(requireRunId(id));
    await this.audit.record({
      action: 'data_migration.report.read', resourceType: 'data_migration_run',
      resourceId: id, riskLevel: 'R1', outcome: 'success',
      metadata: { status: report.status, differenceCount: report.differences.length },
    });
    return report;
  }
}

function requireRunId(value: string): string {
  if (!ULID.test(value)) throw new BadRequestException({
    code: 'DATA_MIGRATION_RUN_ID_INVALID', message: '迁移运行标识非法',
  });
  return value;
}
