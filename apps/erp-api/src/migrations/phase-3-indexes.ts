import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { createConnection, type Connection, type Schema } from 'mongoose';

import { ESignBindingSchema } from '../modules/integration/esign-binding.schema.js';
import { ESignEvidenceRecordSchema } from '../modules/integration/esign-evidence.schema.js';
import { ESignFlowRecordSchema } from '../modules/integration/esign-flow.schema.js';
import { ESignWebhookInboxRecordSchema } from '../modules/integration/esign-webhook-inbox.schema.js';
import { RecruitmentCalendarBindingSchema } from '../modules/integration/recruitment-calendar-binding.schema.js';
import { RecruitmentCalendarDeliveryRecordSchema } from '../modules/integration/recruitment-calendar-delivery.schema.js';
import {
  OnboardingInstanceRecordSchema,
  OnboardingTaskEvidenceRecordSchema,
} from '../modules/onboarding/persistence/onboarding.schemas.js';
import {
  OrgEmployeeNumberSequenceRecordSchema,
  OrgEmploymentRecordSchema,
  OrgPersonRecordSchema,
} from '../modules/org/persistence/org.schemas.js';
import {
  CandidateApplicationRecordSchema,
  CandidateApplicationStageRecordSchema,
  CandidateConsentEvidenceRecordSchema,
  RecruitmentCandidateRecordSchema,
  RecruitmentInterviewFeedbackRecordSchema,
  RecruitmentInterviewRecordSchema,
  RecruitmentOfferEvidenceRecordSchema,
  RecruitmentOfferRecordSchema,
  RecruitmentPositionRecordSchema,
  RecruitmentRequisitionRecordSchema,
} from '../modules/recruitment/persistence/recruitment.schemas.js';
import {
  compareCollectionIndexes,
  type ExistingIndexDefinition,
  type MigrationIndexKey,
  type MigrationIndexOptions,
  type PhaseOneIndexDefinition,
} from './phase-1-indexes.js';

const MIGRATION_ID = 'phase-3-indexes-v1';
const LOCK_ID = `${MIGRATION_ID}:lock`;
const LOCK_TTL_MS = 30 * 60 * 1_000;
const INDEX_NAME_PATTERN = /^[A-Za-z0-9._:-]{1,127}$/;

export type PhaseThreeIndexDefinition = PhaseOneIndexDefinition;

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

const PHASE_THREE_SCHEMAS: readonly Schema[] = Object.freeze([
  RecruitmentCandidateRecordSchema,
  CandidateConsentEvidenceRecordSchema,
  RecruitmentRequisitionRecordSchema,
  RecruitmentPositionRecordSchema,
  CandidateApplicationRecordSchema,
  CandidateApplicationStageRecordSchema,
  RecruitmentInterviewRecordSchema,
  RecruitmentInterviewFeedbackRecordSchema,
  RecruitmentOfferRecordSchema,
  RecruitmentOfferEvidenceRecordSchema,
  RecruitmentCalendarBindingSchema,
  RecruitmentCalendarDeliveryRecordSchema,
  ESignBindingSchema,
  ESignWebhookInboxRecordSchema,
  ESignFlowRecordSchema,
  ESignEvidenceRecordSchema,
  OrgPersonRecordSchema,
  OrgEmploymentRecordSchema,
  OrgEmployeeNumberSequenceRecordSchema,
  OnboardingInstanceRecordSchema,
  OnboardingTaskEvidenceRecordSchema,
]);

/** 从 Phase 3 运行 Schema 生成冻结清单，禁止手写清单与运行模型漂移。 */
export function buildPhaseThreeIndexManifest(): readonly PhaseThreeIndexDefinition[] {
  const manifest: PhaseThreeIndexDefinition[] = [];
  for (const schema of PHASE_THREE_SCHEMAS) {
    const collection = schema.get('collection');
    if (typeof collection !== 'string' || collection.length < 1) {
      throw new Error('PHASE3_INDEX_COLLECTION_INVALID');
    }
    for (const [rawKey, rawOptions] of schema.indexes()) {
      const key = Object.freeze({ ...rawKey }) as MigrationIndexKey;
      const name = typeof rawOptions.name === 'string'
        ? rawOptions.name
        : Object.entries(key).map(([field, direction]) => `${field}_${String(direction)}`).join('_');
      if (!INDEX_NAME_PATTERN.test(name)) throw new Error('PHASE3_INDEX_NAME_INVALID');
      manifest.push(Object.freeze({
        collection,
        name,
        key,
        options: normalizeOptions(rawOptions),
      }));
    }
  }
  const identities = manifest.map((index) => `${index.collection}:${index.name}`);
  if (new Set(identities).size !== identities.length) {
    throw new Error('PHASE3_INDEX_NAME_DUPLICATED');
  }
  return Object.freeze(manifest);
}

/** 只增不删迁移；冲突失败关闭，apply 后重新读取数据库复验。 */
export async function runPhaseThreeIndexMigration(
  connection: Connection,
  dryRun: boolean,
): Promise<{
  readonly checksum: string;
  readonly created: number;
  readonly verified: number;
  readonly missing: number;
}> {
  const database = connection.db;
  if (database === undefined) throw new Error('PHASE3_INDEX_DATABASE_UNAVAILABLE');
  const manifest = buildPhaseThreeIndexManifest();
  const checksum = createHash('sha256').update(stableJson(manifest), 'utf8').digest('base64url');
  const grouped = groupManifest(manifest);
  const plans = await loadPlans(connection, grouped);
  const conflicts = [...plans.values()].flatMap((plan) => plan.conflicts);
  const missing = [...plans.values()].reduce((total, plan) => total + plan.missing.length, 0);
  if (conflicts.length > 0) throw new Error('PHASE3_INDEX_CONFLICT');
  if (dryRun) return Object.freeze({
    checksum, created: 0, verified: manifest.length - missing, missing,
  });

  const owner = randomUUID();
  await acquireLock(connection, owner);
  let created = 0;
  try {
    const runs = database.collection<MigrationRun>('system_migration_runs');
    const previous = await runs.findOne({ _id: MIGRATION_ID });
    if (previous !== null && previous.checksum !== checksum) {
      throw new Error('PHASE3_INDEX_MANIFEST_CHANGED');
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
    )) throw new Error('PHASE3_INDEX_VERIFY_FAILED');
    await runs.updateOne(
      { _id: MIGRATION_ID, checksum },
      {
        $set: {
          status: 'completed', completedAt: new Date(),
          collectionCount: grouped.size, indexCount: manifest.length,
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
  grouped: ReadonlyMap<string, readonly PhaseThreeIndexDefinition[]>,
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
  if (database === undefined) throw new Error('PHASE3_INDEX_DATABASE_UNAVAILABLE');
  const locks = database.collection<MigrationLock>('system_migration_locks');
  const now = new Date();
  try {
    await locks.insertOne({ _id: LOCK_ID, owner, expiresAt: new Date(now.getTime() + LOCK_TTL_MS) });
    return;
  } catch (error) {
    if (!isRecord(error) || error.code !== 11_000) throw error;
  }
  const claimed = await locks.findOneAndUpdate(
    { _id: LOCK_ID, expiresAt: { $lte: now } },
    { $set: { owner, expiresAt: new Date(now.getTime() + LOCK_TTL_MS) } },
    { returnDocument: 'after' },
  );
  if (claimed?.owner !== owner) throw new Error('PHASE3_INDEX_MIGRATION_LOCKED');
}

function groupManifest(manifest: readonly PhaseThreeIndexDefinition[]) {
  const grouped = new Map<string, PhaseThreeIndexDefinition[]>();
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
  if (!(error instanceof Error)) return 'PHASE3_INDEX_UNKNOWN_FAILURE';
  return /^PHASE3_INDEX_[A-Z_]{1,96}$/.test(error.message)
    ? error.message
    : 'PHASE3_INDEX_DATABASE_FAILURE';
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
    const result = await runPhaseThreeIndexMigration(connection, args.includes('--dry-run'));
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
