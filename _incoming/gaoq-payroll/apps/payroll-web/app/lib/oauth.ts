import { createHash, randomBytes } from 'node:crypto';

const requireEnvironment = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`缺少环境变量 ${name}`);
  }
  return value;
};

export interface PayrollOAuthConfiguration {
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly resource: string;
  readonly scopes: readonly string[];
}

/** 读取统一身份公开配置；浏览器端不使用 client secret。 */
export const payrollOAuthConfiguration = (): PayrollOAuthConfiguration =>
  Object.freeze({
    authorizationEndpoint: requireEnvironment('GAOQ_AUTHORIZATION_ENDPOINT'),
    tokenEndpoint: requireEnvironment('GAOQ_TOKEN_ENDPOINT'),
    clientId: requireEnvironment('GAOQ_PAYROLL_CLIENT_ID'),
    redirectUri: requireEnvironment('GAOQ_PAYROLL_REDIRECT_URI'),
    resource: requireEnvironment('AUTH_RESOURCE'),
    scopes: Object.freeze(
      (process.env.GAOQ_PAYROLL_SCOPES ?? 'erp:payroll:payslip:self')
        .split(' ')
        .filter(Boolean),
    ),
  });

/** 生成 PKCE S256 verifier/challenge。 */
export const createPkce = (): {
  readonly verifier: string;
  readonly challenge: string;
} => {
  const verifier = randomBytes(32).toString('base64url');
  return {
    verifier,
    challenge: createHash('sha256').update(verifier).digest('base64url'),
  };
};

/** OAuth Token Endpoint 标准成功响应。 */
export interface OAuthTokenResponse {
  readonly access_token: string;
  readonly token_type: 'Bearer';
  readonly expires_in: number;
  readonly scope: string;
}

/** 使用一次性授权码和 PKCE verifier 换取受众限定的短期令牌。 */
export const exchangeAuthorizationCode = async (
  code: string,
  verifier: string,
): Promise<OAuthTokenResponse> => {
  const config = payrollOAuthConfiguration();
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: config.clientId,
    code,
    redirect_uri: config.redirectUri,
    resource: config.resource,
    code_verifier: verifier,
  });
  const response = await fetch(config.tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    cache: 'no-store',
  });
  if (!response.ok) throw new Error('统一身份令牌交换失败');
  const value = await response.json() as Partial<OAuthTokenResponse>;
  if (
    typeof value.access_token !== 'string' ||
    value.token_type !== 'Bearer' ||
    typeof value.expires_in !== 'number' ||
    !Number.isInteger(value.expires_in) ||
    value.expires_in < 1 ||
    typeof value.scope !== 'string'
  ) throw new Error('统一身份令牌响应结构非法');
  return value as OAuthTokenResponse;
};
