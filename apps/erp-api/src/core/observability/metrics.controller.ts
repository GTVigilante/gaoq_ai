import { Controller, Get, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';

import { PublicRoute, RawResponse } from '../http/public-route.decorator.js';
import { MetricsAccessGuard } from './metrics-access.guard.js';
import { MetricsService } from './metrics.service.js';

/** Prometheus 抓取端点；不进入业务响应信封，但始终要求独立抓取凭据。 */
@Controller('metrics')
@PublicRoute()
@RawResponse()
@UseGuards(MetricsAccessGuard)
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  async scrape(@Res({ passthrough: true }) response: Response): Promise<string> {
    response.setHeader('Content-Type', this.metrics.contentType);
    response.setHeader('Cache-Control', 'no-store');
    return this.metrics.render();
  }
}
