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
      AUDIT_INTEGRITY_KEYS: '',
      METRICS_BEARER_TOKEN: '',
    });

    expect(environment.PORT).toBe(3001);
    expect(environment.AUTH_ACCESS_TOKEN_TTL_SECONDS).toBe(600);
    expect(environment.AUTH_SIGNING_PRIVATE_KEY_BASE64).toBeUndefined();
    expect(environment.AUDIT_INTEGRITY_KEYS).toBeUndefined();
    expect(environment.APPROVAL_DATA_ENCRYPTION_KEYS).toBeUndefined();
    expect(environment.RECRUITMENT_DATA_ENCRYPTION_KEYS).toBeUndefined();
    expect(environment.RECRUITMENT_BLIND_INDEX_KEYS).toBeUndefined();
    expect(environment.TREASURY_DATA_ENCRYPTION_KEYS).toBeUndefined();
    expect(environment.TREASURY_BLIND_INDEX_KEYS).toBeUndefined();
    expect(environment.TREASURY_WORM_ARCHIVE_ENDPOINT).toBeUndefined();
    expect(environment.TREASURY_WORM_RETENTION_DAYS).toBe(3_650);
    expect(environment.METRICS_BEARER_TOKEN).toBeUndefined();
    expect(environment.ESIGN_MALWARE_SCAN_ENDPOINT).toBeUndefined();
    expect(environment.ESIGN_WORM_ARCHIVE_ENDPOINT).toBeUndefined();
    expect(environment.ESIGN_WORM_RETENTION_DAYS).toBe(3_650);
    expect(environment.MCP_OAUTH_CLIENTS_JSON).toBe('[]');
  });

  it('eSign 扫描与 WORM 必须成套配置且位于独立 HTTPS 权限域', () => {
    const base = {
      NODE_ENV: 'test',
      MONGODB_URI: 'mongodb://localhost:27017/gaoq_os?replicaSet=rs0',
      REDIS_URL: 'redis://localhost:6379/0',
      WEB_ORIGIN: 'https://erp.example.com',
      AUTH_ISSUER: 'https://erp.example.com',
      AUTH_AUDIENCE: 'gaoq-erp',
      AUTH_RESOURCE: 'https://erp.example.com/mcp',
      AUTH_JWKS_URI: 'https://erp.example.com/.well-known/jwks.json',
      MCP_AUTHORIZATION_SERVER: 'https://erp.example.com',
      MCP_ALLOWED_ORIGINS: 'https://client.example.com',
    };
    expect(() => validateEnvironment({
      ...base, ESIGN_MALWARE_SCAN_ENDPOINT: 'https://scanner.example.net/v1/scan',
    })).toThrow('必须成套配置');
    const evidence = {
      ESIGN_MALWARE_SCAN_ENDPOINT: 'https://scanner.example.net/v1/scan',
      ESIGN_MALWARE_SCAN_BEARER_TOKEN: 'scanner-token-that-is-at-least-32-characters',
      ESIGN_WORM_ARCHIVE_ENDPOINT: 'https://worm.example.net/v1/archive',
      ESIGN_WORM_ARCHIVE_BEARER_TOKEN: 'archive-token-that-is-at-least-32-characters',
    };
    expect(() => validateEnvironment({
      ...base, ...evidence, ESIGN_WORM_ARCHIVE_ENDPOINT: 'http://worm.example.net/archive',
    })).toThrow('独立权限域 HTTPS');
    expect(() => validateEnvironment({
      ...base, ...evidence, ESIGN_WORM_ARCHIVE_ENDPOINT: 'https://erp.example.com/archive',
    })).toThrow('独立权限域 HTTPS');
    expect(validateEnvironment({ ...base, ...evidence })).toMatchObject({
      ESIGN_WORM_RETENTION_DAYS: 3_650,
    });
  });

  it('拒绝授权服务器与 issuer 错位或 resource 携带 fragment', () => {
    const base = {
      NODE_ENV: 'test',
      MONGODB_URI: 'mongodb://localhost:27017/gaoq_os?replicaSet=rs0',
      REDIS_URL: 'redis://localhost:6379/0',
      WEB_ORIGIN: 'https://erp.example.com',
      AUTH_ISSUER: 'https://erp.example.com',
      AUTH_AUDIENCE: 'gaoq-erp',
      AUTH_RESOURCE: 'https://erp.example.com/mcp',
      AUTH_JWKS_URI: 'https://erp.example.com/.well-known/jwks.json',
      MCP_AUTHORIZATION_SERVER: 'https://erp.example.com',
      MCP_ALLOWED_ORIGINS: 'https://client.example.com',
    };
    expect(() => validateEnvironment({
      ...base, MCP_AUTHORIZATION_SERVER: 'https://auth.example.com',
    })).toThrow('必须与无路径 AUTH_ISSUER 同源');
    expect(() => validateEnvironment({
      ...base, MCP_AUTHORIZATION_SERVER: 'https://erp.example.com?unsafe=1',
    })).toThrow('必须与无路径 AUTH_ISSUER 同源');
    expect(() => validateEnvironment({
      ...base, AUTH_JWKS_URI: 'https://keys.example.com/jwks.json',
    })).toThrow('必须指向 issuer');
    expect(() => validateEnvironment({
      ...base, AUTH_RESOURCE: 'https://erp.example.com/mcp#token',
    })).toThrow('AUTH_RESOURCE 禁止凭据与 fragment');
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

  it('生产环境拒绝不安全的 WebAuthn Web Origin', () => {
    expect(() => validateEnvironment({
      NODE_ENV: 'production',
      MONGODB_URI: 'mongodb://localhost:27017/gaoq_os?replicaSet=rs0',
      REDIS_URL: 'redis://localhost:6379/0',
      WEB_ORIGIN: 'http://erp.example.com',
      AUTH_ISSUER: 'https://erp.example.com',
      AUTH_AUDIENCE: 'gaoq-erp',
      AUTH_RESOURCE: 'https://erp.example.com/mcp',
      AUTH_JWKS_URI: 'https://erp.example.com/.well-known/jwks.json',
      MCP_AUTHORIZATION_SERVER: 'https://erp.example.com',
      MCP_ALLOWED_ORIGINS: 'https://erp.example.com',
    })).toThrow('WEB_ORIGIN 必须使用 HTTPS');
  });

  it('生产环境即使具备签名材料也拒绝缺失审计完整性密钥环', () => {
    expect(() => validateEnvironment({
      NODE_ENV: 'production',
      MONGODB_URI: 'mongodb://localhost:27017/gaoq_os?replicaSet=rs0',
      REDIS_URL: 'redis://localhost:6379/0',
      WEB_ORIGIN: 'https://erp.example.com',
      AUTH_ISSUER: 'https://erp.example.com',
      AUTH_AUDIENCE: 'gaoq-erp',
      AUTH_RESOURCE: 'https://erp.example.com/mcp',
      AUTH_JWKS_URI: 'https://erp.example.com/.well-known/jwks.json',
      AUTH_SIGNING_PRIVATE_KEY_BASE64: 'a'.repeat(64),
      AUTH_SIGNING_KEY_ID: 'signing-key-001',
      MCP_AUTHORIZATION_SERVER: 'https://erp.example.com',
      MCP_ALLOWED_ORIGINS: 'https://erp.example.com',
    })).toThrow('生产环境必须由 Secret Manager 注入审计完整性密钥环');
  });

  it('生产环境具备签名与审计材料时仍拒绝缺失指标抓取凭据', () => {
    expect(() => validateEnvironment({
      NODE_ENV: 'production',
      MONGODB_URI: 'mongodb://localhost:27017/gaoq_os?replicaSet=rs0',
      REDIS_URL: 'redis://localhost:6379/0',
      WEB_ORIGIN: 'https://erp.example.com',
      AUTH_ISSUER: 'https://erp.example.com',
      AUTH_AUDIENCE: 'gaoq-erp',
      AUTH_RESOURCE: 'https://erp.example.com/mcp',
      AUTH_JWKS_URI: 'https://erp.example.com/.well-known/jwks.json',
      AUTH_SIGNING_PRIVATE_KEY_BASE64: 'a'.repeat(64),
      AUTH_SIGNING_KEY_ID: 'signing-key-001',
      AUDIT_INTEGRITY_KEYS: JSON.stringify([{
        id: 'audit-key-001', secret: 'b'.repeat(64), status: 'active',
      }]),
      MCP_AUTHORIZATION_SERVER: 'https://erp.example.com',
      MCP_ALLOWED_ORIGINS: 'https://erp.example.com',
    })).toThrow('生产环境必须由 Secret Manager 注入指标抓取凭据');
  });

  it('生产环境拒绝缺失招聘数据与盲索引独立密钥环', () => {
    expect(() => validateEnvironment({
      NODE_ENV: 'production',
      MONGODB_URI: 'mongodb://localhost:27017/gaoq_os?replicaSet=rs0',
      REDIS_URL: 'redis://localhost:6379/0',
      WEB_ORIGIN: 'https://erp.example.com',
      AUTH_ISSUER: 'https://erp.example.com',
      AUTH_AUDIENCE: 'gaoq-erp',
      AUTH_RESOURCE: 'https://erp.example.com/mcp',
      AUTH_JWKS_URI: 'https://erp.example.com/.well-known/jwks.json',
      AUTH_SIGNING_PRIVATE_KEY_BASE64: 'a'.repeat(64),
      AUTH_SIGNING_KEY_ID: 'signing-key-001',
      AUDIT_INTEGRITY_KEYS: 'b'.repeat(64),
      APPROVAL_DATA_ENCRYPTION_KEYS: 'c'.repeat(64),
      MCP_AUTHORIZATION_SERVER: 'https://erp.example.com',
      MCP_ALLOWED_ORIGINS: 'https://erp.example.com',
    })).toThrow('招聘数据与盲索引独立密钥环');
  });

  it('资金数据与账号盲索引必须独立，生产环境缺失时拒绝启动', () => {
    const base = {
      NODE_ENV: 'test',
      MONGODB_URI: 'mongodb://localhost:27017/gaoq_os?replicaSet=rs0',
      REDIS_URL: 'redis://localhost:6379/0',
      WEB_ORIGIN: 'https://erp.example.com',
      AUTH_ISSUER: 'https://erp.example.com',
      AUTH_AUDIENCE: 'gaoq-erp',
      AUTH_RESOURCE: 'https://erp.example.com/mcp',
      AUTH_JWKS_URI: 'https://erp.example.com/.well-known/jwks.json',
      MCP_AUTHORIZATION_SERVER: 'https://erp.example.com',
      MCP_ALLOWED_ORIGINS: 'https://erp.example.com',
    };
    const shared = 'x'.repeat(64);
    expect(() => validateEnvironment({
      ...base, TREASURY_DATA_ENCRYPTION_KEYS: shared, TREASURY_BLIND_INDEX_KEYS: shared,
    })).toThrow('不得复用同一密钥环');
    expect(() => validateEnvironment({ ...base, NODE_ENV: 'production' }))
      .toThrow('资金数据与盲索引独立密钥环');
  });

  it('Treasury WORM 配置必须成套且使用独立 HTTPS 权限域', () => {
    const base = {
      NODE_ENV: 'test',
      MONGODB_URI: 'mongodb://localhost:27017/gaoq_os?replicaSet=rs0',
      REDIS_URL: 'redis://localhost:6379/0', WEB_ORIGIN: 'https://erp.example.com',
      AUTH_ISSUER: 'https://erp.example.com', AUTH_AUDIENCE: 'gaoq-erp',
      AUTH_RESOURCE: 'https://erp.example.com/mcp',
      AUTH_JWKS_URI: 'https://erp.example.com/.well-known/jwks.json',
      MCP_AUTHORIZATION_SERVER: 'https://erp.example.com',
      MCP_ALLOWED_ORIGINS: 'https://erp.example.com',
    };
    expect(() => validateEnvironment({
      ...base, TREASURY_WORM_ARCHIVE_ENDPOINT: 'https://worm.example.net/v1/objects',
    })).toThrow('必须成套配置');
    const configured = {
      ...base,
      TREASURY_WORM_ARCHIVE_ENDPOINT: 'https://worm.example.net/v1/objects',
      TREASURY_WORM_ARCHIVE_BEARER_TOKEN: 'treasury-worm-token-at-least-32-characters',
    };
    expect(validateEnvironment(configured).TREASURY_WORM_RETENTION_DAYS).toBe(3_650);
    expect(() => validateEnvironment({
      ...configured, TREASURY_WORM_ARCHIVE_ENDPOINT: 'https://erp.example.com/v1/objects',
    })).toThrow('独立权限域 HTTPS');
    expect(() => validateEnvironment({
      ...configured,
      TREASURY_WORM_ARCHIVE_ENDPOINT: 'https://worm.example.net/v1/objects?token=unsafe',
    })).toThrow('独立权限域 HTTPS');
  });

  it('生产环境具备指标凭据时仍拒绝缺失独立 WORM 配置', () => {
    expect(() => validateEnvironment({
      NODE_ENV: 'production',
      MONGODB_URI: 'mongodb://localhost:27017/gaoq_os?replicaSet=rs0',
      REDIS_URL: 'redis://localhost:6379/0',
      WEB_ORIGIN: 'https://erp.example.com',
      AUTH_ISSUER: 'https://erp.example.com',
      AUTH_AUDIENCE: 'gaoq-erp',
      AUTH_RESOURCE: 'https://erp.example.com/mcp',
      AUTH_JWKS_URI: 'https://erp.example.com/.well-known/jwks.json',
      AUTH_SIGNING_PRIVATE_KEY_BASE64: 'a'.repeat(64),
      AUTH_SIGNING_KEY_ID: 'signing-key-001',
      AUDIT_INTEGRITY_KEYS: JSON.stringify([{
        id: 'audit-key-001', secret: 'b'.repeat(64), status: 'active',
      }]),
      METRICS_BEARER_TOKEN: 'metrics-token-that-is-at-least-32-characters',
      MCP_AUTHORIZATION_SERVER: 'https://erp.example.com',
      MCP_ALLOWED_ORIGINS: 'https://erp.example.com',
    })).toThrow('必须完整配置独立 WORM 锚定端点');
  });

  it('生产环境拒绝与 ERP 同域或携带查询参数的 WORM 端点', () => {
    const base = {
      NODE_ENV: 'production',
      MONGODB_URI: 'mongodb://localhost:27017/gaoq_os?replicaSet=rs0',
      REDIS_URL: 'redis://localhost:6379/0',
      WEB_ORIGIN: 'https://erp.example.com',
      AUTH_ISSUER: 'https://erp.example.com',
      AUTH_AUDIENCE: 'gaoq-erp',
      AUTH_RESOURCE: 'https://erp.example.com/mcp',
      AUTH_JWKS_URI: 'https://erp.example.com/.well-known/jwks.json',
      AUTH_SIGNING_PRIVATE_KEY_BASE64: 'a'.repeat(64),
      AUTH_SIGNING_KEY_ID: 'signing-key-001',
      AUDIT_INTEGRITY_KEYS: JSON.stringify([{
        id: 'audit-key-001', secret: 'b'.repeat(64), status: 'active',
      }]),
      METRICS_BEARER_TOKEN: 'metrics-token-that-is-at-least-32-characters',
      AUDIT_WORM_BEARER_TOKEN: 'worm-token-that-is-at-least-32-characters',
      AUDIT_ANCHOR_SIGNING_PRIVATE_KEY_BASE64: 'c'.repeat(64),
      AUDIT_ANCHOR_SIGNING_KEY_ID: 'anchor-key-001',
      MCP_AUTHORIZATION_SERVER: 'https://erp.example.com',
      MCP_ALLOWED_ORIGINS: 'https://erp.example.com',
    };
    expect(() => validateEnvironment({
      ...base, AUDIT_WORM_ENDPOINT: 'https://erp.example.com/worm',
    })).toThrow('必须与 ERP 授权域隔离');
    expect(() => validateEnvironment({
      ...base, AUDIT_WORM_ENDPOINT: 'https://worm.example.net/anchors?token=unsafe',
    })).toThrow('禁止凭据、查询、fragment');
  });
});
