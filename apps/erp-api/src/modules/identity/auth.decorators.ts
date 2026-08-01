import { SetMetadata } from '@nestjs/common';

export const REQUIRED_SCOPES_KEY = 'gaoq:required-scopes';

/** 声明端点所需 OAuth Scope；多个 scope 必须全部满足。 */
export const RequiredScopes = (...scopes: readonly string[]): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRED_SCOPES_KEY, scopes);
