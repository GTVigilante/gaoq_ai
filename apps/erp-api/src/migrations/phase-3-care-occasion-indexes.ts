import { pathToFileURL } from 'node:url';

import { createConnection } from 'mongoose';

import {
  CareOccasionPreferenceRecordSchema,
  CareOccasionTaskRecordSchema,
  CareOccasionTenantRecordSchema,
} from '../modules/care/persistence/care.schemas.js';
import { OrgPersonRecordSchema } from '../modules/org/persistence/org.schemas.js';
import {
  buildIndexManifestFromSchemas,
  runAdditiveIndexMigration,
} from './phase-3-indexes.js';

const MIGRATION_ID = 'phase-3-care-occasion-indexes-v1';

export function buildPhaseThreeCareOccasionIndexManifest() {
  const manifest = buildIndexManifestFromSchemas([
    CareOccasionPreferenceRecordSchema,
    CareOccasionTaskRecordSchema,
    CareOccasionTenantRecordSchema,
    OrgPersonRecordSchema,
  ]);
  return Object.freeze(manifest.filter((item) =>
    item.collection !== 'org_persons' ||
    item.key.birthdayEvidenceId === 1 ||
    item.key.birthdayBlindIndexes === 1,
  ));
}

export async function runPhaseThreeCareOccasionIndexMigration(
  connection: Parameters<typeof runAdditiveIndexMigration>[0],
  dryRun: boolean,
) {
  return runAdditiveIndexMigration(connection, dryRun, {
    migrationId: MIGRATION_ID,
    manifest: buildPhaseThreeCareOccasionIndexManifest(),
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((argument) => argument !== '--');
  if (args.some((argument) => argument !== '--dry-run')) {
    throw new Error('PHASE3_CARE_OCCASION_INDEX_ARGUMENT_INVALID');
  }
  const uri = process.env.MONGODB_URI;
  if (uri === undefined || !uri.startsWith('mongodb://')) {
    throw new Error('PHASE3_CARE_OCCASION_INDEX_MONGODB_URI_REQUIRED');
  }
  const connection = createConnection(uri, {
    autoIndex: false,
    serverSelectionTimeoutMS: 5_000,
  });
  try {
    await connection.asPromise();
    const dryRun = args.includes('--dry-run');
    const result = await runPhaseThreeCareOccasionIndexMigration(connection, dryRun);
    process.stdout.write(`${JSON.stringify({
      migrationId: MIGRATION_ID,
      mode: dryRun ? 'dry-run' : 'apply',
      ...result,
    })}\n`);
  } finally {
    await connection.close();
  }
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  void main().catch((error: unknown) => {
    const code =
      error instanceof Error &&
      /^PHASE3_CARE_OCCASION_INDEX_[A-Z_]{1,96}$/.test(error.message)
        ? error.message
        : 'PHASE3_CARE_OCCASION_INDEX_DATABASE_FAILURE';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
