import { ForbiddenException, Inject, Injectable, Scope } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import type { PayrollIdentityContext } from '@gaoq/platform-contracts';

import type { AuthenticatedPayrollRequest } from './identity.types.js';

/** 请求级可信身份上下文，业务服务禁止读取客户端租户头。 */
@Injectable({ scope: Scope.REQUEST })
export class IdentityContextService {
  constructor(
    @Inject(REQUEST) private readonly request: AuthenticatedPayrollRequest,
  ) {}

  get(): PayrollIdentityContext {
    if (this.request.payrollIdentity === undefined) {
      throw new ForbiddenException({
        code: 'AUTH_CONTEXT_MISSING',
        message: '可信身份上下文不存在',
      });
    }
    return this.request.payrollIdentity;
  }

  requireScope(scope: string): PayrollIdentityContext {
    const identity = this.get();
    if (!identity.scopes.includes(scope)) {
      throw new ForbiddenException({
        code: 'AUTH_SCOPE_DENIED',
        message: '缺少所需算薪权限',
      });
    }
    return identity;
  }
}
