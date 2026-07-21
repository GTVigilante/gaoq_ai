import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';

import type { AppEnvironment } from '../../config/environment.js';

const MAX_RESPONSE_BYTES = 256 * 1024;
const PATH = /^\/erp\/v1\/approval-results\/[A-Za-z0-9._:-]{8,128}$/;

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
    const base = this.config.get('OP_API_BASE_URL', { infer: true });
    if (base === undefined) throw new OpApprovalDeliveryError(
      'OP_API_UNAVAILABLE', 'retryable', 'OP API 暂不可用',
    );
    const configured = new URL(base);
    if (
      configured.protocol !== 'https:' || configured.pathname !== '/' ||
      configured.username !== '' || configured.password !== '' ||
      configured.search !== '' || configured.hash !== '' ||
      (configured.port !== '' && configured.port !== '443')
    ) throw new OpApprovalDeliveryError(
      'OP_APPROVAL_BASE_URL_INVALID', 'business', 'OP API 根地址不安全',
    );
    for (const header of Object.keys(input.headers)) {
      if (['host', 'content-length', 'transfer-encoding'].includes(header.toLowerCase())) {
        throw new OpApprovalDeliveryError(
          'OP_APPROVAL_HEADER_INVALID', 'business', 'OP 审批结果 Header 非法',
        );
      }
    }
    const url = new URL(input.path, configured);
    if (url.origin !== configured.origin || url.search !== '' || url.hash !== '') {
      throw new OpApprovalDeliveryError(
        'OP_APPROVAL_TARGET_INVALID', 'business', 'OP 审批结果目标非法',
      );
    }
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'PUT', headers: { accept: 'application/json', ...input.headers }, body: input.body,
        redirect: 'error', signal: AbortSignal.timeout(8_000),
      });
    } catch (error) {
      throw new OpApprovalDeliveryError(
        'OP_APPROVAL_NETWORK_ERROR', 'retryable', 'OP 审批结果网络异常', undefined,
        { cause: error },
      );
    }
    const contentLength = response.headers.get('content-length');
    if (contentLength !== null && z.coerce.number().int().nonnegative()
      .safeParse(contentLength).success && Number(contentLength) > MAX_RESPONSE_BYTES) {
      throw new OpApprovalDeliveryError(
        'OP_APPROVAL_RESPONSE_TOO_LARGE', 'retryable', 'OP 审批结果响应过大',
      );
    }
    const text = await this.readBoundedBody(response);
    let body: unknown = {};
    if (text.length > 0) {
      try {
        body = JSON.parse(text) as unknown;
      } catch (error) {
        throw new OpApprovalDeliveryError(
          'OP_APPROVAL_RESPONSE_INVALID', 'retryable', 'OP 审批结果响应格式无效',
          undefined, { cause: error },
        );
      }
    }
    if (!response.ok) throw new OpApprovalDeliveryError(
      `OP_APPROVAL_HTTP_${response.status}`, this.classify(response.status),
      'OP 审批结果调用失败', response.status,
    );
    return {
      status: response.status,
      requestId: response.headers.get('x-request-id') ?? undefined,
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
          await reader.cancel();
          throw new OpApprovalDeliveryError(
            'OP_APPROVAL_RESPONSE_TOO_LARGE', 'retryable', 'OP 审批结果响应过大',
          );
        }
        chunks.push(chunk);
      }
    } catch (error) {
      if (error instanceof OpApprovalDeliveryError) throw error;
      throw new OpApprovalDeliveryError(
        'OP_APPROVAL_RESPONSE_READ_ERROR', 'retryable', 'OP 审批结果响应读取失败',
        undefined, { cause: error },
      );
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks, total).toString('utf8');
  }

  private classify(status: number): OpApprovalFailureCategory {
    if (status === 408 || status === 425 || status === 429 || status >= 500) return 'retryable';
    if (status === 409 || status === 412) return 'conflict';
    return 'business';
  }
}
