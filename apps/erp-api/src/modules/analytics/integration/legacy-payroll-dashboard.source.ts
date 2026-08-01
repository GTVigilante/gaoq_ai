import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';

import { LegacyPayrollBoundaryService } from '../../payroll/legacy-payroll-boundary.service.js';
import type { PayrollPeriodStatus } from '../../payroll/domain/index.js';
import {
  PayrollPeriodRecord,
  type PayrollPeriodDocument,
} from '../../payroll/persistence/payroll.schemas.js';

export type LegacyPayrollDashboardSnapshot = {
  readonly period: string;
  readonly status: PayrollPeriodStatus;
  readonly employeeCount: number | null;
};

export type LegacyPayrollDashboardResult = {
  readonly enabled: boolean;
  readonly snapshot: LegacyPayrollDashboardSnapshot | null;
};

/**
 * 管理分析读取旧工资期的唯一适配器。
 *
 * 默认 external 模式必须在构造 Mongo 查询前返回禁用结果，避免 REST、MCP 或
 * 异步 Worker 通过管理聚合旁路读取 ERP 旧工资事实。
 */
@Injectable()
export class LegacyPayrollDashboardSource {
  constructor(
    private readonly boundary: LegacyPayrollBoundaryService,
    @InjectModel(PayrollPeriodRecord.name)
    private readonly payrollPeriods: Model<PayrollPeriodDocument>,
  ) {}

  async getLatest(tenantId: string, latestPeriod: string): Promise<LegacyPayrollDashboardResult> {
    if (!this.boundary.isLegacyEnabled()) {
      return Object.freeze({ enabled: false, snapshot: null });
    }
    const snapshot = await this.payrollPeriods.findOne(
      { tenantId, period: { $lte: latestPeriod } },
      { period: 1, status: 1, employeeCount: 1, _id: 0 },
    ).sort({ period: -1 }).lean().exec();
    return Object.freeze({
      enabled: true,
      snapshot: snapshot === null
        ? null
        : Object.freeze({
            period: snapshot.period,
            status: snapshot.status,
            employeeCount: snapshot.employeeCount,
          }),
    });
  }
}
