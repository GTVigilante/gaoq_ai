import { pathToFileURL } from 'node:url';

import { createConnection } from 'mongoose';

import { KnowledgeSearchIndexTaskRecordSchema } from '../modules/knowledge/persistence/knowledge-search.schemas.js';
import { KnowledgeCourseVersionRecordSchema } from '../modules/knowledge/persistence/knowledge.schemas.js';
import {
  buildIndexManifestFromSchemas,
  runAdditiveIndexMigration,
} from './phase-3-indexes.js';

const MIGRATION_ID = 'phase-3-knowledge-search-indexes-v1';

export function buildPhaseThreeKnowledgeSearchIndexManifest() {
  const runtime = buildIndexManifestFromSchemas([
    KnowledgeCourseVersionRecordSchema,
    KnowledgeSearchIndexTaskRecordSchema,
  ]);
  return Object.freeze(runtime.filter((item) =>
    item.collection === 'knowledge_search_index_tasks' ||
    item.key.audienceDepartmentIds === 1 ||
    item.key.audiencePositionIds === 1));
}

export async function runPhaseThreeKnowledgeSearchIndexMigration(
  connection: Parameters<typeof runAdditiveIndexMigration>[0],
  dryRun: boolean,
) {
  return runAdditiveIndexMigration(connection, dryRun, {
    migrationId: MIGRATION_ID,
    manifest: buildPhaseThreeKnowledgeSearchIndexManifest(),
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((arg) => arg !== '--');
  if (args.some((arg) => arg !== '--dry-run')) {
    throw new Error('PHASE3_KNOWLEDGE_SEARCH_INDEX_ARGUMENT_INVALID');
  }
  const uri = process.env.MONGODB_URI;
  if (uri === undefined || !uri.startsWith('mongodb://')) {
    throw new Error('PHASE3_KNOWLEDGE_SEARCH_INDEX_MONGODB_URI_REQUIRED');
  }
  const connection = createConnection(uri, {
    autoIndex: false,
    serverSelectionTimeoutMS: 5_000,
  });
  try {
    await connection.asPromise();
    const dryRun = args.includes('--dry-run');
    const result = await runPhaseThreeKnowledgeSearchIndexMigration(connection, dryRun);
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
    const code = error instanceof Error &&
      /^PHASE3_(?:KNOWLEDGE_SEARCH_)?INDEX_[A-Z_]{1,96}$/.test(error.message)
      ? error.message
      : 'PHASE3_KNOWLEDGE_SEARCH_INDEX_DATABASE_FAILURE';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
