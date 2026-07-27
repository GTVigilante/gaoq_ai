import 'server-only';

const CLUSTER_ORIGIN =
  /^http:\/\/[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?\.svc\.cluster\.local:3001$/u;
const CLIENT_ID = /^[A-Za-z0-9._-]{8,128}$/u;
const CLIENT_SECRET = /^[\x21-\x7E]{32,256}$/u;
const SCOPE = /^erp:[a-z][a-z0-9_]*:[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$/u;
const ACCESS_TOKEN = /^[A-Za-z0-9._~-]{40,4096}$/u;
const TRANSIENT_STATUS = new Set([502, 503, 504]);
const TOKEN_TIMEOUT_MS = 3_000;
const READ_TIMEOUT_MS = 5_000;
const WRITE_TIMEOUT_MS = 8_000;

interface ApiEnvelope<T> {
  readonly code: string;
  readonly message: string;
  readonly data: T;
  readonly traceId: string;
}

interface TokenState {
  readonly value: string;
  readonly expiresAt: number;
}

const tokens = new Map<string, TokenState>();

export class RecruitmentPortalApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'RecruitmentPortalApiError';
  }
}

/** 判断门户服务凭据是否完整；生产环境缺失时必须失败关闭。 */
export function isRecruitmentPortalConfigured(): boolean {
  return [
    process.env.ERP_PORTAL_CLIENT_ID,
    process.env.ERP_PORTAL_CLIENT_SECRET,
  ].every((value) => value !== undefined && value.length > 0);
}

/**
 * 通过独立服务身份调用 ERP。
 *
 * 每种操作单独申请最小 Scope，访问令牌只保留在服务端内存。
 */
export async function recruitmentPortalFetch<T>(
  path: string,
  scope: string,
  init: RequestInit = {},
): Promise<T> {
  if (!path.startsWith('/api/recruitment/') || path.includes('..')) {
    throw new Error('RECRUITMENT_PORTAL_API_PATH_INVALID');
  }
  if (!SCOPE.test(scope)) throw new Error('RECRUITMENT_PORTAL_SCOPE_INVALID');
  const origin = apiOrigin();
  const token = await serviceToken(origin, scope);
  const method = (init.method ?? 'GET').toUpperCase();
  const retryable = ['GET', 'HEAD'].includes(method) || hasIdempotencyKey(init.headers);
  const headers = new Headers(init.headers);
  headers.set('accept', 'application/json');
  headers.set('authorization', `Bearer ${token}`);
  const response = await fetchWithPolicy(`${origin}${path}`, {
    ...init,
    cache: 'no-store',
    headers,
  }, {
    attempts: retryable ? 2 : 1,
    timeoutMs: ['GET', 'HEAD'].includes(method) ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS,
    failureCode: 'RECRUITMENT_PORTAL_UPSTREAM_UNAVAILABLE',
  });
  return readEnvelope<T>(response);
}

async function serviceToken(origin: string, scope: string): Promise<string> {
  const current = tokens.get(scope);
  if (current !== undefined && current.expiresAt - Date.now() > 30_000) return current.value;
  const clientId = process.env.ERP_PORTAL_CLIENT_ID ?? '';
  const clientSecret = process.env.ERP_PORTAL_CLIENT_SECRET ?? '';
  if (!CLIENT_ID.test(clientId) || !CLIENT_SECRET.test(clientSecret)) {
    throw new RecruitmentPortalApiError(
      'RECRUITMENT_PORTAL_NOT_CONFIGURED',
      '招聘门户服务身份尚未配置',
      503,
    );
  }
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    resource: oauthResource(origin),
    scope,
  });
  const response = await fetchWithPolicy(`${origin}/api/auth/oauth/token`, {
    method: 'POST',
    cache: 'no-store',
    headers: {
      accept: 'application/json',
      authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body,
  }, {
    attempts: 2,
    timeoutMs: TOKEN_TIMEOUT_MS,
    failureCode: 'RECRUITMENT_PORTAL_AUTH_UNAVAILABLE',
  });
  const value = await response.json().catch(() => null) as unknown;
  if (!response.ok || !isTokenResponse(value)) {
    throw new RecruitmentPortalApiError(
      'RECRUITMENT_PORTAL_AUTH_FAILED',
      '招聘门户暂时无法连接人才系统',
      503,
    );
  }
  tokens.set(scope, {
    value: value.access_token,
    expiresAt: Date.now() + value.expires_in * 1_000,
  });
  return value.access_token;
}

async function readEnvelope<T>(response: Response): Promise<T> {
  const value = await response.json().catch(() => null) as unknown;
  if (!isEnvelope<T>(value)) {
    throw new RecruitmentPortalApiError(
      'RECRUITMENT_PORTAL_RESPONSE_INVALID',
      '人才系统响应格式无效',
      502,
    );
  }
  if (!response.ok || value.code !== 'SUCCESS') {
    throw new RecruitmentPortalApiError(value.code, value.message, response.status);
  }
  return value.data;
}

function apiOrigin(): string {
  const raw = process.env.ERP_API_ORIGIN ??
    process.env.NEXT_PUBLIC_ERP_API_ORIGIN ??
    'http://localhost:3001';
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('RECRUITMENT_PORTAL_API_ORIGIN_INVALID');
  }
  const localDevelopment =
    process.env.NODE_ENV !== 'production' &&
    parsed.protocol === 'http:' &&
    ['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname);
  const publicHttps =
    parsed.protocol === 'https:' &&
    !['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname) &&
    !parsed.hostname.endsWith('.local') &&
    (parsed.port === '' || parsed.port === '443');
  if (
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    (!CLUSTER_ORIGIN.test(parsed.origin) && !localDevelopment && !publicHttps)
  ) throw new Error('RECRUITMENT_PORTAL_API_ORIGIN_INVALID');
  return parsed.origin;
}

function oauthResource(origin: string): string {
  const value = process.env.ERP_PORTAL_OAUTH_RESOURCE ?? `${origin}/mcp`;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('RECRUITMENT_PORTAL_OAUTH_RESOURCE_INVALID');
  }
  if (
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) throw new Error('RECRUITMENT_PORTAL_OAUTH_RESOURCE_INVALID');
  return parsed.toString().replace(/\/$/u, '');
}

function isTokenResponse(value: unknown): value is {
  readonly access_token: string;
  readonly token_type: 'Bearer';
  readonly expires_in: number;
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.access_token === 'string' &&
    ACCESS_TOKEN.test(record.access_token) &&
    record.token_type === 'Bearer' &&
    Number.isSafeInteger(record.expires_in) &&
    Number(record.expires_in) >= 60 &&
    Number(record.expires_in) <= 86_400
  );
}

function isEnvelope<T>(value: unknown): value is ApiEnvelope<T> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.code === 'string' &&
    typeof record.message === 'string' &&
    typeof record.traceId === 'string' &&
    Object.hasOwn(record, 'data')
  );
}

async function fetchWithPolicy(
  input: string,
  init: RequestInit,
  policy: {
    readonly attempts: 1 | 2;
    readonly timeoutMs: number;
    readonly failureCode: string;
  },
): Promise<Response> {
  for (let attempt = 1; attempt <= policy.attempts; attempt += 1) {
    try {
      const timeout = AbortSignal.timeout(policy.timeoutMs);
      const signal = init.signal == null
        ? timeout
        : AbortSignal.any([init.signal, timeout]);
      const response = await fetch(input, { ...init, signal });
      if (!TRANSIENT_STATUS.has(response.status) || attempt === policy.attempts) return response;
    } catch (caught) {
      const timedOut = caught instanceof DOMException && caught.name === 'TimeoutError';
      if (attempt === policy.attempts) {
        throw new RecruitmentPortalApiError(
          timedOut ? 'RECRUITMENT_PORTAL_UPSTREAM_TIMEOUT' : policy.failureCode,
          timedOut ? '人才系统响应超时' : '人才系统暂时不可用',
          timedOut ? 504 : 503,
        );
      }
    }
  }
  throw new RecruitmentPortalApiError(policy.failureCode, '人才系统暂时不可用', 503);
}

function hasIdempotencyKey(headers: HeadersInit | undefined): boolean {
  if (headers === undefined) return false;
  const value = new Headers(headers).get('idempotency-key');
  return value !== null && value.length >= 8 && value.length <= 256;
}

/** 仅供单元测试清理服务令牌缓存。 */
export function resetRecruitmentPortalTokenCacheForTests(): void {
  tokens.clear();
}
