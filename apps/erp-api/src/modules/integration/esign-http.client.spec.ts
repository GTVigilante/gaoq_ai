import { afterEach, describe, expect, it, vi } from 'vitest';

import { FetchESignHttpClient } from './esign-http.client.js';

describe('FetchESignHttpClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('只允许官方 OpenAPI 域名和 v3 路径', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const client = new FetchESignHttpClient();
    await expect(client.request({
      url: 'https://169.254.169.254/v3/secrets', method: 'GET', headers: {},
    })).rejects.toThrow('ESIGN_HTTP_TARGET_DENIED');
    await expect(client.request({
      url: 'https://openapi.esign.cn/v2/legacy', method: 'GET', headers: {},
    })).rejects.toThrow('ESIGN_HTTP_TARGET_DENIED');
    await expect(client.request({
      url: 'http://openapi.esign.cn/v3/flow', method: 'GET', headers: {},
    })).rejects.toThrow('ESIGN_HTTP_TARGET_DENIED');
    await expect(client.request({
      url: 'https://user:pass@openapi.esign.cn/v3/flow', method: 'GET', headers: {},
    })).rejects.toThrow('ESIGN_HTTP_TARGET_DENIED');
    await expect(client.request({
      url: 'https://openapi.esign.cn:8443/v3/flow', method: 'GET', headers: {},
    })).rejects.toThrow('ESIGN_HTTP_TARGET_DENIED');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('官方 OpenAPI 请求禁止跳转并限制 JSON 响应', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"code":0}', {
      status: 200,
      headers: { 'content-type': 'application/json', 'x-request-id': 'request-001' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const body = Buffer.from('{"input":1}');
    const response = await new FetchESignHttpClient().request({
      url: 'https://openapi.esign.cn/v3/sign-flow/create-by-file',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(response.status).toBe(200);
    expect(response.headers).toMatchObject({ 'x-request-id': 'request-001' });
    expect(response.body).toEqual(Buffer.from('{"code":0}'));
    const call = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(call[1]).toMatchObject({
      method: 'POST',
      body,
      redirect: 'error',
      signal: expect.any(AbortSignal) as AbortSignal,
    });
  });

  it('签署文件下载限制在 eSign HTTPS 域名且校验 PDF 魔数', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(Buffer.from('%PDF-1.7\nbody'), {
      status: 200, headers: { 'content-length': '13', 'content-type': 'application/pdf' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new FetchESignHttpClient();
    await expect(client.download(
      'https://esignoss.esign.cn/private/file.pdf?Signature=secret',
    )).resolves.toEqual(Buffer.from('%PDF-1.7\nbody'));
    await expect(client.download('https://attacker.example/file.pdf'))
      .rejects.toThrow('ESIGN_DOWNLOAD_TARGET_DENIED');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('拒绝非 PDF 响应，防止错误页或恶意文件进入证据库', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>error</html>', {
      status: 200, headers: { 'content-length': '18', 'content-type': 'text/html' },
    })));
    await expect(new FetchESignHttpClient().download(
      'https://esignoss.esign.cn/private/file.pdf',
    )).rejects.toThrow('ESIGN_DOWNLOAD_NOT_PDF');
  });

  it('下载 HTTP 失败和声明超限均在读取正文前拒绝', async () => {
    const failed = vi.fn().mockResolvedValue(new Response('denied', { status: 403 }));
    vi.stubGlobal('fetch', failed);
    const client = new FetchESignHttpClient();
    await expect(client.download('https://esignoss.esign.cn/private/file.pdf'))
      .rejects.toThrow('ESIGN_DOWNLOAD_FAILED');

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, {
      status: 200,
      headers: { 'content-length': String(50 * 1024 * 1024 + 1) },
    })));
    await expect(client.download('https://esignoss.esign.cn/private/file.pdf'))
      .rejects.toThrow('ESIGN_DOWNLOAD_TOO_LARGE');
  });

  it('网络异常统一为稳定不可用错误', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('包含底层敏感详情')));
    const client = new FetchESignHttpClient();
    await expect(client.request({
      url: 'https://smlopenapi.esign.cn/v3/sign-flow/flow-001/detail',
      method: 'GET',
      headers: {},
    })).rejects.toEqual(new Error('ESIGN_HTTP_UNAVAILABLE'));
  });

  it('请求超过受控时限会主动中止并返回稳定错误', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockImplementation(
      (_url: URL, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      }),
    ));
    const pending = new FetchESignHttpClient().request({
      url: 'https://openapi.esign.cn/v3/sign-flow/flow-001/detail',
      method: 'GET',
      headers: {},
    });
    const assertion = expect(pending).rejects.toEqual(new Error('ESIGN_HTTP_UNAVAILABLE'));
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
  });

  it('空响应正文返回空 Buffer，调用方再执行协议结构校验', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    await expect(new FetchESignHttpClient().request({
      url: 'https://openapi.esign.cn/v3/sign-flow/flow-001/detail',
      method: 'GET',
      headers: {},
    })).resolves.toMatchObject({ body: Buffer.alloc(0) });
  });
});
