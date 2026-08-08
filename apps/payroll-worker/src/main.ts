import { Worker } from 'bullmq';

import {
  processPayrollCalculationJob,
  type PayrollCalculationJob,
} from './calculation.processor.js';
import {
  synchronizeMasterData,
  type MasterDataSyncConfig,
} from './master-data-sync.js';

const redisUrl = process.env.REDIS_URL;
if (redisUrl === undefined || !redisUrl.startsWith('redis://')) {
  throw new Error('REDIS_URL 必须使用 redis://');
}
const parsed = new URL(redisUrl);
const worker = new Worker<PayrollCalculationJob>(
  'payroll-calculation',
  (job) => Promise.resolve(processPayrollCalculationJob(job.data)),
  {
    connection: {
      host: parsed.hostname,
      port: parsed.port === '' ? 6379 : Number(parsed.port),
      ...(parsed.password === '' ? {} : { password: parsed.password }),
      db: parsed.pathname.length > 1 ? Number(parsed.pathname.slice(1)) : 0,
    },
    concurrency: Number(process.env.PAYROLL_WORKER_CONCURRENCY ?? '4'),
  },
);

worker.on('failed', (job, error) => {
  console.error(JSON.stringify({
    level: 'error',
    message: '算薪任务失败',
    jobId: job?.id ?? 'unknown',
    errorName: error.name,
  }));
});

const masterDataSyncEnabled = process.env.MASTER_DATA_SYNC_ENABLED === 'true';
let masterDataTimer: NodeJS.Timeout | undefined;

const masterDataConfig = (): MasterDataSyncConfig => {
  const required = {
    tokenUrl: process.env.GAOQ_OAUTH_TOKEN_URL,
    clientId: process.env.GAOQ_SYNC_CLIENT_ID,
    clientSecret: process.env.GAOQ_SYNC_CLIENT_SECRET,
    erpResource: process.env.GAOQ_ERP_RESOURCE,
    payrollResource: process.env.GAOQ_PAYROLL_RESOURCE,
    erpApiUrl: process.env.GAOQ_ERP_API_URL,
    payrollApiUrl: process.env.PAYROLL_API_URL,
  };
  if (Object.values(required).some((value) => value === undefined || value === '')) {
    throw new Error('主数据同步已启用，但 GaoQ 双资源 OAuth 配置不完整');
  }
  return required as MasterDataSyncConfig;
};

if (masterDataSyncEnabled) {
  const config = masterDataConfig();
  const synchronize = async (): Promise<void> => {
    try {
      const result = await synchronizeMasterData(config);
      console.info(JSON.stringify({
        level: 'info',
        message: 'ERP 主数据快照同步完成',
        snapshotId: result.snapshotId,
        pageCount: result.pageCount,
      }));
    } catch (error) {
      console.error(JSON.stringify({
        level: 'error',
        message: 'ERP 主数据快照同步失败',
        errorName: error instanceof Error ? error.name : 'UnknownError',
      }));
    }
  };
  void synchronize();
  const interval = Number(process.env.MASTER_DATA_SYNC_INTERVAL_MS ?? '300000');
  if (!Number.isInteger(interval) || interval < 60_000) {
    throw new Error('MASTER_DATA_SYNC_INTERVAL_MS 必须是不小于 60000 的整数');
  }
  masterDataTimer = setInterval(() => { void synchronize(); }, interval);
}

const shutdown = async (): Promise<void> => {
  if (masterDataTimer !== undefined) clearInterval(masterDataTimer);
  await worker.close();
  process.exitCode = 0;
};

process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });
