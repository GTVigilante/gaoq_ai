import {
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';

import { IS_PUBLIC_ROUTE } from '../common/public.decorator.js';
import type { AppEnvironment } from '../config/environment.js';
import { AccessTokenVerifier } from './access-token-verifier.js';
import type { AuthenticatedPayrollRequest } from './identity.types.js';

/** 全局 Bearer Guard；租户只从已验签 GaoQ 身份派生。 */
@Injectable()
export class BearerAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly verifier: AccessTokenVerifier,
    private readonly config: ConfigService<AppEnvironment, true>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_ROUTE, [
      context.getHandler(),
      context.getClass(),
    ]) === true) return true;
    const request = context.switchToHttp().getRequest<AuthenticatedPayrollRequest>();
    const response = context.switchToHttp().getResponse<Response>();
    const resourceMetadata = new URL(
      '/.well-known/oauth-protected-resource/api/payroll/v1',
      this.config.get('AUTH_RESOURCE', { infer: true }),
    ).toString();
    response.setHeader(
      'WWW-Authenticate',
      `Bearer resource_metadata="${resourceMetadata}"`,
    );
    const authorization = request.headers.authorization;
    if (authorization === undefined || !authorization.startsWith('Bearer ')) {
      throw new UnauthorizedException({
        code: 'AUTH_BEARER_REQUIRED',
        message: '缺少 Bearer Token',
      });
    }
    const identity = await this.verifier.verify(authorization.slice(7));
    const traceHeader = request.headers['x-trace-id'];
    request.payrollIdentity = Object.freeze({
      ...identity,
      traceId: typeof traceHeader === 'string' && traceHeader.length > 0
        ? traceHeader
        : randomUUID(),
    });
    return true;
  }
}
