import { Injectable } from '@nestjs/common';

const JSON_LIMIT_BYTES = 4 * 1024 * 1024;
const PDF_LIMIT_BYTES = 50 * 1024 * 1024;
const ESIGN_API_HOSTS = new Set(['openapi.esign.cn', 'smlopenapi.esign.cn']);

export interface ESignHttpRequest {
  readonly url: string;
  readonly method: 'GET' | 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: Buffer;
}

export interface ESignHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Buffer;
}

export abstract class ESignHttpClient {
  abstract request(request: ESignHttpRequest): Promise<ESignHttpResponse>;
  abstract download(url: string): Promise<Buffer>;
}

/** eSign 专用 HTTP 边界；域名白名单、禁止跳转并限制响应大小。 */
@Injectable()
export class FetchESignHttpClient extends ESignHttpClient {
  override async request(request: ESignHttpRequest): Promise<ESignHttpResponse> {
    const url = new URL(request.url);
    if (
      url.protocol !== 'https:' || !ESIGN_API_HOSTS.has(url.hostname) ||
      url.username !== '' || url.password !== '' || (url.port !== '' && url.port !== '443') ||
      !url.pathname.startsWith('/v3/')
    ) throw new Error('ESIGN_HTTP_TARGET_DENIED');
    const response = await this.fetchWithTimeout(url, {
      method: request.method, headers: request.headers,
      ...(request.body === undefined ? {} : { body: request.body }),
    }, 15_000);
    return Object.freeze({
      status: response.status,
      headers: Object.freeze(Object.fromEntries(response.headers.entries())),
      body: await readLimited(response, JSON_LIMIT_BYTES),
    });
  }

  override async download(rawUrl: string): Promise<Buffer> {
    const url = new URL(rawUrl);
    if (
      url.protocol !== 'https:' || !isESignDownloadHost(url.hostname) ||
      url.username !== '' || url.password !== '' || (url.port !== '' && url.port !== '443')
    ) throw new Error('ESIGN_DOWNLOAD_TARGET_DENIED');
    const response = await this.fetchWithTimeout(url, { method: 'GET' }, 30_000);
    if (!response.ok) throw new Error('ESIGN_DOWNLOAD_FAILED');
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > PDF_LIMIT_BYTES) {
      throw new Error('ESIGN_DOWNLOAD_TOO_LARGE');
    }
    const body = await readLimited(response, PDF_LIMIT_BYTES);
    if (body.length < 5 || body.subarray(0, 5).toString('ascii') !== '%PDF-') {
      throw new Error('ESIGN_DOWNLOAD_NOT_PDF');
    }
    return body;
  }

  private async fetchWithTimeout(
    url: URL,
    init: RequestInit,
    timeoutMs: number,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, redirect: 'error', signal: controller.signal });
    } catch {
      throw new Error('ESIGN_HTTP_UNAVAILABLE');
    } finally {
      clearTimeout(timeout);
    }
  }
}

function isESignDownloadHost(hostname: string): boolean {
  return hostname === 'esign.cn' || hostname.endsWith('.esign.cn');
}

async function readLimited(response: Response, maxBytes: number): Promise<Buffer> {
  if (response.body === null) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      const value = result.value as Uint8Array;
      total += value.byteLength;
      if (total > maxBytes) throw new Error('ESIGN_HTTP_RESPONSE_TOO_LARGE');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total);
  } finally {
    reader.releaseLock();
  }
}
