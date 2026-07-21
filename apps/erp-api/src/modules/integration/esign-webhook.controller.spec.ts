import { ForbiddenException } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { describe, expect, it, vi } from 'vitest';

import { ESignWebhookController } from './esign-webhook.controller.js';
import type { ESignWebhookService } from './esign-webhook.service.js';

describe('ESignWebhookController', () => {
  it('原样返回供应商确认契约且不接受租户参数', async () => {
    const accept = vi.fn().mockResolvedValue({ inboxId: 'inbox-001', duplicate: false });
    const controller = new ESignWebhookController({ accept } as unknown as ESignWebhookService);
    const rawBody = Buffer.from('{"action":"SIGN_FLOW_COMPLETE"}');
    const response = await controller.receive(
      'app12345', '1784620800000', '0'.repeat(64), 'hmac-sha256', {},
      { rawBody } as RawBodyRequest<Request>,
    );
    expect(response).toEqual({ code: '200', msg: 'success' });
    expect(accept).toHaveBeenCalledWith({
      appId: 'app12345', timestamp: '1784620800000', signature: '0'.repeat(64),
      algorithm: 'hmac-sha256',
    }, rawBody);
  });

  it('禁止 query 避免签名串歧义', async () => {
    const controller = new ESignWebhookController({} as ESignWebhookService);
    await expect(controller.receive(
      undefined, undefined, undefined, undefined, { tenantId: 'tenant-evil' },
      {} as RawBodyRequest<Request>,
    )).rejects.toBeInstanceOf(ForbiddenException);
  });
});
