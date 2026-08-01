import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';

import type { AppEnvironment } from '../../config/environment.js';
import { REDIS_CLIENT } from './redis.constants.js';
import { toBullMqConnection } from './redis-options.js';

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppEnvironment, true>): Redis => {
        const client = new Redis({
          ...toBullMqConnection(config.get('REDIS_URL', { infer: true })),
          lazyConnect: true,
          enableOfflineQueue: false,
          retryStrategy: () => null,
        });
        client.on('error', () => undefined);
        return client;
      },
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /** 应用关闭时释放 Redis 连接，避免测试和滚动发布残留句柄。 */
  async onApplicationShutdown(): Promise<void> {
    if (this.redis.status === 'ready') {
      await this.redis.quit();
      return;
    }
    this.redis.disconnect();
  }
}
