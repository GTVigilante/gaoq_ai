import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { PUBLIC_ROUTE_KEY } from '../../core/http/public-route.decorator.js';
import type { ErpRequest } from '../../core/http/request-context.js';
import { REQUIRED_SCOPES_KEY } from './auth.decorators.js';
import { AccessTokenVerifier } from './access-token-verifier.js';

@Injectable()
export class BearerAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly verifier: AccessTokenVerifier,
  ) {}

  /** 验证 Bearer Token，并将可信主体写入请求；从不读取租户请求头。 */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic === true) {
      return true;
    }
    const request = context.switchToHttp().getRequest<ErpRequest>();
    const authorization = request.header('authorization');
    const match = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(authorization ?? '');
    if (match?.[1] === undefined) {
      throw new UnauthorizedException({ code: 'AUTH_REQUIRED', message: '缺少访问令牌' });
    }
    const token = await this.verifier.verify(match[1]);
    const requiredScopes = this.reflector.getAllAndOverride<readonly string[]>(REQUIRED_SCOPES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]) ?? [];
    if (!requiredScopes.every((scope) => token.scopes.includes(scope))) {
      throw new ForbiddenException({ code: 'AUTH_INSUFFICIENT_SCOPE', message: '权限范围不足' });
    }
    request.user = {
      actorId: token.actorId,
      actorType: token.actorType,
      tenantId: token.tenantId,
      identitySource: token.actorType === 'user' ? 'access_token' : 'service_identity',
      roleCodes: token.roleCodes,
      scopes: token.scopes,
      departmentIds: token.departmentIds,
    };
    request.bearerToken = match[1];
    request.verifiedAccessToken = token;
    return true;
  }
}
