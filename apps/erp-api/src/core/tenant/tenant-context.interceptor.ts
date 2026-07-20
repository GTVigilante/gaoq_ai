import {
  Injectable,
  UnauthorizedException,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import type { ActorContext, TenantContext } from '@gaoq/shared-types';
import { createTraceId } from '@gaoq/shared-utils';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';

import { PUBLIC_ROUTE_KEY } from '../http/public-route.decorator.js';
import type { ErpRequest, TrustedPrincipal } from '../http/request-context.js';
import { TenantContextService } from './tenant-context.service.js';

@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** 仅从认证设施写入的 request.user 建立租户上下文，禁止读取客户端租户头。 */
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic === true) {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest<ErpRequest>();
    const principal = request.user;
    if (!this.isTrustedPrincipal(principal)) {
      throw new UnauthorizedException({ code: 'IDENTITY_REQUIRED', message: '缺少已验证身份' });
    }

    const tenant: TenantContext = {
      tenantId: principal.tenantId,
      source: principal.identitySource,
    };
    const actor: ActorContext = {
      actorId: principal.actorId,
      actorType: principal.actorType,
      tenantId: principal.tenantId,
      roleCodes: [...principal.roleCodes],
      scopes: [...principal.scopes],
      departmentIds: [...principal.departmentIds],
      traceId: request.traceId ?? createTraceId(),
    };

    return new Observable((subscriber) =>
      this.tenantContext.run({ tenant, actor }, () => next.handle().subscribe(subscriber)),
    );
  }

  private isTrustedPrincipal(principal: TrustedPrincipal | undefined): principal is TrustedPrincipal {
    return (
      principal !== undefined &&
      principal.tenantId.length > 0 &&
      principal.actorId.length > 0 &&
      Array.isArray(principal.roleCodes) &&
      Array.isArray(principal.scopes) &&
      Array.isArray(principal.departmentIds)
    );
  }
}
