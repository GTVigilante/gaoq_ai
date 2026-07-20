import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import { InjectConnection } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';

import { REDIS_CLIENT } from '../infrastructure/redis/redis.constants.js';
import type { AppEnvironment } from '../config/environment.js';

export interface HealthResult {
  readonly status: 'ok' | 'error';
  readonly checks?: Readonly<Record<string, 'up' | 'down'>>;
}

@Injectable()
export class HealthService {
  constructor(
    @InjectConnection() private readonly mongo: Connection,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly config: ConfigService<AppEnvironment, true>,
  ) {}

  /** 进程存活探针不得依赖外部系统。 */
  live(): HealthResult {
    return { status: 'ok' };
  }

  /** 就绪探针同时验证 MongoDB Replica Set 与 Redis。 */
  async ready(): Promise<HealthResult> {
    const mongoUp = await this.isMongoReady();
    const redisUp = await this.isRedisReady();

    const status = mongoUp && redisUp ? 'ok' : 'error';
    return { status, checks: { mongodb: mongoUp ? 'up' : 'down', redis: redisUp ? 'up' : 'down' } };
  }

  private async isMongoReady(): Promise<boolean> {
    try {
      const state = Number(this.mongo.readyState);
      if (state === 1) {
        return true;
      }
      if (state === 2) {
        await this.mongo.asPromise();
        return Number(this.mongo.readyState) === 1;
      }
      if (state !== 0) {
        return false;
      }

      await this.mongo.openUri(this.config.get('MONGODB_URI', { infer: true }), {
        serverSelectionTimeoutMS: 1_000,
      });
      return Number(this.mongo.readyState) === 1;
    } catch {
      return false;
    }
  }

  private async isRedisReady(): Promise<boolean> {
    try {
      if (['wait', 'end'].includes(String(this.redis.status))) {
        await this.redis.connect();
      }
      return (await this.redis.ping()) === 'PONG';
    } catch {
      return false;
    }
  }
}
