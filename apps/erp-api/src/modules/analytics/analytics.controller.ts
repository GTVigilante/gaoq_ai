import { BadRequestException, Controller, Get, Query } from '@nestjs/common';

import { AuditService } from '../../core/audit/audit.service.js';
import { RequiredScopes } from '../identity/auth.decorators.js';
import { ManagementDashboardService } from './application/management-dashboard.service.js';

/** 管理驾驶舱只读入口；不返回个人明细、表单、薪资金额或候选人数据。 */
@Controller('analytics')
export class AnalyticsController {
  constructor(
    private readonly dashboard: ManagementDashboardService,
    private readonly audit: AuditService,
  ) {}

  @Get('management-dashboard')
  @RequiredScopes('erp:analytics:management:read')
  async getManagementDashboard(@Query() query: Record<string, unknown>) {
    const keys = Object.keys(query);
    if (keys.length !== 1 || keys[0] !== 'asOf' || typeof query.asOf !== 'string') {
      throw new BadRequestException({
        code: 'ANALYTICS_QUERY_INVALID',
        message: '管理驾驶舱只接受单一 asOf 查询参数',
      });
    }
    const asOf = query.asOf;
    const result = await this.dashboard.get(asOf);
    await this.audit.record({
      action: 'analytics.management_dashboard.read', resourceType: 'management_dashboard',
      resourceId: result.asOf, riskLevel: 'R1', outcome: 'success',
      metadata: { asOf: result.asOf, sourceCount: result.sources.length },
    });
    return result;
  }
}
