import { createHash } from 'node:crypto';

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
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const receiptSchema = z.object({
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
    if (!HASH.test(input.expectedChecksum)) throw new Error('DATA_MIGRATION_ATTACHMENT_HASH_INVALID');
    const endpoint = this.config.get('DATA_MIGRATION_ATTACHMENT_GATEWAY_ENDPOINT', { infer: true });
    const token = this.config.get(
      'DATA_MIGRATION_ATTACHMENT_GATEWAY_BEARER_TOKEN', { infer: true },
    );
    if (endpoint === undefined || token === undefined) {
      throw new Error('DATA_MIGRATION_ATTACHMENT_GATEWAY_UNAVAILABLE');
    }
    const response = await safeFetch(safeEndpoint(endpoint), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(120_000),
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json', 'cache-control': 'no-store',
        'content-type': 'application/json',
        'idempotency-key': digest([
          input.tenantId, input.runId, input.sourceSystem,
          input.sourceAttachmentId, input.expectedChecksum,
          input.classification,
        ]),
      },
      body: JSON.stringify({
        schemaVersion: 'erp-data-migration-attachment.v1',
        tenantId: input.tenantId,
        runId: input.runId,
        sourceSystem: input.sourceSystem,
        sourceAttachmentId: input.sourceAttachmentId,
        expectedChecksum: input.expectedChecksum,
        classification: input.classification,
        retentionDays: input.retentionDays,
      }),
    });
    const parsed = receiptSchema.safeParse(await readJson(response));
    if (!parsed.success || parsed.data.checksum !== input.expectedChecksum ||
      parsed.data.retentionDays < input.retentionDays ||
      parsed.data.classification !== input.classification) {
      throw new Error('DATA_MIGRATION_ATTACHMENT_RECEIPT_INVALID');
    }
    return Object.freeze(parsed.data);
  }
}

function safeEndpoint(value: string): string {
  const endpoint = new URL(value);
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
  if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
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
