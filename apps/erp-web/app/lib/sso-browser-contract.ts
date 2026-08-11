export type BrowserSsoProvider = 'dingtalk' | 'feishu' | 'op';

export interface SsoCallbackInput {
  readonly provider: BrowserSsoProvider;
  readonly state: string;
  readonly code: string;
}

export interface SsoCompletion {
  readonly returnPath: string;
}

const STATE_PATTERN = /^[A-Za-z0-9_-]{20,512}$/u;
const RETURN_PATH_PATTERN = /^\/(?!\/)[^\p{Cc}\\:]*$/u;

/** 将身份平台回调查询压缩为后端允许的最小白名单字段。 */
export function parseSsoCallbackInput(
  providerValue: string,
  search: URLSearchParams,
): SsoCallbackInput {
  const provider = parseProvider(providerValue);
  const stateValues = search.getAll('state');
  const codeValues = [...search.getAll('code'), ...search.getAll('authCode')];
  if (
    stateValues.length !== 1 ||
    codeValues.length !== 1 ||
    !STATE_PATTERN.test(stateValues[0] ?? '') ||
    codeValues[0] === undefined ||
    codeValues[0].length < 1 ||
    codeValues[0].length > 2_048
  ) throw new Error('SSO_CALLBACK_INVALID');
  return Object.freeze({ provider, state: stateValues[0]!, code: codeValues[0] });
}

/** 回调完成响应只采纳受控站内返回路径；访问令牌继续留在内存/HttpOnly 会话链。 */
export function parseSsoCompletion(value: unknown): SsoCompletion {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('SSO_COMPLETION_INVALID');
  }
  const record = value as Readonly<Record<string, unknown>>;
  if (
    typeof record.returnPath !== 'string' ||
    record.returnPath.length > 512 ||
    !RETURN_PATH_PATTERN.test(record.returnPath)
  ) throw new Error('SSO_COMPLETION_INVALID');
  return Object.freeze({ returnPath: record.returnPath });
}

function parseProvider(value: string): BrowserSsoProvider {
  if (value === 'dingtalk' || value === 'feishu' || value === 'op') return value;
  throw new Error('SSO_PROVIDER_INVALID');
}
