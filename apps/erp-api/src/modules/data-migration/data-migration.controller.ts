import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Logger,
  Param,
  Post,
  Query,
} from '@nestjs/common';

import type { AuditRecordInput } from '../../core/audit/audit.types.js';
import { AuditService } from '../../core/audit/audit.service.js';
import { RequiredScopes } from '../identity/auth.decorators.js';
import { DataMigrationAttachmentService } from './application/data-migration-attachment.service.js';
import { DataMigrationService } from './application/data-migration.service.js';
import {
  ApplyDataMigrationRecordDto,
  CreateDataMigrationRunDto,
  DataMigrationEvidenceQueryDto,
} from './data-migration.dto.js';

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

/** 迁移控制面仅接收受信任服务身份；业务目标写入仍由领域应用服务完成。 */
@Controller('data-migrations')
export class DataMigrationController {
  private readonly logger = new Logger(DataMigrationController.name);

  constructor(
    private readonly migrations: DataMigrationService,
    private readonly attachments: DataMigrationAttachmentService,
    private readonly audit: AuditService,
  ) {}

  @Post('runs')
  @RequiredScopes('erp:migration:execute')
  async start(@Body() body: CreateDataMigrationRunDto) {
    const run = await this.migrations.start(body);
    await this.auditAfterCommit({
      action: 'data_migration.run.start', resourceType: 'data_migration_run',
      resourceId: run.id, riskLevel: 'R2', outcome: 'success',
      metadata: { sourceSystem: run.sourceSystem, mode: run.mode, scope: run.scope },
    });
    return run;
  }

  @Post('runs/:id/records')
  @RequiredScopes('erp:migration:execute')
  async apply(@Param('id') id: string, @Body() body: ApplyDataMigrationRecordDto) {
    const runId = requireRunId(id);
    const item = await this.migrations.apply(runId, body);
    await this.auditAfterCommit({
      action: 'data_migration.record.apply', resourceType: 'data_migration_run',
      resourceId: runId,
      riskLevel: 'R2',
      outcome: item.status === 'rejected' ? 'failure' : 'success',
      metadata: { sequence: item.sequence, entityType: item.entityType, status: item.status },
    });
    return item;
  }

  @Post('runs/:id/complete')
  @RequiredScopes('erp:migration:execute')
  async complete(@Param('id') id: string) {
    const runId = requireRunId(id);
    const report = await this.migrations.complete(runId);
    await this.auditAfterCommit({
      action: 'data_migration.run.complete', resourceType: 'data_migration_run',
      resourceId: runId,
      riskLevel: 'R2',
      outcome: report.phaseSixEligible ? 'success' : 'failure',
      metadata: {
        applied: report.counts.applied, duplicate: report.counts.duplicate,
        rejected: report.counts.rejected, differenceCount: report.differences.length,
      },
    });
    return report;
  }

  @Post('runs/:id/attachments/transfer')
  @RequiredScopes('erp:migration:execute', 'erp:migration:attachment:execute')
  async transferAttachments(@Param('id') id: string) {
    const runId = requireRunId(id);
    const result = await this.attachments.request(runId);
    await this.auditAfterCommit({
      action: 'data_migration.attachment.transfer.request',
      resourceType: 'data_migration_run', resourceId: runId,
      riskLevel: 'R2', outcome: 'success',
      metadata: { status: result.status, pendingCount: result.pendingCount },
    });
    return result;
  }

  @Get('runs/:id/report')
  @RequiredScopes('erp:migration:read')
  async report(@Param('id') id: string) {
    const runId = requireRunId(id);
    const report = await this.migrations.report(runId);
    await this.audit.record({
      action: 'data_migration.report.read', resourceType: 'data_migration_run',
      resourceId: runId, riskLevel: 'R1', outcome: 'success',
      metadata: { status: report.status, differenceCount: report.differences.length },
    });
    return report;
  }

  @Get('runs/:id/evidence')
  @RequiredScopes('erp:migration:read', 'erp:migration:evidence:export')
  async evidence(
    @Param('id') id: string,
    @Query() query: DataMigrationEvidenceQueryDto,
  ) {
    const runId = requireRunId(id);
    const page = await this.migrations.evidence(runId, query);
    await this.audit.record({
      action: 'data_migration.evidence.export', resourceType: 'data_migration_run',
      resourceId: runId, riskLevel: 'R2', outcome: 'success',
      metadata: {
        kind: page.kind, recordCount: page.records.length,
        hasNextPage: page.nextCursor !== null, pageChecksum: page.pageChecksum,
      },
    });
    return page;
  }

  /** 迁移状态已提交后的审计故障只告警，不能诱导客户端重复执行迁移。 */
  private async auditAfterCommit(input: AuditRecordInput): Promise<void> {
    try {
      await this.audit.record(input);
    } catch {
      this.logger.error({
        code: 'DATA_MIGRATION_AUDIT_AFTER_COMMIT_FAILED',
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        riskLevel: input.riskLevel,
      });
    }
  }
}

function requireRunId(value: string): string {
  if (!ULID.test(value)) throw new BadRequestException({
    code: 'DATA_MIGRATION_RUN_ID_INVALID', message: '迁移运行标识非法',
  });
  return value;
}
