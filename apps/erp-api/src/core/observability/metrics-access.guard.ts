import {
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request } from 'express';

import { MetricsAuthorizationService } from './metrics-authorization.service.js';

/** Prometheus 抓取凭据守卫；与业务 OAuth 身份域隔离并采用恒定时间摘要比较。 */
@Injectable()
export class MetricsAccessGuard implements CanActivate {
  constructor(private readonly authorization: MetricsAuthorizationService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const result = this.authorization.verify(request.header('authorization'));
    if (result === 'disabled') {
      throw new ServiceUnavailableException({
        code: 'METRICS_DISABLED',
        message: '指标抓取端点未启用',
      });
    }
    if (result !== 'valid') {
      throw new UnauthorizedException({ code: 'METRICS_AUTH_REQUIRED', message: '抓取凭据无效' });
    }
    return true;
  }
}
