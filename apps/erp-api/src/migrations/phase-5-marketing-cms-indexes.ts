import { pathToFileURL } from 'node:url';
import { createConnection } from 'mongoose';
import {
  MarketingAiGenerationRecordSchema,
  MarketingContentRecordSchema,
  MarketingContentRevisionRecordSchema,
  MarketingLeadRecordSchema,
  MarketingMediaRecordSchema,
  MarketingSideEffectRecordSchema,
} from '../modules/marketing-cms/marketing-cms.schemas.js';
import {
  buildIndexManifestFromSchemas,
  runAdditiveIndexMigration,
} from './phase-3-indexes.js';

const MIGRATION_ID = 'phase-5-marketing-cms-indexes-v2';
const SCHEMAS = Object.freeze([
  MarketingContentRecordSchema,
  MarketingContentRevisionRecordSchema,
  MarketingLeadRecordSchema,
  MarketingMediaRecordSchema,
  MarketingAiGenerationRecordSchema,
  MarketingSideEffectRecordSchema,
]);

/** CMS 与可靠副作用 Outbox 的独立追加索引迁移。 */
export function buildPhaseFiveMarketingCmsIndexManifest() {
  return buildIndexManifestFromSchemas(SCHEMAS);
}

export async function runPhaseFiveMarketingCmsIndexMigration(
  connection: Parameters<typeof runAdditiveIndexMigration>[0],
  dryRun: boolean,
) {
  return runAdditiveIndexMigration(connection, dryRun, {
    migrationId: MIGRATION_ID,
    manifest: buildPhaseFiveMarketingCmsIndexManifest(),
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((arg) => arg !== '--');
  if (args.some((arg) => arg !== '--dry-run')) throw new Error('PHASE5_MARKETING_INDEX_ARGUMENT_INVALID');
  const uri = process.env.MONGODB_URI;
  if (uri === undefined || !uri.startsWith('mongodb://')) {
    throw new Error('PHASE5_MARKETING_INDEX_MONGODB_URI_REQUIRED');
  }
  const connection = createConnection(uri, { autoIndex: false, serverSelectionTimeoutMS: 5_000 });
  try {
    await connection.asPromise();
    const result = await runPhaseFiveMarketingCmsIndexMigration(
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
  void main().catch((caught: unknown) => {
    const code = caught instanceof Error &&
      /^PHASE5_MARKETING_INDEX_[A-Z_]{1,96}$/u.test(caught.message)
      ? caught.message
      : 'PHASE5_MARKETING_INDEX_DATABASE_FAILURE';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
