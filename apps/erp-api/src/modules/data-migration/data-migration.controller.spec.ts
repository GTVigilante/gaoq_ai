import { BadRequestException, Logger } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../../core/audit/audit.service.js';
import { REQUIRED_SCOPES_KEY } from '../identity/auth.decorators.js';
import type { DataMigrationAttachmentService } from './application/data-migration-attachment.service.js';
import type { DataMigrationService } from './application/data-migration.service.js';
import { DataMigrationController } from './data-migration.controller.js';

const RUN_ID = '01J8ZQK7V0A2M4N6P8R0T2W4F1';

function report(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    runId: RUN_ID,
    sourceSystem: 'legacy-hr',
    mode: 'full',
    scope: 'org_reference',
    status: 'completed',
    expectedSourceCount: 1,
    checkpoint: 1,
    counts: { applied: 1, duplicate: 0, rejected: 0 },
    sourceChecksum: 'a'.repeat(43),
    expectedSourceChecksum: 'a'.repeat(43),
    targetChecksum: 'b'.repeat(43),
    associationCount: 0,
    unresolvedAssociationCount: 0,
    attachmentCount: 0,
    pendingAttachmentCount: 0,
    differences: [],
    phaseSixEligible: true,
    ...overrides,
  };
}

function assemble(overrides: {
  readonly migrations?: object;
  readonly attachments?: object;
  readonly audit?: object;
} = {}) {
  const migrations = {
    start: vi.fn().mockResolvedValue({
      id: RUN_ID,
      sourceSystem: 'legacy-hr',
      mode: 'full',
      scope: 'recruitment_candidates',
    }),
    apply: vi.fn().mockResolvedValue({
      sequence: 1,
      entityType: 'recruitment.candidate',
      status: 'applied',
    }),
    complete: vi.fn().mockResolvedValue(report()),
    report: vi.fn().mockResolvedValue(report()),
    evidence: vi.fn().mockResolvedValue({
      runId: RUN_ID,
      kind: 'items',
      records: [{ sequence: 1, status: 'applied' }],
      nextCursor: null,
      pageChecksum: 'c'.repeat(43),
    }),
    ...overrides.migrations,
  };
  const attachments = {
    request: vi.fn().mockResolvedValue({
      runId: RUN_ID,
      status: 'queued',
      pendingCount: 2,
    }),
    ...overrides.attachments,
  };
  const audit = { record: vi.fn(), ...overrides.audit };
  return {
    controller: new DataMigrationController(
      migrations as unknown as DataMigrationService,
      attachments as unknown as DataMigrationAttachmentService,
      audit as unknown as AuditService,
    ),
    migrations,
    attachments,
    audit,
  };
}

function getMethodScopes(methodName: string): unknown {
  const method: unknown = Object.getOwnPropertyDescriptor(
    DataMigrationController.prototype,
    methodName,
  )?.value;
  if (typeof method !== 'function') throw new Error(`控制器方法不存在：${methodName}`);
  return Reflect.getMetadata(REQUIRED_SCOPES_KEY, method) as unknown;
}

describe('DataMigrationController', () => {
  it('写入口只静态要求迁移执行权，目标域权限由应用服务按运行范围判定', () => {
    expect(getMethodScopes('start')).toEqual(['erp:migration:execute']);
    expect(getMethodScopes('apply')).toEqual(['erp:migration:execute']);
    expect(getMethodScopes('complete')).toEqual(['erp:migration:execute']);
    expect(getMethodScopes('transferAttachments'))
      .toEqual(['erp:migration:execute', 'erp:migration:attachment:execute']);
    expect(getMethodScopes('report')).toEqual(['erp:migration:read']);
    expect(getMethodScopes('evidence'))
      .toEqual(['erp:migration:read', 'erp:migration:evidence:export']);
  });

  it('创建运行提交后审计不可用仍返回已提交结果并记录独立告警', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { controller, migrations, audit } = assemble({
      audit: { record: vi.fn().mockRejectedValue(new Error('audit unavailable')) },
    });
    const body = {
      sourceSystem: 'legacy-hr',
      sourceRunId: 'snapshot-001',
      mode: 'full' as const,
      scope: 'recruitment_candidates' as const,
      expectedSourceCount: 1,
      expectedSourceChecksum: 'a'.repeat(43),
    };

    await expect(controller.start(body)).resolves.toMatchObject({ id: RUN_ID });

    expect(migrations.start).toHaveBeenCalledWith(body);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'data_migration.run.start',
      resourceId: RUN_ID,
      riskLevel: 'R2',
      outcome: 'success',
    }));
    expect(error).toHaveBeenCalledWith(expect.objectContaining({
      code: 'DATA_MIGRATION_AUDIT_AFTER_COMMIT_FAILED',
      resourceId: RUN_ID,
    }));
    error.mockRestore();
  });

  it.each([
    ['applied', 'success'],
    ['rejected', 'failure'],
  ] as const)('应用记录状态 %s 使用对应审计结果', async (status, outcome) => {
    const { controller, migrations, audit } = assemble({
      migrations: {
        apply: vi.fn().mockResolvedValue({
          sequence: 7,
          entityType: 'org.employee',
          status,
        }),
      },
    });
    const body = {
      sequence: 7,
      sourceRecordId: 'employee-007',
      sourceVersion: 'v1',
      entityType: 'org.employee' as const,
      payload: {},
      payloadHash: 'a'.repeat(43),
      associationSourceIds: [],
      attachments: [],
    };

    await expect(controller.apply(RUN_ID, body)).resolves.toMatchObject({ status });

    expect(migrations.apply).toHaveBeenCalledWith(RUN_ID, body);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'data_migration.record.apply',
      resourceId: RUN_ID,
      outcome,
      metadata: { sequence: 7, entityType: 'org.employee', status },
    }));
  });

  it.each(['bad', '81J8ZQK7V0A2M4N6P8R0T2W4F1'])(
    '非法运行标识 %s 在业务调用前失败关闭',
    async (id) => {
      const { controller, migrations, audit } = assemble();

      await expect(controller.complete(id)).rejects.toBeInstanceOf(BadRequestException);

      expect(migrations.complete).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    },
  );

  it.each([
    [true, 'success'],
    [false, 'failure'],
  ] as const)('完成报告 phaseSixEligible=%s 使用对应审计结果', async (eligible, outcome) => {
    const { controller, audit } = assemble({
      migrations: {
        complete: vi.fn().mockResolvedValue(report({
          phaseSixEligible: eligible,
          differences: eligible ? [] : [{ code: 'REJECTED_RECORDS', severity: 'critical', count: 1 }],
        })),
      },
    });

    await expect(controller.complete(RUN_ID)).resolves.toMatchObject({
      phaseSixEligible: eligible,
    });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'data_migration.run.complete',
      outcome,
    }));
  });

  it('附件搬运请求只审计聚合状态与数量', async () => {
    const { controller, attachments, audit } = assemble();

    await expect(controller.transferAttachments(RUN_ID)).resolves.toEqual({
      runId: RUN_ID,
      status: 'queued',
      pendingCount: 2,
    });

    expect(attachments.request).toHaveBeenCalledWith(RUN_ID);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'data_migration.attachment.transfer.request',
      resourceId: RUN_ID,
      metadata: { status: 'queued', pendingCount: 2 },
    }));
  });

  it('报告读取保持审计失败关闭', async () => {
    const { controller, audit } = assemble({
      audit: { record: vi.fn().mockRejectedValue(new Error('audit unavailable')) },
    });

    await expect(controller.report(RUN_ID)).rejects.toThrow('audit unavailable');
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'data_migration.report.read',
      riskLevel: 'R1',
    }));
  });

  it('详细证据导出保持双 Scope 和 R2 审计失败关闭', async () => {
    const auditFailure = new Error('evidence audit unavailable');
    const { controller, migrations, audit } = assemble({
      audit: { record: vi.fn().mockRejectedValue(auditFailure) },
    });
    const query = { kind: 'items' as const, limit: 200 };

    await expect(controller.evidence(RUN_ID, query)).rejects.toBe(auditFailure);

    expect(migrations.evidence).toHaveBeenCalledWith(RUN_ID, query);
    const evidenceAudit: unknown = audit.record.mock.calls[0]?.[0];
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'data_migration.evidence.export',
      riskLevel: 'R2',
    }));
    expect(evidenceAudit).toMatchObject({
      metadata: {
        kind: 'items',
        recordCount: 1,
        hasNextPage: false,
        pageChecksum: 'c'.repeat(43),
      },
    });
  });
});
