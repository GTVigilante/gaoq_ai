import { createHash, createHmac } from 'node:crypto';

import { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';

import type { AppEnvironment } from '../../config/environment.js';
import { ESignCnAdapter, signESignRequest } from './esign.adapter.js';
import {
  ESignHttpClient,
  type ESignHttpRequest,
  type ESignHttpResponse,
} from './esign-http.client.js';

const CREDENTIAL = { appId: 'app12345', appSecret: 'test-only-app-secret' };

class StubHttpClient extends ESignHttpClient {
  readonly requests: ESignHttpRequest[] = [];
  readonly downloads: string[] = [];
  response: ESignHttpResponse = {
    status: 200, headers: {}, body: Buffer.from('{"code":0,"data":{"signFlowStatus":2}}'),
  };

  override request(request: ESignHttpRequest): Promise<ESignHttpResponse> {
    this.requests.push(request);
    return Promise.resolve(this.response);
  }

  override download(url: string): Promise<Buffer> {
    this.downloads.push(url);
    return Promise.resolve(Buffer.from('%PDF-1.7'));
  }
}

function fixture() {
  const http = new StubHttpClient();
  const adapter = new ESignCnAdapter(new ConfigService<AppEnvironment, true>({
    ESIGN_API_BASE_URL: 'https://smlopenapi.esign.cn',
  } as AppEnvironment), http);
  return { adapter, http };
}

describe('signESignRequest', () => {
  it('严格按官方七段式字符串计算 Content-MD5 和 HmacSHA256', () => {
    const body = Buffer.from('{"urlAvailableDate":300}', 'utf8');
    const headers = signESignRequest(
      CREDENTIAL, 'POST', '/v3/sign-flow/flow-001/file-download-url', body, 1_784_620_800_000,
    );
    const md5 = createHash('md5').update(body).digest('base64');
    const canonical = [
      'POST', '*/*', md5, 'application/json', '',
      '/v3/sign-flow/flow-001/file-download-url',
    ].join('\n');
    expect(headers).toMatchObject({
      'X-Tsign-Open-App-Id': 'app12345', 'X-Tsign-Open-Auth-Mode': 'Signature',
      'X-Tsign-Open-Ca-Timestamp': '1784620800000', 'Content-MD5': md5,
      'X-Tsign-Open-Ca-Signature': createHmac('sha256', CREDENTIAL.appSecret)
        .update(canonical).digest('base64'),
    });
    expect(JSON.stringify(headers)).not.toContain(CREDENTIAL.appSecret);
  });
});

describe('ESignCnAdapter', () => {
  it('查询流程只依赖 code 和结构化状态', async () => {
    const { adapter, http } = fixture();
    await expect(adapter.getFlow(CREDENTIAL, 'flow-001')).resolves.toBe(2);
    expect(http.requests[0]).toMatchObject({
      method: 'GET', url: 'https://smlopenapi.esign.cn/v3/sign-flow/flow-001/detail',
    });
    expect(http.requests[0]?.headers['X-Tsign-Open-Ca-Signature']).toBeTruthy();
  });

  it('获取短时下载地址、下载 PDF 并将验签响应压缩为安全证据', async () => {
    const { adapter, http } = fixture();
    http.response = { status: 200, headers: {}, body: Buffer.from(JSON.stringify({
      code: 0, message: '成功', data: { files: [{
        fileId: 'file-001', fileName: '候选人姓名.pdf',
        downloadUrl: 'https://esignoss.esign.cn/private/file.pdf?Signature=secret',
      }] },
    })) };
    const files = await adapter.listSignedFiles(CREDENTIAL, 'flow-001');
    expect(files).toHaveLength(1);
    expect(JSON.stringify(files)).not.toContain('候选人姓名');
    await expect(adapter.downloadSignedFile(files[0]!)).resolves.toEqual(Buffer.from('%PDF-1.7'));

    http.response = { status: 200, headers: {}, body: Buffer.from(JSON.stringify({
      code: 0, data: { signInfos: [
        { cert: { certOwner: '候选人姓名', certBase64: 'sensitive' }, signature: { modify: false } },
      ] },
    })) };
    const verification = await adapter.verifySignedFile(
      CREDENTIAL, 'flow-001', 'file-001',
    );
    expect(verification).toMatchObject({ valid: true, signatureCount: 1 });
    expect(verification.providerResultDigest).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(verification)).not.toMatch(/候选人|sensitive/u);
  });

  it('供应商 message 不参与分支也不进入错误', async () => {
    const { adapter, http } = fixture();
    http.response = { status: 200, headers: {}, body: Buffer.from(JSON.stringify({
      code: 123456, message: '包含供应商敏感详情', data: null,
    })) };
    const error = await adapter.getFlow(CREDENTIAL, 'flow-001').catch((caught: unknown) => caught);
    expect(error).toEqual(new Error('ESIGN_API_BUSINESS_FAILED'));
    expect(JSON.stringify(error)).not.toContain('敏感详情');
  });
});
