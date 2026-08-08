import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';

import { Public } from './common/public.decorator.js';

@Controller('health')
export class HealthController {
  constructor(@InjectConnection() private readonly connection: Connection) {}

  @Public()
  @Get('live')
  live(): { readonly status: 'ok' } {
    return { status: 'ok' };
  }

  /** 就绪检查只验证本系统独立 MongoDB，不访问 GaoQ ERP 或任何外部业务系统。 */
  @Public()
  @Get('ready')
  async ready(): Promise<{ readonly status: 'ready'; readonly mongodb: 'ok' }> {
    const database = this.connection.db;
    if (database === undefined) throw this.unavailable();
    try {
      await Promise.race([
        database.admin().ping(),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('PAYROLL_MONGODB_READY_TIMEOUT')), 1_500);
        }),
      ]);
      return { status: 'ready', mongodb: 'ok' };
    } catch {
      throw this.unavailable();
    }
  }

  private unavailable(): ServiceUnavailableException {
    return new ServiceUnavailableException({
      code: 'PAYROLL_NOT_READY',
      message: '专业算薪依赖尚未就绪',
    });
  }
}
