import { pathToFileURL } from 'node:url';

import { createConnection } from 'mongoose';

import { AnalyticsManagementExportRecordSchema } from '../modules/analytics/persistence/analytics.schemas.js';
import { ApprovalInstanceRecordSchema } from '../modules/approval/persistence/approval.schemas.js';
import { KnowledgeTrainingAssignmentRecordSchema } from '../modules/knowledge/persistence/knowledge.schemas.js';
import { CandidateApplicationRecordSchema } from '../modules/recruitment/persistence/recruitment.schemas.js';
import { buildIndexManifestFromSchemas, runAdditiveIndexMigration } from './phase-3-indexes.js';

const MIGRATION_ID = 'phase-5-analytics-indexes-v1';

export function buildPhaseFiveAnalyticsIndexManifest() {
  return buildIndexManifestFromSchemas([
    ApprovalInstanceRecordSchema,
    CandidateApplicationRecordSchema,
    KnowledgeTrainingAssignmentRecordSchema,
    AnalyticsManagementExportRecordSchema,
  ]);
}

export async function runPhaseFiveAnalyticsIndexMigration(
  connection: Parameters<typeof runAdditiveIndexMigration>[0],
  dryRun: boolean,
) {
  return runAdditiveIndexMigration(connection, dryRun, {
    migrationId: MIGRATION_ID,
    manifest: buildPhaseFiveAnalyticsIndexManifest(),
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((arg) => arg !== '--');
  if (args.some((arg) => arg !== '--dry-run')) {
    throw new Error('PHASE5_ANALYTICS_INDEX_ARGUMENT_INVALID');
  }
  const uri = process.env.MONGODB_URI;
  if (uri === undefined || !uri.startsWith('mongodb://')) {
    throw new Error('PHASE5_ANALYTICS_INDEX_MONGODB_URI_REQUIRED');
  }
  const connection = createConnection(uri, { autoIndex: false, serverSelectionTimeoutMS: 5_000 });
  try {
    await connection.asPromise();
    const result = await runPhaseFiveAnalyticsIndexMigration(
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
    const code = error instanceof Error &&
      /^PHASE5_ANALYTICS_INDEX_[A-Z_]{1,96}$/.test(error.message)
      ? error.message : 'PHASE5_ANALYTICS_INDEX_DATABASE_FAILURE';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
