export interface CorsOriginEnvironment {
  readonly webOrigin: string;
  readonly marketingWebsiteOrigin?: string;
  readonly mcpAllowedOrigins: string;
}

/** 从已验证配置构造精确 CORS Origin 白名单。 */
export const buildAllowedCorsOrigins = (
  environment: CorsOriginEnvironment,
): ReadonlySet<string> => Object.freeze(new Set([
  environment.webOrigin,
  environment.marketingWebsiteOrigin,
  ...environment.mcpAllowedOrigins.split(',').map((origin) => origin.trim()),
].filter((origin): origin is string => origin !== undefined && origin !== '')));

/** CORS 只允许无浏览器 Origin 的服务请求或精确白名单命中。 */
export const isCorsOriginAllowed = (
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>,
): boolean => origin === undefined || allowedOrigins.has(origin);
