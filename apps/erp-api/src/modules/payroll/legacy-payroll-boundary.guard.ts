import { Injectable } from '@nestjs/common';
import type { CanActivate } from '@nestjs/common';

import { LegacyPayrollBoundaryService } from './legacy-payroll-boundary.service.js';

/** 在专业算薪成为唯一事实源后关闭 ERP 旧工资与资金 REST 入口。 */
@Injectable()
export class LegacyPayrollBoundaryGuard implements CanActivate {
  constructor(private readonly boundary: LegacyPayrollBoundaryService) {}

  canActivate(): boolean {
    this.boundary.assertLegacy();
    return true;
  }
}
