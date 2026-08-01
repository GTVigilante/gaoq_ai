import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import { InjectConnection } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';

import { REDIS_CLIENT } from '../infrastructure/redis/redis.constants.js';
import type { AppEnvironment } from '../config/environment.js';

const DEPENDENCY_CHECK_TIMEOUT_MS = 1_250;
const DEPENDENCY_OPERATION_TIMEOUT_MS = 1_000;

export interface HealthResult {
  readonly status: 'ok' | 'error';
  readonly checks?: Readonly<Record<string, 'up' | 'down'>>;
}

@Injectable()
export class HealthService {
  private mongoCheckInFlight: Promise<boolean> | undefined;
  private redisCheckInFlight: Promise<boolean> | undefined;

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
    const [mongoUp, redisUp] = await Promise.all([
      this.mongoReady(),
      this.redisReady(),
    ]);

    const status = mongoUp && redisUp ? 'ok' : 'error';
    return { status, checks: { mongodb: mongoUp ? 'up' : 'down', redis: redisUp ? 'up' : 'down' } };
  }

  private mongoReady(): Promise<boolean> {
    if (this.mongoCheckInFlight === undefined) {
      const operation = this.isMongoReady();
      this.mongoCheckInFlight = operation;
      void operation.finally(() => {
        if (this.mongoCheckInFlight === operation) this.mongoCheckInFlight = undefined;
      });
    }
    return withDeadline(this.mongoCheckInFlight, DEPENDENCY_CHECK_TIMEOUT_MS);
  }

  private redisReady(): Promise<boolean> {
    if (this.redisCheckInFlight === undefined) {
      const operation = this.isRedisReady();
      this.redisCheckInFlight = operation;
      void operation.finally(() => {
        if (this.redisCheckInFlight === operation) this.redisCheckInFlight = undefined;
      });
    }
    return withDeadline(this.redisCheckInFlight, DEPENDENCY_CHECK_TIMEOUT_MS);
  }

  private async isMongoReady(): Promise<boolean> {
    try {
      const state = Number(this.mongo.readyState);
      if (state === 2) {
        await this.mongo.asPromise();
      } else if (state === 0) {
        await this.mongo.openUri(this.config.get('MONGODB_URI', { infer: true }), {
          connectTimeoutMS: DEPENDENCY_OPERATION_TIMEOUT_MS,
          serverSelectionTimeoutMS: DEPENDENCY_OPERATION_TIMEOUT_MS,
        });
      } else if (state !== 1) return false;
      if (Number(this.mongo.readyState) !== 1 || this.mongo.db === undefined) return false;
      const hello = await this.mongo.db.admin().command(
        { hello: 1 },
        { timeoutMS: DEPENDENCY_OPERATION_TIMEOUT_MS },
      );
      return hello['isWritablePrimary'] === true &&
        typeof hello['setName'] === 'string' &&
        hello['setName'].length > 0 &&
        hello['setName'].length <= 128;
    } catch {
      return false;
    }
  }

  private async isRedisReady(): Promise<boolean> {
    try {
      if (['wait', 'end'].includes(String(this.redis.status))) {
        await this.redis.connect();
      }
      if (String(this.redis.status) !== 'ready') return false;
      return (await this.redis.ping()) === 'PONG';
    } catch {
      return false;
    }
  }
}

async function withDeadline(operation: Promise<boolean>, timeoutMs: number): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<boolean>((resolve) => {
    timeout = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
