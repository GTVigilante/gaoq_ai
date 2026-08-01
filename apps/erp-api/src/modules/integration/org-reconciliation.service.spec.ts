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

function fixture(input: {
  readonly bindings?: readonly unknown[];
  readonly departments?: readonly unknown[];
  readonly employees?: readonly unknown[];
  readonly mappings?: readonly unknown[];
} = {}) {
  const dingtalk = new SnapshotAdapter('dingtalk');
  const feishu = new SnapshotAdapter('feishu');
  const reportUpdateOne = vi.fn().mockResolvedValue({ matchedCount: 1 });
  const reportFindOneAndUpdate = vi.fn().mockReturnValue(query({ status: 'running' }));
  const recordSystem = vi.fn().mockResolvedValue(undefined);
  const service = new OrgReconciliationService(
    { find: vi.fn().mockReturnValue(listQuery(
      input.bindings ?? [{ tenantId: 'tenant-a', channel: 'dingtalk' }],
    )) } as never,
    {
      findOneAndUpdate: reportFindOneAndUpdate,
      updateOne: reportUpdateOne,
    } as never,
    { find: vi.fn().mockReturnValue(query(input.departments ?? [
      { id: 'dept-a', name: '财务部', status: 'active', parentId: null },
      { id: 'dept-unmapped', name: '法务部', status: 'active', parentId: null },
    ])) } as never,
    { find: vi.fn().mockReturnValue(query(input.employees ?? [
      {
        id: 'employee-a', displayName: '张三', employeeNo: 'E001',
        status: 'active', departmentIds: ['dept-a'],
      },
    ])) } as never,
    { find: vi.fn().mockReturnValue(query(input.mappings ?? [
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

  it('报告完成后的审计故障不得把 completed 回写为 failed', async () => {
    const store = fixture();
    store.dingtalk.fetchSnapshotMock.mockResolvedValue({
      departments: new Map(), employees: new Map(),
    });
    store.recordSystem.mockRejectedValueOnce(new Error('审计不可用'));

    await expect(store.service.runDaily(new Date('2026-07-21T00:00:00.000Z')))
      .rejects.toMatchObject({ code: 'ORG_RECONCILIATION_PARTIAL_FAILURE' });
    expect(store.reportUpdateOne).toHaveBeenCalledOnce();
    expect(store.reportUpdateOne.mock.calls[0]?.[1]).toMatchObject({
      $set: { status: 'completed' },
    });
    expect(store.recordSystem).toHaveBeenCalledOnce();
  });

  it('完成报告时丢失租约不得回写失败或追加错误审计', async () => {
    const store = fixture();
    store.dingtalk.fetchSnapshotMock.mockResolvedValue({
      departments: new Map(), employees: new Map(),
    });
    store.reportUpdateOne.mockResolvedValueOnce({ matchedCount: 0 });

    await expect(store.service.runDaily(new Date('2026-07-21T00:00:00.000Z')))
      .rejects.toMatchObject({ code: 'ORG_RECONCILIATION_PARTIAL_FAILURE' });

    expect(store.reportUpdateOne).toHaveBeenCalledOnce();
    expect(store.recordSystem).not.toHaveBeenCalled();
  });

  it('失败终态写入丢失租约时不得覆盖新持有者或记录错误审计', async () => {
    const store = fixture();
    store.dingtalk.fetchSnapshotMock.mockRejectedValue(new Error('SNAPSHOT_FAILED'));
    store.reportUpdateOne.mockResolvedValueOnce({ matchedCount: 0 });

    await expect(store.service.runDaily(new Date('2026-07-21T00:00:00.000Z')))
      .rejects.toMatchObject({ code: 'ORG_RECONCILIATION_PARTIAL_FAILURE' });

    expect(store.reportUpdateOne).toHaveBeenCalledOnce();
    expect(store.recordSystem).not.toHaveBeenCalled();
  });

  it('失败报告已提交后的审计故障不得再次改写报告', async () => {
    const store = fixture();
    store.dingtalk.fetchSnapshotMock.mockRejectedValue(new Error('SNAPSHOT_FAILED'));
    store.recordSystem.mockRejectedValueOnce(new Error('AUDIT_UNAVAILABLE'));

    await expect(store.service.runDaily(new Date('2026-07-21T00:00:00.000Z')))
      .rejects.toMatchObject({ code: 'ORG_RECONCILIATION_PARTIAL_FAILURE' });

    expect(store.reportUpdateOne).toHaveBeenCalledOnce();
    expect(store.reportUpdateOne.mock.calls[0]?.[1]).toMatchObject({
      $set: { status: 'failed' },
    });
    expect(store.recordSystem).toHaveBeenCalledOnce();
  });

  it('已存在当日报告或并发唯一键冲突时安全跳过', async () => {
    const existing = fixture();
    existing.reportFindOneAndUpdate.mockReset().mockReturnValue(query(null));
    await expect(existing.service.runDaily(new Date('2026-07-21T00:00:00.000Z')))
      .resolves.toBe(0);
    expect(existing.dingtalk.fetchSnapshotMock).not.toHaveBeenCalled();

    const duplicate = fixture();
    duplicate.reportFindOneAndUpdate.mockReset().mockReturnValue({
      lean: () => ({
        exec: () => Promise.reject(Object.assign(new Error('DUPLICATE_KEY'), { code: 11000 })),
      }),
    });
    await expect(duplicate.service.runDaily(new Date('2026-07-21T00:00:00.000Z')))
      .resolves.toBe(0);
  });

  it('对账覆盖停用、终止、父部门、状态与字段差异的全部只读分支', async () => {
    const departments = [
      { id: 'dept-inactive-unmapped', name: '停用无映射', status: 'inactive', parentId: null },
      { id: 'dept-active-missing', name: '外部缺失', status: 'active', parentId: null },
      { id: 'dept-inactive-missing', name: '停用外部缺失', status: 'inactive', parentId: null },
      { id: 'dept-parent', name: '子部门', status: 'active', parentId: 'dept-root' },
      { id: 'dept-inactive', name: '停用部门', status: 'inactive', parentId: null },
      { id: 'dept-root', name: '根部门', status: 'active', parentId: null },
    ];
    const employees = [
      { id: 'term-unmapped', displayName: '甲', employeeNo: 'T1', status: 'terminated', departmentIds: [] },
      { id: 'active-unmapped', displayName: '乙', employeeNo: 'A1', status: 'active', departmentIds: [] },
      { id: 'term-missing', displayName: '丙', employeeNo: 'T2', status: 'terminated', departmentIds: [] },
      { id: 'active-missing', displayName: '丁', employeeNo: 'A2', status: 'active', departmentIds: [] },
      { id: 'mismatch', displayName: '正确姓名', employeeNo: 'E1', status: 'active', departmentIds: ['dept-root', 'unknown'] },
      { id: 'terminated', displayName: '戊', employeeNo: 'E2', status: 'terminated', departmentIds: [] },
      { id: 'suspended', displayName: '己', employeeNo: 'E3', status: 'suspended', departmentIds: [] },
      { id: 'active-state', displayName: '庚', employeeNo: 'E4', status: 'active', departmentIds: [] },
      { id: 'probation-state', displayName: '辛', employeeNo: 'E5', status: 'probation', departmentIds: [] },
    ];
    const mappings = [
      { aggregateType: 'org.department', aggregateId: 'dept-active-missing', externalId: 'ext-dept-active-missing' },
      { aggregateType: 'org.department', aggregateId: 'dept-inactive-missing', externalId: 'ext-dept-inactive-missing' },
      { aggregateType: 'org.department', aggregateId: 'dept-parent', externalId: 'ext-dept-parent' },
      { aggregateType: 'org.department', aggregateId: 'dept-inactive', externalId: 'ext-dept-inactive' },
      { aggregateType: 'org.department', aggregateId: 'dept-root', externalId: 'ext-dept-root' },
      { aggregateType: 'org.employee', aggregateId: 'term-missing', externalId: 'ext-term-missing' },
      { aggregateType: 'org.employee', aggregateId: 'active-missing', externalId: 'ext-active-missing' },
      { aggregateType: 'org.employee', aggregateId: 'mismatch', externalId: 'ext-mismatch' },
      { aggregateType: 'org.employee', aggregateId: 'terminated', externalId: 'ext-terminated' },
      { aggregateType: 'org.employee', aggregateId: 'suspended', externalId: 'ext-suspended' },
      { aggregateType: 'org.employee', aggregateId: 'active-state', externalId: 'ext-active-state' },
      { aggregateType: 'org.employee', aggregateId: 'probation-state', externalId: 'ext-probation-state' },
      { aggregateType: 'org.employee', aggregateId: 'ignored-null', externalId: null },
    ];
    const store = fixture({ departments, employees, mappings });
    store.dingtalk.fetchSnapshotMock.mockResolvedValue({
      departments: new Map([
        ['0', {}],
        ['1', {}],
        ['ext-dept-parent', { name: '子部门', parentExternalId: 'wrong-parent' }],
        ['ext-dept-inactive', { name: '停用部门', parentExternalId: null }],
        ['ext-dept-root', { name: '根部门', parentExternalId: null }],
      ]),
      employees: new Map([
        ['ext-mismatch', {
          displayName: '错误姓名', employeeNo: 'WRONG',
          departmentExternalIds: ['wrong-department'],
        }],
        ['ext-terminated', { displayName: '戊', employeeNo: 'E2', departmentExternalIds: [] }],
        ['ext-suspended', { displayName: '己', employeeNo: 'E3', departmentExternalIds: [], suspended: false }],
        ['ext-active-state', { displayName: '庚', employeeNo: 'E4', departmentExternalIds: [], suspended: true }],
        ['ext-probation-state', { displayName: '辛', employeeNo: 'E5', resigned: true }],
      ]),
    });

    await expect(store.service.runDaily(new Date('2026-07-21T00:00:00.000Z'))).resolves.toBe(1);

    const write = store.reportUpdateOne.mock.calls[0]?.[1] as {
      $set: { differences: readonly Record<string, unknown>[] };
    };
    expect(write.$set.differences).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'external_missing', aggregateId: 'dept-active-missing' }),
      expect.objectContaining({ kind: 'field_mismatch', aggregateId: 'dept-parent', fields: ['parentId'] }),
      expect.objectContaining({ kind: 'field_mismatch', aggregateId: 'dept-inactive', fields: ['status'] }),
      expect.objectContaining({ kind: 'mapping_missing', aggregateId: 'active-unmapped' }),
      expect.objectContaining({ kind: 'external_missing', aggregateId: 'active-missing' }),
      expect.objectContaining({
        kind: 'field_mismatch',
        aggregateId: 'mismatch',
        fields: ['displayName', 'employeeNo', 'departmentIds'],
      }),
      expect.objectContaining({ kind: 'field_mismatch', aggregateId: 'terminated', fields: ['status'] }),
      expect.objectContaining({ kind: 'field_mismatch', aggregateId: 'suspended', fields: ['status'] }),
      expect.objectContaining({ kind: 'field_mismatch', aggregateId: 'active-state', fields: ['status'] }),
      expect.objectContaining({ kind: 'field_mismatch', aggregateId: 'probation-state', fields: ['status'] }),
    ]));
    expect(JSON.stringify(write)).not.toContain('term-unmapped');
    expect(JSON.stringify(write)).not.toContain('dept-inactive-unmapped');
  });

  it('规模上限与差异截断均失败关闭或限制报告体积', async () => {
    const tooLarge = fixture({
      departments: Array.from({ length: 20_001 }, (_, index) => ({
        id: `dept-${index}`, name: '部门', status: 'active', parentId: null,
      })),
      employees: [],
      mappings: [],
    });
    tooLarge.dingtalk.fetchSnapshotMock.mockResolvedValue({
      departments: new Map(), employees: new Map(),
    });
    await expect(tooLarge.service.runDaily(new Date('2026-07-21T00:00:00.000Z')))
      .rejects.toMatchObject({ code: 'ORG_RECONCILIATION_PARTIAL_FAILURE' });
    expect(tooLarge.reportUpdateOne.mock.calls[0]?.[1]).toMatchObject({
      $set: {
        status: 'failed',
        lastErrorCode: 'ORG_RECONCILIATION_EXPECTED_TOO_LARGE',
      },
    });

    const truncated = fixture({ departments: [], employees: [], mappings: [] });
    truncated.dingtalk.fetchSnapshotMock.mockResolvedValue({
      departments: new Map(Array.from({ length: 1_001 }, (_, index) => [
        `orphan-${index}`,
        {},
      ])),
      employees: new Map(),
    });
    await expect(truncated.service.runDaily(new Date('2026-07-21T00:00:00.000Z')))
      .resolves.toBe(1);
    expect(truncated.reportUpdateOne.mock.calls[0]?.[1]).toMatchObject({
      $set: {
        differenceCount: 1_001,
        truncated: true,
      },
    });
    const report = truncated.reportUpdateOne.mock.calls[0]?.[1] as {
      $set: { differences: readonly unknown[] };
    };
    expect(report.$set.differences).toHaveLength(1_000);
    expect(report.$set.differences[0]).toMatchObject({ kind: 'external_orphan' });
  });
});
