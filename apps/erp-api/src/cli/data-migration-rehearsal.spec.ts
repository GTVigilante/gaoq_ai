import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  canonicalJson,
  digest,
  EMPTY_MIGRATION_CHECKSUM,
  roll,
} from '../modules/data-migration/data-migration-checksum.js';
import {
  compareMigrationRehearsals,
  verifyMigrationEvidenceArtifact,
} from './data-migration-rehearsal.js';

const temporaryDirectories: string[] = [];
const RUN_IDS = [
  '01J8ZQK7V0A2M4N6P8R0T2W4F1',
  '01J8ZQK7V0A2M4N6P8R0T2W4F2',
  '01J8ZQK7V0A2M4N6P8R0T2W4F3',
] as const;

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe('迁移演练证据门禁', () => {
  it('三次独立全量演练控制量与目标校验和一致时生成比较封印', async () => {
    const paths = await Promise.all([
      evidenceArtifact(RUN_IDS[0], { applied: 1, duplicate: 0, rejected: 0 }),
      evidenceArtifact(RUN_IDS[1], { applied: 0, duplicate: 1, rejected: 0 }),
      evidenceArtifact(RUN_IDS[2], { applied: 0, duplicate: 1, rejected: 0 }),
    ]);

    const result = await compareMigrationRehearsals(paths);

    expect(result).toMatchObject({
      qualified: true,
      rehearsalCount: 3,
      expectedSourceCount: 1,
      associationCount: 1,
      attachmentCount: 1,
    });
    expect(result.runs.map((run) => run.runId)).toEqual(RUN_IDS);
    expect(result.comparisonChecksum).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });

  it('证据行被修改但未重新封印时失败关闭', async () => {
    const path = await evidenceArtifact(RUN_IDS[0], { applied: 1, duplicate: 0, rejected: 0 }, {
      evidenceTargetId: 'employee-tampered',
      sealBeforeTampering: true,
    });

    await expect(verifyMigrationEvidenceArtifact(path))
      .rejects.toThrow('DATA_MIGRATION_PACKAGE_REHEARSAL_SEAL_INVALID');
  });

  it('三次演练的目标校验和不一致时拒绝生成通过结论', async () => {
    const first = await evidenceArtifact(RUN_IDS[0], { applied: 1, duplicate: 0, rejected: 0 });
    const second = await evidenceArtifact(
      RUN_IDS[1], { applied: 0, duplicate: 1, rejected: 0 }, { targetHash: 'x'.repeat(43) },
    );
    const third = await evidenceArtifact(RUN_IDS[2], { applied: 0, duplicate: 1, rejected: 0 });

    await expect(compareMigrationRehearsals([first, second, third]))
      .rejects.toThrow('DATA_MIGRATION_PACKAGE_REHEARSAL_CONTROL_TOTAL_MISMATCH');
  });

  it('存在拒绝记录的演练不能进入三次演练比较', async () => {
    const failure = {
      status: 'failed', phaseSixEligible: false, differences: [
        { code: 'REJECTED_RECORDS', severity: 'critical', count: 1 },
      ],
    };
    const paths = await Promise.all([
      evidenceArtifact(RUN_IDS[0], { applied: 0, duplicate: 0, rejected: 1 }, failure),
      evidenceArtifact(RUN_IDS[1], { applied: 0, duplicate: 0, rejected: 1 }, failure),
      evidenceArtifact(RUN_IDS[2], { applied: 0, duplicate: 0, rejected: 1 }, failure),
    ]);

    await expect(compareMigrationRehearsals(paths))
      .rejects.toThrow('DATA_MIGRATION_PACKAGE_REHEARSAL_RUN_NOT_QUALIFIED');
  });
});

async function evidenceArtifact(
  runId: string,
  counts: { applied: number; duplicate: number; rejected: number },
  overrides: Readonly<Record<string, unknown>> = {},
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'gaoq-migration-evidence-'));
  temporaryDirectories.push(directory);
  const sourceFactHash = 'f'.repeat(43);
  const targetHash = typeof overrides.targetHash === 'string'
    ? overrides.targetHash : 't'.repeat(43);
  const sourceChecksum = roll(EMPTY_MIGRATION_CHECKSUM, 1, sourceFactHash);
  const targetChecksum = roll(EMPTY_MIGRATION_CHECKSUM, 1, targetHash);
  const report = {
    runId,
    sourceSystem: 'legacy-hr',
    mode: 'full',
    scope: 'org_workforce',
    status: 'completed',
    expectedSourceCount: 1,
    checkpoint: 1,
    counts,
    sourceChecksum,
    expectedSourceChecksum: sourceChecksum,
    targetChecksum,
    associationCount: 1,
    unresolvedAssociationCount: 0,
    attachmentCount: 1,
    pendingAttachmentCount: 0,
    differences: overrides.differences ?? [],
    phaseSixEligible: overrides.phaseSixEligible ?? true,
    ...(overrides.status === undefined ? {} : { status: overrides.status }),
  };
  const originalEvidence = {
    recordType: 'items', data: {
      sequence: 1, status: counts.rejected === 0
        ? (counts.applied === 1 ? 'applied' : 'duplicate') : 'rejected',
      sourceFactHash,
      targetId: counts.rejected === 0 ? 'employee-001' : null,
      targetHash: counts.rejected === 0 ? targetHash : null,
    },
  };
  const lines: Readonly<Record<string, unknown>>[] = [
    { formatVersion: 1, recordType: 'report', data: report },
    { formatVersion: 1, ...originalEvidence },
    {
      formatVersion: 1, recordType: 'associations',
      data: { sequence: 1, status: 'resolved' },
    },
    {
      formatVersion: 1,
      recordType: 'attachments',
      data: { sequence: 1, status: 'verified', targetEvidenceId: 'worm/file-001' },
    },
  ];
  let checksum = EMPTY_MIGRATION_CHECKSUM;
  lines.forEach((line, index) => {
    checksum = roll(checksum, index + 1, digest(canonicalJson(line)));
  });
  if (overrides.sealBeforeTampering === true) {
    lines[1] = {
      formatVersion: 1,
      recordType: 'items', data: {
        sequence: 1, status: 'applied', sourceFactHash, targetHash,
        targetId: overrides.evidenceTargetId,
      },
    };
  }
  lines.push({
    formatVersion: 1, recordType: 'seal', runId, recordCount: 4,
    counts: { items: 1, associations: 1, attachments: 1 },
    artifactChecksum: checksum,
  });
  const path = join(directory, 'evidence.ndjson');
  await writeFile(path, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, {
    encoding: 'utf8', mode: 0o600,
  });
  return path;
}
