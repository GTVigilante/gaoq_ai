import { Module, RequestMethod, type MiddlewareConsumer, type NestModule } from '@nestjs/common';

import { TraceMiddleware } from './trace.middleware.js';

@Module({
  providers: [TraceMiddleware],
})
export class TraceMiddlewareModule implements NestModule {
  /** 将追踪上下文安装到所有 HTTP 路由。 */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TraceMiddleware).forRoutes({ path: '{*path}', method: RequestMethod.ALL });
  }
}
