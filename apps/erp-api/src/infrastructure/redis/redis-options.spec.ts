import { describe, expect, it } from 'vitest';

import { toBullMqConnection } from './redis-options.js';

describe('toBullMqConnection', () => {
  it('规范解析 Redis、ACL 凭据、数据库与默认端口', () => {
    expect(toBullMqConnection('redis://cache.internal/')).toEqual({
      host: 'cache.internal',
      port: 6379,
      db: 0,
      maxRetriesPerRequest: null,
    });
    expect(toBullMqConnection(
      'redis://service%2Duser:secret%3Avalue@cache.internal:6380/12',
    )).toEqual({
      host: 'cache.internal',
      port: 6380,
      db: 12,
      username: 'service-user',
      password: 'secret:value',
      maxRetriesPerRequest: null,
    });
  });

  it('支持 rediss 并显式启用 TLS', () => {
    expect(toBullMqConnection('rediss://cache.internal/1')).toEqual({
      host: 'cache.internal',
      port: 6379,
      db: 1,
      tls: {},
      maxRetriesPerRequest: null,
    });
  });

  it('拒绝非 Redis 协议、非规范路径、查询、片段和越界数据库', () => {
    for (const value of [
      'https://cache.internal/0',
      'redis://cache.internal/01',
      'redis://cache.internal/1/',
      'redis://cache.internal/0?db=1',
      'redis://cache.internal/0#fragment',
      'redis://cache.internal/1000001',
    ]) {
      expect(() => toBullMqConnection(value)).toThrow(/REDIS_URL/);
    }
  });

  it('拒绝非法端口和非规范凭据编码', () => {
    for (const value of [
      'redis://cache.internal:0/0',
      'redis://user:%E0%A4@cache.internal/0',
      'redis://user:%0Asecret@cache.internal/0',
      `redis://${'u'.repeat(257)}:secret@cache.internal/0`,
      `redis://user:${'p'.repeat(513)}@cache.internal/0`,
      'not-a-url',
    ]) {
      expect(() => toBullMqConnection(value)).toThrow(/REDIS_URL/);
    }
  });
});
