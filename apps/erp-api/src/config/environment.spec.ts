import { describe, expect, it } from 'vitest';

import { validateEnvironment } from './environment.js';

describe('validateEnvironment', () => {
  it('接受完整且合法的本地配置', () => {
    const environment = validateEnvironment({
      NODE_ENV: 'test',
      PORT: '3001',
      MONGODB_URI: 'mongodb://localhost:27017/gaoq_os?replicaSet=rs0&directConnection=true',
      REDIS_URL: 'redis://localhost:6379/0',
      WEB_ORIGIN: 'http://localhost:3000',
      LOG_LEVEL: 'info',
      AUTH_ISSUER: 'https://auth.example.internal',
      AUTH_AUDIENCE: 'gaoq-erp',
      AUTH_RESOURCE: 'http://localhost:3001/mcp',
      AUTH_JWKS_URI: 'https://auth.example.internal/.well-known/jwks.json',
      MCP_AUTHORIZATION_SERVER: 'https://auth.example.internal',
      MCP_ALLOWED_ORIGINS: 'http://localhost:3000',
      AUTH_SIGNING_PRIVATE_KEY_BASE64: '',
      AUTH_SIGNING_KEY_ID: '',
    });

    expect(environment.PORT).toBe(3001);
    expect(environment.AUTH_ACCESS_TOKEN_TTL_SECONDS).toBe(600);
    expect(environment.AUTH_SIGNING_PRIVATE_KEY_BASE64).toBeUndefined();
  });

  it('拒绝缺失的外部资源连接信息', () => {
    expect(() =>
      validateEnvironment({
        WEB_ORIGIN: 'http://localhost:3000',
      }),
    ).toThrow('环境变量校验失败');
  });

  it('生产环境缺少 Secret Manager 签名材料时拒绝启动', () => {
    expect(() =>
      validateEnvironment({
        NODE_ENV: 'production',
        MONGODB_URI: 'mongodb://localhost:27017/gaoq_os?replicaSet=rs0',
        REDIS_URL: 'redis://localhost:6379/0',
        WEB_ORIGIN: 'https://erp.example.com',
        AUTH_ISSUER: 'https://erp.example.com',
        AUTH_AUDIENCE: 'gaoq-erp',
        AUTH_RESOURCE: 'https://erp.example.com/mcp',
        AUTH_JWKS_URI: 'https://erp.example.com/.well-known/jwks.json',
        MCP_AUTHORIZATION_SERVER: 'https://erp.example.com',
        MCP_ALLOWED_ORIGINS: 'https://erp.example.com',
      }),
    ).toThrow('生产环境必须由 Secret Manager 注入签名私钥');
  });
});
