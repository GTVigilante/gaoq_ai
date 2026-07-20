import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';

import { PublicRoute } from '../core/http/public-route.decorator.js';
import { HealthService, type HealthResult } from './health.service.js';

@Controller('health')
@PublicRoute()
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /** Kubernetes 存活探针。 */
  @Get('live')
  live(): HealthResult {
    return this.health.live();
  }

  /** Kubernetes 就绪探针；依赖故障时返回 503。 */
  @Get('ready')
  async ready(): Promise<HealthResult> {
    const result = await this.health.ready();
    if (result.status === 'error') {
      throw new ServiceUnavailableException({ code: 'DEPENDENCY_UNAVAILABLE', message: '依赖服务未就绪' });
    }
    return result;
  }
}
