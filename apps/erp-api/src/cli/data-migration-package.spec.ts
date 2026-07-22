import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  canonicalJson,
  digest,
  EMPTY_MIGRATION_CHECKSUM,
  migrationSourceFactHash,
  roll,
} from '../modules/data-migration/data-migration-checksum.js';
import { validateMigrationPackage } from './data-migration-package.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) =>
    rm(directory, { recursive: true, force: true })));
});

async function packageDirectory(overrides: Readonly<Record<string, unknown>> = {}): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'gaoq-migration-package-'));
  temporaryDirectories.push(directory);
  const payload = { code: 'POS-001', name: '产品经理', status: 'active' };
  const record = {
    sequence: 1,
    sourceRecordId: 'legacy-position-001',
    sourceVersion: '1',
    entityType: 'org.position' as const,
    payload,
    payloadHash: digest(canonicalJson(payload)),
    associationSourceIds: [],
    attachments: [],
  };
  const sourceChecksum = roll(
    EMPTY_MIGRATION_CHECKSUM, record.sequence, migrationSourceFactHash(record),
  );
  const manifest = {
    formatVersion: 1,
    sourceSystem: 'legacy-hr',
    sourceRunId: 'full-001',
    mode: 'full',
    scope: 'org_reference',
    expectedSourceCount: 1,
    expectedSourceChecksum: sourceChecksum,
    ...overrides,
  };
  await Promise.all([
    writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest), 'utf8'),
    writeFile(join(directory, 'records.ndjson'), `${JSON.stringify(record)}\n`, 'utf8'),
  ]);
  return directory;
}

describe('数据迁移来源包 CLI', () => {
  it('流式校验连续序号、payload 摘要与来源滚动校验和', async () => {
    const directory = await packageDirectory();
    await expect(validateMigrationPackage(directory)).resolves.toMatchObject({
      recordCount: 1,
      manifest: { sourceRunId: 'full-001', scope: 'org_reference' },
    });
  });

  it('来源控制总数不一致时在调用 ERP 前失败', async () => {
    const directory = await packageDirectory({ expectedSourceCount: 2 });
    await expect(validateMigrationPackage(directory))
      .rejects.toThrow('DATA_MIGRATION_PACKAGE_SOURCE_COUNT_MISMATCH');
  });

  it('来源滚动校验和不一致时在调用 ERP 前失败', async () => {
    const directory = await packageDirectory({ expectedSourceChecksum: 'x'.repeat(43) });
    await expect(validateMigrationPackage(directory))
      .rejects.toThrow('DATA_MIGRATION_PACKAGE_SOURCE_CHECKSUM_MISMATCH');
  });
});
