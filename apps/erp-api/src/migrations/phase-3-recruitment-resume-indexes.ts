import { pathToFileURL } from 'node:url';

import { createConnection } from 'mongoose';

import {
  RecruitmentResumeAnalysisRecordSchema,
} from '../modules/recruitment/persistence/recruitment-resume.schemas.js';
import {
  buildIndexManifestFromSchemas,
  runAdditiveIndexMigration,
} from './phase-3-indexes.js';

const MIGRATION_ID = 'phase-3-recruitment-resume-indexes-v1';
const SCHEMAS = Object.freeze([RecruitmentResumeAnalysisRecordSchema]);

/** 简历分析独立追加迁移，避免修改已发布 Phase 3 基线清单的 checksum。 */
export function buildPhaseThreeRecruitmentResumeIndexManifest() {
  return buildIndexManifestFromSchemas(SCHEMAS);
}

export async function runPhaseThreeRecruitmentResumeIndexMigration(
  connection: Parameters<typeof runAdditiveIndexMigration>[0],
  dryRun: boolean,
) {
  return runAdditiveIndexMigration(connection, dryRun, {
    migrationId: MIGRATION_ID,
    manifest: buildPhaseThreeRecruitmentResumeIndexManifest(),
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((arg) => arg !== '--');
  if (args.some((arg) => arg !== '--dry-run')) throw new Error('PHASE3_INDEX_ARGUMENT_INVALID');
  const uri = process.env.MONGODB_URI;
  if (uri === undefined || !uri.startsWith('mongodb://')) {
    throw new Error('PHASE3_INDEX_MONGODB_URI_REQUIRED');
  }
  const connection = createConnection(uri, { autoIndex: false, serverSelectionTimeoutMS: 5_000 });
  try {
    await connection.asPromise();
    const result = await runPhaseThreeRecruitmentResumeIndexMigration(
      connection,
      args.includes('--dry-run'),
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
    const code = error instanceof Error && /^PHASE3_INDEX_[A-Z_]{1,96}$/.test(error.message)
      ? error.message
      : 'PHASE3_INDEX_DATABASE_FAILURE';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
