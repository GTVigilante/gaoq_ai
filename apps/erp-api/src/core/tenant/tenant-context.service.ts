import { Injectable } from '@nestjs/common';
import type { ActorContext, TenantContext } from '@gaoq/shared-types';
import { AsyncLocalStorage } from 'node:async_hooks';

/** 单次调用的可信身份上下文。 */
export interface TrustedRequestContext {
  readonly tenant: TenantContext;
  readonly actor: ActorContext;
}

@Injectable()
export class TenantContextService {
  private readonly storage = new AsyncLocalStorage<TrustedRequestContext>();

  /** 在可信租户上下文中执行回调，并向后续异步调用传播上下文。 */
  run<T>(context: TrustedRequestContext, callback: () => T): T {
    return this.storage.run(context, callback);
  }

  /** 获取当前可信租户上下文；缺失时拒绝继续执行业务逻辑。 */
  getRequired(): TrustedRequestContext {
    const context = this.storage.getStore();
    if (context === undefined) {
      throw new Error('可信租户上下文不存在');
    }
    return context;
  }

  /** 获取已验证身份派生的租户上下文。 */
  getTenantRequired(): TenantContext {
    return this.getRequired().tenant;
  }

  /** 获取已验证身份派生的操作主体上下文。 */
  getActorRequired(): ActorContext {
    return this.getRequired().actor;
  }
}
