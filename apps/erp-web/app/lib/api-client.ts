const API_ORIGIN = process.env.NEXT_PUBLIC_ERP_API_ORIGIN ?? 'http://localhost:3001';
const ACCESS_TOKEN = /^[A-Za-z0-9._~-]{40,4096}$/u;
const TRACE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;

interface ApiEnvelope<T> {
  readonly code: string;
  readonly message: string;
  readonly data: T;
  readonly traceId: string;
  readonly timestamp: string;
}

interface TokenGrant {
  readonly accessToken: string;
  readonly tokenType: 'Bearer';
  readonly expiresIn: number;
  readonly scope: string;
}

export interface ErpApiResult<T> {
  readonly data: T;
  readonly traceId: string;
  readonly etag: string | null;
}

export interface BrowserSessionSnapshot {
  readonly scopes: readonly string[];
  readonly expiresAt: number;
}

/** 统一前端错误；只保留服务端安全消息、稳定错误码和 traceId。 */
export class ErpApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly traceId: string | null,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ErpApiError';
  }
}

let tokenState: { readonly value: string; readonly scopes: readonly string[]; readonly expiresAt: number } | null = null;
let refreshPromise: Promise<string> | null = null;

/**
 * 调用受保护 ERP REST。访问令牌只保存在当前 JS 内存；刷新令牌始终留在 HttpOnly Cookie。
 */
export async function erpFetch<T>(
  path: string,
  init: Omit<RequestInit, 'credentials' | 'cache'> = {},
): Promise<ErpApiResult<T>> {
  assertApiPath(path);
  const token = await accessToken();
  const response = await request(path, token, init);
  if (response.status === 401) {
    clearBrowserSession();
    return retry<T>(path, init);
  }
  return readResponse<T>(response);
}

/** 调用无需 Bearer 的浏览器认证入口；仍强制 Cookie 和 no-store。 */
export async function erpPublicFetch<T>(
  path: string,
  init: Omit<RequestInit, 'credentials' | 'cache'> = {},
): Promise<ErpApiResult<T>> {
  assertApiPath(path);
  const response = await fetch(`${API_ORIGIN}${path}`, {
    ...init,
    credentials: 'include',
    cache: 'no-store',
    headers: mergeHeaders(init.headers),
  });
  return readResponse<T>(response);
}

/** 返回当前浏览器会话的非敏感 Scope 摘要。 */
export async function getBrowserSession(): Promise<BrowserSessionSnapshot> {
  await accessToken();
  if (tokenState === null) throw new ErpApiError('AUTH_REQUIRED', '登录已失效', null, 401);
  return Object.freeze({ scopes: tokenState.scopes, expiresAt: tokenState.expiresAt });
}

/** 清理当前页面内存中的访问令牌。 */
export function clearBrowserSession(): void {
  tokenState = null;
  refreshPromise = null;
}

/** 为写请求生成浏览器内一次性幂等键，不写入任何持久化存储。 */
export function createIdempotencyKey(namespace: string): string {
  if (!/^[a-z][a-z0-9._-]{2,63}$/u.test(namespace)) {
    throw new Error('IDEMPOTENCY_NAMESPACE_INVALID');
  }
  return `${namespace}:${crypto.randomUUID()}`;
}

/** 生成 REST 强版本头，禁止弱 ETag。 */
export function strongEtag(version: number): string {
  if (!Number.isSafeInteger(version) || version < 1) throw new Error('ETAG_VERSION_INVALID');
  return `"${version}"`;
}

/** 判断写请求是否已被服务端明确拒绝；只有超时、限流和处理中允许复用原请求重试。 */
export function isDefinitiveWriteRejection(value: unknown): boolean {
  if (!(value instanceof ErpApiError) || value.status < 400 || value.status >= 500) return false;
  if (value.status === 408 || value.status === 429) return false;
  if (value.status === 409) return value.code !== 'IDEMPOTENCY_IN_PROGRESS';
  return true;
}

/** 从统一响应信封中提取业务数据。 */
export function parseApiEnvelope<T>(value: unknown): ApiEnvelope<T> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ErpApiError('API_RESPONSE_INVALID', '服务响应格式无效', null, 502);
  }
  const record = value as Readonly<Record<string, unknown>>;
  if (
    typeof record.code !== 'string' || record.code.length < 1 || record.code.length > 128 ||
    typeof record.message !== 'string' || record.message.length > 512 ||
    typeof record.traceId !== 'string' || !TRACE_ID.test(record.traceId) ||
    typeof record.timestamp !== 'string' || Number.isNaN(Date.parse(record.timestamp)) ||
    !Object.hasOwn(record, 'data')
  ) throw new ErpApiError('API_RESPONSE_INVALID', '服务响应格式无效', null, 502);
  return Object.freeze({
    code: record.code,
    message: record.message,
    data: record.data as T,
    traceId: record.traceId,
    timestamp: record.timestamp,
  });
}

async function retry<T>(
  path: string,
  init: Omit<RequestInit, 'credentials' | 'cache'>,
): Promise<ErpApiResult<T>> {
  const token = await accessToken();
  return readResponse<T>(await request(path, token, init));
}

async function request(
  path: string,
  token: string,
  init: Omit<RequestInit, 'credentials' | 'cache'>,
): Promise<Response> {
  return fetch(`${API_ORIGIN}${path}`, {
    ...init,
    credentials: 'include',
    cache: 'no-store',
    headers: mergeHeaders(init.headers, token),
  });
}

async function accessToken(): Promise<string> {
  if (tokenState !== null && tokenState.expiresAt - Date.now() > 30_000) return tokenState.value;
  refreshPromise ??= refreshAccessToken();
  try {
    return await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}

async function refreshAccessToken(): Promise<string> {
  const response = await fetch(`${API_ORIGIN}/api/auth/token/refresh`, {
    method: 'POST', credentials: 'include', cache: 'no-store', headers: { accept: 'application/json' },
  });
  const result = await readResponse<unknown>(response);
  const grant = parseTokenGrant(result.data);
  tokenState = Object.freeze({
    value: grant.accessToken,
    scopes: Object.freeze(grant.scope.split(' ').filter(Boolean)),
    expiresAt: Date.now() + grant.expiresIn * 1_000,
  });
  return grant.accessToken;
}

async function readResponse<T>(response: Response): Promise<ErpApiResult<T>> {
  let envelope: ApiEnvelope<T>;
  try {
    envelope = parseApiEnvelope<T>(await response.json() as unknown);
  } catch (error) {
    if (error instanceof ErpApiError) throw error;
    throw new ErpApiError('API_RESPONSE_INVALID', '服务响应无法解析', null, response.status);
  }
  if (!response.ok || envelope.code !== 'SUCCESS') {
    throw new ErpApiError(envelope.code, envelope.message, envelope.traceId, response.status);
  }
  return Object.freeze({ data: envelope.data, traceId: envelope.traceId, etag: response.headers.get('etag') });
}

function parseTokenGrant(value: unknown): TokenGrant {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ErpApiError('AUTH_RESPONSE_INVALID', '登录响应无效', null, 502);
  }
  const record = value as Readonly<Record<string, unknown>>;
  if (
    typeof record.accessToken !== 'string' || !ACCESS_TOKEN.test(record.accessToken) ||
    record.tokenType !== 'Bearer' || typeof record.expiresIn !== 'number' ||
    !Number.isSafeInteger(record.expiresIn) || record.expiresIn < 60 || record.expiresIn > 86_400 ||
    typeof record.scope !== 'string' || record.scope.length > 16_384
  ) throw new ErpApiError('AUTH_RESPONSE_INVALID', '登录响应无效', null, 502);
  return Object.freeze({
    accessToken: record.accessToken,
    tokenType: 'Bearer',
    expiresIn: record.expiresIn,
    scope: record.scope,
  });
}

function mergeHeaders(headers?: HeadersInit, token?: string): Headers {
  const result = new Headers(headers);
  result.set('accept', 'application/json');
  if (token !== undefined) result.set('authorization', `Bearer ${token}`);
  return result;
}

function assertApiPath(path: string): void {
  if (!/^\/api\/[A-Za-z0-9/?=&._:%-]+$/u.test(path) || path.includes('..')) {
    throw new Error('ERP_API_PATH_INVALID');
  }
}
