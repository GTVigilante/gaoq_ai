import 'reflect-metadata';

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';

import {
  ApplyDataMigrationRecordDto,
  CreateDataMigrationRunDto,
  DataMigrationEvidenceQueryDto,
} from './data-migration.dto.js';

const HASH = 'a'.repeat(43);

async function errors<T extends object>(
  type: new () => T,
  value: Readonly<Record<string, unknown>>,
) {
  return validate(plainToInstance(type, value), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
}

function validRun(): Record<string, unknown> {
  return {
    sourceSystem: 'legacy-hr',
    sourceRunId: 'snapshot_2026-07-28',
    mode: 'full',
    scope: 'recruitment_candidates',
    expectedSourceCount: 1,
    expectedSourceChecksum: HASH,
  };
}

function validRecord(): Record<string, unknown> {
  return {
    sequence: 1,
    sourceRecordId: 'candidate-001',
    sourceVersion: 'v1.2026-07-28',
    entityType: 'recruitment.candidate',
    payload: { legacyCode: 'C-001' },
    payloadHash: HASH,
    associationSourceIds: ['position-001'],
    attachments: [{
      sourceAttachmentId: 'resume-001',
      checksum: HASH,
    }],
  };
}

describe('数据迁移 DTO', () => {
  it.each(['full', 'incremental'] as const)('接受合法 %s 运行声明', async (mode) => {
    await expect(errors(CreateDataMigrationRunDto, { ...validRun(), mode }))
      .resolves.toHaveLength(0);
  });

  it.each([
    ['sourceSystem', 'contains space'],
    ['sourceRunId', ''],
    ['mode', 'replace'],
    ['scope', 'all_tables'],
    ['expectedSourceCount', -1],
    ['expectedSourceCount', 10_000_001],
    ['expectedSourceChecksum', 'not-a-hash'],
  ])('拒绝非法运行字段 %s=%s', async (field, value) => {
    const result = await errors(CreateDataMigrationRunDto, {
      ...validRun(),
      [field]: value,
    });
    expect(result.some((item) => item.property === field)).toBe(true);
  });

  it('拒绝运行声明额外字段，避免客户端注入租户或执行主体', async () => {
    const result = await errors(CreateDataMigrationRunDto, {
      ...validRun(),
      tenantId: 'tenant-forged',
    });
    expect(result.some((item) => item.property === 'tenantId')).toBe(true);
  });

  it('接受有界关联与嵌套附件摘要的合法迁移记录', async () => {
    await expect(errors(ApplyDataMigrationRecordDto, validRecord()))
      .resolves.toHaveLength(0);
  });

  it.each([
    ['sequence', 0],
    ['sequence', 10_000_001],
    ['sourceRecordId', '../candidate'],
    ['sourceVersion', 'contains space'],
    ['sourceVersion', 'line\nbreak'],
    ['sourceVersion', 'v'.repeat(65)],
    ['entityType', 'database.raw'],
    ['payload', null],
    ['payloadHash', 'bad'],
    ['associationSourceIds', ['valid', 'contains space']],
  ])('拒绝非法记录字段 %s', async (field, value) => {
    const result = await errors(ApplyDataMigrationRecordDto, {
      ...validRecord(),
      [field]: value,
    });
    expect(result.some((item) => item.property === field)).toBe(true);
  });

  it('拒绝过量关联，避免单条记录放大查询与内存消耗', async () => {
    const result = await errors(ApplyDataMigrationRecordDto, {
      ...validRecord(),
      associationSourceIds: Array.from({ length: 20_001 }, (_, index) => `id-${index}`),
    });
    expect(result.some((item) => item.property === 'associationSourceIds')).toBe(true);
  });

  it('嵌套附件拒绝非法摘要和额外来源凭据字段', async () => {
    const result = await errors(ApplyDataMigrationRecordDto, {
      ...validRecord(),
      attachments: [{
        sourceAttachmentId: 'resume-001',
        checksum: 'bad',
        sourceToken: 'forbidden',
      }],
    });
    const attachmentError = result.find((item) => item.property === 'attachments');
    expect(attachmentError?.children?.[0]?.children?.map((item) => item.property))
      .toEqual(expect.arrayContaining(['checksum', 'sourceToken']));
  });

  it('附件数组最多二十项', async () => {
    const result = await errors(ApplyDataMigrationRecordDto, {
      ...validRecord(),
      attachments: Array.from({ length: 21 }, (_, index) => ({
        sourceAttachmentId: `attachment-${index}`,
        checksum: HASH,
      })),
    });
    expect(result.some((item) => item.property === 'attachments')).toBe(true);
  });

  it.each(['items', 'associations', 'attachments'] as const)(
    '证据查询接受固定 kind=%s 并把 limit 转为整数',
    async (kind) => {
      const query = plainToInstance(DataMigrationEvidenceQueryDto, {
        kind,
        limit: '500',
        cursor: 'cursor_001',
      });
      await expect(validate(query)).resolves.toHaveLength(0);
      expect(query.limit).toBe(500);
    },
  );

  it('证据查询缺省 limit 为 200', async () => {
    const query = plainToInstance(DataMigrationEvidenceQueryDto, { kind: 'items' });
    await expect(validate(query)).resolves.toHaveLength(0);
    expect(query.limit).toBe(200);
  });

  it.each([
    ['kind', 'raw'],
    ['limit', 0],
    ['limit', 501],
    ['limit', '1.5'],
    ['cursor', 'cursor/with/slash'],
    ['cursor', 'x'.repeat(513)],
  ])('证据查询拒绝非法字段 %s', async (field, value) => {
    const result = await errors(DataMigrationEvidenceQueryDto, {
      kind: 'items',
      limit: 200,
      [field]: value,
    });
    expect(result.some((item) => item.property === field)).toBe(true);
  });
});
