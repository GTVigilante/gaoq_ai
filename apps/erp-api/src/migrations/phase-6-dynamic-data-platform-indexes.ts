import { pathToFileURL } from 'node:url';

import { createConnection } from 'mongoose';

import {
  DynamicFormDataRecordSchema,
  DynamicFormDefinitionRecordSchema,
  DynamicFormRelationRecordSchema,
} from '../modules/dynamic-form/persistence/dynamic-form.schemas.js';
import { MultidimensionalBaseRecordSchema } from '../modules/dynamic-form/persistence/multidimensional-base.schema.js';
import { buildIndexManifestFromSchemas, runAdditiveIndexMigration } from './phase-3-indexes.js';

const MIGRATION_ID = 'phase-6-dynamic-data-platform-indexes-v1';
const SCHEMAS = Object.freeze([
  DynamicFormDefinitionRecordSchema,
  DynamicFormDataRecordSchema,
  DynamicFormRelationRecordSchema,
  MultidimensionalBaseRecordSchema,
]);

/** 动态表单与多维 Base 只追加索引迁移；禁止删除集合、索引或业务数据。 */
export function buildPhaseSixDynamicDataPlatformIndexManifest() {
  return buildIndexManifestFromSchemas(SCHEMAS);
}

export async function runPhaseSixDynamicDataPlatformIndexMigration(
  connection: Parameters<typeof runAdditiveIndexMigration>[0],
  dryRun: boolean,
) {
  return runAdditiveIndexMigration(connection, dryRun, {
    migrationId: MIGRATION_ID,
    manifest: buildPhaseSixDynamicDataPlatformIndexManifest(),
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((arg) => arg !== '--');
  if (args.some((arg) => arg !== '--dry-run')) throw new Error('PHASE6_DYNAMIC_DATA_INDEX_ARGUMENT_INVALID');
  const uri = process.env.MONGODB_URI;
  if (uri === undefined || !uri.startsWith('mongodb://')) throw new Error('PHASE6_DYNAMIC_DATA_INDEX_MONGODB_URI_REQUIRED');
  const connection = createConnection(uri, { autoIndex: false, serverSelectionTimeoutMS: 5_000 });
  try {
    await connection.asPromise();
    const result = await runPhaseSixDynamicDataPlatformIndexMigration(connection, args.includes('--dry-run'));
    process.stdout.write(`${JSON.stringify({ migrationId: MIGRATION_ID, mode: args.includes('--dry-run') ? 'dry-run' : 'apply', ...result })}\n`);
  } finally {
    await connection.close();
  }
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  void main().catch((caught: unknown) => {
    const code = caught instanceof Error && /^PHASE6_DYNAMIC_DATA_INDEX_[A-Z_]{1,96}$/u.test(caught.message)
      ? caught.message
      : 'PHASE6_DYNAMIC_DATA_INDEX_DATABASE_FAILURE';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
