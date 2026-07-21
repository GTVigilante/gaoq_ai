import { Controller, Get } from '@nestjs/common';

import { PublicRoute, RawResponse } from '../../core/http/public-route.decorator.js';
import { AccessTokenSigner } from './access-token-signer.js';

@Controller('.well-known')
@PublicRoute()
@RawResponse()
export class JwksController {
  constructor(private readonly signer: AccessTokenSigner) {}

  /** 发布仅含当前 RSA 公钥的 JWKS，供 ERP、MCP 与外部资源服务器验签。 */
  @Get('jwks.json')
  jwks(): ReturnType<AccessTokenSigner['getPublicJwks']> {
    return this.signer.getPublicJwks();
  }
}
