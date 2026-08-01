import type { Job } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';

import type { DataMigrationAttachmentService } from './application/data-migration-attachment.service.js';
import { DataMigrationAttachmentProcessor } from './data-migration-attachment.processor.js';
import {
  assertDataMigrationAttachmentJobData,
  assertDataMigrationAttachmentJobId,
  createDataMigrationAttachmentJobId,
  DATA_MIGRATION_ATTACHMENT_TRANSFER_JOB,
  type DataMigrationAttachmentJobData,
} from './data-migration-attachment.queue.js';

const DATA: DataMigrationAttachmentJobData = Object.freeze({
  tenantId: 'tenant-001',
  runId: '01J8ZQK7V0A2M4N6P8R0T2W4F1',
  dispatchId: '01J8ZQK7V0A2M4N6P8R0T2W4F2',
});

function job(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    name: DATA_MIGRATION_ATTACHMENT_TRANSFER_JOB,
    id: createDataMigrationAttachmentJobId(DATA),
    data: DATA,
    ...overrides,
  } as unknown as Job<DataMigrationAttachmentJobData>;
}

describe('数据迁移附件队列边界', () => {
  it('相同完整载荷生成相同 JobId，任一控制标识变化都会改变 JobId', () => {
    const original = createDataMigrationAttachmentJobId(DATA);
    expect(createDataMigrationAttachmentJobId({ ...DATA })).toBe(original);
    expect(createDataMigrationAttachmentJobId({
      ...DATA,
      tenantId: 'tenant-002',
    })).not.toBe(original);
    expect(createDataMigrationAttachmentJobId({
      ...DATA,
      runId: '01J8ZQK7V0A2M4N6P8R0T2W4F3',
    })).not.toBe(original);
    expect(createDataMigrationAttachmentJobId({
      ...DATA,
      dispatchId: '01J8ZQK7V0A2M4N6P8R0T2W4F4',
    })).not.toBe(original);
    expect(original).toMatch(/^data_migration_attachment_[A-Za-z0-9_-]{43}$/u);
  });

  it.each([
    null,
    [],
    {},
    { ...DATA, tenantId: '*invalid' },
    { ...DATA, runId: 'bad' },
    { ...DATA, dispatchId: 'bad' },
    { ...DATA, secret: 'forbidden' },
  ])('拒绝受损或扩张的队列载荷 %#', (value) => {
    expect(() => assertDataMigrationAttachmentJobData(value))
      .toThrow('DATA_MIGRATION_ATTACHMENT_JOB_DATA_INVALID');
  });

  it.each([undefined, 7, 'bad', `data_migration_attachment_${'x'.repeat(42)}`])(
    '拒绝非法 JobId %s',
    (value) => {
      expect(() => assertDataMigrationAttachmentJobId(value))
        .toThrow('DATA_MIGRATION_ATTACHMENT_JOB_ID_INVALID');
    },
  );
});

describe('DataMigrationAttachmentProcessor', () => {
  it('重算 JobId 后才调用应用服务', async () => {
    const service = { process: vi.fn() };
    const processor = new DataMigrationAttachmentProcessor(
      service as unknown as DataMigrationAttachmentService,
    );

    await expect(processor.process(job())).resolves.toBeUndefined();

    expect(service.process).toHaveBeenCalledWith(DATA);
  });

  it('拒绝未知任务名称', async () => {
    const service = { process: vi.fn() };
    const processor = new DataMigrationAttachmentProcessor(
      service as unknown as DataMigrationAttachmentService,
    );

    await expect(processor.process(job({ name: 'unknown' })))
      .rejects.toThrow('DATA_MIGRATION_ATTACHMENT_JOB_UNKNOWN');
    expect(service.process).not.toHaveBeenCalled();
  });

  it('拒绝合法形态但与载荷不匹配的 JobId', async () => {
    const service = { process: vi.fn() };
    const processor = new DataMigrationAttachmentProcessor(
      service as unknown as DataMigrationAttachmentService,
    );
    const otherId = createDataMigrationAttachmentJobId({
      ...DATA,
      dispatchId: '01J8ZQK7V0A2M4N6P8R0T2W4F4',
    });

    await expect(processor.process(job({ id: otherId })))
      .rejects.toThrow('DATA_MIGRATION_ATTACHMENT_JOB_ID_MISMATCH');
    expect(service.process).not.toHaveBeenCalled();
  });

  it('在应用服务前拒绝非法 JobId 与载荷', async () => {
    const service = { process: vi.fn() };
    const processor = new DataMigrationAttachmentProcessor(
      service as unknown as DataMigrationAttachmentService,
    );

    await expect(processor.process(job({ id: 'bad' })))
      .rejects.toThrow('DATA_MIGRATION_ATTACHMENT_JOB_ID_INVALID');
    await expect(processor.process(job({
      data: { ...DATA, tenantId: '*invalid' },
    }))).rejects.toThrow('DATA_MIGRATION_ATTACHMENT_JOB_DATA_INVALID');
    expect(service.process).not.toHaveBeenCalled();
  });
});
