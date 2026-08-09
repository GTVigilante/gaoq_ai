import { pathToFileURL } from 'node:url';

import { createConnection } from 'mongoose';

import {
  PerformanceAssignmentRecordSchema,
  PerformanceCycleRecordSchema,
  PerformancePayrollSnapshotRecordSchema,
  PerformanceTemplateRecordSchema,
} from '../modules/performance/persistence/performance.schemas.js';
import {
  HrbpAssignmentRecordSchema,
  ReportingLineRecordSchema,
} from '../modules/workforce/persistence/workforce.schemas.js';
import {
  buildIndexManifestFromSchemas,
  runAdditiveIndexMigration,
} from './phase-3-indexes.js';

const MIGRATION_ID = 'phase-6-workforce-performance-indexes-v1';
const SCHEMAS = Object.freeze([
  ReportingLineRecordSchema,
  HrbpAssignmentRecordSchema,
  PerformanceTemplateRecordSchema,
  PerformanceCycleRecordSchema,
  PerformanceAssignmentRecordSchema,
  PerformancePayrollSnapshotRecordSchema,
]);

/** 汇报关系、HRBP 与绩效只追加索引迁移，不删除或重建任何集合。 */
export function buildPhaseSixWorkforcePerformanceIndexManifest() {
  return buildIndexManifestFromSchemas(SCHEMAS);
}

export async function runPhaseSixWorkforcePerformanceIndexMigration(
  connection: Parameters<typeof runAdditiveIndexMigration>[0],
  dryRun: boolean,
) {
  return runAdditiveIndexMigration(connection, dryRun, {
    migrationId: MIGRATION_ID,
    manifest: buildPhaseSixWorkforcePerformanceIndexManifest(),
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((arg) => arg !== '--');
  if (args.some((arg) => arg !== '--dry-run')) throw new Error('PHASE6_WORKFORCE_PERFORMANCE_INDEX_ARGUMENT_INVALID');
  const uri = process.env.MONGODB_URI;
  if (uri === undefined || !uri.startsWith('mongodb://')) {
    throw new Error('PHASE6_WORKFORCE_PERFORMANCE_INDEX_MONGODB_URI_REQUIRED');
  }
  const connection = createConnection(uri, { autoIndex: false, serverSelectionTimeoutMS: 5_000 });
  try {
    await connection.asPromise();
    const result = await runPhaseSixWorkforcePerformanceIndexMigration(connection, args.includes('--dry-run'));
    process.stdout.write(`${JSON.stringify({ migrationId: MIGRATION_ID, mode: args.includes('--dry-run') ? 'dry-run' : 'apply', ...result })}\n`);
  } finally {
    await connection.close();
  }
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  void main().catch((caught: unknown) => {
    const code = caught instanceof Error && /^PHASE6_WORKFORCE_PERFORMANCE_INDEX_[A-Z_]{1,96}$/u.test(caught.message)
      ? caught.message
      : 'PHASE6_WORKFORCE_PERFORMANCE_INDEX_DATABASE_FAILURE';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
