import type { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import type { Connection } from 'mongoose';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppEnvironment } from '../config/environment.js';
import { HealthService } from './health.service.js';

interface MongoDouble {
  readyState: number;
  readonly asPromise: ReturnType<typeof vi.fn>;
  readonly openUri: ReturnType<typeof vi.fn>;
  db:
    | {
      readonly admin: () => {
        readonly command: ReturnType<typeof vi.fn>;
      };
    }
    | undefined;
}

interface RedisDouble {
  status: string;
  readonly connect: ReturnType<typeof vi.fn>;
  readonly ping: ReturnType<typeof vi.fn>;
}

function fixture() {
  const command = vi.fn().mockResolvedValue({
    isWritablePrimary: true,
    setName: 'rs0',
  });
  const mongo: MongoDouble = {
    readyState: 1,
    asPromise: vi.fn().mockResolvedValue(undefined),
    openUri: vi.fn().mockResolvedValue(undefined),
    db: { admin: () => ({ command }) },
  };
  const redis: RedisDouble = {
    status: 'ready',
    connect: vi.fn().mockImplementation(() => {
      redis.status = 'ready';
      return Promise.resolve();
    }),
    ping: vi.fn().mockResolvedValue('PONG'),
  };
  const config = {
    get: () => 'mongodb://mongo.internal/gaoq?replicaSet=rs0',
  } as unknown as ConfigService<AppEnvironment, true>;
  return {
    service: new HealthService(
      mongo as unknown as Connection,
      redis as unknown as Redis,
      config,
    ),
    mongo,
    redis,
    command,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('HealthService', () => {
  it('存活探针不访问任何外部依赖', () => {
    const assembled = fixture();
    expect(assembled.service.live()).toEqual({ status: 'ok' });
    expect(assembled.command).not.toHaveBeenCalled();
    expect(assembled.redis.ping).not.toHaveBeenCalled();
  });

  it('就绪探针并行验证可写 MongoDB Replica Set 与 Redis', async () => {
    const assembled = fixture();

    await expect(assembled.service.ready()).resolves.toEqual({
      status: 'ok',
      checks: { mongodb: 'up', redis: 'up' },
    });
    expect(assembled.command).toHaveBeenCalledWith(
      { hello: 1 },
      { timeoutMS: 1_000 },
    );
    expect(assembled.redis.ping).toHaveBeenCalledOnce();
    expect(assembled.mongo.openUri).not.toHaveBeenCalled();
    expect(assembled.redis.connect).not.toHaveBeenCalled();
  });

  it('对初始断连依赖执行单次受限重连', async () => {
    for (const redisStatus of ['wait', 'end']) {
      const assembled = fixture();
      assembled.mongo.readyState = 0;
      assembled.mongo.openUri.mockImplementation(() => {
        assembled.mongo.readyState = 1;
      });
      assembled.redis.status = redisStatus;

      await expect(assembled.service.ready()).resolves.toMatchObject({ status: 'ok' });
      expect(assembled.mongo.openUri).toHaveBeenCalledWith(
        'mongodb://mongo.internal/gaoq?replicaSet=rs0',
        { connectTimeoutMS: 1_000, serverSelectionTimeoutMS: 1_000 },
      );
      expect(assembled.redis.connect).toHaveBeenCalledOnce();
    }
  });

  it('等待正在建立的 Mongo 连接后再验证主节点', async () => {
    const assembled = fixture();
    assembled.mongo.readyState = 2;
    assembled.mongo.asPromise.mockImplementation(() => {
      assembled.mongo.readyState = 1;
    });

    await expect(assembled.service.ready()).resolves.toMatchObject({ status: 'ok' });
    expect(assembled.mongo.asPromise).toHaveBeenCalledOnce();
    expect(assembled.mongo.openUri).not.toHaveBeenCalled();
  });

  it('并发探针共享同一 Mongo 重连，不制造连接风暴', async () => {
    const assembled = fixture();
    assembled.mongo.readyState = 0;
    let resolveOpen: (() => void) | undefined;
    const opening = new Promise<void>((resolve) => {
      resolveOpen = resolve;
    }).then(() => {
      assembled.mongo.readyState = 1;
    });
    assembled.mongo.openUri.mockReturnValue(opening);

    const first = assembled.service.ready();
    const second = assembled.service.ready();
    await vi.waitFor(() => expect(assembled.mongo.openUri).toHaveBeenCalledOnce());
    resolveOpen?.();

    await expect(Promise.all([first, second])).resolves.toEqual([
      { status: 'ok', checks: { mongodb: 'up', redis: 'up' } },
      { status: 'ok', checks: { mongodb: 'up', redis: 'up' } },
    ]);
  });

  it('依赖检查超过截止时间时快速失败关闭', async () => {
    vi.useFakeTimers();
    const assembled = fixture();
    assembled.mongo.readyState = 2;
    assembled.mongo.asPromise.mockReturnValue(new Promise(() => undefined));

    const operation = assembled.service.ready();
    await vi.advanceTimersByTimeAsync(1_250);

    await expect(operation).resolves.toEqual({
      status: 'error',
      checks: { mongodb: 'down', redis: 'up' },
    });
  });

  it('拒绝非可写主节点、非副本集、非法状态和缺失数据库句柄', async () => {
    const cases: Array<(assembled: ReturnType<typeof fixture>) => void> = [
      (assembled) => assembled.command.mockResolvedValue({
        isWritablePrimary: false,
        setName: 'rs0',
      }),
      (assembled) => assembled.command.mockResolvedValue({
        isWritablePrimary: true,
      }),
      (assembled) => assembled.command.mockResolvedValue({
        isWritablePrimary: true,
        setName: '',
      }),
      (assembled) => assembled.command.mockResolvedValue({
        isWritablePrimary: true,
        setName: 'r'.repeat(129),
      }),
      (assembled) => {
        assembled.mongo.readyState = 3;
      },
      (assembled) => {
        assembled.mongo.db = undefined;
      },
    ];
    for (const alter of cases) {
      const assembled = fixture();
      alter(assembled);
      await expect(assembled.service.ready()).resolves.toMatchObject({
        status: 'error',
        checks: { mongodb: 'down' },
      });
    }
  });

  it('依赖异常、Redis 非 ready 或非 PONG 均收敛为 down', async () => {
    const mongoFailure = fixture();
    mongoFailure.command.mockRejectedValue(new Error('mongo unavailable'));
    await expect(mongoFailure.service.ready()).resolves.toMatchObject({
      status: 'error',
      checks: { mongodb: 'down' },
    });

    for (const alter of [
      (assembled: ReturnType<typeof fixture>) => {
        assembled.redis.status = 'connecting';
      },
      (assembled: ReturnType<typeof fixture>) => {
        assembled.redis.ping.mockResolvedValue('NOPE');
      },
      (assembled: ReturnType<typeof fixture>) => {
        assembled.redis.ping.mockRejectedValue(new Error('redis unavailable'));
      },
      (assembled: ReturnType<typeof fixture>) => {
        assembled.redis.status = 'wait';
        assembled.redis.connect.mockRejectedValue(new Error('connect failed'));
      },
    ]) {
      const assembled = fixture();
      alter(assembled);
      await expect(assembled.service.ready()).resolves.toMatchObject({
        status: 'error',
        checks: { redis: 'down' },
      });
    }
  });
});
