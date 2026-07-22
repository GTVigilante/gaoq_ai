import { createHash } from 'node:crypto';

import type { ApplyDataMigrationRecordDto } from './data-migration.dto.js';

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('DATA_MIGRATION_CANONICAL_VALUE_INVALID');
  return encoded;
}

export function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64url');
}

export function roll(previous: string, sequence: number, factHash: string): string {
  return digest(`${previous}\n${sequence}:${factHash}`);
}

export function migrationSourceFactHash(input: ApplyDataMigrationRecordDto): string {
  return digest(canonicalJson({
    sourceRecordId: input.sourceRecordId,
    sourceVersion: input.sourceVersion,
    entityType: input.entityType,
    payloadHash: input.payloadHash,
    associationSourceIds: [...input.associationSourceIds].sort(),
    attachments: [...input.attachments]
      .map((item) => ({ sourceAttachmentId: item.sourceAttachmentId, checksum: item.checksum }))
      .sort((left, right) => left.sourceAttachmentId.localeCompare(right.sourceAttachmentId)),
  }));
}

export const EMPTY_MIGRATION_CHECKSUM = digest('');
export const dataMigrationChecksum = Object.freeze({
  canonicalJson,
  digest,
  roll,
  sourceFactHash: migrationSourceFactHash,
  empty: EMPTY_MIGRATION_CHECKSUM,
});
