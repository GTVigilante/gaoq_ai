import { pathToFileURL } from 'node:url';

import { createConnection } from 'mongoose';

import { SupplierRelationshipRecordSchema } from '../modules/supplier/persistence/supplier.schemas.js';
import { SupplierMemberSchema } from '../modules/supplier/persistence/supplier-member.schema.js';
import { buildIndexManifestFromSchemas, runAdditiveIndexMigration } from './phase-3-indexes.js';

const MIGRATION_ID = 'phase-s1-supplier-indexes-v1';
const SCHEMAS = Object.freeze([SupplierRelationshipRecordSchema, SupplierMemberSchema]);

/** 供应方主档只追加索引迁移；禁止删除、重建或自动改写既有集合。 */
export function buildPhaseS1SupplierIndexManifest() {
  return buildIndexManifestFromSchemas(SCHEMAS);
}

export async function runPhaseS1SupplierIndexMigration(connection: Parameters<typeof runAdditiveIndexMigration>[0], dryRun: boolean) {
  return runAdditiveIndexMigration(connection, dryRun, { migrationId: MIGRATION_ID, manifest: buildPhaseS1SupplierIndexManifest() });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((argument) => argument !== '--');
  if (args.some((argument) => argument !== '--dry-run')) throw new Error('PHASE_S1_SUPPLIER_INDEX_ARGUMENT_INVALID');
  const uri = process.env.MONGODB_URI;
  if (uri === undefined || !uri.startsWith('mongodb://')) throw new Error('PHASE_S1_SUPPLIER_INDEX_MONGODB_URI_REQUIRED');
  const connection = createConnection(uri, { autoIndex: false, serverSelectionTimeoutMS: 5_000 });
  try {
    await connection.asPromise();
    const result = await runPhaseS1SupplierIndexMigration(connection, args.includes('--dry-run'));
    process.stdout.write(`${JSON.stringify({ migrationId: MIGRATION_ID, mode: args.includes('--dry-run') ? 'dry-run' : 'apply', ...result })}\n`);
  } finally { await connection.close(); }
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  void main().catch((caught: unknown) => {
    const code = caught instanceof Error && /^PHASE_S1_SUPPLIER_INDEX_[A-Z_]{1,96}$/u.test(caught.message) ? caught.message : 'PHASE_S1_SUPPLIER_INDEX_DATABASE_FAILURE';
    process.stderr.write(`${code}\n`); process.exitCode = 1;
  });
}
