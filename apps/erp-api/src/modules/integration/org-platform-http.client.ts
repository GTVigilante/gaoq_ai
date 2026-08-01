import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { OrgPushError, type OrgPushFailureCategory } from './org-push.adapter.js';

const MAX_RESPONSE_BYTES = 256 * 1024;
const ALLOWED_ORIGINS = new Set([
  'https://api.dingtalk.com',
  'https://oapi.dingtalk.com',
  'https://open.feishu.cn',
]);

export type OrgPlatformHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface OrgPlatformHttpRequest {
  readonly origin: 'https://api.dingtalk.com' | 'https://oapi.dingtalk.com' | 'https://open.feishu.cn';
  readonly path: string;
  readonly method: OrgPlatformHttpMethod;
  readonly headers?: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>;
  /** 敏感查询参数仅供协议兼容，异常与日志均不得输出拼接后的 URL。 */
  readonly sensitiveQuery?: Readonly<Record<string, string>>;
  readonly body?: Readonly<Record<string, unknown>>;
}
export interface OrgPlatformHttpResponse {
  readonly status: number;
  readonly requestId: string | undefined;
  readonly body: unknown;
}

export abstract class OrgPlatformHttpClient {
  abstract request(input: OrgPlatformHttpRequest): Promise<OrgPlatformHttpResponse>;
}

/** 固定域名、限时、限响应体的上游 HTTP 客户端；从不记录 URL、Header、Body 或响应正文。 */
@Injectable()
export class FetchOrgPlatformHttpClient extends OrgPlatformHttpClient {
  override async request(input: OrgPlatformHttpRequest): Promise<OrgPlatformHttpResponse> {
    this.assertTarget(input);
    const url = new URL(input.path, input.origin);
    for (const [key, value] of Object.entries(input.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    for (const [key, value] of Object.entries(input.sensitiveQuery ?? {})) {
      url.searchParams.set(key, value);
    }
    let response: Response;
    try {
      response = await fetch(url, {
        method: input.method,
        headers: {
          accept: 'application/json',
          ...(input.body === undefined ? {} : { 'content-type': 'application/json; charset=utf-8' }),
          ...input.headers,
        },
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
        redirect: 'error',
        signal: AbortSignal.timeout(8_000),
      });
    } catch {
      throw new OrgPushError('ORG_PLATFORM_NETWORK_ERROR', 'retryable', '组织平台网络异常');
    }
    const requestId = response.headers.get('x-request-id')
      ?? response.headers.get('x-acs-request-id')
      ?? response.headers.get('x-tt-logid')
      ?? undefined;
    const contentLength = response.headers.get('content-length');
    if (
      contentLength !== null &&
      z.coerce.number().int().nonnegative().safeParse(contentLength).success &&
      Number(contentLength) > MAX_RESPONSE_BYTES
    ) {
      throw new OrgPushError('ORG_PLATFORM_RESPONSE_TOO_LARGE', 'retryable', '组织平台响应过大');
    }
    let text: string;
    try {
      text = await response.text();
    } catch {
      throw new OrgPushError('ORG_PLATFORM_RESPONSE_READ_ERROR', 'retryable', '组织平台响应读取失败');
    }
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
      throw new OrgPushError('ORG_PLATFORM_RESPONSE_TOO_LARGE', 'retryable', '组织平台响应过大');
    }
    let body: unknown = {};
    if (text.length > 0) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        throw new OrgPushError('ORG_PLATFORM_RESPONSE_INVALID', 'retryable', '组织平台响应格式无效');
      }
    }
    if (!response.ok) {
      throw new OrgPushError(
        `ORG_PLATFORM_HTTP_${response.status}`,
        this.classifyStatus(response.status),
        '组织平台调用失败',
        response.status,
        this.providerCode(body),
      );
    }
    return { status: response.status, requestId, body };
  }

  private assertTarget(input: OrgPlatformHttpRequest): void {
    if (!ALLOWED_ORIGINS.has(input.origin)) throw new Error('组织平台目标域名不在白名单');
    if (!input.path.startsWith('/') || input.path.startsWith('//') || input.path.includes('..')) {
      throw new Error('组织平台请求路径非法');
    }
    for (const key of Object.keys(input.headers ?? {})) {
      if (key.toLowerCase() === 'host' || key.toLowerCase() === 'content-length') {
        throw new Error('组织平台请求头非法');
      }
    }
  }

  private classifyStatus(status: number): OrgPushFailureCategory {
    if (status === 408 || status === 425 || status === 429 || status >= 500) return 'retryable';
    if (status === 409 || status === 412) return 'conflict';
    return 'business';
  }

  private providerCode(body: unknown): number | undefined {
    const parsed = z.object({
      code: z.number().int().optional(),
      errcode: z.number().int().optional(),
    }).passthrough().safeParse(body);
    if (!parsed.success) return undefined;
    return parsed.data.code ?? parsed.data.errcode;
  }
}
