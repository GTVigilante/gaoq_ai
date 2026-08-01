import { Controller, ForbiddenException, Headers, HttpCode, Post, Query, Req } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';

import { PublicRoute, RawResponse } from '../../core/http/public-route.decorator.js';
import { ESignWebhookService } from './esign-webhook.service.js';

/** 公网 eSign 回调边界；租户只由已验证 appId 绑定解析，不读取请求租户参数。 */
@Controller('webhooks/esign')
export class ESignWebhookController {
  constructor(private readonly webhooks: ESignWebhookService) {}

  @Post()
  @HttpCode(200)
  @PublicRoute()
  @RawResponse()
  async receive(
    @Headers('x-tsign-open-app-id') appId: string | undefined,
    @Headers('x-tsign-open-timestamp') timestamp: string | undefined,
    @Headers('x-tsign-open-signature') signature: string | undefined,
    @Headers('x-tsign-open-signature-algorithm') algorithm: string | undefined,
    @Query() query: Readonly<Record<string, unknown>>,
    @Req() request: RawBodyRequest<Request>,
  ): Promise<{ readonly code: '200'; readonly msg: 'success' }> {
    // 生产回调 URL 固定不带 query，避免代理层重排或重复参数造成验签歧义。
    if (Object.keys(query).length > 0) throw new ForbiddenException({
      code: 'ESIGN_WEBHOOK_QUERY_NOT_ALLOWED', message: 'eSign 回调地址禁止 query 参数',
    });
    await this.webhooks.accept(
      { appId, timestamp, signature, algorithm },
      request.rawBody,
    );
    return Object.freeze({ code: '200', msg: 'success' });
  }
}
