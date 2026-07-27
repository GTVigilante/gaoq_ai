import { createHash } from 'node:crypto';

import type { AuditService } from '../../core/audit/audit.service.js';
import { TenantContextService } from '../../core/tenant/tenant-context.service.js';
import type { AttendanceApplicationService } from '../attendance/application/attendance-application.service.js';
import type { AttendanceDataCryptoService } from '../attendance/persistence/attendance-data-crypto.service.js';
import type { Job } from 'bullmq';
import type { Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { AttendanceProviderRegistry } from './attendance-provider.adapter.js';
import type { AttendanceProviderPullService } from './attendance-provider-pull.service.js';
import { AttendanceProviderProcessor } from './attendance-provider.processor.js';
import {
  ATTENDANCE_PROVIDER_PROCESS_JOB,
  ATTENDANCE_PROVIDER_PULL_JOB,
  ATTENDANCE_PROVIDER_SCAN_JOB,
  type AttendanceProviderJobData,
} from './attendance-provider.queue.js';
import type {
  AttendanceProviderEmployeeMappingDocument,
  AttendanceProviderInboxDocument,
  AttendanceProviderStateDocument,
} from './attendance-provider.schemas.js';

const STATE_ID = '01J8ZQK7V0A2M4N6P8R0T2W4C1';
const INBOX_ID = '01J8ZQK7V0A2M4N6P8R0T2W4C2';
const FACT_ID = '01J8ZQK7V0A2M4N6P8R0T2W4C3';
const requestId = 'provider-request-001';
const requestFingerprint = createHash('sha256')
  .update(JSON.stringify(['request', requestId]), 'utf8').digest('base64url');

function query<T>(value: T) {
  const chain = {
    lean: vi.fn(() => chain),
    exec: vi.fn().mockResolvedValue(value),
    limit: vi.fn(() => chain),
  };
  return chain;
}

function assemble(mapping = [{ employeeId: 'employee-001' }]) {
  const context = new TenantContextService();
  const claimed = {
    id: INBOX_ID, tenantId: 'tenant-001', stateId: STATE_ID, providerCode: 'feishu' as const,
    eventBlindIndexes: ['key.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
    providerOccurredAt: new Date(), payloadKeyId: 'key-001', payloadIv: 'A'.repeat(16),
    payloadCiphertext: 'A'.repeat(32), payloadAuthTag: 'A'.repeat(22),
    transportRequestIdFingerprint: requestFingerprint,
    status: 'processing' as const, attempts: 1, processingStartedAt: new Date(),
    processedAt: null, failureCode: null, normalizerVersion: null,
    evidenceVerifiedAt: null, sourceFactId: null,
  };
  const inboxUpdateOne = vi.fn().mockResolvedValue({ modifiedCount: 1 });
  const inbox = {
    findOneAndUpdate: vi.fn().mockReturnValue(query(claimed)), updateOne: inboxUpdateOne,
  };
  const states = {
    findOne: vi.fn().mockReturnValue(query({
      id: STATE_ID, tenantId: 'tenant-001', providerCode: 'feishu',
      timeZone: 'Asia/Shanghai', status: 'active',
    })),
  };
  const mappings = {
    find: vi.fn().mockReturnValue(query(mapping)),
  };
  const attendanceIngest = vi.fn().mockResolvedValue({ fact: { id: FACT_ID } });
  const auditRecord = vi.fn().mockResolvedValue(undefined);
  const pull = {
    enqueueDueStates: vi.fn().mockResolvedValue(2),
    pullState: vi.fn().mockResolvedValue(3),
  };
  const unprotect = vi.fn().mockReturnValue({
    payload: { record: 'raw' }, transportRequestId: requestId,
  });
  const providerFingerprints = vi.fn().mockReturnValue(['blind.employee']);
  const verify = vi.fn().mockReturnValue(true);
  const normalize = vi.fn().mockReturnValue({
    externalEmployeeId: 'external-user-001', externalEventId: 'flow-001',
    factType: 'punch_in', occurredAt: '2026-07-22T01:00:00.000Z',
    timeZone: 'Asia/Shanghai',
    impact: { workedMinutes: 0, leaveMinutes: 0, overtimeMinutes: 0, absentMinutes: 0 },
    sourceObservedAt: '2026-07-22T01:01:00.000Z',
  });
  const verifier = { verify };
  const normalizer = { schemaVersion: 'feishu-user-task-v1', normalize };
  const registry = {
    verifier: vi.fn().mockReturnValue(verifier),
    normalizer: vi.fn().mockReturnValue(normalizer),
  };
  const processor = new AttendanceProviderProcessor(
    states as unknown as Model<AttendanceProviderStateDocument>,
    mappings as unknown as Model<AttendanceProviderEmployeeMappingDocument>,
    inbox as unknown as Model<AttendanceProviderInboxDocument>,
    context,
    { record: auditRecord } as unknown as AuditService,
    pull as unknown as AttendanceProviderPullService,
    { ingest: attendanceIngest } as unknown as AttendanceApplicationService,
    {
      unprotect, providerFingerprints,
    } as unknown as AttendanceDataCryptoService,
    registry as unknown as AttendanceProviderRegistry,
  );
  const job = {
    name: ATTENDANCE_PROVIDER_PROCESS_JOB,
    data: { tenantId: 'tenant-001', inboxId: INBOX_ID },
  } as Job<AttendanceProviderJobData>;
  return {
    processor, job, claimed, context, inbox, inboxUpdateOne, states, mappings,
    auditRecord, pull, attendanceIngest, unprotect, providerFingerprints,
    registry, verifier, normalizer, verify, normalize,
  };
}

function job(name: string, data: unknown = {}): Job<AttendanceProviderJobData> {
  return { name, data } as Job<AttendanceProviderJobData>;
}

describe('AttendanceProviderProcessor', () => {
  it('在可信系统上下文中通过应用服务写入事实并提交 Inbox 检查点', async () => {
    const fixture = assemble();

    await expect(fixture.processor.process(fixture.job)).resolves.toBe(1);

    expect(fixture.attendanceIngest).toHaveBeenCalledWith(
      expect.stringMatching(/^attendance-provider-/),
      expect.objectContaining({
        employeeId: 'employee-001', providerCode: 'feishu',
        externalEventId: 'flow-001', factType: 'punch_in',
      }),
    );
    const completed = fixture.inboxUpdateOne.mock.calls.map((call) => call[1] as {
      readonly $set: Record<string, unknown>;
    }).find((update) => update.$set.status === 'completed');
    if (completed === undefined) throw new Error('缺少完成态更新');
    expect(completed.$set).toMatchObject({
      status: 'completed', sourceFactId: FACT_ID, normalizerVersion: 'feishu-user-task-v1',
    });
    expect(fixture.auditRecord).toHaveBeenCalledWith(expect.objectContaining({
      action: 'integration.attendance_provider.fact.ingest', outcome: 'success',
    }));
  });

  it('未知外部员工进入人工复核且不触达 Attendance 应用服务', async () => {
    const fixture = assemble([]);

    await expect(fixture.processor.process(fixture.job)).resolves.toBe(1);

    expect(fixture.attendanceIngest).not.toHaveBeenCalled();
    const reviewed = fixture.inboxUpdateOne.mock.calls.map((call) => call[1] as {
      readonly $set: Record<string, unknown>;
    }).find((update) => update.$set.status === 'manual_review');
    if (reviewed === undefined) throw new Error('缺少人工复核更新');
    expect(reviewed.$set).toMatchObject({
      status: 'manual_review', failureCode: 'ATTENDANCE_PROVIDER_EMPLOYEE_UNBOUND',
    });
  });

  it('分派扫描任务并拒绝扫描参数注入', async () => {
    const fixture = assemble();
    await expect(fixture.processor.process(
      job(ATTENDANCE_PROVIDER_SCAN_JOB),
    )).resolves.toBe(2);
    expect(fixture.pull.enqueueDueStates).toHaveBeenCalledOnce();
    await expect(fixture.processor.process(
      job(ATTENDANCE_PROVIDER_SCAN_JOB, { tenantId: '越权字段' }),
    )).rejects.toThrow();
  });

  it('拒绝未知任务与非法任务上下文', async () => {
    const fixture = assemble();
    await expect(fixture.processor.process(job('unknown'))).rejects.toThrow(
      'ATTENDANCE_PROVIDER_JOB_UNKNOWN',
    );
    await expect(fixture.processor.process(job(ATTENDANCE_PROVIDER_PULL_JOB, {
      tenantId: 'tenant-001', stateId: 'bad',
    }))).rejects.toThrow();
    await expect(fixture.processor.process(job(ATTENDANCE_PROVIDER_PROCESS_JOB, {
      tenantId: 'tenant-001', inboxId: 'bad',
    }))).rejects.toThrow();
  });

  it('在可信系统上下文补拉并记录事件数', async () => {
    const fixture = assemble();
    fixture.pull.pullState.mockImplementationOnce(() => {
      expect(fixture.context.getActorRequired()).toMatchObject({
        actorType: 'system_job',
        scopes: ['erp:attendance:provider:pull'],
      });
      return Promise.resolve(3);
    });
    await expect(fixture.processor.process(job(ATTENDANCE_PROVIDER_PULL_JOB, {
      tenantId: 'tenant-001', stateId: STATE_ID,
    }))).resolves.toBe(3);
    expect(fixture.auditRecord).toHaveBeenCalledWith(expect.objectContaining({
      action: 'integration.attendance_provider.pull',
      outcome: 'success',
      metadata: { eventCount: 3 },
    }));
  });

  it('补拉失败保留稳定失败码和原异常', async () => {
    const fixture = assemble();
    const error = new Error('PROVIDER_RATE_LIMITED');
    fixture.pull.pullState.mockRejectedValueOnce(error);
    await expect(fixture.processor.process(job(ATTENDANCE_PROVIDER_PULL_JOB, {
      tenantId: 'tenant-001', stateId: STATE_ID,
    }))).rejects.toBe(error);
    const audit = fixture.auditRecord.mock.calls[0]?.[0] as {
      outcome?: string;
      metadata?: unknown;
    } | undefined;
    expect(audit?.outcome).toBe('failure');
    expect(audit?.metadata).toMatchObject({ failureCode: 'PROVIDER_RATE_LIMITED' });
  });

  it.each([
    ['补拉成功审计故障', false],
    ['补拉失败审计故障', true],
  ])('%s不改变业务结果', async (_name, pullFails) => {
    const fixture = assemble();
    const error = new Error('PROVIDER_UNAVAILABLE');
    if (pullFails) fixture.pull.pullState.mockRejectedValueOnce(error);
    fixture.auditRecord.mockRejectedValueOnce(new Error('AUDIT_UNAVAILABLE'));
    const result = fixture.processor.process(job(ATTENDANCE_PROVIDER_PULL_JOB, {
      tenantId: 'tenant-001', stateId: STATE_ID,
    }));
    if (pullFails) await expect(result).rejects.toBe(error);
    else await expect(result).resolves.toBe(3);
    expect(fixture.auditRecord).toHaveBeenCalledOnce();
  });

  it('没有可领取 Inbox 时幂等返回零', async () => {
    const fixture = assemble();
    fixture.inbox.findOneAndUpdate.mockReturnValueOnce(query(null));
    await expect(fixture.processor.process(fixture.job)).resolves.toBe(0);
    expect(fixture.unprotect).not.toHaveBeenCalled();
  });

  it.each([
    [{ payload: {}, transportRequestId: '短' }],
    [{ payload: {}, transportRequestId: requestId, extra: true }],
  ])('拒绝非法加密信封：%s', async (envelope) => {
    const fixture = assemble();
    fixture.unprotect.mockReturnValueOnce(envelope);
    await expect(fixture.processor.process(fixture.job)).rejects.toThrow();
    const failed = fixture.inboxUpdateOne.mock.calls[0];
    expect((failed?.[1] as { $set?: unknown }).$set).toMatchObject({
      status: 'failed', failureCode: 'ATTENDANCE_PROVIDER_PROCESSING_FAILED',
    });
  });

  it('传输请求指纹不一致时进入人工复核', async () => {
    const fixture = assemble();
    fixture.claimed.transportRequestIdFingerprint = 'mismatch';
    await expect(fixture.processor.process(fixture.job)).resolves.toBe(1);
    expect(fixture.verify).not.toHaveBeenCalled();
    const review = fixture.inboxUpdateOne.mock.calls[0];
    expect((review?.[1] as { $set?: unknown }).$set).toMatchObject({
      status: 'manual_review',
      failureCode: 'ATTENDANCE_PROVIDER_TRANSPORT_EVIDENCE_MISMATCH',
      normalizerVersion: null,
    });
    const audit = fixture.auditRecord.mock.calls[0]?.[0] as { metadata?: unknown } | undefined;
    expect(audit?.metadata).toEqual({
      providerCode: 'feishu',
      failureCode: 'ATTENDANCE_PROVIDER_TRANSPORT_EVIDENCE_MISMATCH',
    });
  });

  it('供应商证据验签失败时进入人工复核', async () => {
    const fixture = assemble();
    fixture.verify.mockReturnValueOnce(false);
    await expect(fixture.processor.process(fixture.job)).resolves.toBe(1);
    expect(fixture.states.findOne).not.toHaveBeenCalled();
    const review = fixture.inboxUpdateOne.mock.calls[0];
    expect((review?.[1] as { $set?: unknown }).$set).toMatchObject({
      failureCode: 'ATTENDANCE_PROVIDER_EVIDENCE_UNVERIFIED',
    });
  });

  it('供应商状态失活时失败关闭', async () => {
    const fixture = assemble();
    fixture.states.findOne.mockReturnValueOnce(query(null));
    await expect(fixture.processor.process(fixture.job)).rejects.toThrow(
      'ATTENDANCE_PROVIDER_STATE_NOT_FOUND',
    );
  });

  it.each([
    [{ normalizerVersion: 'feishu-user-task-v1', evidenceVerifiedAt: null }],
    [{ normalizerVersion: null, evidenceVerifiedAt: new Date() }],
    [{ normalizerVersion: 'feishu-user-task-v0', evidenceVerifiedAt: new Date() }],
  ])('证据检查点不完整或标准化器版本漂移时转人工复核：%s', async (changes) => {
    const fixture = assemble();
    Object.assign(fixture.claimed, changes);
    await expect(fixture.processor.process(fixture.job)).resolves.toBe(1);
    expect(fixture.normalize).not.toHaveBeenCalled();
    const review = fixture.inboxUpdateOne.mock.calls[0];
    expect((review?.[1] as { $set?: unknown }).$set).toMatchObject({
      status: 'manual_review',
      failureCode: 'ATTENDANCE_PROVIDER_NORMALIZER_VERSION_CHANGED',
    });
  });

  it('标准化异常进入人工复核并记录当前版本', async () => {
    const fixture = assemble();
    fixture.normalize.mockImplementationOnce(() => {
      throw new Error('INVALID_PROVIDER_EVENT');
    });
    await expect(fixture.processor.process(fixture.job)).resolves.toBe(1);
    const review = fixture.inboxUpdateOne.mock.calls[0];
    expect((review?.[1] as { $set?: unknown }).$set).toMatchObject({
      status: 'manual_review',
      failureCode: 'ATTENDANCE_PROVIDER_NORMALIZED_PAYLOAD_INVALID',
      normalizerVersion: 'feishu-user-task-v1',
    });
  });

  it('证据检查点写入丢失租约时停止领域写入', async () => {
    const fixture = assemble();
    fixture.inboxUpdateOne
      .mockResolvedValueOnce({ modifiedCount: 0 })
      .mockResolvedValueOnce({ modifiedCount: 1 });
    await expect(fixture.processor.process(fixture.job)).rejects.toThrow(
      'ATTENDANCE_PROVIDER_INBOX_LEASE_LOST',
    );
    expect(fixture.attendanceIngest).not.toHaveBeenCalled();
  });

  it('已有一致证据检查点时跳过重复检查点写入', async () => {
    const fixture = assemble();
    Object.assign(fixture.claimed, {
      normalizerVersion: 'feishu-user-task-v1',
      evidenceVerifiedAt: new Date(),
    });
    await expect(fixture.processor.process(fixture.job)).resolves.toBe(1);
    expect(fixture.inboxUpdateOne).toHaveBeenCalledTimes(1);
    expect((fixture.inboxUpdateOne.mock.calls[0]?.[1] as {
      $set?: { status?: string };
    }).$set?.status).toBe('completed');
  });

  it('多个员工映射命中时失败关闭', async () => {
    const fixture = assemble([
      { employeeId: 'employee-001' },
      { employeeId: 'employee-002' },
    ]);
    await expect(fixture.processor.process(fixture.job)).rejects.toThrow(
      'ATTENDANCE_PROVIDER_EMPLOYEE_MAPPING_CONFLICT',
    );
    expect(fixture.attendanceIngest).not.toHaveBeenCalled();
  });

  it('在可信入站上下文调用考勤应用服务', async () => {
    const fixture = assemble();
    fixture.attendanceIngest.mockImplementationOnce(() => {
      expect(fixture.context.getActorRequired()).toMatchObject({
        actorType: 'system_job',
        scopes: [
          'erp:attendance:provider:process',
          'erp:attendance:source:ingest',
        ],
      });
      return Promise.resolve({ fact: { id: FACT_ID } });
    });
    await expect(fixture.processor.process(fixture.job)).resolves.toBe(1);
  });

  it('完成 Inbox 时丢失租约会转入失败处理', async () => {
    const fixture = assemble();
    fixture.inboxUpdateOne
      .mockResolvedValueOnce({ modifiedCount: 1 })
      .mockResolvedValueOnce({ modifiedCount: 0 })
      .mockResolvedValueOnce({ modifiedCount: 1 });
    await expect(fixture.processor.process(fixture.job)).rejects.toThrow(
      'ATTENDANCE_PROVIDER_INBOX_LEASE_LOST',
    );
  });

  it('失败状态写入也丢失租约时不覆盖并发终态', async () => {
    const fixture = assemble();
    fixture.unprotect.mockImplementationOnce(() => {
      throw new Error('PAYLOAD_DECRYPT_FAILED');
    });
    fixture.inboxUpdateOne.mockResolvedValueOnce({ modifiedCount: 0 });
    await expect(fixture.processor.process(fixture.job)).rejects.toThrow(
      'ATTENDANCE_PROVIDER_INBOX_LEASE_LOST',
    );
    expect(fixture.auditRecord).not.toHaveBeenCalled();
  });

  it.each([
    [new Error('PAYLOAD_DECRYPT_FAILED'), 'PAYLOAD_DECRYPT_FAILED'],
    [new Error('上游原始敏感错误'), 'ATTENDANCE_PROVIDER_PROCESSING_FAILED'],
  ])('失败审计只记录稳定错误码', async (error, expectedCode) => {
    const fixture = assemble();
    fixture.unprotect.mockImplementationOnce(() => {
      throw error;
    });
    await expect(fixture.processor.process(fixture.job)).rejects.toBe(error);
    const audit = fixture.auditRecord.mock.calls[0]?.[0] as { metadata?: unknown } | undefined;
    expect(audit?.metadata).toMatchObject({ failureCode: expectedCode });
  });

  it('人工复核更新丢失租约时转入失败处理', async () => {
    const fixture = assemble([]);
    fixture.inboxUpdateOne
      .mockResolvedValueOnce({ modifiedCount: 1 })
      .mockResolvedValueOnce({ modifiedCount: 0 })
      .mockResolvedValueOnce({ modifiedCount: 1 });
    await expect(fixture.processor.process(fixture.job)).rejects.toThrow(
      'ATTENDANCE_PROVIDER_INBOX_LEASE_LOST',
    );
  });

  it.each([
    ['完成终态', 'complete'],
    ['人工复核终态', 'review'],
    ['失败终态', 'failure'],
  ])('%s后的审计故障不覆盖业务结果', async (_name, mode) => {
    const fixture = assemble(mode === 'review' ? [] : undefined);
    const processingError = new Error('PAYLOAD_DECRYPT_FAILED');
    if (mode === 'failure') {
      fixture.unprotect.mockImplementationOnce(() => {
        throw processingError;
      });
    }
    fixture.auditRecord.mockRejectedValueOnce(new Error('AUDIT_UNAVAILABLE'));
    const result = fixture.processor.process(fixture.job);
    if (mode === 'failure') await expect(result).rejects.toBe(processingError);
    else await expect(result).resolves.toBe(1);
    expect(fixture.auditRecord).toHaveBeenCalledOnce();
  });
});
