import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';

import { PublicRoute, RawResponse } from '../../core/http/public-route.decorator.js';
import { AccessTokenSigner } from './access-token-signer.js';

@Controller('.well-known')
@PublicRoute()
@RawResponse()
export class JwksController {
  constructor(private readonly signer: AccessTokenSigner) {}

  /** 发布当前签名公钥与轮换窗口内的历史验签公钥。 */
  @Get('jwks.json')
  jwks(
    @Res({ passthrough: true }) response: Response,
  ): ReturnType<AccessTokenSigner['getPublicJwks']> {
    response.setHeader('Cache-Control', 'public, max-age=300, must-revalidate');
    response.setHeader('Content-Type', 'application/jwk-set+json');
    return this.signer.getPublicJwks();
  }
}
