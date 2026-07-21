import { pathToFileURL } from 'node:url';

import { createConnection } from 'mongoose';

import {
  TreasuryBankAccountRecordSchema,
  TreasuryBankReturnRecordSchema,
  TreasuryDisbursementBatchRecordSchema,
  TreasuryPaymentInstructionRecordSchema,
} from '../modules/treasury/persistence/treasury.schemas.js';
import { buildIndexManifestFromSchemas, runAdditiveIndexMigration } from './phase-3-indexes.js';

const MIGRATION_ID = 'phase-4-treasury-indexes-v1';
const SCHEMAS = Object.freeze([
  TreasuryBankAccountRecordSchema,
  TreasuryPaymentInstructionRecordSchema,
  TreasuryDisbursementBatchRecordSchema,
  TreasuryBankReturnRecordSchema,
]);

export function buildPhaseFourTreasuryIndexManifest() {
  return buildIndexManifestFromSchemas(SCHEMAS);
}
export async function runPhaseFourTreasuryIndexMigration(
  connection: Parameters<typeof runAdditiveIndexMigration>[0],
  dryRun: boolean,
) {
  return runAdditiveIndexMigration(connection, dryRun, {
    migrationId: MIGRATION_ID,
    manifest: buildPhaseFourTreasuryIndexManifest(),
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((arg) => arg !== '--');
  if (args.some((arg) => arg !== '--dry-run')) {
    throw new Error('PHASE4_TREASURY_INDEX_ARGUMENT_INVALID');
  }
  const uri = process.env.MONGODB_URI;
  if (uri === undefined || !uri.startsWith('mongodb://')) {
    throw new Error('PHASE4_TREASURY_INDEX_MONGODB_URI_REQUIRED');
  }
  const connection = createConnection(uri, { autoIndex: false, serverSelectionTimeoutMS: 5_000 });
  try {
    await connection.asPromise();
    const result = await runPhaseFourTreasuryIndexMigration(
      connection, args.includes('--dry-run'),
    );
    process.stdout.write(`${JSON.stringify({
      migrationId: MIGRATION_ID,
      mode: args.includes('--dry-run') ? 'dry-run' : 'apply',
      ...result,
    })}\n`);
  } finally {
    await connection.close();
  }
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  void main().catch((error: unknown) => {
    const code = error instanceof Error && /^PHASE4_TREASURY_INDEX_[A-Z_]{1,96}$/.test(error.message)
      ? error.message
      : 'PHASE4_TREASURY_INDEX_DATABASE_FAILURE';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
