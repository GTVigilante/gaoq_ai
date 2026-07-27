import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const redisEval = vi.fn();
const redisConnect = vi.fn();
const redisDisconnect = vi.fn();

vi.mock('server-only', () => ({}));
vi.mock('ioredis', () => ({
  Redis: class {
    status = 'wait';
    eval = redisEval;
    connect = redisConnect;
    disconnect = redisDisconnect;
    on = vi.fn();
  },
}));

import {
  assertRecruitmentPortalRequestAllowed,
  RecruitmentPortalProtectionError,
  resetRecruitmentPortalProtectionForTests,
} from './recruitment-portal-protection.js';

const SECRET = 'edge-verification-secret-at-least-32-characters';

describe('招聘门户公开请求保护', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('CAREERS_PUBLIC_ORIGIN', 'https://careers.example.com');
    vi.stubEnv('CAREERS_RATE_LIMIT_REDIS_URL', 'rediss://redis.example.com/3');
    vi.stubEnv('CAREERS_EDGE_VERIFICATION_SECRET', SECRET);
    vi.stubEnv('CAREERS_CLIENT_IP_HEADER', 'x-real-ip');
    redisConnect.mockResolvedValue(undefined);
    redisEval.mockResolvedValue(1);
  });

  afterEach(() => {
    resetRecruitmentPortalProtectionForTests();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it('只接受精确公开 Origin、入口验证头和受控来源地址头', async () => {
    await expect(assertRecruitmentPortalRequestAllowed(request({
      origin: 'https://careers.example.com',
      'x-gaoq-edge-verification': SECRET,
      'x-real-ip': '203.0.113.10',
      'x-forwarded-for': '198.51.100.8',
    }))).resolves.toBeUndefined();
    expect(redisEval).toHaveBeenCalledWith(
      expect.stringContaining('INCR'),
      1,
      expect.stringMatching(/^gaoq:careers:application-rate:[a-f0-9]{64}$/u),
      600,
    );
  });

  it('拒绝伪造转发链、缺失入口验证和错误 Origin', async () => {
    for (const headers of [
      {
        origin: 'https://evil.example.com',
        'x-gaoq-edge-verification': SECRET,
        'x-real-ip': '203.0.113.10',
      },
      {
        origin: 'https://careers.example.com',
        'x-real-ip': '203.0.113.10',
        'x-forwarded-for': '198.51.100.8',
      },
      {
        origin: 'https://careers.example.com',
        'x-gaoq-edge-verification': SECRET,
        'x-real-ip': '203.0.113.10, 198.51.100.8',
      },
    ]) {
      await expect(assertRecruitmentPortalRequestAllowed(request(headers)))
        .rejects.toBeInstanceOf(RecruitmentPortalProtectionError);
    }
    expect(redisEval).not.toHaveBeenCalled();
  });

  it('Redis 不可用时失败关闭，超过共享窗口额度时拒绝', async () => {
    redisEval.mockRejectedValueOnce(new Error('redis unavailable'));
    await expect(assertRecruitmentPortalRequestAllowed(request(validHeaders())))
      .rejects.toMatchObject({ code: 'CAREERS_PROTECTION_UNAVAILABLE', status: 503 });
    resetRecruitmentPortalProtectionForTests();
    redisEval.mockResolvedValueOnce(6);
    await expect(assertRecruitmentPortalRequestAllowed(request(validHeaders())))
      .rejects.toMatchObject({ code: 'CAREERS_RATE_LIMITED', status: 429 });
  });
});

function validHeaders(): Record<string, string> {
  return {
    origin: 'https://careers.example.com',
    'x-gaoq-edge-verification': SECRET,
    'x-real-ip': '203.0.113.10',
  };
}

function request(headers: Record<string, string>): Request {
  return new Request('https://careers.example.com/api/careers/applications', {
    method: 'POST',
    headers,
  });
}
