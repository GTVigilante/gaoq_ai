import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { validateEnvironment } from './environment.js';

const knowledgeSigning = {
  KNOWLEDGE_EVIDENCE_GATEWAY_SIGNING_PUBLIC_KEY_BASE64:
    generateKeyPairSync('ed25519').publicKey.export({
      format: 'der',
      type: 'spki',
    }).toString('base64'),
  KNOWLEDGE_EVIDENCE_GATEWAY_SIGNING_KEY_ID: 'knowledge-key-001',
};
const knowledgeSearchSigning = {
  KNOWLEDGE_SEARCH_GATEWAY_SIGNING_PUBLIC_KEY_BASE64:
    generateKeyPairSync('ed25519').publicKey.export({
      format: 'der',
      type: 'spki',
    }).toString('base64'),
  KNOWLEDGE_SEARCH_GATEWAY_SIGNING_KEY_ID: 'knowledge-search-key-001',
};

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
    expect(environment.RECRUITMENT_RESUME_AI_PROVIDER).toBe('disabled');
    expect(environment.RECRUITMENT_RESUME_SOURCE_ENDPOINT).toBeUndefined();
    expect(environment.OPENAI_RESUME_API_KEY).toBeUndefined();
    expect(environment.KNOWLEDGE_EVIDENCE_GATEWAY_ENDPOINT).toBeUndefined();
    expect(environment.KNOWLEDGE_EVIDENCE_GATEWAY_SIGNING_PUBLIC_KEY_BASE64).toBeUndefined();
    expect(environment.KNOWLEDGE_SEARCH_GATEWAY_ENDPOINT).toBeUndefined();
    expect(environment.TREASURY_DATA_ENCRYPTION_KEYS).toBeUndefined();
    expect(environment.TREASURY_BLIND_INDEX_KEYS).toBeUndefined();
    expect(environment.TREASURY_WORM_ARCHIVE_ENDPOINT).toBeUndefined();
    expect(environment.TREASURY_WORM_RETENTION_DAYS).toBe(3_650);
    expect(environment.TREASURY_BANK_SUBMISSION_ENDPOINT).toBeUndefined();
    expect(environment.TREASURY_BANK_SUBMISSION_MODE).toBe('sandbox');
    expect(environment.TREASURY_BANK_RETURN_INBOX_ENDPOINT).toBeUndefined();
    expect(environment.PAYROLL_TAX_WORM_ARCHIVE_ENDPOINT).toBeUndefined();
    expect(environment.PAYROLL_TAX_GATEWAY_ENDPOINT).toBeUndefined();
    expect(environment.PAYROLL_TAX_GATEWAY_MODE).toBe('sandbox');
    expect(environment.PHASE6_PRODUCTION_AUTHORIZATION_ENDPOINT).toBeUndefined();
    expect(environment.PHASE6_RELEASE_COMMIT_SHA).toBeUndefined();
    expect(environment.PAYROLL_TAX_WORM_RETENTION_DAYS).toBe(3_650);
    expect(environment.METRICS_BEARER_TOKEN).toBeUndefined();
    expect(environment.DATA_MIGRATION_ATTACHMENT_GATEWAY_ENDPOINT).toBeUndefined();
    expect(environment.DATA_MIGRATION_ATTACHMENT_RETENTION_DAYS).toBe(2_555);
    expect(environment.ESIGN_MALWARE_SCAN_ENDPOINT).toBeUndefined();
    expect(environment.ESIGN_WORM_ARCHIVE_ENDPOINT).toBeUndefined();
    expect(environment.ESIGN_WORM_RETENTION_DAYS).toBe(3_650);
    expect(environment.OP_API_BASE_URL).toBeUndefined();
    expect(environment.OP_SSO_CLIENT_ID).toBeUndefined();
    expect(environment.OP_SSO_CLIENT_SECRET).toBeUndefined();
    expect(environment.OP_SSO_REDIRECT_URI).toBeUndefined();
    expect(environment.MCP_OAUTH_CLIENTS_JSON).toBe('[]');
  });

  it('知识证据网关必须成套配置并使用独立标准 HTTPS 根地址', () => {
    const base = {
      NODE_ENV: 'test',
      MONGODB_URI: 'mongodb://localhost:27017/gaoq_os?replicaSet=rs0',
      REDIS_URL: 'redis://localhost:6379/0',
      WEB_ORIGIN: 'https://erp.example.com',
      AUTH_ISSUER: 'https://auth.example.internal',
      AUTH_AUDIENCE: 'gaoq-erp',
      AUTH_RESOURCE: 'https://erp.example.com/mcp',
      AUTH_JWKS_URI: 'https://auth.example.internal/.well-known/jwks.json',
      MCP_AUTHORIZATION_SERVER: 'https://auth.example.internal',
      MCP_ALLOWED_ORIGINS: 'https://client.example.com',
    };
    expect(validateEnvironment({
      ...base,
      KNOWLEDGE_EVIDENCE_GATEWAY_ENDPOINT: 'https://knowledge.example.internal',
      KNOWLEDGE_EVIDENCE_GATEWAY_BEARER_TOKEN:
        'knowledge-evidence-token-at-least-32-characters',
      ...knowledgeSigning,
    })).toMatchObject({
      KNOWLEDGE_EVIDENCE_GATEWAY_ENDPOINT: 'https://knowledge.example.internal',
    });
    expect(() => validateEnvironment({
      ...base,
      KNOWLEDGE_EVIDENCE_GATEWAY_ENDPOINT: 'https://knowledge.example.internal',
    })).toThrow('知识证据网关端点与凭据必须成套配置');
    expect(() => validateEnvironment({
      ...base,
      METRICS_BEARER_TOKEN: 'knowledge-evidence-token-at-least-32-characters',
      KNOWLEDGE_EVIDENCE_GATEWAY_ENDPOINT: 'https://knowledge.example.internal',
      KNOWLEDGE_EVIDENCE_GATEWAY_BEARER_TOKEN:
        'knowledge-evidence-token-at-least-32-characters',
      ...knowledgeSigning,
    })).toThrow('知识证据网关不得复用其他业务、平台或外部系统凭据');
    for (const endpoint of [
      'http://knowledge.example.internal',
      'https://knowledge.example.internal/path',
      'https://localhost',
      'https://127.0.0.2',
      'https://[::1]',
      'https://auth.example.internal',
    ]) expect(() => validateEnvironment({
      ...base,
      KNOWLEDGE_EVIDENCE_GATEWAY_ENDPOINT: endpoint,
      KNOWLEDGE_EVIDENCE_GATEWAY_BEARER_TOKEN:
        'knowledge-evidence-token-at-least-32-characters',
      ...knowledgeSigning,
    })).toThrow('知识证据网关必须为独立标准 HTTPS 根地址');
    expect(() => validateEnvironment({
      ...base,
      KNOWLEDGE_EVIDENCE_GATEWAY_ENDPOINT: 'https://knowledge.example.internal',
      KNOWLEDGE_EVIDENCE_GATEWAY_BEARER_TOKEN:
        'knowledge-evidence-token-at-least-32-characters',
      ...knowledgeSigning,
      KNOWLEDGE_EVIDENCE_GATEWAY_SIGNING_PUBLIC_KEY_BASE64:
        Buffer.from('not-an-ed25519-key').toString('base64'),
    })).toThrow('知识证据网关签名公钥必须为有效 Ed25519 SPKI DER base64');
  });

  it('知识搜索网关使用独立服务身份与 Ed25519 信任域', () => {
    const base = {
      NODE_ENV: 'test',
      MONGODB_URI: 'mongodb://localhost:27017/gaoq_os?replicaSet=rs0',
      REDIS_URL: 'redis://localhost:6379/0',
      WEB_ORIGIN: 'https://erp.example.com',
      AUTH_ISSUER: 'https://auth.example.internal',
      AUTH_AUDIENCE: 'gaoq-erp',
      AUTH_RESOURCE: 'https://erp.example.com/mcp',
      AUTH_JWKS_URI: 'https://auth.example.internal/.well-known/jwks.json',
      MCP_AUTHORIZATION_SERVER: 'https://auth.example.internal',
      MCP_ALLOWED_ORIGINS: 'https://client.example.com',
    };
    expect(validateEnvironment({
      ...base,
      KNOWLEDGE_SEARCH_GATEWAY_ENDPOINT: 'https://search.example.internal',
      KNOWLEDGE_SEARCH_GATEWAY_BEARER_TOKEN:
        'knowledge-search-token-distinct-at-least-32-characters',
      ...knowledgeSearchSigning,
    })).toMatchObject({
      KNOWLEDGE_SEARCH_GATEWAY_ENDPOINT: 'https://search.example.internal',
      KNOWLEDGE_SEARCH_GATEWAY_SIGNING_KEY_ID: 'knowledge-search-key-001',
    });
    expect(() => validateEnvironment({
      ...base,
      KNOWLEDGE_SEARCH_GATEWAY_ENDPOINT: 'https://search.example.internal',
    })).toThrow('知识搜索网关端点、凭据、公钥与 Key ID 必须成套配置');
    expect(() => validateEnvironment({
      ...base,
      KNOWLEDGE_EVIDENCE_GATEWAY_ENDPOINT: 'https://evidence.example.internal',
      KNOWLEDGE_EVIDENCE_GATEWAY_BEARER_TOKEN:
        'shared-knowledge-token-at-least-32-characters',
      ...knowledgeSigning,
      KNOWLEDGE_SEARCH_GATEWAY_ENDPOINT: 'https://evidence.example.internal',
      KNOWLEDGE_SEARCH_GATEWAY_BEARER_TOKEN:
        'shared-knowledge-token-at-least-32-characters',
      KNOWLEDGE_SEARCH_GATEWAY_SIGNING_PUBLIC_KEY_BASE64:
        knowledgeSigning.KNOWLEDGE_EVIDENCE_GATEWAY_SIGNING_PUBLIC_KEY_BASE64,
      KNOWLEDGE_SEARCH_GATEWAY_SIGNING_KEY_ID: 'knowledge-search-key-001',
    })).toThrow('知识搜索网关必须为独立标准 HTTPS 根地址');
    expect(() => validateEnvironment({
      ...base,
      KNOWLEDGE_SEARCH_GATEWAY_ENDPOINT: 'https://search.example.internal',
      KNOWLEDGE_SEARCH_GATEWAY_BEARER_TOKEN:
        'knowledge-search-token-distinct-at-least-32-characters',
      ...knowledgeSearchSigning,
      KNOWLEDGE_SEARCH_GATEWAY_SIGNING_PUBLIC_KEY_BASE64:
        Buffer.from('not-ed25519').toString('base64'),
    })).toThrow('知识搜索网关签名公钥必须为有效 Ed25519 SPKI DER base64');
  });

  it('营销官网 Origin 必须精确隔离，生产验证码配置失败关闭', () => {
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
    expect(validateEnvironment({
      ...base,
      MARKETING_WEBSITE_ORIGIN: 'https://www.example.com',
    })).toMatchObject({
      MARKETING_WEBSITE_ORIGIN: 'https://www.example.com',
    });
    expect(() => validateEnvironment({
      ...base,
      MARKETING_WEBSITE_ORIGIN: 'https://www.example.com/path',
    })).toThrow('营销官网必须为独立精确 Origin');
    expect(() => validateEnvironment({
      ...base,
      MARKETING_WEBSITE_ORIGIN: 'https://erp.example.com',
    })).toThrow('营销官网必须为独立精确 Origin');
    expect(() => validateEnvironment({
      ...base,
      NODE_ENV: 'production',
    })).toThrow('生产环境必须配置营销官网精确 HTTPS Origin');
    expect(() => validateEnvironment({
      ...base,
      NODE_ENV: 'production',
      MARKETING_WEBSITE_ORIGIN: 'https://www.example.com',
    })).toThrow('生产环境营销官网必须配置验证码校验端点与独立凭据');
    for (const origin of [
      'https://localhost',
      'https://tenant.localhost',
      'https://localhost.',
    ]) {
      expect(() => validateEnvironment({
        ...base,
        NODE_ENV: 'production',
        MARKETING_WEBSITE_ORIGIN: origin,
        MARKETING_CAPTCHA_VERIFY_ENDPOINT: 'https://captcha.example.net/verify',
        MARKETING_CAPTCHA_BEARER_TOKEN:
          'captcha-gateway-token-at-least-32-characters',
      })).toThrow('营销官网必须为独立精确 Origin');
    }
  });

  it('迁移附件网关端点与凭据必须成套且使用独立标准 HTTPS', () => {
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
    const token = 'migration-attachment-gateway-token-0001';
    expect(validateEnvironment({
      ...base,
      DATA_MIGRATION_ATTACHMENT_GATEWAY_ENDPOINT: 'https://migration-files.example.net/v1/transfer',
      DATA_MIGRATION_ATTACHMENT_GATEWAY_BEARER_TOKEN: token,
    })).toMatchObject({
      DATA_MIGRATION_ATTACHMENT_GATEWAY_ENDPOINT:
        'https://migration-files.example.net/v1/transfer',
    });
    expect(() => validateEnvironment({
      ...base,
      DATA_MIGRATION_ATTACHMENT_GATEWAY_ENDPOINT: 'https://migration-files.example.net/v1/transfer',
    })).toThrow('端点与凭据必须成套配置');
    expect(() => validateEnvironment({
      ...base,
      DATA_MIGRATION_ATTACHMENT_GATEWAY_ENDPOINT: 'https://erp.example.com/v1/transfer',
      DATA_MIGRATION_ATTACHMENT_GATEWAY_BEARER_TOKEN: token,
    })).toThrow('独立权限域标准 HTTPS');
  });

  it('简历 AI 只在隔离网关、模型与独立密钥成套时启用', () => {
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
    const configured = {
      RECRUITMENT_RESUME_AI_PROVIDER: 'openai',
      RECRUITMENT_RESUME_SOURCE_ENDPOINT: 'https://resume-files.example.net/v1/redacted-text',
      RECRUITMENT_RESUME_SOURCE_BEARER_TOKEN: 'resume-source-token-at-least-32-characters',
      OPENAI_RESUME_MODEL: 'gpt-5.6-luna',
      OPENAI_RESUME_API_KEY: 'openai-project-key-at-least-32-characters',
    };
    expect(validateEnvironment({ ...base, ...configured })).toMatchObject(configured);
    expect(() => validateEnvironment({
      ...base,
      ...configured,
      OPENAI_RESUME_API_KEY: '',
    })).toThrow('必须配置隔离网关、OpenAI 模型与独立 API Key');
    expect(() => validateEnvironment({
      ...base,
      ...configured,
      RECRUITMENT_RESUME_SOURCE_ENDPOINT: 'http://resume-files.example.net/v1/redacted-text',
    })).toThrow('独立权限域标准 HTTPS');
    expect(() => validateEnvironment({
      ...base,
      OPENAI_RESUME_MODEL: 'gpt-5.6-luna',
    })).toThrow('关闭时禁止悬空注入');
  });

  it('营销官网生产 CORS 只接受精确 HTTPS 根 Origin', () => {
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
    expect(validateEnvironment({
      ...base,
      MARKETING_WEBSITE_ORIGIN: 'https://www.example.com',
    })).toMatchObject({
      MARKETING_WEBSITE_ORIGIN: 'https://www.example.com',
    });
    for (const origin of [
      'http://www.example.com',
      'https://www.example.com/path',
      'https://user@www.example.com',
      'https://www.example.com?tenant=x',
      'https://www.example.com:80',
      'https://localhost',
    ]) {
      expect(() => validateEnvironment({
        ...base,
        NODE_ENV: 'production',
        MARKETING_WEBSITE_ORIGIN: origin,
      })).toThrow('营销官网 Origin');
    }
  });

  it('OP 组织下发只接受独立权限域的标准 HTTPS 根地址', () => {
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

    expect(validateEnvironment({ ...base, OP_API_BASE_URL: 'https://op.example.net' }))
      .toMatchObject({ OP_API_BASE_URL: 'https://op.example.net' });
    expect(() => validateEnvironment({ ...base, OP_API_BASE_URL: 'http://op.example.net' }))
      .toThrow('独立权限域的标准 HTTPS 根地址');
    expect(() => validateEnvironment({ ...base, OP_API_BASE_URL: 'https://op.example.net/api' }))
      .toThrow('独立权限域的标准 HTTPS 根地址');
    expect(() => validateEnvironment({ ...base, OP_API_BASE_URL: 'https://erp.example.com' }))
      .toThrow('独立权限域的标准 HTTPS 根地址');
  });

  it('OP SSO 凭据必须成套且回调精确绑定 ERP issuer', () => {
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
      OP_API_BASE_URL: 'https://op.example.net',
    };
    expect(() => validateEnvironment({ ...base, OP_SSO_CLIENT_ID: 'op-client-001' }))
      .toThrow('必须成套配置');
    const configured = {
      ...base,
      OP_SSO_CLIENT_ID: 'op-client-001',
      OP_SSO_CLIENT_SECRET: 's'.repeat(32),
      OP_SSO_REDIRECT_URI: 'https://erp.example.com/api/auth/sso/op/callback',
    };
    expect(validateEnvironment(configured)).toMatchObject({ OP_SSO_CLIENT_ID: 'op-client-001' });
    expect(() => validateEnvironment({
      ...configured, OP_SSO_REDIRECT_URI: 'https://evil.example.net/api/auth/sso/op/callback',
    })).toThrow('精确指向 ERP issuer');
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

  it('Treasury 银行提交网关必须成套且与 ERP、WORM 权限域隔离', () => {
    const base = {
      NODE_ENV: 'test', MONGODB_URI: 'mongodb://localhost:27017/gaoq_os?replicaSet=rs0',
      REDIS_URL: 'redis://localhost:6379/0', WEB_ORIGIN: 'https://erp.example.com',
      AUTH_ISSUER: 'https://erp.example.com', AUTH_AUDIENCE: 'gaoq-erp',
      AUTH_RESOURCE: 'https://erp.example.com/mcp',
      AUTH_JWKS_URI: 'https://erp.example.com/.well-known/jwks.json',
      MCP_AUTHORIZATION_SERVER: 'https://erp.example.com',
      MCP_ALLOWED_ORIGINS: 'https://erp.example.com',
      TREASURY_WORM_ARCHIVE_ENDPOINT: 'https://worm.example.net/v1/objects',
      TREASURY_WORM_ARCHIVE_BEARER_TOKEN: 'treasury-worm-token-at-least-32-characters',
    };
    expect(() => validateEnvironment({
      ...base, TREASURY_BANK_SUBMISSION_ENDPOINT: 'https://bank.example.net/v1/submissions',
    })).toThrow('必须成套配置');
    expect(validateEnvironment({
      ...base, TREASURY_BANK_SUBMISSION_ENDPOINT: 'https://bank.example.net/v1/submissions',
      TREASURY_BANK_SUBMISSION_BEARER_TOKEN: 'bank-gateway-token-at-least-32-characters',
    }).TREASURY_BANK_SUBMISSION_ENDPOINT).toBe('https://bank.example.net/v1/submissions');
    expect(() => validateEnvironment({
      ...base, TREASURY_BANK_SUBMISSION_ENDPOINT: 'https://bank.example.net/v1/submissions',
      TREASURY_BANK_SUBMISSION_BEARER_TOKEN:
        'treasury-worm-token-at-least-32-characters',
    })).toThrow('不得复用同一凭据');
    for (const endpoint of [
      'https://erp.example.com/v1/submissions', 'https://worm.example.net/v1/submissions',
      'https://bank.example.net/v1/submissions?token=unsafe',
    ]) expect(() => validateEnvironment({
      ...base, TREASURY_BANK_SUBMISSION_ENDPOINT: endpoint,
      TREASURY_BANK_SUBMISSION_BEARER_TOKEN: 'bank-gateway-token-at-least-32-characters',
    })).toThrow('独立权限域 HTTPS');
  });

  it('Treasury 回盘 Inbox 必须独立于 ERP、WORM 和提交网关', () => {
    const base = {
      NODE_ENV: 'test', MONGODB_URI: 'mongodb://localhost:27017/gaoq_os?replicaSet=rs0',
      REDIS_URL: 'redis://localhost:6379/0', WEB_ORIGIN: 'https://erp.example.com',
      AUTH_ISSUER: 'https://erp.example.com', AUTH_AUDIENCE: 'gaoq-erp',
      AUTH_RESOURCE: 'https://erp.example.com/mcp',
      AUTH_JWKS_URI: 'https://erp.example.com/.well-known/jwks.json',
      MCP_AUTHORIZATION_SERVER: 'https://erp.example.com',
      MCP_ALLOWED_ORIGINS: 'https://erp.example.com',
      TREASURY_WORM_ARCHIVE_ENDPOINT: 'https://worm.example.net/v1/objects',
      TREASURY_WORM_ARCHIVE_BEARER_TOKEN: 'treasury-worm-token-at-least-32-characters',
      TREASURY_BANK_SUBMISSION_ENDPOINT: 'https://submit.example.net/v1/submissions',
      TREASURY_BANK_SUBMISSION_BEARER_TOKEN: 'bank-submit-token-at-least-32-characters',
    };
    expect(() => validateEnvironment({
      ...base, TREASURY_BANK_RETURN_INBOX_ENDPOINT: 'https://inbox.example.net/v1/returns',
    })).toThrow('必须成套配置');
    expect(validateEnvironment({
      ...base, TREASURY_BANK_RETURN_INBOX_ENDPOINT: 'https://inbox.example.net/v1/returns',
      TREASURY_BANK_RETURN_INBOX_BEARER_TOKEN: 'return-inbox-token-at-least-32-characters',
    }).TREASURY_BANK_RETURN_INBOX_ENDPOINT).toBe('https://inbox.example.net/v1/returns');
    for (const endpoint of [
      'https://erp.example.com/v1/returns', 'https://worm.example.net/v1/returns',
      'https://submit.example.net/v1/returns', 'https://inbox.example.net/v1/returns?token=unsafe',
    ]) expect(() => validateEnvironment({
      ...base, TREASURY_BANK_RETURN_INBOX_ENDPOINT: endpoint,
      TREASURY_BANK_RETURN_INBOX_BEARER_TOKEN: 'return-inbox-token-at-least-32-characters',
    })).toThrow('独立权限域 HTTPS');
    expect(() => validateEnvironment({
      ...base, TREASURY_BANK_RETURN_INBOX_ENDPOINT: 'https://inbox.example.net/v1/returns',
      TREASURY_BANK_RETURN_INBOX_BEARER_TOKEN: 'bank-submit-token-at-least-32-characters',
    })).toThrow('不得复用');
  });

  it('Payroll Tax WORM 与税务网关必须成套配置并隔离权限域和凭据', () => {
    const base = {
      NODE_ENV: 'test', MONGODB_URI: 'mongodb://localhost:27017/gaoq_os?replicaSet=rs0',
      REDIS_URL: 'redis://localhost:6379/0', WEB_ORIGIN: 'https://erp.example.com',
      AUTH_ISSUER: 'https://erp.example.com', AUTH_AUDIENCE: 'gaoq-erp',
      AUTH_RESOURCE: 'https://erp.example.com/mcp',
      AUTH_JWKS_URI: 'https://erp.example.com/.well-known/jwks.json',
      MCP_AUTHORIZATION_SERVER: 'https://erp.example.com',
      MCP_ALLOWED_ORIGINS: 'https://erp.example.com',
      TREASURY_WORM_ARCHIVE_ENDPOINT: 'https://treasury-worm.example.net/v1/objects',
      TREASURY_WORM_ARCHIVE_BEARER_TOKEN: 'treasury-worm-token-at-least-32-characters',
    };
    expect(() => validateEnvironment({
      ...base, PAYROLL_TAX_WORM_ARCHIVE_ENDPOINT: 'https://tax-worm.example.net/v1/objects',
    })).toThrow('必须成套配置');
    const configured = {
      ...base,
      PAYROLL_TAX_WORM_ARCHIVE_ENDPOINT: 'https://tax-worm.example.net/v1/objects',
      PAYROLL_TAX_WORM_ARCHIVE_BEARER_TOKEN: 'tax-worm-token-that-is-at-least-32-characters',
      PAYROLL_TAX_GATEWAY_ENDPOINT: 'https://tax-gateway.example.net/v1/submissions',
      PAYROLL_TAX_GATEWAY_BEARER_TOKEN: 'tax-gateway-token-at-least-32-characters',
    };
    expect(validateEnvironment(configured)).toMatchObject({
      PAYROLL_TAX_WORM_RETENTION_DAYS: 3_650,
      PAYROLL_TAX_GATEWAY_ENDPOINT: 'https://tax-gateway.example.net/v1/submissions',
    });
    for (const endpoints of [
      { PAYROLL_TAX_WORM_ARCHIVE_ENDPOINT: 'http://tax-worm.example.net/v1/objects' },
      { PAYROLL_TAX_GATEWAY_ENDPOINT: 'https://tax-worm.example.net/v1/submissions' },
      { PAYROLL_TAX_GATEWAY_ENDPOINT: 'https://erp.example.com/v1/submissions' },
      { PAYROLL_TAX_GATEWAY_ENDPOINT: 'https://tax-gateway.example.net/v1/submissions?token=x' },
    ]) expect(() => validateEnvironment({ ...configured, ...endpoints }))
      .toThrow('相互隔离的标准 HTTPS 权限域');
    expect(() => validateEnvironment({
      ...configured,
      PAYROLL_TAX_GATEWAY_BEARER_TOKEN: 'tax-worm-token-that-is-at-least-32-characters',
    })).toThrow('不得复用');
    expect(() => validateEnvironment({
      ...configured,
      PAYROLL_TAX_WORM_ARCHIVE_BEARER_TOKEN: 'treasury-worm-token-at-least-32-characters',
    })).toThrow('不得复用');
  });

  it('生产资金通道必须完整绑定独立 Phase 6 授权域与发布物', () => {
    const base = {
      NODE_ENV: 'test', MONGODB_URI: 'mongodb://localhost:27017/gaoq_os?replicaSet=rs0',
      REDIS_URL: 'redis://localhost:6379/0', WEB_ORIGIN: 'https://erp.example.com',
      AUTH_ISSUER: 'https://erp.example.com', AUTH_AUDIENCE: 'gaoq-erp',
      AUTH_RESOURCE: 'https://erp.example.com/mcp',
      AUTH_JWKS_URI: 'https://erp.example.com/.well-known/jwks.json',
      MCP_AUTHORIZATION_SERVER: 'https://erp.example.com',
      MCP_ALLOWED_ORIGINS: 'https://erp.example.com',
      TREASURY_BANK_SUBMISSION_ENDPOINT: 'https://bank.example.net/v1/submissions',
      TREASURY_BANK_SUBMISSION_BEARER_TOKEN: 'bank-gateway-token-at-least-32-characters',
      TREASURY_BANK_SUBMISSION_MODE: 'production',
    };
    expect(() => validateEnvironment(base)).toThrow('一次性授权域完整配置');
    const authorization = {
      PHASE6_PRODUCTION_AUTHORIZATION_ENDPOINT:
        'https://release-authorization.example.net/v1/authorizations',
      PHASE6_PRODUCTION_AUTHORIZATION_BEARER_TOKEN:
        'phase6-authorization-token-at-least-32-characters',
      PHASE6_RELEASE_COMMIT_SHA: 'a'.repeat(40),
      PHASE6_DEPLOYMENT_MANIFEST_SHA256: `sha256:${'b'.repeat(64)}`,
    };
    expect(() => validateEnvironment({ ...base, ...authorization }))
      .toThrow('只能在 NODE_ENV=production');
    expect(validateEnvironment({
      ...base, TREASURY_BANK_SUBMISSION_MODE: 'sandbox', ...authorization,
    })).toMatchObject({
      TREASURY_BANK_SUBMISSION_MODE: 'sandbox',
      PHASE6_RELEASE_COMMIT_SHA: 'a'.repeat(40),
    });
    expect(() => validateEnvironment({
      ...base, ...authorization,
      PHASE6_PRODUCTION_AUTHORIZATION_ENDPOINT: 'https://bank.example.net/v1/authorizations',
    })).toThrow('独立权限域标准 HTTPS');
    expect(() => validateEnvironment({
      ...base, ...authorization,
      PHASE6_PRODUCTION_AUTHORIZATION_BEARER_TOKEN:
        'bank-gateway-token-at-least-32-characters',
    })).toThrow('不得复用资金、税务或 WORM 凭据');
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
