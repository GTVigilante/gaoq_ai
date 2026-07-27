import type { ClientSession, Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { RecruitmentDataCryptoService } from '../../recruitment/persistence/recruitment-data-crypto.service.js';
import type { TalentTouchpoint } from '../domain/index.js';
import {
  TalentTouchpointRepository,
  TalentTouchpointWriteConflictError,
} from './talent-lifecycle.repository.js';
import type {
  TalentTouchpointDocument,
  TalentTouchpointRecord,
} from './talent-lifecycle.schemas.js';

const session = { id: 'session-001' } as unknown as ClientSession;

function context(tenantId = 'tenant-001'): TenantContextService {
  return {
    getTenantRequired: vi.fn().mockReturnValue({ tenantId }),
  } as unknown as TenantContextService;
}

function crypto() {
  return {
    protect: vi.fn().mockReturnValue({
      keyId: 'recruitment-key-001',
      iv: 'a'.repeat(16),
      ciphertext: 'ciphertext',
      authTag: 'b'.repeat(22),
    }),
    unprotect: vi.fn().mockReturnValue({ note: '跟进备注' }),
  };
}

function query<T>(resolve: () => T | Promise<T>) {
  const value = {
    session: vi.fn(),
    sort: vi.fn(),
    limit: vi.fn(),
    lean: vi.fn(),
    exec: vi.fn(async () => resolve()),
  };
  value.session.mockReturnValue(value);
  value.sort.mockReturnValue(value);
  value.limit.mockReturnValue(value);
  value.lean.mockReturnValue(value);
  return value;
}

function modelHarness() {
  let one: unknown = null;
  let many: readonly unknown[] = [];
  const queries: ReturnType<typeof query>[] = [];
  const model = {
    create: vi.fn().mockResolvedValue(undefined),
    updateOne: vi.fn().mockResolvedValue({ matchedCount: 1 }),
    findOne: vi.fn().mockImplementation(() => {
      const current = query(() => one);
      queries.push(current);
      return current;
    }),
    find: vi.fn().mockImplementation(() => {
      const current = query(() => many);
      queries.push(current);
      return current;
    }),
  };
  return {
    model,
    queries,
    setOne: (value: unknown) => { one = value; },
    setMany: (value: readonly unknown[]) => { many = value; },
  };
}

function touchpoint(overrides: Partial<TalentTouchpoint> = {}): TalentTouchpoint {
  return Object.freeze({
    id: '01J8ZQK7V0A2M4N6P8R0T2W4Y0',
    tenantId: 'tenant-001',
    candidateId: '01J8ZQK7V0A2M4N6P8R0T2W4Y1',
    kind: 'candidate_outreach',
    channel: 'phone',
    direction: 'outbound',
    outcome: 'follow_up_required',
    ownerActorId: 'actor-001',
    occurredAt: '2026-07-27T08:00:00.000Z',
    nextActionAt: '2026-07-28T08:00:00.000Z',
    status: 'open',
    note: '跟进备注',
    version: 1,
    createdAt: '2026-07-27T08:00:00.000Z',
    updatedAt: '2026-07-27T08:00:00.000Z',
    ...overrides,
  });
}

function record(overrides: Partial<TalentTouchpointRecord> = {}): TalentTouchpointRecord {
  return {
    id: '01J8ZQK7V0A2M4N6P8R0T2W4Y0',
    tenantId: 'tenant-001',
    candidateId: '01J8ZQK7V0A2M4N6P8R0T2W4Y1',
    kind: 'candidate_outreach',
    channel: 'phone',
    direction: 'outbound',
    outcome: 'follow_up_required',
    ownerActorId: 'actor-001',
    occurredAt: new Date('2026-07-27T08:00:00.000Z'),
    nextActionAt: new Date('2026-07-28T08:00:00.000Z'),
    status: 'open',
    noteKeyId: null,
    noteIv: null,
    noteCiphertext: null,
    noteAuthTag: null,
    version: 1,
    createdAt: new Date('2026-07-27T08:00:00.000Z'),
    updatedAt: new Date('2026-07-27T08:00:00.000Z'),
    ...overrides,
  };
}

function repository(
  harness = modelHarness(),
  cryptoService = crypto(),
  tenantContext = context(),
) {
  return {
    harness,
    cryptoService,
    value: new TalentTouchpointRepository(
      tenantContext,
      cryptoService as unknown as RecruitmentDataCryptoService,
      harness.model as unknown as Model<TalentTouchpointDocument>,
    ),
  };
}

describe('TalentTouchpointRepository', () => {
  it('按可信租户和标识查询，不存在时返回空值', async () => {
    const fixture = repository();

    await expect(fixture.value.findById('touchpoint-001')).resolves.toBeNull();

    expect(fixture.harness.model.findOne).toHaveBeenCalledWith({
      tenantId: 'tenant-001',
      id: 'touchpoint-001',
    });
    expect(fixture.harness.queries[0]?.session).not.toHaveBeenCalled();
  });

  it('事务内查询绑定会话并把无备注记录还原为领域对象', async () => {
    const fixture = repository();
    fixture.harness.setOne(record({ nextActionAt: null }));

    await expect(fixture.value.findById('touchpoint-001', session)).resolves.toMatchObject({
      tenantId: 'tenant-001',
      note: null,
      nextActionAt: null,
      occurredAt: '2026-07-27T08:00:00.000Z',
    });

    expect(fixture.harness.queries[0]?.session).toHaveBeenCalledWith(session);
    expect(fixture.cryptoService.unprotect).not.toHaveBeenCalled();
  });

  it('使用租户、资源类型和资源标识作为 AAD 解密备注', async () => {
    const fixture = repository();
    fixture.harness.setOne(record({
      noteKeyId: 'recruitment-key-001',
      noteIv: 'a'.repeat(16),
      noteCiphertext: 'ciphertext',
      noteAuthTag: 'b'.repeat(22),
    }));

    await expect(fixture.value.findById('touchpoint-001')).resolves.toMatchObject({
      note: '跟进备注',
    });
    expect(fixture.cryptoService.unprotect).toHaveBeenCalledWith({
      tenantId: 'tenant-001',
      resourceType: 'talent_touchpoint',
      resourceId: '01J8ZQK7V0A2M4N6P8R0T2W4Y0',
    }, {
      keyId: 'recruitment-key-001',
      iv: 'a'.repeat(16),
      ciphertext: 'ciphertext',
      authTag: 'b'.repeat(22),
    });
  });

  it('授权路由不存在时返回空值且只投影非敏感字段', async () => {
    const fixture = repository();

    await expect(fixture.value.findAuthorizationRoute('touchpoint-001')).resolves.toBeNull();
    expect(fixture.harness.model.findOne).toHaveBeenCalledWith(
      { tenantId: 'tenant-001', id: 'touchpoint-001' },
      { _id: 0, candidateId: 1, ownerActorId: 1 },
    );
  });

  it('授权路由只返回候选人与负责人标识', async () => {
    const fixture = repository();
    fixture.harness.setOne({
      candidateId: 'candidate-001',
      ownerActorId: 'actor-001',
      noteCiphertext: '不得返回',
    });

    await expect(fixture.value.findAuthorizationRoute('touchpoint-001')).resolves.toEqual({
      candidateId: 'candidate-001',
      ownerActorId: 'actor-001',
    });
  });

  it('候选人时间线强制租户过滤、稳定排序和五百条上限', async () => {
    const fixture = repository();
    fixture.harness.setMany([
      record({ id: 'touchpoint-002' }),
      record({ id: 'touchpoint-001', nextActionAt: null }),
    ]);

    await expect(fixture.value.findByCandidateId('candidate-001')).resolves.toHaveLength(2);
    expect(fixture.harness.model.find).toHaveBeenCalledWith({
      tenantId: 'tenant-001',
      candidateId: 'candidate-001',
    });
    expect(fixture.harness.queries[0]?.sort).toHaveBeenCalledWith({
      occurredAt: -1,
      id: 1,
    });
    expect(fixture.harness.queries[0]?.limit).toHaveBeenCalledWith(500);
  });

  it('插入无备注触点时不产生密文字段', async () => {
    const fixture = repository();

    await fixture.value.insert(touchpoint({ note: null }), session);

    const rows = fixture.harness.model.create.mock.calls[0]?.[0] as unknown as
      readonly Record<string, unknown>[];
    expect(rows[0]).toMatchObject({
      tenantId: 'tenant-001',
      noteKeyId: null,
      noteIv: null,
      noteCiphertext: null,
      noteAuthTag: null,
      nextActionAt: new Date('2026-07-28T08:00:00.000Z'),
    });
    expect(fixture.cryptoService.protect).not.toHaveBeenCalled();
    expect(fixture.harness.model.create).toHaveBeenCalledWith(rows, { session });
  });

  it('插入备注时仅持久化完整密文组合', async () => {
    const fixture = repository();

    await fixture.value.insert(touchpoint(), session);

    expect(fixture.cryptoService.protect).toHaveBeenCalledWith({
      tenantId: 'tenant-001',
      resourceType: 'talent_touchpoint',
      resourceId: '01J8ZQK7V0A2M4N6P8R0T2W4Y0',
    }, { note: '跟进备注' });
    const rows = fixture.harness.model.create.mock.calls[0]?.[0] as unknown as
      readonly Record<string, unknown>[];
    expect(rows[0]).toMatchObject({
      noteKeyId: 'recruitment-key-001',
      noteIv: 'a'.repeat(16),
      noteCiphertext: 'ciphertext',
      noteAuthTag: 'b'.repeat(22),
    });
    expect(rows[0]).not.toHaveProperty('note');
  });

  it('插入前拒绝客户端构造的跨租户实体', async () => {
    const fixture = repository();

    await expect(fixture.value.insert(
      touchpoint({ tenantId: 'tenant-evil' }),
      session,
    )).rejects.toThrow('人才服务触点仓储拒绝跨租户实体');
    expect(fixture.harness.model.create).not.toHaveBeenCalled();
  });

  it('关闭触点时使用可信租户和预期版本执行乐观锁更新', async () => {
    const fixture = repository();
    const closed = touchpoint({
      status: 'completed',
      version: 2,
      updatedAt: '2026-07-27T09:00:00.000Z',
    });

    await fixture.value.replace(closed, 1, session);

    expect(fixture.harness.model.updateOne).toHaveBeenCalledWith(
      {
        tenantId: 'tenant-001',
        id: '01J8ZQK7V0A2M4N6P8R0T2W4Y0',
        version: 1,
      },
      { $set: {
        status: 'completed',
        version: 2,
        updatedAt: new Date('2026-07-27T09:00:00.000Z'),
      } },
      { session, timestamps: false, runValidators: true },
    );
  });

  it('更新前拒绝跨租户实体', async () => {
    const fixture = repository();

    await expect(fixture.value.replace(
      touchpoint({ tenantId: 'tenant-evil' }),
      1,
      session,
    )).rejects.toThrow('人才服务触点仓储拒绝跨租户实体');
    expect(fixture.harness.model.updateOne).not.toHaveBeenCalled();
  });

  it('乐观锁未命中时抛出稳定冲突类型', async () => {
    const fixture = repository();
    fixture.harness.model.updateOne.mockResolvedValueOnce({ matchedCount: 0 });

    await expect(fixture.value.replace(touchpoint(), 0, session))
      .rejects.toBeInstanceOf(TalentTouchpointWriteConflictError);
  });

  it.each([
    [{ noteKeyId: 'key', noteIv: null, noteCiphertext: null, noteAuthTag: null }],
    [{ noteKeyId: null, noteIv: 'iv', noteCiphertext: null, noteAuthTag: null }],
    [{ noteKeyId: null, noteIv: null, noteCiphertext: 'ciphertext', noteAuthTag: null }],
    [{ noteKeyId: null, noteIv: null, noteCiphertext: null, noteAuthTag: 'tag' }],
  ])('任一密文字段部分存在时失败关闭：%o', async (encrypted) => {
    const fixture = repository();
    fixture.harness.setOne(record(encrypted));

    await expect(fixture.value.findById('touchpoint-001'))
      .rejects.toThrow('TALENT_TOUCHPOINT_CIPHERTEXT_INVALID');
    expect(fixture.cryptoService.unprotect).not.toHaveBeenCalled();
  });

  it.each([
    null,
    [],
    {},
    { note: 7 },
  ])('解密负载不是严格备注对象时失败关闭：%o', async (decrypted) => {
    const cryptoService = crypto();
    cryptoService.unprotect.mockReturnValueOnce(decrypted);
    const fixture = repository(modelHarness(), cryptoService);
    fixture.harness.setOne(record({
      noteKeyId: 'recruitment-key-001',
      noteIv: 'a'.repeat(16),
      noteCiphertext: 'ciphertext',
      noteAuthTag: 'b'.repeat(22),
    }));

    await expect(fixture.value.findById('touchpoint-001'))
      .rejects.toThrow('TALENT_TOUCHPOINT_CIPHERTEXT_INVALID');
  });
});
