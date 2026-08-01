import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  Logger,
  Post,
} from '@nestjs/common';

import { AuditService } from '../../core/audit/audit.service.js';
import { RequiredScopes } from '../identity/auth.decorators.js';
import { ReconcileAttendanceProviderCoverageDto } from './attendance-provider-coverage.dto.js';
import {
  AttendanceProviderCoverageService,
  type AttendanceProviderCoverageReconcileResult,
} from './attendance-provider-coverage.service.js';

@Controller('integrations/attendance-provider-coverages')
export class AttendanceProviderCoverageController {
  private readonly logger = new Logger(AttendanceProviderCoverageController.name);

  constructor(
    private readonly coverages: AttendanceProviderCoverageService,
    private readonly audit: AuditService,
  ) {}

  @Post('reconcile')
  @RequiredScopes(
    'erp:attendance:provider:reconcile',
    'erp:attendance:coverage:attest',
  )
  async reconcile(
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: ReconcileAttendanceProviderCoverageDto,
  ): Promise<AttendanceProviderCoverageReconcileResult> {
    const result = await this.coverages.reconcile(this.key(key), body);
    try {
      await this.audit.record({
        action: 'integration.attendance_provider.coverage.reconcile',
        resourceType: 'attendance_provider_state',
        resourceId: result.stateId,
        riskLevel: 'R2',
        outcome: 'success',
        metadata: {
          providerCode: result.providerCode,
          month: result.month,
          throughBusinessDate: result.throughBusinessDate,
          attestedCount: result.attestedCount,
          complete: result.complete,
        },
      });
    } catch {
      this.logger.error({
        code: 'ATTENDANCE_PROVIDER_COVERAGE_AUDIT_AFTER_COMMIT_FAILED',
        stateId: result.stateId,
        month: result.month,
      });
    }
    return result;
  }

  private key(value: string | undefined): string {
    if (
      value === undefined ||
      value.length < 8 ||
      value.length > 128 ||
      !/^[A-Za-z0-9._:-]+$/.test(value)
    ) {
      throw new BadRequestException({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        message: '必须提供 8..128 字符合法 Idempotency-Key',
      });
    }
    return value;
  }
}
