import { pathToFileURL } from 'node:url';

import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { createConnection, type Connection } from 'mongoose';

import { buildCareConsentExpiryJob } from '../modules/care/care-consent-expiry-job.js';
import {
  CARE_EXECUTION_QUEUE,
  type CareJobData,
} from '../modules/care/care-execution.queue.js';

const MIGRATION_ID = 'phase-3-care-consent-expiry-jobs-v1';
const BATCH_SIZE = 500;

interface ActiveConsentRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly expiresAt: Date;
}

export interface CareConsentExpiryBackfillResult {
  readonly scanned: number;
  readonly due: number;
  readonly scheduled: number;
}

export async function runCareConsentExpiryJobBackfill(
  connection: Connection,
  queue: Pick<Queue<CareJobData>, 'addBulk'> | null,
  now = Date.now(),
): Promise<CareConsentExpiryBackfillResult> {
  const records = connection.collection<ActiveConsentRecord>('care_alumni_consents');
  let scanned = 0;
  let due = 0;
  let scheduled = 0;
  let batch: ReturnType<typeof buildCareConsentExpiryJob>[] = [];
  const cursor = records.find(
    { status: 'active' },
    { projection: { _id: 0, id: 1, tenantId: 1, expiresAt: 1 } },
  ).sort({ tenantId: 1, id: 1 }).batchSize(BATCH_SIZE);

  for await (const record of cursor) {
    const job = buildCareConsentExpiryJob({
      tenantId: record.tenantId,
      consentId: record.id,
      expiresAt: record.expiresAt.toISOString(),
    }, now);
    scanned += 1;
    if ((job.opts.delay ?? 0) === 0) due += 1;
    if (queue === null) continue;
    batch.push(job);
    if (batch.length < BATCH_SIZE) continue;
    await queue.addBulk(batch);
    scheduled += batch.length;
    batch = [];
  }
  if (queue !== null && batch.length > 0) {
    await queue.addBulk(batch);
    scheduled += batch.length;
  }
  return Object.freeze({ scanned, due, scheduled });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((arg) => arg !== '--');
  if (args.length !== 1 || !['--dry-run', '--apply'].includes(args[0] ?? '')) {
    throw new Error('PHASE3_CARE_EXPIRY_ARGUMENT_INVALID');
  }
  const apply = args[0] === '--apply';
  const mongoUri = process.env.MONGODB_URI;
  if (mongoUri === undefined || !mongoUri.startsWith('mongodb://')) {
    throw new Error('PHASE3_CARE_EXPIRY_MONGODB_URI_REQUIRED');
  }
  const redisUrl = process.env.REDIS_URL;
  if (apply && (redisUrl === undefined || !redisUrl.startsWith('redis://'))) {
    throw new Error('PHASE3_CARE_EXPIRY_REDIS_URL_REQUIRED');
  }
  const connection = createConnection(mongoUri, {
    autoIndex: false, serverSelectionTimeoutMS: 5_000,
  });
  let redis: Redis | null = null;
  let queue: Queue<CareJobData> | null = null;
  try {
    await connection.asPromise();
    if (apply && redisUrl !== undefined) {
      redis = new Redis(redisUrl, {
        enableReadyCheck: true, lazyConnect: true, maxRetriesPerRequest: null,
      });
      await redis.connect();
      queue = new Queue<CareJobData>(CARE_EXECUTION_QUEUE, { connection: redis });
    }
    const preview = await runCareConsentExpiryJobBackfill(connection, null);
    const result = apply
      ? await runCareConsentExpiryJobBackfill(connection, queue)
      : preview;
    process.stdout.write(`${JSON.stringify({
      migrationId: MIGRATION_ID, mode: apply ? 'apply' : 'dry-run', ...result,
    })}\n`);
  } finally {
    await queue?.close();
    await redis?.quit();
    await connection.close();
  }
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  void main().catch((error: unknown) => {
    const code = error instanceof Error &&
      /^PHASE3_CARE_EXPIRY_[A-Z_]{1,96}$/.test(error.message)
      ? error.message
      : 'PHASE3_CARE_EXPIRY_EXECUTION_FAILED';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
