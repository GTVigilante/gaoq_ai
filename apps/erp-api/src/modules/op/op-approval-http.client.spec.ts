import { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppEnvironment } from '../../config/environment.js';
import { FetchOpApprovalHttpClient } from './op-approval-http.client.js';

function client(baseUrl = 'https://op.example.net') {
  return new FetchOpApprovalHttpClient(new ConfigService<AppEnvironment, true>({
    OP_API_BASE_URL: baseUrl,
  } as AppEnvironment));
}

describe('FetchOpApprovalHttpClient', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('只向固定 HTTPS 根域和审批结果 PUT 路径发送请求', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: 'OK', data: {
        externalEventId: 'approval-event-001',
        approvalInstanceId: '01K00000000000000000000001', approvalVersion: 3,
      },
    }), { status: 200, headers: { 'x-request-id': 'request-001' } }));
    vi.stubGlobal('fetch', fetchMock);
    const response = await client().put({
      path: '/erp/v1/approval-results/approval-event-001',
      headers: { 'content-type': 'application/json', 'x-gaoq-erp-signature': '0'.repeat(64) },
      body: '{"result":"approved"}',
    });
    expect(response.requestId).toBe('request-001');
    expect(fetchMock).toHaveBeenCalledWith(
      new URL('https://op.example.net/erp/v1/approval-results/approval-event-001'),
      expect.objectContaining({ method: 'PUT', redirect: 'error' }),
    );
  });

  it('拒绝路径逃逸、危险请求头、非 HTTPS 根地址和超大流式响应', async () => {
    await expect(client().put({ path: '//attacker.example/x', headers: {}, body: '{}' }))
      .rejects.toMatchObject({ code: 'OP_APPROVAL_PATH_INVALID' });
    await expect(client().put({
      path: '/erp/v1/approval-results/approval-event-001', headers: { Host: 'attacker' }, body: '{}',
    })).rejects.toMatchObject({ code: 'OP_APPROVAL_HEADER_INVALID' });
    await expect(client('http://op.example.net').put({
      path: '/erp/v1/approval-results/approval-event-001', headers: {}, body: '{}',
    })).rejects.toMatchObject({ code: 'OP_APPROVAL_BASE_URL_INVALID' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('x'.repeat(256 * 1024 + 1))));
    await expect(client().put({
      path: '/erp/v1/approval-results/approval-event-001', headers: {}, body: '{}',
    })).rejects.toMatchObject({ code: 'OP_APPROVAL_RESPONSE_TOO_LARGE' });
  });
});
