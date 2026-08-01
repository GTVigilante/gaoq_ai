import { createHash } from 'node:crypto';

import { ULID_PATTERN } from '@gaoq/shared-utils';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';

import type { AppEnvironment } from '../../../config/environment.js';
import {
  DataMigrationAttachmentGateway,
  type DataMigrationAttachmentReceipt,
} from './data-migration-attachment.ports.js';

const RESPONSE_LIMIT_BYTES = 16 * 1024;
const HASH = /^[A-Za-z0-9_-]{43}$/;
const TENANT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const BEARER_TOKEN = /^[\x21-\x7E]{32,512}$/;
const CONTENT_LENGTH = /^(?:0|[1-9]\d{0,5})$/;
const CONTENT_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/i;
const transferInputSchema = z.object({
  tenantId: z.string().regex(TENANT_ID),
  runId: z.string().regex(ULID_PATTERN),
  sourceSystem: z.string().regex(SOURCE_ID),
  sourceAttachmentId: z.string().regex(SOURCE_ID),
  expectedChecksum: z.string().regex(HASH),
  retentionDays: z.number().int().min(2_555).max(36_500),
  classification: z.enum(['L3', 'L4']),
}).strict();
const receiptSchema = z.object({
  schemaVersion: z.literal('erp-data-migration-attachment-receipt.v1'),
  tenantId: z.string().regex(TENANT_ID),
  runId: z.string().regex(ULID_PATTERN),
  sourceSystem: z.string().regex(SOURCE_ID),
  sourceAttachmentId: z.string().regex(SOURCE_ID),
  targetEvidenceId: z.string().regex(SAFE_ID),
  malwareScanEvidenceId: z.string().regex(SAFE_ID),
  checksum: z.string().regex(HASH),
  immutable: z.literal(true),
  malwareClean: z.literal(true),
  retentionDays: z.number().int().min(2_555).max(36_500),
  classification: z.enum(['L3', 'L4']),
}).strict();

/** 隔离附件网关 Adapter：ERP 永不接收附件正文或来源系统凭据。 */
@Injectable()
export class HttpDataMigrationAttachmentGateway extends DataMigrationAttachmentGateway {
  constructor(private readonly config: ConfigService<AppEnvironment, true>) { super(); }

  override async transfer(input: {
    readonly tenantId: string;
    readonly runId: string;
    readonly sourceSystem: string;
    readonly sourceAttachmentId: string;
    readonly expectedChecksum: string;
    readonly retentionDays: number;
    readonly classification: 'L3' | 'L4';
  }): Promise<DataMigrationAttachmentReceipt> {
    const parsedInput = transferInputSchema.safeParse(input);
    if (!parsedInput.success) throw new Error('DATA_MIGRATION_ATTACHMENT_COMMAND_INVALID');
    const command = parsedInput.data;
    const endpoint = this.config.get('DATA_MIGRATION_ATTACHMENT_GATEWAY_ENDPOINT', { infer: true });
    const token = this.config.get(
      'DATA_MIGRATION_ATTACHMENT_GATEWAY_BEARER_TOKEN', { infer: true },
    );
    if (endpoint === undefined || token === undefined || !BEARER_TOKEN.test(token)) {
      throw new Error('DATA_MIGRATION_ATTACHMENT_GATEWAY_UNAVAILABLE');
    }
    const idempotencyKey = digest([
      command.tenantId, command.runId, command.sourceSystem,
      command.sourceAttachmentId, command.expectedChecksum,
      command.classification, String(command.retentionDays),
    ]);
    const response = await safeFetch(safeEndpoint(endpoint), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(120_000),
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json', 'cache-control': 'no-store',
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey,
      },
      body: JSON.stringify({
        schemaVersion: 'erp-data-migration-attachment.v1',
        tenantId: command.tenantId,
        runId: command.runId,
        sourceSystem: command.sourceSystem,
        sourceAttachmentId: command.sourceAttachmentId,
        expectedChecksum: command.expectedChecksum,
        classification: command.classification,
        retentionDays: command.retentionDays,
      }),
    });
    const parsed = receiptSchema.safeParse(await readJson(response));
    if (
      !parsed.success ||
      parsed.data.tenantId !== command.tenantId ||
      parsed.data.runId !== command.runId ||
      parsed.data.sourceSystem !== command.sourceSystem ||
      parsed.data.sourceAttachmentId !== command.sourceAttachmentId ||
      parsed.data.checksum !== command.expectedChecksum ||
      parsed.data.retentionDays < command.retentionDays ||
      parsed.data.classification !== command.classification
    ) {
      throw new Error('DATA_MIGRATION_ATTACHMENT_RECEIPT_INVALID');
    }
    return Object.freeze(parsed.data);
  }
}

function safeEndpoint(value: string): string {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error('DATA_MIGRATION_ATTACHMENT_GATEWAY_ENDPOINT_INVALID');
  }
  if (
    endpoint.protocol !== 'https:' || endpoint.username !== '' || endpoint.password !== '' ||
    endpoint.search !== '' || endpoint.hash !== '' ||
    (endpoint.port !== '' && endpoint.port !== '443')
  ) throw new Error('DATA_MIGRATION_ATTACHMENT_GATEWAY_ENDPOINT_INVALID');
  return endpoint.toString();
}

async function safeFetch(endpoint: string, init: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(endpoint, init);
  } catch {
    throw new Error('DATA_MIGRATION_ATTACHMENT_GATEWAY_UNAVAILABLE');
  }
  if (!response.ok) throw new Error(`DATA_MIGRATION_ATTACHMENT_GATEWAY_HTTP_${response.status}`);
  const contentType = response.headers.get('content-type') ?? '';
  const contentEncoding = response.headers.get('content-encoding');
  const contentLength = response.headers.get('content-length');
  if (
    !CONTENT_TYPE.test(contentType) ||
    (contentEncoding !== null && contentEncoding.toLowerCase() !== 'identity') ||
    (contentLength !== null && (
      !CONTENT_LENGTH.test(contentLength) ||
      Number(contentLength) > RESPONSE_LIMIT_BYTES
    ))
  ) {
    throw new Error('DATA_MIGRATION_ATTACHMENT_RECEIPT_INVALID');
  }
  return response;
}

async function readJson(response: Response): Promise<unknown> {
  if (response.body === null) throw new Error('DATA_MIGRATION_ATTACHMENT_RECEIPT_INVALID');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      const value: unknown = part.value;
      if (!(value instanceof Uint8Array)) throw new Error('DATA_MIGRATION_ATTACHMENT_RECEIPT_INVALID');
      total += value.byteLength;
      if (total > RESPONSE_LIMIT_BYTES) throw new Error('DATA_MIGRATION_ATTACHMENT_RECEIPT_TOO_LARGE');
      chunks.push(value);
    }
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // 读取已失败；取消失败不能覆盖稳定领域错误。
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new Error('DATA_MIGRATION_ATTACHMENT_RECEIPT_INVALID');
  }
}

function digest(parts: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(parts), 'utf8').digest('base64url');
}
