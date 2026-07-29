import { GoneException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppEnvironment } from '../../config/environment.js';

/**
 * 旧工资事实源共享边界。
 *
 * REST Guard、MCP、Worker、迁移与跨模块内部调用必须复用本服务，禁止只在 HTTP
 * 入口关闭后继续读写 ERP 旧 Payroll/Treasury 集合。
 */
@Injectable()
export class LegacyPayrollBoundaryService {
  constructor(private readonly config: ConfigService<AppEnvironment, true>) {}

  assertLegacy(): void {
    if (this.config.get('PAYROLL_SYSTEM_MODE', { infer: true }) === 'legacy') return;
    throw new GoneException({
      code: 'PAYROLL_MOVED_TO_PROFESSIONAL_SYSTEM',
      message: '工资能力已迁移至专业算薪系统',
      payrollWebOrigin: this.config.get('PAYROLL_WEB_ORIGIN', { infer: true }),
    });
  }
}
