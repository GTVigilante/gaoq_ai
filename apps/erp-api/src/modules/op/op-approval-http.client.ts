import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TextDecoder } from 'node:util';

import type { AppEnvironment } from '../../config/environment.js';

const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
const PATH = /^\/erp\/v1\/approval-results\/[A-Za-z0-9._:-]{8,128}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REQUIRED_HEADERS = new Set([
  'content-type',
  'x-gaoq-erp-client-id',
  'x-gaoq-erp-external-tenant-id',
  'x-gaoq-erp-timestamp',
  'x-gaoq-erp-nonce',
  'x-gaoq-erp-idempotency-key',
  'x-gaoq-erp-signature-algorithm',
  'x-gaoq-erp-signature',
]);
const JSON_CONTENT_TYPE =
  /^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json(?:\s*;\s*charset=utf-8)?$/i;

export type OpApprovalFailureCategory = 'retryable' | 'business' | 'conflict';

export class OpApprovalDeliveryError extends Error {
  constructor(
    readonly code: string,
    readonly category: OpApprovalFailureCategory,
    message: string,
    readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'OpApprovalDeliveryError';
  }
}

export interface OpApprovalHttpRequest {
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface OpApprovalHttpResponse {
  readonly status: number;
  readonly requestId: string | undefined;
  readonly body: unknown;
}

export abstract class OpApprovalHttpClient {
  abstract put(input: OpApprovalHttpRequest): Promise<OpApprovalHttpResponse>;
}

/** ERP→OP 审批结果专用传输；固定根域、固定路径、禁重定向并限响应体。 */
@Injectable()
export class FetchOpApprovalHttpClient extends OpApprovalHttpClient {
  constructor(private readonly config: ConfigService<AppEnvironment, true>) {
    super();
  }

  override async put(input: OpApprovalHttpRequest): Promise<OpApprovalHttpResponse> {
    if (!PATH.test(input.path) || input.path.includes('..')) {
      throw new OpApprovalDeliveryError('OP_APPROVAL_PATH_INVALID', 'business', 'OP 审批结果路径非法');
    }
    const headers = normalizeRequestHeaders(input.headers);
    assertRequestBody(input.body);
    const base = this.config.get('OP_API_BASE_URL', { infer: true });
    if (base === undefined) throw new OpApprovalDeliveryError(
      'OP_API_UNAVAILABLE', 'retryable', 'OP API 暂不可用',
    );
    let configured: URL;
    try {
      configured = new URL(base);
    } catch {
      throw new OpApprovalDeliveryError(
        'OP_APPROVAL_BASE_URL_INVALID', 'business', 'OP API 根地址不安全',
      );
    }
    if (
      configured.protocol !== 'https:' || configured.hostname.length === 0 ||
      configured.pathname !== '/' ||
      configured.username !== '' || configured.password !== '' ||
      configured.search !== '' || configured.hash !== '' ||
      (configured.port !== '' && configured.port !== '443')
    ) throw new OpApprovalDeliveryError(
      'OP_APPROVAL_BASE_URL_INVALID', 'business', 'OP API 根地址不安全',
    );
    const url = new URL(input.path, configured);
    if (url.origin !== configured.origin || url.search !== '' || url.hash !== '') {
      throw new OpApprovalDeliveryError(
        'OP_APPROVAL_TARGET_INVALID', 'business', 'OP 审批结果目标非法',
      );
    }
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'PUT', headers: { accept: 'application/json', ...headers }, body: input.body,
        redirect: 'error', signal: AbortSignal.timeout(8_000),
      });
    } catch {
      throw new OpApprovalDeliveryError(
        'OP_APPROVAL_NETWORK_ERROR', 'retryable', 'OP 审批结果网络异常',
      );
    }
    const contentLength = response.headers.get('content-length');
    if (contentLength !== null && !/^\d+$/.test(contentLength)) {
      throw new OpApprovalDeliveryError(
        'OP_APPROVAL_RESPONSE_LENGTH_INVALID', 'retryable', 'OP 审批结果响应长度无效',
      );
    }
    if (
      contentLength !== null &&
      (!Number.isSafeInteger(Number(contentLength)) || Number(contentLength) > MAX_RESPONSE_BYTES)
    ) {
      throw new OpApprovalDeliveryError(
        'OP_APPROVAL_RESPONSE_TOO_LARGE', 'retryable', 'OP 审批结果响应过大',
      );
    }
    const text = await this.readBoundedBody(response);
    if (!response.ok) throw new OpApprovalDeliveryError(
      `OP_APPROVAL_HTTP_${response.status}`, this.classify(response.status),
      'OP 审批结果调用失败', response.status,
    );
    let body: unknown = {};
    if (text.length > 0) {
      if (!isJsonContentType(response.headers.get('content-type'))) {
        throw new OpApprovalDeliveryError(
          'OP_APPROVAL_RESPONSE_CONTENT_TYPE_INVALID',
          'retryable',
          'OP 审批结果响应类型无效',
        );
      }
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        throw new OpApprovalDeliveryError(
          'OP_APPROVAL_RESPONSE_INVALID', 'retryable', 'OP 审批结果响应格式无效',
        );
      }
    }
    return {
      status: response.status,
      requestId: normalizeRequestId(response.headers.get('x-request-id')),
      body,
    };
  }

  private async readBoundedBody(response: Response): Promise<string> {
    const reader = response.body?.getReader();
    if (reader === undefined) return '';
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        const chunk: unknown = result.value;
        if (!(chunk instanceof Uint8Array)) throw new Error('OP_APPROVAL_CHUNK_INVALID');
        total += chunk.byteLength;
        if (total > MAX_RESPONSE_BYTES) {
          cancelReader(reader);
          throw new OpApprovalDeliveryError(
            'OP_APPROVAL_RESPONSE_TOO_LARGE', 'retryable', 'OP 审批结果响应过大',
          );
        }
        chunks.push(chunk);
      }
    } catch (error) {
      if (error instanceof OpApprovalDeliveryError) throw error;
      cancelReader(reader);
      throw new OpApprovalDeliveryError(
        'OP_APPROVAL_RESPONSE_READ_ERROR', 'retryable', 'OP 审批结果响应读取失败',
      );
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // 读取器清理失败不能覆盖稳定的连接器结果。
      }
    }
    const bytes = Buffer.concat(chunks, total);
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new OpApprovalDeliveryError(
        'OP_APPROVAL_RESPONSE_INVALID', 'retryable', 'OP 审批结果响应格式无效',
      );
    }
  }

  private classify(status: number): OpApprovalFailureCategory {
    if (status === 408 || status === 425 || status === 429 || status >= 500) return 'retryable';
    if (status === 409 || status === 412) return 'conflict';
    return 'business';
  }
}

function normalizeRequestHeaders(
  input: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const entries = Object.entries(input);
  if (entries.length !== REQUIRED_HEADERS.size) throw invalidHeader();
  const normalized: Record<string, string> = {};
  for (const [rawName, value] of entries) {
    const name = rawName.toLowerCase();
    if (
      !REQUIRED_HEADERS.has(name) ||
      normalized[name] !== undefined ||
      value.length === 0 ||
      value.length > 2_048 ||
      containsControlCharacter(value)
    ) throw invalidHeader();
    normalized[name] = value;
  }
  if (
    normalized['content-type']?.toLowerCase() !== 'application/json; charset=utf-8' ||
    !IDENTIFIER.test(normalized['x-gaoq-erp-client-id'] ?? '') ||
    !IDENTIFIER.test(normalized['x-gaoq-erp-external-tenant-id'] ?? '') ||
    !/^\d{13}$/.test(normalized['x-gaoq-erp-timestamp'] ?? '') ||
    !/^[A-Za-z0-9_-]{22}$/.test(normalized['x-gaoq-erp-nonce'] ?? '') ||
    !IDENTIFIER.test(normalized['x-gaoq-erp-idempotency-key'] ?? '') ||
    normalized['x-gaoq-erp-signature-algorithm'] !== 'hmac-sha256' ||
    !/^[a-f0-9]{64}$/.test(normalized['x-gaoq-erp-signature'] ?? '')
  ) throw invalidHeader();
  return normalized;
}

function assertRequestBody(body: string): void {
  const bytes = Buffer.byteLength(body, 'utf8');
  if (bytes < 2 || bytes > MAX_REQUEST_BYTES) throw invalidRequest();
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw invalidRequest();
    }
  } catch (error) {
    if (error instanceof OpApprovalDeliveryError) throw error;
    throw invalidRequest();
  }
}

function invalidHeader(): OpApprovalDeliveryError {
  return new OpApprovalDeliveryError(
    'OP_APPROVAL_HEADER_INVALID', 'business', 'OP 审批结果 Header 非法',
  );
}

function invalidRequest(): OpApprovalDeliveryError {
  return new OpApprovalDeliveryError(
    'OP_APPROVAL_REQUEST_INVALID', 'business', 'OP 审批结果请求非法',
  );
}

function isJsonContentType(value: string | null): boolean {
  return value !== null && JSON_CONTENT_TYPE.test(value.trim());
}

function normalizeRequestId(value: string | null): string | undefined {
  if (value === null || value.length === 0 || value.length > 128) return undefined;
  return [...value].every((character) => {
    const code = character.charCodeAt(0);
    return code >= 33 && code <= 126;
  }) ? value : undefined;
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  void reader.cancel().catch(() => {
    // 取消失败不能覆盖稳定的连接器错误。
  });
}
