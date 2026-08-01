import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { describe, expect, it, vi } from 'vitest';

import { OpApprovalWebhookController } from './op-approval-webhook.controller.js';
import type { OpApprovalWebhookService } from './op-approval-webhook.service.js';
import { OpWebhookController } from './op-webhook.controller.js';
import type { OpWebhookService } from './op-webhook.service.js';

const HEADERS = [
  'op-client-001',
  '1785206400000',
  'nonce_1234567890abcdef',
  'event-20260728-001',
  'a'.repeat(64),
  'hmac-sha256',
] as const;

const request = {
  rawBody: Buffer.from('{"safe":true}', 'utf8'),
} as RawBodyRequest<Request>;

describe('OpWebhookController', () => {
  it('逐字转交六个认证头与原始正文并返回固定 202 形状', async () => {
    const accept = vi.fn().mockResolvedValue({
      inboxId: '01K00000000000000000000000',
      duplicate: false,
    });
    const controller = new OpWebhookController({ accept } as unknown as OpWebhookService);

    await expect(controller.receive(...HEADERS, {}, request)).resolves.toEqual({
      accepted: true,
      inboxId: '01K00000000000000000000000',
      duplicate: false,
    });
    expect(accept).toHaveBeenCalledWith({
      clientId: HEADERS[0],
      timestamp: HEADERS[1],
      nonce: HEADERS[2],
      eventId: HEADERS[3],
      signature: HEADERS[4],
      algorithm: HEADERS[5],
    }, request.rawBody);
  });

  it('存在任意 query 时在调用服务前失败关闭', async () => {
    const accept = vi.fn();
    const controller = new OpWebhookController({ accept } as unknown as OpWebhookService);

    await expect(controller.receive(...HEADERS, { tenantId: 'forged' }, request))
      .rejects.toMatchObject({ response: { code: 'OP_WEBHOOK_QUERY_NOT_ALLOWED' } });
    expect(accept).not.toHaveBeenCalled();
  });
});

describe('OpApprovalWebhookController', () => {
  it('逐字转交六个认证头与原始正文并返回固定 202 形状', async () => {
    const accept = vi.fn().mockResolvedValue({
      inboxId: '01K00000000000000000000001',
      duplicate: true,
    });
    const controller = new OpApprovalWebhookController(
      { accept } as unknown as OpApprovalWebhookService,
    );

    await expect(controller.receive(...HEADERS, {}, request)).resolves.toEqual({
      accepted: true,
      inboxId: '01K00000000000000000000001',
      duplicate: true,
    });
    expect(accept).toHaveBeenCalledWith({
      clientId: HEADERS[0],
      timestamp: HEADERS[1],
      nonce: HEADERS[2],
      eventId: HEADERS[3],
      signature: HEADERS[4],
      algorithm: HEADERS[5],
    }, request.rawBody);
  });

  it('存在任意 query 时在调用服务前失败关闭', async () => {
    const accept = vi.fn();
    const controller = new OpApprovalWebhookController(
      { accept } as unknown as OpApprovalWebhookService,
    );

    await expect(controller.receive(...HEADERS, { templateCode: 'bypass' }, request))
      .rejects.toMatchObject({ response: { code: 'OP_APPROVAL_QUERY_NOT_ALLOWED' } });
    expect(accept).not.toHaveBeenCalled();
  });
});
