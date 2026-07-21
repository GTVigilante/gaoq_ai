import { afterEach, describe, expect, it, vi } from 'vitest';

import { FetchESignHttpClient } from './esign-http.client.js';

describe('FetchESignHttpClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
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
    expect(fetchMock).not.toHaveBeenCalled();
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
});
