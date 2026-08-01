import type { ActorContext } from '@gaoq/shared-types';
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { TenantContextService } from '../../core/tenant/tenant-context.service.js';
import { AttendanceProviderCoverageService } from './attendance-provider-coverage.service.js';

const tenant = { tenantId: 'tenant-001', source: 'access_token' as const };
const STATE_ID = '01J8ZQK7V0A2M4N6P8R0T2W4S1';
const MAPPING_1 = '01J8ZQK7V0A2M4N6P8R0T2W4M1';
const MAPPING_2 = '01J8ZQK7V0A2M4N6P8R0T2W4M2';

function actor(
  scopes: readonly string[],
  actorType: ActorContext['actorType'] = 'system_job',
): ActorContext {
  return {
    actorType,
    actorId: 'attendance-provider-reconciler',
    tenantId: tenant.tenantId,
    roleCodes: [],
    scopes,
    departmentIds: [],
    traceId: 'trace-001',
  };
}

function state(overrides: Record<string, unknown> = {}) {
  return {
    id: STATE_ID,
    tenantId: tenant.tenantId,
    providerCode: 'dingtalk' as const,
    timeZone: 'Asia/Shanghai',
    status: 'active' as const,
    cursorKeyId: 'key-001',
    cursorIv: 'iv',
    cursorCiphertext: 'ciphertext',
    cursorAuthTag: 'auth-tag',
    lastPolledAt: new Date('2026-05-01T00:00:00.000Z'),
    ...overrides,
  };
}

function query<T>(value: T) {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  chain.lean = vi.fn(() => chain);
  chain.exec = vi.fn().mockResolvedValue(value);
  chain.sort = vi.fn(() => chain);
  chain.limit = vi.fn(() => chain);
  return chain;
}

function assemble() {
  const context = new TenantContextService();
  let currentState: ReturnType<typeof state> | null = state();
  let unresolvedCount = 0;
  let mappingRecords = [
    { id: MAPPING_1, employeeId: 'employee-001', providerCode: 'dingtalk' },
    { id: MAPPING_2, employeeId: 'employee-002', providerCode: 'dingtalk' },
  ];
  const states = {
    findOne: vi.fn(() => query(currentState)),
  };
  const mappings = {
    find: vi.fn(() => query(mappingRecords)),
  };
  const inbox = {
    countDocuments: vi.fn(() => ({
      exec: vi.fn().mockImplementation(() => Promise.resolve(unresolvedCount)),
    })),
  };
  let cursor: unknown = {
    throughDate: '2026-04-30',
    windowToDate: null,
    employeeAfterId: null,
  };
  const crypto = { unprotect: vi.fn(() => cursor) };
  const attendanceRules = {
    attestProviderCoverage: vi.fn().mockImplementation((
      _key: string,
      input: Record<string, unknown>,
    ) => Promise.resolve({
      coverage: {
        id: 'coverage-001',
        ...input,
        evidenceChecksum: 'e'.repeat(43),
      },
    })),
  };
  const service = new AttendanceProviderCoverageService(
    states as never,
    mappings as never,
    inbox as never,
    context,
    crypto as never,
    attendanceRules as never,
  );
  return {
    service,
    context,
    states,
    mappings,
    inbox,
    crypto,
    attendanceRules,
    setState: (value: ReturnType<typeof state> | null) => {
      currentState = value;
    },
    setUnresolved: (value: number) => {
      unresolvedCount = value;
    },
    setMappings: (value: typeof mappingRecords) => {
      mappingRecords = value;
    },
    setCursor: (value: unknown) => {
      cursor = value;
    },
  };
}

function run<T>(
  store: ReturnType<typeof assemble>,
  operation: () => Promise<T>,
  scopes: readonly string[] = [
    'erp:attendance:provider:reconcile',
    'erp:attendance:coverage:attest',
  ],
  actorType: ActorContext['actorType'] = 'system_job',
): Promise<T> {
  return store.context.run({ tenant, actor: actor(scopes, actorType) }, operation);
}

describe('AttendanceProviderCoverageService', () => {
  it('验证完整水位线和零未决 Inbox 后按稳定映射分页登记覆盖证明', async () => {
    const store = assemble();
    const result = await run(store, () => store.service.reconcile('reconcile-key-001', {
      stateId: STATE_ID,
      month: '2026-04',
      limit: 1,
    }));
    expect(store.states.findOne).toHaveBeenCalledWith({
      tenantId: tenant.tenantId,
      id: STATE_ID,
      status: 'active',
    });
    expect(store.inbox.countDocuments).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: tenant.tenantId,
      stateId: STATE_ID,
      providerCode: 'dingtalk',
      status: { $ne: 'completed' },
      providerOccurredAt: { $lt: new Date('2026-04-30T16:00:00.000Z') },
    }));
    expect(store.attendanceRules.attestProviderCoverage).toHaveBeenCalledTimes(1);
    expect(store.attendanceRules.attestProviderCoverage).toHaveBeenCalledWith(
      expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      expect.objectContaining({
        employeeId: 'employee-001',
        providerMappingId: MAPPING_1,
        throughBusinessDate: '2026-04-30',
        sourceCutoffAt: '2026-05-01T00:00:00.000Z',
      }),
    );
    expect(result).toEqual(expect.objectContaining({
      attestedCount: 1,
      nextAfterMappingId: MAPPING_1,
      complete: false,
    }));
    expect(JSON.stringify(result)).not.toContain('externalEmployeeId');
  });

  it('同一已持久化水位重试时生成稳定的证明截止时间和子幂等键', async () => {
    const store = assemble();
    await run(store, () => store.service.reconcile('reconcile-stable-key', {
      stateId: STATE_ID,
      month: '2026-04',
      limit: 1,
    }));
    await run(store, () => store.service.reconcile('reconcile-stable-key', {
      stateId: STATE_ID,
      month: '2026-04',
      limit: 1,
    }));
    const [first, second] = store.attendanceRules.attestProviderCoverage.mock.calls;
    expect(first?.[0]).toBe(second?.[0]);
    expect(first?.[1]).toEqual(second?.[1]);
  });

  it('最后一页返回 complete 且兼容严格旧字符串水位线', async () => {
    const store = assemble();
    store.setCursor('2026-04-30');
    store.setMappings([
      { id: MAPPING_2, employeeId: 'employee-002', providerCode: 'dingtalk' },
    ]);
    const result = await run(store, () => store.service.reconcile('reconcile-key-002', {
      stateId: STATE_ID,
      month: '2026-04',
      afterMappingId: MAPPING_1,
      limit: 100,
    }));
    expect(result).toEqual(expect.objectContaining({
      attestedCount: 1,
      nextAfterMappingId: null,
      complete: true,
    }));
  });

  it.each([
    ['用户身份', 'user' as const, [
      'erp:attendance:provider:reconcile',
      'erp:attendance:coverage:attest',
    ]],
    ['缺少对账 Scope', 'service' as const, ['erp:attendance:coverage:attest']],
    ['缺少证明 Scope', 'system_job' as const, ['erp:attendance:provider:reconcile']],
  ])('%s 被拒绝', async (_name, actorType, scopes) => {
    const store = assemble();
    await expect(run(
      store,
      () => store.service.reconcile('reconcile-auth', {
        stateId: STATE_ID,
        month: '2026-04',
      }),
      scopes,
      actorType,
    )).rejects.toBeInstanceOf(ForbiddenException);
    expect(store.states.findOne).not.toHaveBeenCalled();
  });

  it('活动 Provider 状态不存在时返回 404', async () => {
    const store = assemble();
    store.setState(null);
    await expect(run(store, () => store.service.reconcile('reconcile-state', {
      stateId: STATE_ID,
      month: '2026-04',
    }))).rejects.toBeInstanceOf(NotFoundException);
  });

  it.each([
    ['缺少游标', {
      cursorKeyId: null,
      cursorIv: null,
      cursorCiphertext: null,
      cursorAuthTag: null,
    }, 'ATTENDANCE_PROVIDER_WATERMARK_MISSING'],
    ['未完成映射分页', {}, 'ATTENDANCE_PROVIDER_MAPPING_PAGE_INCOMPLETE'],
    ['水位未覆盖月末', {}, 'ATTENDANCE_PROVIDER_WATERMARK_INCOMPLETE'],
    ['从未拉取', { lastPolledAt: null }, 'ATTENDANCE_PROVIDER_WATERMARK_INCOMPLETE'],
  ])('%s 时失败关闭', async (name, stateOverrides, code) => {
    const store = assemble();
    if (name === '未完成映射分页') {
      store.setCursor({
        throughDate: '2026-04-20',
        windowToDate: '2026-04-26',
        employeeAfterId: MAPPING_1,
      });
    }
    if (name === '水位未覆盖月末') {
      store.setCursor({
        throughDate: '2026-04-29',
        windowToDate: null,
        employeeAfterId: null,
      });
    }
    store.setState(state(stateOverrides));
    await expect(run(store, () => store.service.reconcile('reconcile-watermark', {
      stateId: STATE_ID,
      month: '2026-04',
    }))).rejects.toMatchObject({ response: { code } });
  });

  it('月份内任何未完成、失败或人工复核 Inbox 都阻止覆盖证明', async () => {
    const store = assemble();
    store.setUnresolved(1);
    await expect(run(store, () => store.service.reconcile('reconcile-unresolved', {
      stateId: STATE_ID,
      month: '2026-04',
    }))).rejects.toMatchObject({
      response: { code: 'ATTENDANCE_PROVIDER_INBOX_UNRESOLVED' },
    });
    expect(store.attendanceRules.attestProviderCoverage).not.toHaveBeenCalled();
  });

  it('首个分页没有活动映射时失败关闭，后续空页可幂等完成', async () => {
    const missing = assemble();
    missing.setMappings([]);
    await expect(run(missing, () => missing.service.reconcile('reconcile-mapping', {
      stateId: STATE_ID,
      month: '2026-04',
    }))).rejects.toBeInstanceOf(ConflictException);

    const completed = assemble();
    completed.setMappings([]);
    const result = await run(completed, () => completed.service.reconcile('reconcile-end', {
      stateId: STATE_ID,
      month: '2026-04',
      afterMappingId: MAPPING_2,
    }));
    expect(result).toEqual(expect.objectContaining({
      attestedCount: 0,
      complete: true,
    }));
  });

  it('拒绝受损、非完整或未知字段的解密水位线', async () => {
    const store = assemble();
    store.setCursor({
      throughDate: '2026-04-30',
      windowToDate: null,
      employeeAfterId: null,
      token: 'must-not-pass',
    });
    await expect(run(store, () => store.service.reconcile('reconcile-cursor', {
      stateId: STATE_ID,
      month: '2026-04',
    }))).rejects.toThrow();
    expect(store.mappings.find).not.toHaveBeenCalled();
  });
});
