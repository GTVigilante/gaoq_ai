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
      const text = await response.text();
      if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
        throw new Error('上游响应过大');
      }
      return JSON.parse(text) as unknown;
    } catch {
      throw new BadGatewayException({ code: 'SSO_UPSTREAM_ERROR', message: '身份提供者暂时不可用' });
    }
  }
}
