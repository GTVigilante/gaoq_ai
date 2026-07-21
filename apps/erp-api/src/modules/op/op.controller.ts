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
} from '@nestjs/common';

import { AuditService } from '../../core/audit/audit.service.js';
import { RequiredScopes } from '../identity/auth.decorators.js';
import {
  OpOperatingSummaryService,
  type OpOperatingSummaryView,
} from './application/op-operating-summary.service.js';
import {
  OpApprovalBridgeService,
  type OpApprovalBridgeView,
} from './application/op-approval-bridge.service.js';
import {
  OpApprovalResultOperationsService,
  type OpApprovalResultRetryReason,
} from './application/op-approval-result-operations.service.js';

const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const RETRY_REASONS: readonly OpApprovalResultRetryReason[] = [
  'credentials_fixed', 'route_fixed', 'provider_recovered', 'approved_exception',
];

/** OP 控制面；业务数据只读，仅允许对终态失败投递执行受审计的幂等重试。 */
@Controller('op')
export class OpController {
  constructor(
    private readonly summaries: OpOperatingSummaryService,
    private readonly approvalBridges: OpApprovalBridgeService,
    private readonly approvalResultOperations: OpApprovalResultOperationsService,
    private readonly audit: AuditService,
  ) {}

  @Get('operating-summaries/:date')
  @RequiredScopes('erp:op:operating_summary:read')
  async getOperatingSummary(@Param('date') date: string): Promise<OpOperatingSummaryView> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new BadRequestException({
      code: 'OP_OPERATING_SUMMARY_DATE_INVALID', message: '经营摘要日期必须为 YYYY-MM-DD',
    });
    const result = await this.summaries.getLatest(date);
    await this.audit.record({
      action: 'op.operating_summary.read', resourceType: 'op_operating_summary',
      resourceId: result.id, riskLevel: 'R0', outcome: 'success', metadata: {
        summaryDate: result.summaryDate, revision: result.revision,
        payloadHash: result.payloadHash,
      },
    });
    return result;
  }

  @Get('approval-bridges/:externalEventId')
  @RequiredScopes('erp:op:approval_bridge:read')
  async getApprovalBridge(
    @Param('externalEventId') externalEventId: string,
  ): Promise<OpApprovalBridgeView> {
    const result = await this.approvalBridges.get(externalEventId);
    await this.audit.record({
      action: 'op.approval_bridge.read', resourceType: 'op_approval_bridge',
      resourceId: result.approvalInstanceId, riskLevel: 'R0', outcome: 'success',
      metadata: {
        externalEventId: result.externalEventId,
        sourceDocumentType: result.sourceDocumentType,
        approvalStatus: result.approvalStatus,
      },
    });
    return result;
  }

  @Get('approval-result-deliveries')
  @RequiredScopes('erp:op:approval_result:read')
  async listApprovalResultDeliveries(
    @Query('status') status: string | undefined,
    @Query('before') before: string | undefined,
    @Query('limit') limit: string | undefined,
  ) {
    const parsedStatus = this.requireDeliveryStatus(status);
    const result = await this.approvalResultOperations.listTerminal({
      status: parsedStatus,
      ...(before === undefined ? {} : { beforeEventId: this.requireUlid(before) }),
      limit: this.requireLimit(limit),
    });
    await this.audit.record({
      action: 'op.approval.result.list', resourceType: 'op_approval_result',
      resourceId: parsedStatus, riskLevel: 'R0', outcome: 'success',
      metadata: { status: parsedStatus, count: result.items.length },
    });
    return result;
  }

  @Post('approval-result-deliveries/:eventId/retries')
  @HttpCode(200)
  @RequiredScopes('erp:op:approval_result:operate')
  async retryApprovalResultDelivery(
    @Param('eventId') eventId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: { readonly reason?: string },
  ) {
    const parsedEventId = this.requireUlid(eventId);
    const reason = this.requireRetryReason(body.reason);
    let result;
    try {
      result = await this.approvalResultOperations.retry(
        parsedEventId, reason, this.requireIdempotencyKey(idempotencyKey),
      );
    } catch (error) {
      await this.auditApprovalResultRetry(parsedEventId, reason, 'failure');
      throw error;
    }
    await this.auditApprovalResultRetry(parsedEventId, reason, 'success');
    return result;
  }

  private requireDeliveryStatus(value: string | undefined): 'manual_review' | 'dead' {
    if (value === 'manual_review' || value === 'dead') return value;
    throw new BadRequestException({
      code: 'OP_APPROVAL_RESULT_STATUS_INVALID', message: 'status 必须为 manual_review 或 dead',
    });
  }

  private requireUlid(value: string): string {
    if (ULID_PATTERN.test(value)) return value;
    throw new BadRequestException({
      code: 'OP_APPROVAL_RESULT_EVENT_ID_INVALID', message: 'eventId 必须为严格 ULID',
    });
  }

  private requireLimit(value: string | undefined): number {
    const parsed = value === undefined ? 50 : Number(value);
    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 100) return parsed;
    throw new BadRequestException({
      code: 'OP_APPROVAL_RESULT_LIMIT_INVALID', message: 'limit 必须为 1..100',
    });
  }

  private requireRetryReason(value: string | undefined): OpApprovalResultRetryReason {
    if (RETRY_REASONS.includes(value as OpApprovalResultRetryReason)) {
      return value as OpApprovalResultRetryReason;
    }
    throw new BadRequestException({
      code: 'OP_APPROVAL_RESULT_REASON_INVALID', message: '重试原因码非法',
    });
  }

  private requireIdempotencyKey(value: string | undefined): string {
    if (value !== undefined && IDEMPOTENCY_KEY_PATTERN.test(value)) return value;
    throw new BadRequestException({
      code: 'IDEMPOTENCY_KEY_REQUIRED', message: '必须提供合法 Idempotency-Key',
    });
  }

  private async auditApprovalResultRetry(
    eventId: string,
    reason: OpApprovalResultRetryReason,
    outcome: 'success' | 'failure',
  ): Promise<void> {
    await this.audit.record({
      action: 'op.approval.result.retry', resourceType: 'op_approval_result',
      resourceId: eventId, riskLevel: 'R2', outcome, metadata: { reason },
    });
  }
}
