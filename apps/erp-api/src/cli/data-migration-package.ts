import { createReadStream } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';

import { z } from 'zod';

import {
  canonicalJson,
  digest,
  EMPTY_MIGRATION_CHECKSUM,
  migrationSourceFactHash,
  roll,
} from '../modules/data-migration/data-migration-checksum.js';

const HASH = /^[A-Za-z0-9_-]{43}$/;
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_LINE_BYTES = 10 * 1024 * 1024;

const attachmentSchema = z.object({
  sourceAttachmentId: z.string().regex(SOURCE_ID),
  checksum: z.string().regex(HASH),
}).strict();

const recordSchema = z.object({
  sequence: z.number().int().min(1).max(10_000_000),
  sourceRecordId: z.string().regex(SOURCE_ID),
  sourceVersion: z.string().min(1).max(64),
  entityType: z.enum(['org.department', 'org.position', 'org.job_level', 'org.employee']),
  payload: z.record(z.string(), z.unknown()),
  payloadHash: z.string().regex(HASH),
  associationSourceIds: z.array(z.string().regex(SOURCE_ID)).max(100),
  attachments: z.array(attachmentSchema).max(20),
}).strict().superRefine((record, context) => {
  if (new Set(record.associationSourceIds).size !== record.associationSourceIds.length) {
    context.addIssue({ code: 'custom', message: '关联来源标识重复' });
  }
  const attachmentIds = record.attachments.map((item) => item.sourceAttachmentId);
  if (new Set(attachmentIds).size !== attachmentIds.length) {
    context.addIssue({ code: 'custom', message: '附件来源标识重复' });
  }
});

const manifestSchema = z.object({
  formatVersion: z.literal(1),
  sourceSystem: z.string().regex(SOURCE_ID),
  sourceRunId: z.string().regex(SOURCE_ID),
  mode: z.enum(['full', 'incremental']),
  scope: z.enum(['org_reference', 'org_workforce']),
  expectedSourceCount: z.number().int().min(0).max(10_000_000),
  expectedSourceChecksum: z.string().regex(HASH),
}).strict();

export type MigrationPackageManifest = z.infer<typeof manifestSchema>;
export type MigrationPackageRecord = z.infer<typeof recordSchema>;

export interface ValidatedMigrationPackage {
  readonly directory: string;
  readonly manifest: MigrationPackageManifest;
  readonly recordCount: number;
  readonly sourceChecksum: string;
}

export async function validateMigrationPackage(
  packageDirectory: string,
): Promise<ValidatedMigrationPackage> {
  const directory = await realpath(packageDirectory);
  const manifestPath = await containedFile(directory, 'manifest.json');
  const recordsPath = await containedFile(directory, 'records.ndjson');
  const manifest = await readManifest(manifestPath);
  let expectedSequence = 1;
  let sourceChecksum = EMPTY_MIGRATION_CHECKSUM;
  const sourceRecordIds = new Set<string>();

  for await (const record of readMigrationRecords(recordsPath)) {
    if (record.sequence !== expectedSequence) throw packageError('SEQUENCE_GAP');
    if (sourceRecordIds.has(record.sourceRecordId)) throw packageError('SOURCE_RECORD_DUPLICATE');
    sourceRecordIds.add(record.sourceRecordId);
    if (digest(canonicalJson(record.payload)) !== record.payloadHash) {
      throw packageError('PAYLOAD_HASH_MISMATCH');
    }
    assertRecordScope(manifest.scope, record.entityType);
    sourceChecksum = roll(sourceChecksum, record.sequence, migrationSourceFactHash(record));
    expectedSequence += 1;
  }

  const recordCount = expectedSequence - 1;
  if (recordCount !== manifest.expectedSourceCount) throw packageError('SOURCE_COUNT_MISMATCH');
  if (sourceChecksum !== manifest.expectedSourceChecksum) {
    throw packageError('SOURCE_CHECKSUM_MISMATCH');
  }
  return Object.freeze({ directory, manifest, recordCount, sourceChecksum });
}

export async function applyMigrationPackage(
  packageDirectory: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<Readonly<Record<string, unknown>>> {
  const validated = await validateMigrationPackage(packageDirectory);
  const endpoint = requireEndpoint(environment.ERP_API_BASE_URL);
  const token = environment.ERP_MIGRATION_TOKEN;
  if (token === undefined || token.length < 20) throw packageError('TOKEN_REQUIRED');
  const headers = Object.freeze({
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  });
  const run = await requestJson(`${endpoint}/data-migrations/runs`, {
    method: 'POST', headers, body: JSON.stringify(withoutFormatVersion(validated.manifest)),
  });
  const runId = requiredString(run, 'id');
  const checkpoint = requiredInteger(run, 'checkpoint');
  if (checkpoint < 0 || checkpoint > validated.recordCount) throw packageError('CHECKPOINT_INVALID');

  const recordsPath = await containedFile(validated.directory, 'records.ndjson');
  for await (const record of readMigrationRecords(recordsPath)) {
    if (record.sequence <= checkpoint) continue;
    await requestJson(`${endpoint}/data-migrations/runs/${encodeURIComponent(runId)}/records`, {
      method: 'POST', headers, body: JSON.stringify(record),
    });
  }
  return requestJson(`${endpoint}/data-migrations/runs/${encodeURIComponent(runId)}/complete`, {
    method: 'POST', headers, body: '{}',
  });
}

export async function exportMigrationEvidence(
  runId: string,
  environment: NodeJS.ProcessEnv = process.env,
  emit: (line: Readonly<Record<string, unknown>>) => void = (line) => {
    process.stdout.write(`${JSON.stringify(line)}\n`);
  },
): Promise<Readonly<Record<string, unknown>>> {
  if (!/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u.test(runId)) throw packageError('RUN_ID_INVALID');
  const endpoint = requireEndpoint(environment.ERP_API_BASE_URL);
  const token = environment.ERP_MIGRATION_TOKEN;
  if (token === undefined || token.length < 20) throw packageError('TOKEN_REQUIRED');
  const headers = Object.freeze({ authorization: `Bearer ${token}` });
  let artifactChecksum = EMPTY_MIGRATION_CHECKSUM;
  let artifactSequence = 0;
  const counts: Record<'items' | 'associations' | 'attachments', number> = {
    items: 0, associations: 0, attachments: 0,
  };
  const append = (line: Readonly<Record<string, unknown>>): void => {
    artifactSequence += 1;
    artifactChecksum = roll(artifactChecksum, artifactSequence, digest(canonicalJson(line)));
    emit(line);
  };
  const report = await requestJson(
    `${endpoint}/data-migrations/runs/${encodeURIComponent(runId)}/report`,
    { method: 'GET', headers },
  );
  append(Object.freeze({ recordType: 'report', data: report }));

  for (const kind of ['items', 'associations', 'attachments'] as const) {
    let cursor: string | null = null;
    do {
      const parameters = new URLSearchParams({ kind, limit: '500' });
      if (cursor !== null) parameters.set('cursor', cursor);
      const page = await requestJson(
        `${endpoint}/data-migrations/runs/${encodeURIComponent(runId)}/evidence?${parameters.toString()}`,
        { method: 'GET', headers },
      );
      const records = page.records;
      const nextCursor = page.nextCursor;
      const pageChecksum = page.pageChecksum;
      const checksumBody = {
        runId: page.runId, kind: page.kind, records, nextCursor,
      };
      if (page.runId !== runId || page.kind !== kind || !Array.isArray(records) ||
        (nextCursor !== null && typeof nextCursor !== 'string') ||
        typeof pageChecksum !== 'string' || digest(canonicalJson(checksumBody)) !== pageChecksum) {
        throw packageError('EVIDENCE_PAGE_INVALID');
      }
      const evidenceRecords = records as unknown[];
      for (const record of evidenceRecords) {
        if (typeof record !== 'object' || record === null || Array.isArray(record)) {
          throw packageError('EVIDENCE_PAGE_INVALID');
        }
        counts[kind] += 1;
        append(Object.freeze({ recordType: kind, data: record }));
      }
      cursor = nextCursor;
    } while (cursor !== null);
  }
  const reportCounts = report.counts;
  if (typeof reportCounts !== 'object' || reportCounts === null ||
    Array.isArray(reportCounts) ||
    counts.items !== controlTotal(reportCounts, 'applied') +
      controlTotal(reportCounts, 'duplicate') + controlTotal(reportCounts, 'rejected') ||
    counts.associations !== controlTotal(report, 'associationCount') ||
    counts.attachments !== controlTotal(report, 'attachmentCount')) {
    throw packageError('EVIDENCE_CONTROL_TOTAL_MISMATCH');
  }
  const seal = Object.freeze({
    recordType: 'seal', runId, recordCount: artifactSequence,
    counts: Object.freeze({ ...counts }), artifactChecksum,
  });
  emit(seal);
  return seal;
}

export async function* readMigrationRecords(
  recordsPath: string,
): AsyncGenerator<MigrationPackageRecord> {
  const lines = createInterface({
    input: createReadStream(recordsPath, { encoding: 'utf8' }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) throw packageError('LINE_TOO_LARGE');
    if (line.trim().length === 0) throw packageError('EMPTY_LINE');
    try {
      yield recordSchema.parse(JSON.parse(line));
    } catch {
      throw packageError(`RECORD_INVALID_AT_${lineNumber}`);
    }
  }
}

async function containedFile(directory: string, name: string): Promise<string> {
  const path = await realpath(resolve(directory, name));
  if (dirname(path) !== directory) throw packageError('PATH_ESCAPE');
  return path;
}

async function readManifest(path: string): Promise<MigrationPackageManifest> {
  try {
    return manifestSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  } catch {
    throw packageError('MANIFEST_INVALID');
  }
}

function assertRecordScope(
  scope: MigrationPackageManifest['scope'],
  entityType: MigrationPackageRecord['entityType'],
): void {
  const valid = scope === 'org_reference'
    ? ['org.department', 'org.position', 'org.job_level'].includes(entityType)
    : entityType === 'org.employee';
  if (!valid) throw packageError('ENTITY_OUT_OF_SCOPE');
}

function withoutFormatVersion(manifest: MigrationPackageManifest): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(manifest).filter(([key]) => key !== 'formatVersion'),
  );
}

function requireEndpoint(value: string | undefined): string {
  if (value === undefined) throw packageError('ENDPOINT_REQUIRED');
  const url = new URL(value);
  const local = url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname);
  if (url.protocol !== 'https:' && !local) throw packageError('ENDPOINT_TLS_REQUIRED');
  return url.toString().replace(/\/$/u, '');
}

async function requestJson(url: string, init: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw packageError('RESPONSE_INVALID');
  }
  if (!response.ok) {
    const code = typeof value === 'object' && value !== null &&
      typeof (value as { code?: unknown }).code === 'string'
      ? (value as { code: string }).code : `HTTP_${response.status}`;
    throw packageError(`REMOTE_${code}`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw packageError('RESPONSE_INVALID');
  }
  return value as Record<string, unknown>;
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const item = value[key];
  if (typeof item !== 'string') throw packageError('RESPONSE_INVALID');
  return item;
}

function requiredInteger(value: Record<string, unknown>, key: string): number {
  const item = value[key];
  if (!Number.isSafeInteger(item)) throw packageError('RESPONSE_INVALID');
  return Number(item);
}

function controlTotal(value: object, key: string): number {
  const item = (value as Record<string, unknown>)[key];
  if (!Number.isSafeInteger(item) || Number(item) < 0) {
    throw packageError('EVIDENCE_CONTROL_TOTAL_INVALID');
  }
  return Number(item);
}

function packageError(code: string): Error {
  return new Error(`DATA_MIGRATION_PACKAGE_${code}`);
}

async function main(): Promise<void> {
  const [command, target, ...rest] = process.argv.slice(2);
  if (!['validate', 'apply', 'evidence'].includes(command ?? '') || target === undefined ||
    rest.length !== 0) throw packageError('ARGUMENT_INVALID');
  if (command === 'validate') {
    const result = await validateMigrationPackage(target);
    process.stdout.write(`${JSON.stringify({
      valid: true, recordCount: result.recordCount, sourceChecksum: result.sourceChecksum,
      sourceRunId: result.manifest.sourceRunId, scope: result.manifest.scope,
    })}\n`);
    return;
  }
  if (command === 'evidence') {
    await exportMigrationEvidence(target);
    return;
  }
  const report = await applyMigrationPackage(target);
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  void main().catch((error: unknown) => {
    const code = error instanceof Error && /^DATA_MIGRATION_PACKAGE_[A-Z0-9_]{2,160}$/u.test(error.message)
      ? error.message : 'DATA_MIGRATION_PACKAGE_UNEXPECTED_FAILURE';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
