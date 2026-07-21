import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { createConnection, type Connection, type IndexOptions, type Schema } from 'mongoose';

import { IdempotencyRecordSchema } from '../core/idempotency/idempotency.schema.js';
import { AccessProfileSchema } from '../modules/identity/access-profile.schema.js';
import { ExternalIdentitySchema } from '../modules/identity/external-identity.schema.js';
import { IdentityRefreshTokenSchema } from '../modules/identity/refresh-token.schema.js';
import { IdentitySessionSchema } from '../modules/identity/session.schema.js';
import { SsoTenantBindingSchema } from '../modules/identity/sso-tenant-binding.schema.js';
import {
  OrgDeliveryRecordSchema,
  OrgExternalVersionStateSchema,
} from '../modules/integration/org-delivery.schemas.js';
import { OrgEmployeeProvisioningRequestSchema } from '../modules/integration/org-employee-provisioning.schema.js';
import { OrgPlatformBindingSchema } from '../modules/integration/org-platform-binding.schema.js';
import { OrgReconciliationReportSchema } from '../modules/integration/org-reconciliation.schema.js';
import {
  OrgDepartmentRecordSchema,
  OrgEmployeeRecordSchema,
  OrgJobLevelRecordSchema,
  OrgPositionRecordSchema,
} from '../modules/org/persistence/org.schemas.js';
import { OutboxRecordSchema } from '../modules/org/persistence/outbox.schema.js';

const MIGRATION_ID = 'phase-1-indexes-v1';
const LOCK_ID = `${MIGRATION_ID}:lock`;
const LOCK_TTL_MS = 30 * 60 * 1_000;
const INDEX_NAME_PATTERN = /^[A-Za-z0-9._:-]{1,127}$/;

type IndexDirection = 1 | -1 | '2d' | '2dsphere' | 'geoHaystack' | 'hashed' | 'text';
export type MigrationIndexKey = Readonly<Record<string, IndexDirection>>;

export interface MigrationIndexOptions {
  readonly unique?: boolean;
  readonly sparse?: boolean;
  readonly expireAfterSeconds?: number;
  readonly partialFilterExpression?: NonNullable<IndexOptions['partialFilterExpression']>;
  readonly collation?: NonNullable<IndexOptions['collation']>;
}

export interface PhaseOneIndexDefinition {
  readonly collection: string;
  readonly name: string;
  readonly key: MigrationIndexKey;
  readonly options: MigrationIndexOptions;
}

export interface ExistingIndexDefinition {
  readonly name: string;
  readonly key: Readonly<Record<string, unknown>>;
  readonly unique?: boolean;
  readonly sparse?: boolean;
  readonly expireAfterSeconds?: number;
  readonly partialFilterExpression?: IndexOptions['partialFilterExpression'];
  readonly collation?: IndexOptions['collation'];
}

export interface IndexMigrationPlan {
  readonly missing: readonly PhaseOneIndexDefinition[];
  readonly conflicts: readonly {
    readonly expected: PhaseOneIndexDefinition;
    readonly existingName: string;
  }[];
}

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

const PHASE_ONE_SCHEMAS: readonly Schema[] = Object.freeze([
  IdempotencyRecordSchema,
  AccessProfileSchema,
  ExternalIdentitySchema,
  IdentityRefreshTokenSchema,
  IdentitySessionSchema,
  SsoTenantBindingSchema,
  OrgDeliveryRecordSchema,
  OrgExternalVersionStateSchema,
  OrgEmployeeProvisioningRequestSchema,
  OrgPlatformBindingSchema,
  OrgReconciliationReportSchema,
  OrgDepartmentRecordSchema,
  OrgEmployeeRecordSchema,
  OrgPositionRecordSchema,
  OrgJobLevelRecordSchema,
  OutboxRecordSchema,
]);

/** 从业务 schema 生成冻结的 Phase 1 索引清单，避免迁移定义与运行模型漂移。 */
export function buildPhaseOneIndexManifest(): readonly PhaseOneIndexDefinition[] {
  const manifest: PhaseOneIndexDefinition[] = [];
  for (const schema of PHASE_ONE_SCHEMAS) {
    const collection = schema.get('collection');
    if (typeof collection !== 'string' || collection.length < 1) {
      throw new Error('PHASE1_INDEX_COLLECTION_INVALID');
    }
    for (const [rawKey, rawOptions] of schema.indexes()) {
      const key = Object.freeze({ ...rawKey }) as MigrationIndexKey;
      const name = typeof rawOptions.name === 'string'
        ? rawOptions.name
        : defaultIndexName(key);
      if (!INDEX_NAME_PATTERN.test(name)) throw new Error('PHASE1_INDEX_NAME_INVALID');
      manifest.push(Object.freeze({
        collection,
        name,
        key,
        options: normalizeOptions(rawOptions),
      }));
    }
  }
  const identities = new Set<string>();
  for (const index of manifest) {
    const identity = `${index.collection}:${index.name}`;
    if (identities.has(identity)) throw new Error('PHASE1_INDEX_NAME_DUPLICATED');
    identities.add(identity);
  }
  return Object.freeze(manifest);
}

/** 比较声明索引与数据库现状；未知索引保留，同键异配置失败关闭。 */
export function compareCollectionIndexes(
  expected: readonly PhaseOneIndexDefinition[],
  existing: readonly ExistingIndexDefinition[],
): IndexMigrationPlan {
  const missing: PhaseOneIndexDefinition[] = [];
  const conflicts: { expected: PhaseOneIndexDefinition; existingName: string }[] = [];
  for (const target of expected) {
    const named = existing.find((candidate) => candidate.name === target.name);
    if (named !== undefined) {
      if (!sameIndex(target, named)) conflicts.push({ expected: target, existingName: named.name });
      continue;
    }
    const sameKey = existing.find((candidate) => sameKeyDefinition(target.key, candidate.key));
    if (sameKey !== undefined) {
      if (!sameIndex(target, sameKey)) {
        conflicts.push({ expected: target, existingName: sameKey.name });
      }
      continue;
    }
    missing.push(target);
  }
  return Object.freeze({ missing: Object.freeze(missing), conflicts: Object.freeze(conflicts) });
}

/** 执行只增不删索引迁移；dry-run 仅检查，不获取租约或写迁移记录。 */
export async function runPhaseOneIndexMigration(
  connection: Connection,
  dryRun: boolean,
): Promise<{
  readonly checksum: string;
  readonly created: number;
  readonly verified: number;
  readonly missing: number;
}> {
  const database = connection.db;
  if (database === undefined) throw new Error('PHASE1_INDEX_DATABASE_UNAVAILABLE');
  const manifest = buildPhaseOneIndexManifest();
  const checksum = manifestChecksum(manifest);
  const byCollection = groupByCollection(manifest);
  const plans = await loadPlans(connection, byCollection);
  const conflicts = [...plans.values()].flatMap((plan) => plan.conflicts);
  const missing = [...plans.values()].reduce((total, plan) => total + plan.missing.length, 0);
  if (conflicts.length > 0) throw new Error('PHASE1_INDEX_CONFLICT');
  if (dryRun) {
    return Object.freeze({
      checksum,
      created: 0,
      verified: manifest.length - missing,
      missing,
    });
  }

  const owner = randomUUID();
  await acquireLock(connection, owner);
  let created = 0;
  try {
    const runs = database.collection<MigrationRun>('system_migration_runs');
    const completed = await runs.findOne({ _id: MIGRATION_ID });
    if (completed !== null && completed.checksum !== checksum) {
      throw new Error('PHASE1_INDEX_MANIFEST_CHANGED');
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
      const collection = connection.collection(collectionName);
      for (const index of plan.missing) {
        await collection.createIndex(index.key, {
          name: index.name,
          ...(index.options.unique === true ? { unique: true } : {}),
          ...(index.options.sparse === true ? { sparse: true } : {}),
          ...(index.options.expireAfterSeconds === undefined
            ? {}
            : { expireAfterSeconds: index.options.expireAfterSeconds }),
          ...(index.options.partialFilterExpression === undefined
            ? {}
            : { partialFilterExpression: index.options.partialFilterExpression }),
          ...(index.options.collation === undefined ? {} : { collation: index.options.collation }),
        });
        created += 1;
      }
    }
    const verification = await loadPlans(connection, byCollection);
    if ([...verification.values()].some(
      (plan) => plan.missing.length > 0 || plan.conflicts.length > 0,
    )) throw new Error('PHASE1_INDEX_VERIFY_FAILED');
    await runs.updateOne(
      { _id: MIGRATION_ID, checksum },
      {
        $set: {
          status: 'completed',
          completedAt: new Date(),
          collectionCount: byCollection.size,
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
  byCollection: ReadonlyMap<string, readonly PhaseOneIndexDefinition[]>,
): Promise<ReadonlyMap<string, IndexMigrationPlan>> {
  const plans = new Map<string, IndexMigrationPlan>();
  for (const [collectionName, expected] of byCollection) {
    let existing: ExistingIndexDefinition[];
    try {
      existing = await connection.collection(collectionName).listIndexes().toArray() as ExistingIndexDefinition[];
    } catch (error) {
      if (!isNamespaceMissing(error)) throw error;
      existing = [];
    }
    plans.set(collectionName, compareCollectionIndexes(expected, existing));
  }
  return plans;
}

async function acquireLock(connection: Connection, owner: string): Promise<void> {
  const database = connection.db;
  if (database === undefined) throw new Error('PHASE1_INDEX_DATABASE_UNAVAILABLE');
  const locks = database.collection<MigrationLock>('system_migration_locks');
  const now = new Date();
  const lock = { _id: LOCK_ID, owner, expiresAt: new Date(now.getTime() + LOCK_TTL_MS) };
  try {
    await locks.insertOne(lock);
    return;
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
  }
  const claimed = await locks.findOneAndUpdate(
    { _id: LOCK_ID, expiresAt: { $lte: now } },
    { $set: { owner, expiresAt: lock.expiresAt } },
    { returnDocument: 'after' },
  );
  if (claimed?.owner !== owner) throw new Error('PHASE1_INDEX_MIGRATION_LOCKED');
}

function groupByCollection(
  manifest: readonly PhaseOneIndexDefinition[],
): ReadonlyMap<string, readonly PhaseOneIndexDefinition[]> {
  const grouped = new Map<string, PhaseOneIndexDefinition[]>();
  for (const index of manifest) {
    const entries = grouped.get(index.collection) ?? [];
    entries.push(index);
    grouped.set(index.collection, entries);
  }
  return grouped;
}

function defaultIndexName(key: MigrationIndexKey): string {
  return Object.entries(key).map(([field, direction]) => `${field}_${String(direction)}`).join('_');
}

function normalizeOptions(value: object): MigrationIndexOptions {
  const record = value as Readonly<Record<string, unknown>>;
  return Object.freeze({
    ...(record.unique === true ? { unique: true } : {}),
    ...(record.sparse === true ? { sparse: true } : {}),
    ...(typeof record.expireAfterSeconds === 'number'
      ? { expireAfterSeconds: record.expireAfterSeconds }
      : {}),
    ...(isRecord(record.partialFilterExpression)
      ? { partialFilterExpression: stableObject(record.partialFilterExpression) }
      : {}),
    ...(isRecord(record.collation) && typeof record.collation.locale === 'string'
      ? {
          collation: stableObject(record.collation) as unknown as NonNullable<
            IndexOptions['collation']
          >,
        }
      : {}),
  });
}

function sameIndex(expected: PhaseOneIndexDefinition, existing: ExistingIndexDefinition): boolean {
  return sameKeyDefinition(expected.key, existing.key) &&
    stableJson(expected.options) === stableJson(normalizeOptions(existing));
}

function sameKeyDefinition(
  expected: Readonly<Record<string, unknown>>,
  existing: Readonly<Record<string, unknown>>,
): boolean {
  return JSON.stringify(Object.entries(expected)) === JSON.stringify(Object.entries(existing));
}

function manifestChecksum(manifest: readonly PhaseOneIndexDefinition[]): string {
  return createHash('sha256').update(stableJson(manifest), 'utf8').digest('base64url');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${stableJson(value[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

function stableObject(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return Object.freeze(Object.fromEntries(
    Object.keys(value).sort().map((key) => [
      key,
      isRecord(value[key]) ? stableObject(value[key]) : value[key],
    ]),
  ));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDuplicateKey(error: unknown): boolean {
  return isRecord(error) && error.code === 11_000;
}

function isNamespaceMissing(error: unknown): boolean {
  return isRecord(error) && error.code === 26;
}

function safeFailureCode(error: unknown): string {
  if (!(error instanceof Error)) return 'PHASE1_INDEX_UNKNOWN_FAILURE';
  return /^PHASE1_INDEX_[A-Z_]{1,96}$/.test(error.message)
    ? error.message
    : 'PHASE1_INDEX_DATABASE_FAILURE';
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((arg) => arg !== '--');
  if (args.some((arg) => arg !== '--dry-run')) throw new Error('PHASE1_INDEX_ARGUMENT_INVALID');
  const uri = process.env.MONGODB_URI;
  if (uri === undefined || !uri.startsWith('mongodb://')) {
    throw new Error('PHASE1_INDEX_MONGODB_URI_REQUIRED');
  }
  const connection = createConnection(uri, {
    autoIndex: false,
    serverSelectionTimeoutMS: 5_000,
  });
  try {
    await connection.asPromise();
    const result = await runPhaseOneIndexMigration(connection, args.includes('--dry-run'));
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
