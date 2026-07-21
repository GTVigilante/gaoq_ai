import { describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../../core/audit/audit.service.js';
import { OrgReconciliationService } from './org-reconciliation.service.js';
import {
  OrgPushAdapter,
  OrgPushAdapterRegistry,
  OrgPushError,
  type ExternalOrgSnapshot,
} from './org-push.adapter.js';

function query(value: unknown) {
  return {
    limit: () => query(value),
    lean: () => ({ exec: () => Promise.resolve(value) }),
  };
}

function listQuery(value: unknown) {
  return {
    sort: () => ({
      limit: () => query(value),
    }),
  };
}

class SnapshotAdapter extends OrgPushAdapter {
  readonly channel: 'dingtalk' | 'feishu';
  readonly fetchSnapshotMock = vi.fn<
    (tenantId: string) => Promise<ExternalOrgSnapshot>
  >();

  constructor(channel: 'dingtalk' | 'feishu') {
    super();
    this.channel = channel;
  }

  pushDepartment(): never { throw new Error('not used'); }
  pushEmployee(): never { throw new Error('not used'); }
  provisionEmployee(): never { throw new Error('not used'); }
  changeEmployeeStatus(): never { throw new Error('not used'); }
  fetchSnapshot(tenantId: string) { return this.fetchSnapshotMock(tenantId); }
}

function fixture() {
  const dingtalk = new SnapshotAdapter('dingtalk');
  const feishu = new SnapshotAdapter('feishu');
  const reportUpdateOne = vi.fn().mockResolvedValue({ matchedCount: 1 });
  const reportFindOneAndUpdate = vi.fn().mockReturnValue(query({ status: 'running' }));
  const recordSystem = vi.fn().mockResolvedValue(undefined);
  const service = new OrgReconciliationService(
    { find: vi.fn().mockReturnValue(listQuery([{ tenantId: 'tenant-a', channel: 'dingtalk' }])) } as never,
    {
      findOneAndUpdate: reportFindOneAndUpdate,
      updateOne: reportUpdateOne,
    } as never,
    { find: vi.fn().mockReturnValue(query([
      { id: 'dept-a', name: '财务部', status: 'active', parentId: null },
      { id: 'dept-unmapped', name: '法务部', status: 'active', parentId: null },
    ])) } as never,
    { find: vi.fn().mockReturnValue(query([
      {
        id: 'employee-a', displayName: '张三', employeeNo: 'E001',
        status: 'active', departmentIds: ['dept-a'],
      },
    ])) } as never,
    { find: vi.fn().mockReturnValue(query([
      { aggregateType: 'org.department', aggregateId: 'dept-a', externalId: 'ext-dept-a' },
      { aggregateType: 'org.employee', aggregateId: 'employee-a', externalId: 'ext-user-a' },
    ])) } as never,
    new OrgPushAdapterRegistry(dingtalk, feishu),
    { recordSystem } as unknown as AuditService,
  );
  return { service, dingtalk, reportFindOneAndUpdate, reportUpdateOne, recordSystem };
}

describe('OrgReconciliationService', () => {
  it('每日比较映射、缺失、孤儿与字段差异，报告不保存外部个人字段值', async () => {
    const store = fixture();
    store.dingtalk.fetchSnapshotMock.mockResolvedValue({
      departments: new Map([
        ['ext-dept-a', { externalId: 'ext-dept-a', name: '错误名称', parentExternalId: '1' }],
        ['orphan-dept', { externalId: 'orphan-dept', name: '外部孤儿部门' }],
      ]),
      employees: new Map([
        ['ext-user-a', {
          externalId: 'ext-user-a', displayName: '张三', employeeNo: 'E001',
          departmentExternalIds: ['ext-dept-a'], active: true,
        }],
        ['orphan-user', {
          externalId: 'orphan-user', displayName: '不应入库的姓名',
          mobile: '13800000000', departmentExternalIds: [],
        }],
      ]),
    });

    await expect(store.service.runDaily(new Date('2026-07-21T00:00:00.000Z'))).resolves.toBe(1);

    const write = store.reportUpdateOne.mock.calls[0]?.[1] as {
      $set: { differences: unknown[]; differenceCount: number; status: string };
    };
    expect(write.$set.status).toBe('completed');
    expect(write.$set.differenceCount).toBe(4);
    expect(write.$set.differences).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'field_mismatch', aggregateId: 'dept-a', fields: ['name'] }),
      expect.objectContaining({ kind: 'mapping_missing', aggregateId: 'dept-unmapped' }),
      expect.objectContaining({ kind: 'external_orphan', externalId: 'orphan-dept' }),
      expect.objectContaining({ kind: 'external_orphan', externalId: 'orphan-user' }),
    ]));
    expect(JSON.stringify(write)).not.toContain('不应入库的姓名');
    expect(JSON.stringify(write)).not.toContain('13800000000');
    expect(store.recordSystem).toHaveBeenCalledWith('tenant-a', expect.objectContaining({
      outcome: 'success', metadata: { channel: 'dingtalk', differenceCount: 4 },
    }));
    const claimFilter = store.reportFindOneAndUpdate.mock.calls[0]?.[0] as {
      $or: readonly Record<string, unknown>[];
    };
    expect(claimFilter.$or).toEqual(expect.arrayContaining([
      { status: 'failed' },
      { status: { $exists: false } },
    ]));
    const runningLease = claimFilter.$or.find((condition) => condition['status'] === 'running') as {
      startedAt: { $lt: unknown };
    };
    expect(runningLease.startedAt.$lt).toBeInstanceOf(Date);
  });

  it('平台快照失败时只持久化稳定错误码并记录失败审计', async () => {
    const store = fixture();
    store.dingtalk.fetchSnapshotMock.mockRejectedValue(
      new OrgPushError('DINGTALK_SNAPSHOT_INVALID', 'retryable', '包含敏感详情的错误'),
    );

    await expect(store.service.runDaily(new Date('2026-07-21T00:00:00.000Z')))
      .rejects.toMatchObject({ code: 'ORG_RECONCILIATION_PARTIAL_FAILURE' });

    const write = store.reportUpdateOne.mock.calls[0]?.[1] as {
      $set: Record<string, unknown>;
    };
    expect(write.$set).toMatchObject({
      status: 'failed', lastErrorCode: 'DINGTALK_SNAPSHOT_INVALID',
    });
    expect(JSON.stringify(write)).not.toContain('包含敏感详情');
    expect(store.recordSystem).toHaveBeenCalledWith('tenant-a', expect.objectContaining({
      outcome: 'failure',
      metadata: { channel: 'dingtalk', errorCode: 'DINGTALK_SNAPSHOT_INVALID' },
    }));
  });
});
