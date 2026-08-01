import { createHash } from 'node:crypto';

import { ULID_PATTERN } from '@gaoq/shared-utils';

export const DATA_MIGRATION_ATTACHMENT_QUEUE = 'data-migration-attachment';
export const DATA_MIGRATION_ATTACHMENT_TRANSFER_JOB = 'data-migration.attachment.transfer';
const TENANT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const JOB_ID_PATTERN = /^data_migration_attachment_[A-Za-z0-9_-]{43}$/;

export interface DataMigrationAttachmentJobData {
  readonly tenantId: string;
  readonly runId: string;
  readonly dispatchId: string;
}

/** 队列载荷只允许租户、运行和本次派发标识，禁止附件或凭据进入 Redis。 */
export function assertDataMigrationAttachmentJobData(
  value: unknown,
): asserts value is DataMigrationAttachmentJobData {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'dispatchId,runId,tenantId'
  ) throw new Error('DATA_MIGRATION_ATTACHMENT_JOB_DATA_INVALID');
  const candidate = value as Partial<DataMigrationAttachmentJobData>;
  if (
    typeof candidate.tenantId !== 'string' ||
    !TENANT_ID_PATTERN.test(candidate.tenantId) ||
    typeof candidate.runId !== 'string' ||
    !ULID_PATTERN.test(candidate.runId) ||
    typeof candidate.dispatchId !== 'string' ||
    !ULID_PATTERN.test(candidate.dispatchId)
  ) throw new Error('DATA_MIGRATION_ATTACHMENT_JOB_DATA_INVALID');
}

/** JobId 绑定完整载荷；Worker 必须重算，拒绝篡改或错路由任务。 */
export function createDataMigrationAttachmentJobId(
  data: DataMigrationAttachmentJobData,
): string {
  assertDataMigrationAttachmentJobData(data);
  const digest = createHash('sha256')
    .update(JSON.stringify([data.tenantId, data.runId, data.dispatchId]), 'utf8')
    .digest('base64url');
  return `data_migration_attachment_${digest}`;
}

export function assertDataMigrationAttachmentJobId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !JOB_ID_PATTERN.test(value)) {
    throw new Error('DATA_MIGRATION_ATTACHMENT_JOB_ID_INVALID');
  }
}
