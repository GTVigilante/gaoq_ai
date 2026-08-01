import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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
  applyMigrationPackage,
  exportMigrationEvidence,
  readMigrationRecords,
  runMigrationPackageCommand,
  validateMigrationPackage,
  type MigrationPackageRecord,
} from './data-migration-package.js';

const temporaryDirectories: string[] = [];
const RUN_ID = '01J8ZQK7V0A2M4N6P8R0T2W4F1';

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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

async function readPackageRecord(directory: string): Promise<Record<string, unknown>> {
  return JSON.parse(
    (await readFile(join(directory, 'records.ndjson'), 'utf8')).trim(),
  ) as Record<string, unknown>;
}

async function writePackageRecords(
  directory: string,
  records: readonly Readonly<Record<string, unknown>>[],
): Promise<void> {
  await writeFile(
    join(directory, 'records.ndjson'),
    records.map((record) => JSON.stringify(record)).join('\n') + '\n',
    'utf8',
  );
}

function migrationEnvironment(
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    ERP_API_BASE_URL: 'https://erp.example.test/api',
    ERP_MIGRATION_TOKEN: 'migration-token-at-least-twenty-characters',
    ...overrides,
  };
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
    const runId = RUN_ID;
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

  it('拒绝序号缺口、重复来源、摘要漂移和范围越权', async () => {
    const sequenceGap = await packageDirectory({}, { sequence: 2 });
    await expect(validateMigrationPackage(sequenceGap))
      .rejects.toThrow('DATA_MIGRATION_PACKAGE_SEQUENCE_GAP');

    const duplicate = await packageDirectory();
    const duplicateRecord = await readPackageRecord(duplicate);
    await writePackageRecords(duplicate, [
      duplicateRecord,
      { ...duplicateRecord, sequence: 2 },
    ]);
    await expect(validateMigrationPackage(duplicate))
      .rejects.toThrow('DATA_MIGRATION_PACKAGE_SOURCE_RECORD_DUPLICATE');

    const hashMismatch = await packageDirectory();
    const hashRecord = await readPackageRecord(hashMismatch);
    await writePackageRecords(hashMismatch, [{ ...hashRecord, payloadHash: 'x'.repeat(43) }]);
    await expect(validateMigrationPackage(hashMismatch))
      .rejects.toThrow('DATA_MIGRATION_PACKAGE_PAYLOAD_HASH_MISMATCH');

    const outOfScope = await packageDirectory({}, { entityType: 'approval.template' });
    await expect(validateMigrationPackage(outOfScope))
      .rejects.toThrow('DATA_MIGRATION_PACKAGE_ENTITY_OUT_OF_SCOPE');
  });

  it('拒绝非法清单、记录、重复关联和重复附件', async () => {
    const invalidManifest = await packageDirectory();
    await writeFile(join(invalidManifest, 'manifest.json'), '{"formatVersion":2}', 'utf8');
    await expect(validateMigrationPackage(invalidManifest))
      .rejects.toThrow('DATA_MIGRATION_PACKAGE_MANIFEST_INVALID');

    const malformedRecord = await packageDirectory();
    await writeFile(join(malformedRecord, 'records.ndjson'), '{bad-json}\n', 'utf8');
    await expect(validateMigrationPackage(malformedRecord))
      .rejects.toThrow('DATA_MIGRATION_PACKAGE_RECORD_INVALID_AT_1');

    const duplicateAssociation = await packageDirectory({}, {
      associationSourceIds: ['employee-001', 'employee-001'],
    });
    await expect(validateMigrationPackage(duplicateAssociation))
      .rejects.toThrow('DATA_MIGRATION_PACKAGE_RECORD_INVALID_AT_1');

    const duplicateAttachment = await packageDirectory({}, {
      attachments: [
        { sourceAttachmentId: 'attachment-001', checksum: 'a'.repeat(43) },
        { sourceAttachmentId: 'attachment-001', checksum: 'b'.repeat(43) },
      ],
    });
    await expect(validateMigrationPackage(duplicateAttachment))
      .rejects.toThrow('DATA_MIGRATION_PACKAGE_RECORD_INVALID_AT_1');
  });

  it('流式读取拒绝空行和超大行，并阻止符号链接逃逸', async () => {
    const emptyLine = await packageDirectory();
    await writeFile(join(emptyLine, 'records.ndjson'), '\n', 'utf8');
    await expect(collectRecords(join(emptyLine, 'records.ndjson')))
      .rejects.toThrow('DATA_MIGRATION_PACKAGE_EMPTY_LINE');

    const largeLine = await packageDirectory();
    await writeFile(
      join(largeLine, 'records.ndjson'),
      'x'.repeat(8 * 1024 * 1024 + 1),
      'utf8',
    );
    await expect(collectRecords(join(largeLine, 'records.ndjson')))
      .rejects.toThrow('DATA_MIGRATION_PACKAGE_LINE_TOO_LARGE');

    const escaped = await packageDirectory();
    const external = await mkdtemp(join(tmpdir(), 'gaoq-migration-external-'));
    temporaryDirectories.push(external);
    await writeFile(join(external, 'manifest.json'), '{}', 'utf8');
    await rm(join(escaped, 'manifest.json'));
    await symlink(join(external, 'manifest.json'), join(escaped, 'manifest.json'));
    await expect(validateMigrationPackage(escaped))
      .rejects.toThrow('DATA_MIGRATION_PACKAGE_PATH_ESCAPE');
  });

  it('应用来源包时续传记录并在附件已完成后封账', async () => {
    const directory = await packageDirectory();
    const complete = { id: RUN_ID, status: 'completed' };
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ id: RUN_ID, checkpoint: 0 }))
      .mockResolvedValueOnce(jsonResponse({ sequence: 1 }))
      .mockResolvedValueOnce(jsonResponse({ pendingCount: 0 }))
      .mockResolvedValueOnce(jsonResponse(complete));
    vi.stubGlobal('fetch', fetchMock);

    await expect(applyMigrationPackage(directory, migrationEnvironment()))
      .resolves.toEqual(complete);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error' });
    expect(fetchMock.mock.calls[1]?.[0]).toContain(`/runs/${RUN_ID}/records`);
  });

  it('应用来源包时跳过检查点并等待待传附件', async () => {
    const directory = await packageDirectory();
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ id: RUN_ID, checkpoint: 1 }))
      .mockResolvedValueOnce(jsonResponse({ pendingCount: 1 }))
      .mockResolvedValueOnce(jsonResponse({ pendingAttachmentCount: 0 }))
      .mockResolvedValueOnce(jsonResponse({ id: RUN_ID, status: 'completed' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(applyMigrationPackage(directory, migrationEnvironment({
      ERP_MIGRATION_ATTACHMENT_WAIT_SECONDS: '10',
    }))).resolves.toMatchObject({ status: 'completed' });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[1]?.[0]).toContain('/attachments/transfer');
    expect(fetchMock.mock.calls[2]?.[0]).toContain('/report');
  });

  it('应用来源包拒绝非法端点、Token、运行响应和附件等待配置', async () => {
    const invalidEndpoints = [
      undefined,
      'not-a-url',
      'http://erp.example.test',
      'https://user:password@erp.example.test',
      'https://erp.example.test/api?token=secret',
      'https://erp.example.test/api#fragment',
    ];
    for (const endpoint of invalidEndpoints) {
      const directory = await packageDirectory();
      await expect(applyMigrationPackage(directory, migrationEnvironment({
        ERP_API_BASE_URL: endpoint,
      }))).rejects.toThrow('DATA_MIGRATION_PACKAGE_');
    }

    const tokenDirectory = await packageDirectory();
    await expect(applyMigrationPackage(tokenDirectory, migrationEnvironment({
      ERP_MIGRATION_TOKEN: 'short',
    }))).rejects.toThrow('DATA_MIGRATION_PACKAGE_TOKEN_REQUIRED');

    for (const run of [
      { id: 'invalid-run', checkpoint: 0 },
      { id: RUN_ID, checkpoint: '0' },
      { id: RUN_ID, checkpoint: -1 },
      { id: RUN_ID, checkpoint: 2 },
    ]) {
      const directory = await packageDirectory();
      vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse(run)));
      await expect(applyMigrationPackage(directory, migrationEnvironment()))
        .rejects.toThrow('DATA_MIGRATION_PACKAGE_');
    }

    for (const pendingCount of [-1, 1]) {
      const directory = await packageDirectory();
      vi.stubGlobal('fetch', vi.fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse({ id: RUN_ID, checkpoint: 1 }))
        .mockResolvedValueOnce(jsonResponse({ pendingCount })));
      await expect(applyMigrationPackage(directory, migrationEnvironment({
        ERP_MIGRATION_ATTACHMENT_WAIT_SECONDS: '9',
      }))).rejects.toThrow(
        pendingCount < 0
          ? 'DATA_MIGRATION_PACKAGE_RESPONSE_INVALID'
          : 'DATA_MIGRATION_PACKAGE_ATTACHMENT_WAIT_INVALID',
      );
    }
  });

  it('附件等待超过截止时间时失败关闭', async () => {
    const directory = await packageDirectory();
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValueOnce(0).mockReturnValueOnce(10_000);
    vi.stubGlobal('fetch', vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ id: RUN_ID, checkpoint: 1 }))
      .mockResolvedValueOnce(jsonResponse({ pendingCount: 1 })));

    await expect(applyMigrationPackage(directory, migrationEnvironment({
      ERP_MIGRATION_ATTACHMENT_WAIT_SECONDS: '10',
    }))).rejects.toThrow('DATA_MIGRATION_PACKAGE_ATTACHMENT_WAIT_TIMEOUT');
  });

  it('附件轮询按固定间隔继续并在控制总数归零后完成', async () => {
    const directory = await packageDirectory();
    const timeout = vi.fn((callback: () => void) => {
      callback();
      return 0;
    });
    vi.stubGlobal('setTimeout', timeout);
    vi.stubGlobal('fetch', vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ id: RUN_ID, checkpoint: 1 }))
      .mockResolvedValueOnce(jsonResponse({ pendingCount: 1 }))
      .mockResolvedValueOnce(jsonResponse({ pendingAttachmentCount: 1 }))
      .mockResolvedValueOnce(jsonResponse({ pendingAttachmentCount: 0 }))
      .mockResolvedValueOnce(jsonResponse({ id: RUN_ID, status: 'completed' })));

    await expect(applyMigrationPackage(directory, migrationEnvironment({
      ERP_MIGRATION_ATTACHMENT_WAIT_SECONDS: '10',
    }))).resolves.toMatchObject({ status: 'completed' });
    expect(timeout).toHaveBeenCalledWith(expect.any(Function), 2_000);
  });

  it('证据导出支持游标分页且拒绝重复游标', async () => {
    const report = completedReport({ applied: 2 });
    const first = evidencePage(RUN_ID, 'items', [{ sequence: 1 }], 'cursor-001');
    const second = evidencePage(RUN_ID, 'items', [{ sequence: 2 }]);
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(report))
      .mockResolvedValueOnce(jsonResponse(first))
      .mockResolvedValueOnce(jsonResponse(second))
      .mockResolvedValueOnce(jsonResponse(evidencePage(RUN_ID, 'associations', [])))
      .mockResolvedValueOnce(jsonResponse(evidencePage(RUN_ID, 'attachments', [])));
    vi.stubGlobal('fetch', fetchMock);

    await expect(exportMigrationEvidence(RUN_ID, migrationEnvironment(), vi.fn()))
      .resolves.toMatchObject({ counts: { items: 2 } });
    expect(fetchMock.mock.calls[2]?.[0]).toContain('cursor=cursor-001');

    const repeated = evidencePage(RUN_ID, 'items', [], 'cursor-001');
    vi.stubGlobal('fetch', vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(completedReport()))
      .mockResolvedValueOnce(jsonResponse(repeated))
      .mockResolvedValueOnce(jsonResponse(repeated)));
    await expect(exportMigrationEvidence(RUN_ID, migrationEnvironment(), vi.fn()))
      .rejects.toThrow('DATA_MIGRATION_PACKAGE_EVIDENCE_PAGE_INVALID');
  });

  it('证据导出拒绝伪造页面、非法记录和控制总数漂移', async () => {
    const valid = evidencePage(RUN_ID, 'items', []);
    const invalidPages: readonly unknown[] = [
      { ...valid, runId: '01J8ZQK7V0A2M4N6P8R0T2W4F2' },
      { ...valid, kind: 'attachments' },
      { ...valid, records: {} },
      { ...valid, records: Array.from({ length: 501 }, () => ({})) },
      { ...valid, nextCursor: 1 },
      { ...valid, nextCursor: '' },
      { ...valid, nextCursor: 'x'.repeat(1_025) },
      { ...valid, pageChecksum: 1 },
      { ...valid, pageChecksum: 'x'.repeat(43) },
      evidencePage(RUN_ID, 'items', [null]),
      evidencePage(RUN_ID, 'items', [[]]),
    ];
    for (const page of invalidPages) {
      vi.stubGlobal('fetch', vi.fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse(completedReport()))
        .mockResolvedValueOnce(jsonResponse(page)));
      await expect(exportMigrationEvidence(RUN_ID, migrationEnvironment(), vi.fn()))
        .rejects.toThrow('DATA_MIGRATION_PACKAGE_EVIDENCE_PAGE_INVALID');
    }

    for (const report of [
      { ...completedReport(), counts: null },
      completedReport({ applied: -1 }),
      completedReport({ applied: 1 }),
      { ...completedReport(), associationCount: 1 },
      { ...completedReport(), attachmentCount: 1 },
    ]) {
      vi.stubGlobal('fetch', evidenceFetch(report));
      await expect(exportMigrationEvidence(RUN_ID, migrationEnvironment(), vi.fn()))
        .rejects.toThrow('DATA_MIGRATION_PACKAGE_EVIDENCE_');
    }
  });

  it('远端响应必须为有效 JSON 对象且错误码必须满足白名单', async () => {
    await expect(exportMigrationEvidence('invalid', migrationEnvironment(), vi.fn()))
      .rejects.toThrow('DATA_MIGRATION_PACKAGE_RUN_ID_INVALID');
    await expect(exportMigrationEvidence(RUN_ID, migrationEnvironment({
      ERP_MIGRATION_TOKEN: 'short',
    }), vi.fn())).rejects.toThrow('DATA_MIGRATION_PACKAGE_TOKEN_REQUIRED');

    for (const response of [
      new Response('not-json', { status: 200 }),
      jsonResponse([], 200),
      jsonResponse({ code: 'UPSTREAM_DENIED' }, 403),
      jsonResponse({ code: 'INVALID\nINJECTED' }, 400),
    ]) {
      vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValueOnce(response));
      await expect(exportMigrationEvidence(RUN_ID, migrationEnvironment(), vi.fn()))
        .rejects.toThrow('DATA_MIGRATION_PACKAGE_');
    }
  });

  it('命令路由输出验证结果并拒绝多余参数', async () => {
    const directory = await packageDirectory();
    const output: string[] = [];
    await runMigrationPackageCommand(['validate', directory], {}, (line) => output.push(line));
    expect(JSON.parse(output.join(''))).toMatchObject({
      valid: true,
      recordCount: 1,
      sourceRunId: 'full-001',
    });

    for (const arguments_ of [
      [],
      ['unknown', directory],
      ['validate'],
      ['validate', directory, 'extra'],
      ['compare', directory],
    ]) {
      await expect(runMigrationPackageCommand(arguments_))
        .rejects.toThrow('DATA_MIGRATION_PACKAGE_ARGUMENT_INVALID');
    }
  });

  it('命令路由执行 apply/evidence 并覆盖默认安全输出器', async () => {
    const directory = await packageDirectory();
    const output: string[] = [];
    vi.stubGlobal('fetch', vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ id: RUN_ID, checkpoint: 1 }))
      .mockResolvedValueOnce(jsonResponse({ pendingCount: 0 }))
      .mockResolvedValueOnce(jsonResponse({ id: RUN_ID, status: 'completed' })));
    await runMigrationPackageCommand(
      ['apply', directory],
      migrationEnvironment(),
      (line) => output.push(line),
    );
    expect(JSON.parse(output.join(''))).toMatchObject({ status: 'completed' });

    output.length = 0;
    vi.stubGlobal('fetch', evidenceFetch(completedReport()));
    await runMigrationPackageCommand(
      ['evidence', RUN_ID],
      migrationEnvironment(),
      (line) => output.push(line),
    );
    expect(output).toHaveLength(2);

    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runMigrationPackageCommand(['validate', directory]);
    expect(stdout).toHaveBeenCalledOnce();

    vi.stubGlobal('fetch', evidenceFetch(completedReport()));
    await exportMigrationEvidence(RUN_ID, migrationEnvironment());
    expect(stdout).toHaveBeenCalledTimes(3);
  });
});

function evidencePage(
  runId: string,
  kind: 'items' | 'associations' | 'attachments',
  records: readonly unknown[],
  nextCursor: string | null = null,
) {
  const body = { runId, kind, records, nextCursor };
  return { ...body, pageChecksum: digest(canonicalJson(body)) };
}

function completedReport(
  counts: Readonly<Record<string, number>> = {},
): Record<string, unknown> {
  return {
    runId: RUN_ID,
    status: 'completed',
    phaseSixEligible: true,
    counts: { applied: 0, duplicate: 0, rejected: 0, ...counts },
    associationCount: 0,
    attachmentCount: 0,
  };
}

function evidenceFetch(report: unknown): typeof fetch {
  return vi.fn<typeof fetch>()
    .mockResolvedValueOnce(jsonResponse(report))
    .mockResolvedValueOnce(jsonResponse(evidencePage(RUN_ID, 'items', [])))
    .mockResolvedValueOnce(jsonResponse(evidencePage(RUN_ID, 'associations', [])))
    .mockResolvedValueOnce(jsonResponse(evidencePage(RUN_ID, 'attachments', [])));
}

async function collectRecords(path: string): Promise<MigrationPackageRecord[]> {
  const records: MigrationPackageRecord[] = [];
  for await (const record of readMigrationRecords(path)) records.push(record);
  return records;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status, headers: { 'content-type': 'application/json' },
  });
}
