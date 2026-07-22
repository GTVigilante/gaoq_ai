import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import type { AppEnvironment } from '../../config/environment.js';
import { MetricsAuthorizationService } from './metrics-authorization.service.js';
import { MetricsService } from './metrics.service.js';

/** 为无 Nest HTTP 监听器的后台 Worker 暴露唯一的受保护 Prometheus 端点。 */
@Injectable()
export class WorkerMetricsServer implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(WorkerMetricsServer.name);
  private server: Server | undefined;

  constructor(
    private readonly config: ConfigService<AppEnvironment, true>,
    private readonly authorization: MetricsAuthorizationService,
    private readonly metrics: MetricsService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.authorization.verify(undefined) === 'disabled') return;
    const server = createServer((request, response) => {
      void this.handle(request, response);
    });
    this.server = server;
    const port = this.config.get('WORKER_METRICS_PORT', { infer: true });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '0.0.0.0', () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.logger.log(`Worker 指标端点已监听 0.0.0.0:${port}`);
  }

  async onApplicationShutdown(): Promise<void> {
    const server = this.server;
    if (server === undefined || !server.listening) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error === undefined ? resolve() : reject(error));
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method === 'GET' && request.url === '/health/live') {
      respond(response, 200, 'OK');
      return;
    }
    if (request.method !== 'GET' || request.url !== '/metrics') {
      respond(response, 404, 'Not Found');
      return;
    }
    const rawAuthorization = request.headers.authorization;
    const authorization = Array.isArray(rawAuthorization) ? undefined : rawAuthorization;
    if (this.authorization.verify(authorization) !== 'valid') {
      respond(response, 401, 'Unauthorized');
      return;
    }
    try {
      response.statusCode = 200;
      response.setHeader('Content-Type', this.metrics.contentType);
      response.setHeader('Cache-Control', 'no-store');
      response.end(await this.metrics.render());
    } catch {
      respond(response, 500, 'Internal Server Error');
    }
  }
}

function respond(response: ServerResponse, statusCode: number, body: string): void {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'text/plain; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(body);
}
