import { BadGatewayException, Injectable } from '@nestjs/common';
import { z } from 'zod';

const MAX_RESPONSE_BYTES = 256 * 1024;

export interface SsoHttpRequest {
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: Readonly<Record<string, string>>;
}

/** 固定上游地址的最小 HTTP 端口，便于契约测试且不暴露平台令牌。 */
export abstract class SsoHttpClient {
  abstract getJson(request: SsoHttpRequest): Promise<unknown>;
  abstract postJson(request: SsoHttpRequest): Promise<unknown>;
}

@Injectable()
export class FetchSsoHttpClient extends SsoHttpClient {
  override getJson(request: SsoHttpRequest): Promise<unknown> {
    return this.request('GET', request);
  }

  override postJson(request: SsoHttpRequest): Promise<unknown> {
    return this.request('POST', request);
  }

  private async request(method: 'GET' | 'POST', request: SsoHttpRequest): Promise<unknown> {
    try {
      const response = await fetch(request.url, {
        method,
        headers: {
          accept: 'application/json',
          ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...request.headers,
        },
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        redirect: 'error',
        signal: AbortSignal.timeout(5_000),
      });
      const contentLength = response.headers.get('content-length');
      if (
        !response.ok ||
        (contentLength !== null && z.coerce.number().parse(contentLength) > MAX_RESPONSE_BYTES)
      ) {
        throw new Error(`上游响应异常：${response.status}`);
      }
      const text = await this.readBoundedBody(response);
      return JSON.parse(text) as unknown;
    } catch {
      throw new BadGatewayException({ code: 'SSO_UPSTREAM_ERROR', message: '身份提供者暂时不可用' });
    }
  }

  /** 对未声明 Content-Length 的身份提供者响应实施流式硬上限。 */
  private async readBoundedBody(response: Response): Promise<string> {
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error('上游响应为空');
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        const chunk: unknown = result.value;
        if (!(chunk instanceof Uint8Array)) throw new Error('上游响应块无效');
        totalBytes += chunk.byteLength;
        if (totalBytes > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          throw new Error('上游响应过大');
        }
        chunks.push(chunk);
      }
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks, totalBytes).toString('utf8');
  }
}
