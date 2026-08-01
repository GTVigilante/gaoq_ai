import {
  Controller, ForbiddenException, Headers, HttpCode, Post, Query, Req,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';

import { PublicRoute, RawResponse } from '../../core/http/public-route.decorator.js';
import { OpApprovalWebhookService } from './op-approval-webhook.service.js';

/** OP 审批公网入口；租户与模板分别由验签 clientId 和 ERP 路由绑定解析。 */
@Controller('webhooks/op/approvals')
export class OpApprovalWebhookController {
  constructor(private readonly webhooks: OpApprovalWebhookService) {}

  @Post()
  @HttpCode(202)
  @PublicRoute()
  @RawResponse()
  async receive(
    @Headers('x-gaoq-op-client-id') clientId: string | undefined,
    @Headers('x-gaoq-op-timestamp') timestamp: string | undefined,
    @Headers('x-gaoq-op-nonce') nonce: string | undefined,
    @Headers('x-gaoq-op-event-id') eventId: string | undefined,
    @Headers('x-gaoq-op-signature') signature: string | undefined,
    @Headers('x-gaoq-op-signature-algorithm') algorithm: string | undefined,
    @Query() query: Readonly<Record<string, unknown>>,
    @Req() request: RawBodyRequest<Request>,
  ): Promise<{ readonly accepted: true; readonly inboxId: string; readonly duplicate: boolean }> {
    if (Object.keys(query).length > 0) throw new ForbiddenException({
      code: 'OP_APPROVAL_QUERY_NOT_ALLOWED', message: 'OP 审批回调地址禁止 query 参数',
    });
    const result = await this.webhooks.accept(
      { clientId, timestamp, nonce, eventId, signature, algorithm }, request.rawBody,
    );
    return Object.freeze({ accepted: true, ...result });
  }
}
