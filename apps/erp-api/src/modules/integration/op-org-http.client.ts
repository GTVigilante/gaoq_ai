import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';

import type { AppEnvironment } from '../../config/environment.js';
import { OrgPushError, type OrgPushFailureCategory } from './org-push.adapter.js';

const MAX_RESPONSE_BYTES = 256 * 1024;
const PATH = /^\/erp\/v1\/org\/(?:snapshot|departments\/[A-Za-z0-9._:-]{1,128}|employees\/[A-Za-z0-9._:-]{1,128})$/;

export interface OpOrgHttpRequest {
  readonly method: 'GET' | 'PUT';
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}

export interface OpOrgHttpResponse {
  readonly status: number;
  readonly requestId: string | undefined;
  readonly body: unknown;
}

export abstract class OpOrgHttpClient {
  abstract request(input: OpOrgHttpRequest): Promise<OpOrgHttpResponse>;
}

/** ERP→OP 专用 HTTP 客户端；固定配置根域、原始签名字节、限时和限响应体。 */
@Injectable()
export class FetchOpOrgHttpClient extends OpOrgHttpClient {
  constructor(private readonly config: ConfigService<AppEnvironment, true>) {
    super();
  }

  override async request(input: OpOrgHttpRequest): Promise<OpOrgHttpResponse> {
    if (!PATH.test(input.path) || input.path.includes('..')) {
      throw new Error('OP_ORG_PATH_INVALID');
    }
    const base = this.config.get('OP_API_BASE_URL', { infer: true });
    if (base === undefined) {
      throw new OrgPushError('OP_API_UNAVAILABLE', 'retryable', 'OP 组织 API 暂不可用');
    }
    const configured = new URL(base);
    if (
      configured.protocol !== 'https:' || configured.pathname !== '/' ||
      configured.username !== '' || configured.password !== '' ||
      configured.search !== '' || configured.hash !== '' ||
      (configured.port !== '' && configured.port !== '443')
    ) throw new Error('OP_ORG_BASE_URL_INVALID');
    for (const header of Object.keys(input.headers)) {
      if (['host', 'content-length', 'transfer-encoding'].includes(header.toLowerCase())) {
        throw new Error('OP_ORG_HEADER_INVALID');
      }
    }
    const url = new URL(input.path, base);
    if (url.origin !== configured.origin || url.search !== '' || url.hash !== '') {
      throw new Error('OP_ORG_TARGET_INVALID');
    }
    let response: Response;
    try {
      response = await fetch(url, {
        method: input.method,
        headers: { accept: 'application/json', ...input.headers },
        ...(input.body === undefined ? {} : { body: input.body }),
        redirect: 'error',
        signal: AbortSignal.timeout(8_000),
      });
    } catch (error) {
      throw new OrgPushError(
        'OP_ORG_NETWORK_ERROR', 'retryable', 'OP 组织 API 网络异常', undefined, undefined,
        { cause: error },
      );
    }
    const contentLength = response.headers.get('content-length');
    if (contentLength !== null && z.coerce.number().int().nonnegative()
      .safeParse(contentLength).success && Number(contentLength) > MAX_RESPONSE_BYTES) {
      throw new OrgPushError('OP_ORG_RESPONSE_TOO_LARGE', 'retryable', 'OP 组织响应过大');
    }
    const text = await this.readBoundedBody(response);
    let body: unknown = {};
    if (text.length > 0) {
      try {
        body = JSON.parse(text) as unknown;
      } catch (error) {
        throw new OrgPushError(
          'OP_ORG_RESPONSE_INVALID', 'retryable', 'OP 组织响应格式无效',
          undefined, undefined, { cause: error },
        );
      }
    }
    if (!response.ok) {
      throw new OrgPushError(
        `OP_ORG_HTTP_${response.status}`, this.classify(response.status),
        'OP 组织 API 调用失败', response.status,
      );
    }
    return {
      status: response.status,
      requestId: response.headers.get('x-request-id') ?? undefined,
      body,
    };
  }

  private classify(status: number): OrgPushFailureCategory {
    if (status === 408 || status === 425 || status === 429 || status >= 500) return 'retryable';
    if (status === 409 || status === 412) return 'conflict';
    return 'business';
  }

  /** 即使对端省略 Content-Length，也在读取阶段实施硬上限。 */
  private async readBoundedBody(response: Response): Promise<string> {
    const reader = response.body?.getReader();
    if (reader === undefined) return '';
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        const chunk: unknown = result.value;
        if (!(chunk instanceof Uint8Array)) throw new Error('OP_ORG_RESPONSE_CHUNK_INVALID');
        totalBytes += chunk.byteLength;
        if (totalBytes > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          throw new OrgPushError('OP_ORG_RESPONSE_TOO_LARGE', 'retryable', 'OP 组织响应过大');
        }
        chunks.push(chunk);
      }
    } catch (error) {
      if (error instanceof OrgPushError) throw error;
      throw new OrgPushError(
        'OP_ORG_RESPONSE_READ_ERROR', 'retryable', 'OP 组织响应读取失败',
        undefined, undefined, { cause: error },
      );
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks, totalBytes).toString('utf8');
  }
}
