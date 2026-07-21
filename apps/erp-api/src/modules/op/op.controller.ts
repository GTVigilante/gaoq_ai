import { BadRequestException, Controller, Get, Param } from '@nestjs/common';

import { AuditService } from '../../core/audit/audit.service.js';
import { RequiredScopes } from '../identity/auth.decorators.js';
import {
  OpOperatingSummaryService,
  type OpOperatingSummaryView,
} from './application/op-operating-summary.service.js';

/** OP 经营数据只读控制面；不提供人工录入或覆写接口。 */
@Controller('op')
export class OpController {
  constructor(
    private readonly summaries: OpOperatingSummaryService,
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
}
