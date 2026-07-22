import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { createConnection, type Connection, type Schema } from 'mongoose';

import {
  ApprovalNotificationRecordSchema,
} from '../modules/approval/notification/approval-notification.schema.js';
import {
  ApprovalActionRecordSchema,
  ApprovalDelegationRecordSchema,
  ApprovalInstanceRecordSchema,
  ApprovalTemplateRecordSchema,
} from '../modules/approval/persistence/approval.schemas.js';
import { McpConfirmationRecordSchema } from '../modules/mcp/mcp-confirmation.schema.js';
import {
  WebAuthnCeremonyRecordSchema,
  WebAuthnCredentialRecordSchema,
} from '../modules/identity/strong-auth/webauthn.schemas.js';
import {
  compareCollectionIndexes,
  type ExistingIndexDefinition,
  type MigrationIndexKey,
  type MigrationIndexOptions,
  type PhaseOneIndexDefinition,
} from './phase-1-indexes.js';

const MIGRATION_ID = 'phase-2-indexes-v2';
const LOCK_ID = `${MIGRATION_ID}:lock`;
const LOCK_TTL_MS = 30 * 60 * 1_000;
const INDEX_NAME_PATTERN = /^[A-Za-z0-9._:-]{1,127}$/;

export type PhaseTwoIndexDefinition = PhaseOneIndexDefinition;

interface MigrationLock {
  readonly _id: string;
  readonly owner: string;
  readonly expiresAt: Date;
}

interface MigrationRun {
  readonly _id: string;
  readonly checksum: string;
  readonly status: 'running' | 'completed' | 'failed';
  readonly startedAt: Date;
  readonly completedAt?: Date;
  readonly collectionCount?: number;
  readonly indexCount?: number;
  readonly failureCode?: string;
}

const PHASE_TWO_SCHEMAS: readonly Schema[] = Object.freeze([
  ApprovalTemplateRecordSchema,
  ApprovalInstanceRecordSchema,
  ApprovalActionRecordSchema,
  ApprovalDelegationRecordSchema,
  ApprovalNotificationRecordSchema,
  McpConfirmationRecordSchema,
  WebAuthnCredentialRecordSchema,
  WebAuthnCeremonyRecordSchema,
]);

/** 从 Phase 2 运行 Schema 生成索引清单，避免迁移定义和模型漂移。 */
export function buildPhaseTwoIndexManifest(): readonly PhaseTwoIndexDefinition[] {
  const manifest: PhaseTwoIndexDefinition[] = [];
  for (const schema of PHASE_TWO_SCHEMAS) {
    const collection = schema.get('collection');
    if (typeof collection !== 'string' || collection.length < 1) {
      throw new Error('PHASE2_INDEX_COLLECTION_INVALID');
    }
    for (const [rawKey, rawOptions] of schema.indexes()) {
      const key = Object.freeze({ ...rawKey }) as MigrationIndexKey;
      const name = typeof rawOptions.name === 'string'
        ? rawOptions.name
        : Object.entries(key).map(([field, direction]) => `${field}_${String(direction)}`).join('_');
      if (!INDEX_NAME_PATTERN.test(name)) throw new Error('PHASE2_INDEX_NAME_INVALID');
      manifest.push(Object.freeze({
        collection,
        name,
        key,
        options: normalizeOptions(rawOptions),
      }));
    }
  }
  const names = manifest.map((index) => `${index.collection}:${index.name}`);
  if (new Set(names).size !== names.length) throw new Error('PHASE2_INDEX_NAME_DUPLICATED');
  return Object.freeze(manifest);
}

/** 只创建缺失索引；未知索引保留，同名/同键异配置失败关闭。 */
export async function runPhaseTwoIndexMigration(
  connection: Connection,
  dryRun: boolean,
): Promise<{
  readonly checksum: string;
  readonly created: number;
  readonly verified: number;
  readonly missing: number;
}> {
  const database = connection.db;
  if (database === undefined) throw new Error('PHASE2_INDEX_DATABASE_UNAVAILABLE');
  const legacyDelegations = await database.collection('approval_delegations').countDocuments({
    $or: [{ coverageDays: { $exists: false } }, { coverageDays: { $size: 0 } }],
  }, { limit: 1 });
  if (legacyDelegations > 0) throw new Error('PHASE2_DELEGATION_COVERAGE_BACKFILL_REQUIRED');
  const manifest = buildPhaseTwoIndexManifest();
  const checksum = createHash('sha256').update(stableJson(manifest), 'utf8').digest('base64url');
  const grouped = groupManifest(manifest);
  const plans = await loadPlans(connection, grouped);
  const conflicts = [...plans.values()].flatMap((plan) => plan.conflicts);
  const missing = [...plans.values()].reduce((total, plan) => total + plan.missing.length, 0);
  if (conflicts.length > 0) throw new Error('PHASE2_INDEX_CONFLICT');
  if (dryRun) return Object.freeze({
    checksum,
    created: 0,
    verified: manifest.length - missing,
    missing,
  });

  const owner = randomUUID();
  await acquireLock(connection, owner);
  let created = 0;
  try {
    const runs = database.collection<MigrationRun>('system_migration_runs');
    const previous = await runs.findOne({ _id: MIGRATION_ID });
    if (previous !== null && previous.checksum !== checksum) {
      throw new Error('PHASE2_INDEX_MANIFEST_CHANGED');
    }
    await runs.updateOne(
      { _id: MIGRATION_ID },
      {
        $set: { checksum, status: 'running', startedAt: new Date() },
        $unset: { completedAt: '', failureCode: '' },
      },
      { upsert: true },
    );
    for (const [collectionName, plan] of plans) {
      for (const index of plan.missing) {
        await connection.collection(collectionName).createIndex(index.key, {
          name: index.name,
          ...index.options,
        });
        created += 1;
      }
    }
    const verification = await loadPlans(connection, grouped);
    if ([...verification.values()].some(
      (plan) => plan.missing.length > 0 || plan.conflicts.length > 0,
    )) throw new Error('PHASE2_INDEX_VERIFY_FAILED');
    await runs.updateOne(
      { _id: MIGRATION_ID, checksum },
      {
        $set: {
          status: 'completed',
          completedAt: new Date(),
          collectionCount: grouped.size,
          indexCount: manifest.length,
        },
        $unset: { failureCode: '' },
      },
    );
    return Object.freeze({ checksum, created, verified: manifest.length, missing });
  } catch (error) {
    await database.collection<MigrationRun>('system_migration_runs').updateOne(
      { _id: MIGRATION_ID, checksum },
      { $set: { status: 'failed', failureCode: safeFailureCode(error) } },
    );
    throw error;
  } finally {
    await database.collection<MigrationLock>('system_migration_locks').deleteOne({
      _id: LOCK_ID,
      owner,
    });
  }
}

async function loadPlans(
  connection: Connection,
  grouped: ReadonlyMap<string, readonly PhaseTwoIndexDefinition[]>,
) {
  const plans = new Map<string, ReturnType<typeof compareCollectionIndexes>>();
  for (const [collectionName, expected] of grouped) {
    let existing: ExistingIndexDefinition[];
    try {
      existing = await connection.collection(collectionName).listIndexes().toArray() as ExistingIndexDefinition[];
    } catch (error) {
      if (!isRecord(error) || error.code !== 26) throw error;
      existing = [];
    }
    plans.set(collectionName, compareCollectionIndexes(expected, existing));
  }
  return plans;
}

async function acquireLock(connection: Connection, owner: string): Promise<void> {
  const database = connection.db;
  if (database === undefined) throw new Error('PHASE2_INDEX_DATABASE_UNAVAILABLE');
  const locks = database.collection<MigrationLock>('system_migration_locks');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + LOCK_TTL_MS);
  try {
    await locks.insertOne({ _id: LOCK_ID, owner, expiresAt });
    return;
  } catch (error) {
    if (!isRecord(error) || error.code !== 11_000) throw error;
  }
  const claimed = await locks.findOneAndUpdate(
    { _id: LOCK_ID, expiresAt: { $lte: now } },
    { $set: { owner, expiresAt } },
    { returnDocument: 'after' },
  );
  if (claimed?.owner !== owner) throw new Error('PHASE2_INDEX_MIGRATION_LOCKED');
}

function groupManifest(manifest: readonly PhaseTwoIndexDefinition[]) {
  const grouped = new Map<string, PhaseTwoIndexDefinition[]>();
  for (const index of manifest) {
    const items = grouped.get(index.collection) ?? [];
    items.push(index);
    grouped.set(index.collection, items);
  }
  return grouped;
}

function normalizeOptions(options: object): MigrationIndexOptions {
  const value = options as Readonly<Record<string, unknown>>;
  return Object.freeze({
    ...(value.unique === true ? { unique: true } : {}),
    ...(value.sparse === true ? { sparse: true } : {}),
    ...(typeof value.expireAfterSeconds === 'number'
      ? { expireAfterSeconds: value.expireAfterSeconds }
      : {}),
    ...(isRecord(value.partialFilterExpression)
      ? { partialFilterExpression: value.partialFilterExpression }
      : {}),
  });
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map(
    (key) => `${JSON.stringify(key)}:${stableJson(value[key])}`,
  ).join(',')}}`;
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeFailureCode(error: unknown): string {
  if (!(error instanceof Error)) return 'PHASE2_INDEX_UNKNOWN_FAILURE';
  return /^PHASE2_INDEX_[A-Z_]{1,96}$/.test(error.message)
    ? error.message
    : 'PHASE2_INDEX_DATABASE_FAILURE';
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((arg) => arg !== '--');
  if (args.some((arg) => arg !== '--dry-run')) throw new Error('PHASE2_INDEX_ARGUMENT_INVALID');
  const uri = process.env.MONGODB_URI;
  if (uri === undefined || !uri.startsWith('mongodb://')) {
    throw new Error('PHASE2_INDEX_MONGODB_URI_REQUIRED');
  }
  const connection = createConnection(uri, { autoIndex: false, serverSelectionTimeoutMS: 5_000 });
  try {
    await connection.asPromise();
    const result = await runPhaseTwoIndexMigration(connection, args.includes('--dry-run'));
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
    process.stderr.write(`${safeFailureCode(error)}\n`);
    process.exitCode = 1;
  });
}
