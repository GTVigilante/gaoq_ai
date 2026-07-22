import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  canonicalJson,
  digest,
  EMPTY_MIGRATION_CHECKSUM,
  migrationSourceFactHash,
  roll,
} from '../modules/data-migration/data-migration-checksum.js';
import {
  exportMigrationEvidence,
  validateMigrationPackage,
} from './data-migration-package.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) =>
    rm(directory, { recursive: true, force: true })));
});

async function packageDirectory(
  overrides: Readonly<Record<string, unknown>> = {},
  recordOverrides: Readonly<Record<string, unknown>> = {},
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'gaoq-migration-package-'));
  temporaryDirectories.push(directory);
  const payload = { code: 'POS-001', name: '产品经理', status: 'active' };
  const draftRecord = {
    sequence: 1,
    sourceRecordId: 'legacy-position-001',
    sourceVersion: '1',
    entityType: 'org.position' as const,
    payload,
    payloadHash: '',
    associationSourceIds: [],
    attachments: [],
    ...recordOverrides,
  };
  const record = {
    ...draftRecord,
    payloadHash: digest(canonicalJson(draftRecord.payload)),
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

  it('统一白名单允许劳动关系独立来源包', async () => {
    const payload = {
      employeeSourceId: 'legacy-employee-001', sourcePersonId: 'legacy-person-001',
      identityEvidenceId: 'identity-evidence-001',
      onboardingInstanceId: 'legacy-onboarding-001',
      onboardingCompletionEvidenceId: 'onboarding-evidence-001',
      offerId: 'legacy-offer-001', signedEvidenceId: 'signed-evidence-001',
      status: 'active', effectiveFrom: '2018-01-01', effectiveTo: null,
      terminationCareCaseId: null, terminationExecutionEvidenceId: null,
      terminationEvidenceId: null,
    };
    const directory = await packageDirectory(
      { scope: 'org_employment', sourceRunId: 'employment-001' },
      {
        entityType: 'org.employment', sourceRecordId: 'legacy-employment-001', payload,
        associationSourceIds: ['legacy-employee-001'],
      },
    );
    await expect(validateMigrationPackage(directory)).resolves.toMatchObject({
      manifest: { scope: 'org_employment' }, recordCount: 1,
    });
  });

  it('统一白名单允许审批模板独立来源包', async () => {
    const payload = {
      code: 'LEGACY_EXPENSE', name: '历史费用审批', riskLevel: 'R2', revision: 1,
      status: 'published',
      definition: {
        fields: [{
          key: 'amount', label: '金额', type: 'money_minor', required: true, sensitivity: 'L2',
        }],
        nodes: [{
          id: 'manager', name: '经理审批', type: 'approval', approvalMode: 'all',
          resolver: { type: 'initiator_manager' },
        }],
      },
      createdByEmployeeSourceId: 'legacy-employee-editor',
      updatedByEmployeeSourceId: 'legacy-employee-approver',
      approvedByEmployeeSourceId: 'legacy-employee-approver',
      governanceEvidenceSourceAttachmentId: 'legacy-template-evidence-001',
      publishedAt: '2020-01-02T00:00:00.000Z', retiredAt: null,
      createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-02T00:00:00.000Z',
    };
    const directory = await packageDirectory(
      { scope: 'approval_templates', sourceRunId: 'approval-templates-001' },
      {
        entityType: 'approval.template', sourceRecordId: 'legacy-template-001', payload,
        associationSourceIds: ['legacy-employee-editor', 'legacy-employee-approver'],
        attachments: [{
          sourceAttachmentId: 'legacy-template-evidence-001', checksum: 'a'.repeat(43),
        }],
      },
    );
    await expect(validateMigrationPackage(directory)).resolves.toMatchObject({
      manifest: { scope: 'approval_templates' }, recordCount: 1,
    });
  });

  it('导出逐页验证页面校验和并生成全量证据封印', async () => {
    const runId = '01J8ZQK7V0A2M4N6P8R0T2W4F1';
    const report = {
      runId, status: 'failed', phaseSixEligible: false,
      counts: { applied: 0, duplicate: 0, rejected: 1 },
      associationCount: 0, attachmentCount: 0,
    };
    const pages = [
      evidencePage(runId, 'items', [{ sequence: 1, status: 'rejected' }]),
      evidencePage(runId, 'associations', []),
      evidencePage(runId, 'attachments', []),
    ];
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(report));
    for (const page of pages) fetchMock.mockResolvedValueOnce(jsonResponse(page));
    vi.stubGlobal('fetch', fetchMock);
    const lines: Readonly<Record<string, unknown>>[] = [];

    const seal = await exportMigrationEvidence(runId, {
      ERP_API_BASE_URL: 'https://erp.example.test/api',
      ERP_MIGRATION_TOKEN: 'migration-token-at-least-twenty-characters',
    }, (line) => lines.push(line));

    expect(seal).toMatchObject({
      recordType: 'seal', runId, recordCount: 2,
      counts: { items: 1, associations: 0, attachments: 0 },
    });
    expect(lines).toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(JSON.stringify(lines)).not.toContain('migration-token-at-least-twenty-characters');
  });
});

function evidencePage(
  runId: string,
  kind: 'items' | 'associations' | 'attachments',
  records: readonly Readonly<Record<string, unknown>>[],
) {
  const body = { runId, kind, records, nextCursor: null };
  return { ...body, pageChecksum: digest(canonicalJson(body)) };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
}
