import {
  GoneException,
  Injectable,
} from '@nestjs/common';
import type { CanActivate } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppEnvironment } from '../../config/environment.js';

/** 在专业算薪成为唯一事实源后关闭 ERP 旧工资与资金 REST 入口。 */
@Injectable()
export class LegacyPayrollBoundaryGuard implements CanActivate {
  constructor(private readonly config: ConfigService<AppEnvironment, true>) {}

  canActivate(): boolean {
    if (this.config.get('PAYROLL_SYSTEM_MODE', { infer: true }) === 'legacy') {
      return true;
    }
    throw new GoneException({
      code: 'PAYROLL_MOVED_TO_PROFESSIONAL_SYSTEM',
      message: '工资能力已迁移至专业算薪系统',
      payrollWebOrigin: this.config.get('PAYROLL_WEB_ORIGIN', { infer: true }),
    });
  }
}
