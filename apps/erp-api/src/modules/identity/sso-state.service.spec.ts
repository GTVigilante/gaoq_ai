import { createHash } from 'node:crypto';

import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';

import { SsoStateService, type IssueSsoStateInput } from './sso-state.service.js';

const createRedis = () => ({
  set: vi.fn<
    (key: string, value: string, ex: 'EX', ttl: number, nx: 'NX') => Promise<'OK' | null>
  >(),
  getdel: vi.fn<(key: string) => Promise<string | null>>(),
});

const createService = (redis: ReturnType<typeof createRedis>): SsoStateService =>
  new SsoStateService(redis as unknown as Redis);

const validInput: IssueSsoStateInput = {
  tenantId: 'tenant-001',
  provider: 'dingtalk',
  externalTenantId: 'corp-001',
  returnPath: '/dashboard',
};

const sha256Hex = (value: string): string => createHash('sha256').update(value).digest('hex');

const sha256Base64Url = (value: string): string =>
  createHash('sha256').update(value).digest('base64url');

const readStoredPayload = (redis: ReturnType<typeof createRedis>) => {
  const [, raw] = redis.set.mock.calls[0] ?? [];
  return JSON.parse(raw as string) as { readonly codeVerifier: string };
};

const readStoredRaw = (redis: ReturnType<typeof createRedis>): string => {
  const raw = redis.set.mock.calls[0]?.[1];
  if (raw === undefined) {
    throw new Error('未捕获到 Redis 状态载荷');
  }
  return raw;
};

/** 捕获异步抛出的异常，便于断言稳定错误码。 */
const captureError = async (action: () => Promise<unknown>): Promise<unknown> => {
  try {
    await action();
  } catch (error) {
    return error;
  }
  throw new Error('预期抛出异常但实际成功');
};

const expectInvalidState = async (action: () => Promise<unknown>): Promise<void> => {
  const error = await captureError(action);
  expect(error).toBeInstanceOf(UnauthorizedException);
  expect((error as UnauthorizedException).getResponse()).toMatchObject({
    code: 'SSO_STATE_INVALID',
  });
};

describe('SsoStateService', () => {
  it('签发时使用 sha256(state) 作为 key，key 不含 state 原文，且带 TTL 与 NX', async () => {
    const redis = createRedis();
    redis.set.mockResolvedValue('OK');

    const issued = await createService(redis).issue(validInput);

    expect(redis.set).toHaveBeenCalledTimes(1);
    const [key, raw, ex, ttl, nx] = redis.set.mock.calls[0] ?? [];
    expect(key).toBe(`gaoq:sso:state:${sha256Hex(issued.state)}`);
    expect(key).not.toContain(issued.state);
    expect(ex).toBe('EX');
    expect(ttl).toBe(300);
    expect(nx).toBe('NX');
    const payload = JSON.parse(raw as string) as Record<string, unknown>;
    expect(payload).toMatchObject({
      tenantId: validInput.tenantId,
      provider: validInput.provider,
      externalTenantId: validInput.externalTenantId,
      returnPath: validInput.returnPath,
    });
  });

  it('codeChallenge 等于 base64url(sha256(codeVerifier))', async () => {
    const redis = createRedis();
    redis.set.mockResolvedValue('OK');

    const issued = await createService(redis).issue(validInput);
    const { codeVerifier } = readStoredPayload(redis);

    expect(issued.codeChallenge).toBe(sha256Base64Url(codeVerifier));
  });

  it('SET NX 冲突时有限重试，成功即止', async () => {
    const redis = createRedis();
    redis.set.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValue('OK');

    const issued = await createService(redis).issue(validInput);

    expect(redis.set).toHaveBeenCalledTimes(3);
    expect(issued.state).toBeTruthy();
  });

  it('重试 3 次仍冲突时抛 ServiceUnavailableException', async () => {
    const redis = createRedis();
    redis.set.mockResolvedValue(null);

    const error = await captureError(() => createService(redis).issue(validInput));

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(redis.set).toHaveBeenCalledTimes(3);
  });

  it('consume 通过 GETDEL 原子消费，key 使用 sha256(state)', async () => {
    const redis = createRedis();
    redis.set.mockResolvedValue('OK');
    const service = createService(redis);
    const issued = await service.issue(validInput);
    redis.getdel.mockResolvedValue(readStoredRaw(redis));

    const consumed = await service.consume(issued.state, 'dingtalk');

    expect(redis.getdel).toHaveBeenCalledTimes(1);
    const key = redis.getdel.mock.calls[0]?.[0] as string;
    expect(key).toBe(`gaoq:sso:state:${sha256Hex(issued.state)}`);
    expect(key).not.toContain(issued.state);
    expect(consumed).toEqual({
      tenantId: validInput.tenantId,
      provider: validInput.provider,
      externalTenantId: validInput.externalTenantId,
      codeVerifier: readStoredPayload(redis).codeVerifier,
      returnPath: validInput.returnPath,
    });
  });

  it('同一 state 只能消费一次，第二次抛 SSO_STATE_INVALID', async () => {
    const redis = createRedis();
    redis.set.mockResolvedValue('OK');
    const service = createService(redis);
    const issued = await service.issue(validInput);
    redis.getdel.mockResolvedValueOnce(readStoredRaw(redis)).mockResolvedValue(null);

    await service.consume(issued.state, 'dingtalk');
    await expectInvalidState(() => service.consume(issued.state, 'dingtalk'));
    expect(redis.getdel).toHaveBeenCalledTimes(2);
  });

  it('provider 不匹配时抛 SSO_STATE_INVALID', async () => {
    const redis = createRedis();
    redis.set.mockResolvedValue('OK');
    const service = createService(redis);
    const issued = await service.issue(validInput);
    redis.getdel.mockResolvedValue(readStoredRaw(redis));

    await expectInvalidState(() => service.consume(issued.state, 'feishu'));
  });

  it('OP 使用与钉钉飞书相同的一次性 state 与 PKCE 存储约束', async () => {
    const redis = createRedis();
    redis.set.mockResolvedValue('OK');
    const service = createService(redis);
    const issued = await service.issue({ ...validInput, provider: 'op' });
    redis.getdel.mockResolvedValue(readStoredRaw(redis));

    await expect(service.consume(issued.state, 'op')).resolves.toMatchObject({ provider: 'op' });
  });

  it('Redis 中的坏 JSON 抛 SSO_STATE_INVALID', async () => {
    const redis = createRedis();
    redis.getdel.mockResolvedValue('{broken json');

    await expectInvalidState(() => createService(redis).consume('any-state', 'dingtalk'));
  });

  it('Redis 中缺少必需字段或多出字段抛 SSO_STATE_INVALID', async () => {
    const redis = createRedis();
    redis.getdel.mockResolvedValue(
      JSON.stringify({
        tenantId: 'tenant-001',
        provider: 'dingtalk',
        externalTenantId: 'corp-001',
        codeVerifier: 'verifier',
        returnPath: '/dashboard',
        injected: 'extra',
      }),
    );

    await expectInvalidState(() => createService(redis).consume('any-state', 'dingtalk'));
  });

  it.each(['//evil.com', 'https://evil.com/x', '/a\\b', 'relative/path'])(
    '恶意或非法 returnPath %s 在签发时被拒绝',
    async (returnPath) => {
      const redis = createRedis();
      await expectInvalidState(() =>
        createService(redis).issue({ ...validInput, returnPath }),
      );
      expect(redis.set).not.toHaveBeenCalled();
    },
  );

  it('Redis 中被篡改的恶意 returnPath 在消费时被拒绝', async () => {
    const redis = createRedis();
    redis.getdel.mockResolvedValue(
      JSON.stringify({
        tenantId: 'tenant-001',
        provider: 'dingtalk',
        externalTenantId: 'corp-001',
        codeVerifier: 'verifier',
        returnPath: '//evil.com',
      }),
    );

    await expectInvalidState(() => createService(redis).consume('any-state', 'dingtalk'));
  });

  it('报错信息不泄露 state 原文与存储内容', async () => {
    const redis = createRedis();
    const secret = 'raw-state-secret-value';
    redis.getdel.mockResolvedValue(JSON.stringify({ secret }));

    const error = await captureError(() => createService(redis).consume(secret, 'dingtalk'));

    const response = (error as UnauthorizedException).getResponse();
    expect(JSON.stringify(response)).not.toContain(secret);
  });
});
