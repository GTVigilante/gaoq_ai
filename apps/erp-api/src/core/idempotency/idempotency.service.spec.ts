import {
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
} from '@nestjs/common';
import type { ClientSession, Connection, Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import { TenantContextService } from '../tenant/tenant-context.service.js';
import type { IdempotencyRecordDocument } from './idempotency.schema.js';
import { IdempotencyService } from './idempotency.service.js';

const trustedContext = {
  tenant: { tenantId: 'tenant-001', source: 'access_token' as const },
  actor: {
    actorId: 'actor-001', actorType: 'user' as const, tenantId: 'tenant-001',
    roleCodes: ['org-admin'], scopes: ['erp:org:master:write'], departmentIds: [], traceId: 'trace-001',
  },
};

/** 构造 mongoose 查询链 mock：findOne(...).session(s).lean().exec() 与 findOne(...).lean().exec()。 */
const queryChain = (result: unknown) => {
  const exec = vi.fn().mockResolvedValue(result);
  const lean = vi.fn(() => ({ exec }));
  const session = vi.fn(() => ({ lean }));
  return { session, lean };
};

interface FakeStore {
  model: {
    findOne: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    updateOne: ReturnType<typeof vi.fn>;
  };
  connection: { startSession: ReturnType<typeof vi.fn> };
  session: ClientSession;
  service: IdempotencyService;
  context: TenantContextService;
}

/** 组装 mock Connection/Model 与被测服务；findOneResults 按调用次序返回。 */
function assemble(findOneResults: unknown[]): FakeStore {
  const context = new TenantContextService();
  const findOne = vi.fn();
  for (const result of findOneResults) {
    findOne.mockReturnValueOnce(queryChain(result));
  }
  findOne.mockImplementation(() => queryChain(null));
  const create = vi.fn().mockResolvedValue([]);
  const updateOne = vi.fn().mockResolvedValue({ modifiedCount: 1 });
  // 与真实 mongoose 一致：withTransaction 回调与后续操作共用同一 session 对象
  const session = {
    withTransaction: vi.fn((fn: (session: ClientSession) => Promise<unknown>) =>
      fn(session as unknown as ClientSession),
    ),
    endSession: vi.fn().mockResolvedValue(undefined),
  };
  const startSession = vi.fn().mockResolvedValue(session);
  const service = new IdempotencyService(
    { startSession } as unknown as Connection,
    { findOne, create, updateOne } as unknown as Model<IdempotencyRecordDocument>,
    context,
  );
  return {
    model: { findOne, create, updateOne },
    connection: { startSession },
    session: session as unknown as ClientSession,
    service,
    context,
  };
}

const run = <T>(store: FakeStore, fn: () => Promise<T>): Promise<T> =>
  store.context.run(trustedContext, fn);

/** 捕获拒绝值，便于断言异常类型与稳定 code。 */
function capture(promise: Promise<unknown>): Promise<unknown> {
  return promise.catch((error: unknown) => error);
}

describe('IdempotencyService', () => {
  it('租户标识只取自已验证上下文，忽略请求体中的伪造 tenantId', async () => {
    const store = assemble([null]);
    const result = await run(store, () =>
      store.service.execute(
        'org.department.create',
        'key-0001',
        { tenantId: 'attacker-tenant', name: '财务部' },
        () => Promise.resolve({ id: 'dept-001' }),
      ),
    );

    expect(result).toEqual({ id: 'dept-001' });
    const created = store.model.create.mock.calls[0]?.[0] as Array<Record<string, unknown>>;
    expect(created[0]).toMatchObject({
      tenantId: 'tenant-001',
      operation: 'org.department.create',
      idempotencyKey: 'key-0001',
      status: 'processing',
      response: null,
    });
    expect(created[0]?.['expiresAt']).toBeInstanceOf(Date);
  });

  it('缺少可信租户上下文时拒绝执行', async () => {
    const store = assemble([]);
    await expect(
      store.service.execute('org.department.create', 'key-0001', {}, () => Promise.resolve({})),
    ).rejects.toThrow('可信租户上下文不存在');
    expect(store.model.create).not.toHaveBeenCalled();
  });

  it('请求哈希稳定：对象键序无关、数组保序', async () => {
    const first = assemble([null]);
    await run(first, () =>
      first.service.execute('op.a', 'key-hash-1', { b: 2, a: [1, 2], c: { y: 1, x: 2 } }, () =>
        Promise.resolve({ ok: true }),
      ),
    );
    const second = assemble([null]);
    await run(second, () =>
      second.service.execute('op.a', 'key-hash-1', { c: { x: 2, y: 1 }, a: [1, 2], b: 2 }, () =>
        Promise.resolve({ ok: true }),
      ),
    );

    const hashA = (first.model.create.mock.calls[0]?.[0] as Array<Record<string, unknown>>)[0]?.['requestHash'];
    const hashB = (second.model.create.mock.calls[0]?.[0] as Array<Record<string, unknown>>)[0]?.['requestHash'];
    expect(hashA).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hashA).toBe(hashB);
  });

  it('同键同请求重放：返回深拷贝冻结响应，handler 不再执行', async () => {
    const store = assemble([null]);
    const handler = vi.fn(() => Promise.resolve({ id: 'dept-001', nested: { count: 1 } }));
    const first = await run(store, () =>
      store.service.execute('op.a', 'key-replay-1', { name: '财务部' }, handler),
    );
    const completed = {
      tenantId: 'tenant-001',
      operation: 'op.a',
      idempotencyKey: 'key-replay-1',
      requestHash: (store.model.create.mock.calls[0]?.[0] as Array<Record<string, unknown>>)[0]?.['requestHash'],
      status: 'completed',
      response: { id: 'dept-001', nested: { count: 1 } },
    };
    const replayStore = assemble([completed]);
    const replayHandler = vi.fn(() => Promise.resolve({ id: 'should-not-run' }));
    const second = await run(replayStore, () =>
      replayStore.service.execute('op.a', 'key-replay-1', { name: '财务部' }, replayHandler),
    );

    expect(first).toEqual(second);
    expect(replayHandler).not.toHaveBeenCalled();
    expect(second).not.toBe(completed.response);
    expect(Object.isFrozen(second)).toBe(true);
    const nested = (second as unknown as { nested: object }).nested;
    expect(Object.isFrozen(nested)).toBe(true);
    expect(() => {
      (second as Record<string, unknown>)['id'] = 'tampered';
    }).toThrow();
  });

  it('同键不同请求：抛 409 IDEMPOTENCY_KEY_REUSED', async () => {
    const existing = {
      status: 'completed',
      requestHash: 'other-hash',
      response: { id: 'dept-001' },
    };
    const store = assemble([existing]);
    const handler = vi.fn(() => Promise.resolve({}));

    const failure = await capture(
      run(store, () => store.service.execute('op.a', 'key-reuse-1', { name: '别的' }, handler)),
    );

    expect(failure).toBeInstanceOf(ConflictException);
    expect((failure as ConflictException).getStatus()).toBe(409);
    expect((failure as ConflictException).getResponse()).toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('同键处理中：抛 409 IDEMPOTENCY_IN_PROGRESS', async () => {
    const existing = { status: 'processing', requestHash: 'any-hash', response: null };
    const store = assemble([existing]);
    const handler = vi.fn(() => Promise.resolve({}));

    const failure = await capture(
      run(store, () => store.service.execute('op.a', 'key-prog-1', {}, handler)),
    );

    expect(failure).toBeInstanceOf(ConflictException);
    expect((failure as ConflictException).getResponse()).toMatchObject({
      code: 'IDEMPOTENCY_IN_PROGRESS',
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('handler 使用事务同一 ClientSession，落库走同一 session', async () => {
    const store = assemble([null]);
    let handlerSession: ClientSession | undefined;
    await run(store, () =>
      store.service.execute('op.a', 'key-session-1', {}, (session) => {
        handlerSession = session;
        return Promise.resolve({ id: 'x-001' });
      }),
    );

    expect(handlerSession).toBe(store.session);
    expect(store.model.create.mock.calls[0]?.[1]).toEqual({ session: store.session });
    expect(store.model.updateOne.mock.calls[0]?.[2]).toEqual({ session: store.session });
    const update = store.model.updateOne.mock.calls[0]?.[1] as { $set: Record<string, unknown> };
    expect(update.$set['status']).toBe('completed');
    expect(update.$set['response']).toEqual({ id: 'x-001' });
  });

  it('handler 异常不吞掉：原样抛出且不写 completed（真实环境事务回滚）', async () => {
    const store = assemble([null]);
    const failure = await capture(
      run(store, () =>
        store.service.execute('op.a', 'key-fail-1', {}, () =>
          Promise.reject(new Error('业务失败')),
        ),
      ),
    );

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('业务失败');
    expect(store.model.updateOne).not.toHaveBeenCalled();
  });

  it('非法幂等键与非法 operation：抛 400 且不触库', async () => {
    const store = assemble([]);
    const badKeys = ['short', 'key with space!!', 'x'.repeat(129)];
    for (const key of badKeys) {
      const failure = await capture(
        run(store, () => store.service.execute('op.a', key, {}, () => Promise.resolve({}))),
      );
      expect(failure).toBeInstanceOf(BadRequestException);
      expect((failure as BadRequestException).getResponse()).toMatchObject({
        code: 'IDEMPOTENCY_INVALID_KEY',
      });
    }
    const badOperation = await capture(
      run(store, () =>
        store.service.execute('非法操作', 'key-valid-1', {}, () => Promise.resolve({})),
      ),
    );
    expect(badOperation).toBeInstanceOf(BadRequestException);
    expect((badOperation as BadRequestException).getResponse()).toMatchObject({
      code: 'IDEMPOTENCY_INVALID_OPERATION',
    });
    expect(store.connection.startSession).not.toHaveBeenCalled();
  });

  it('请求体拒绝 undefined/循环引用/超深嵌套：400 IDEMPOTENCY_INVALID_REQUEST', async () => {
    const store = assemble([]);
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 25; i += 1) {
      deep = { nested: deep };
    }
    const invalidRequests: unknown[] = [{ value: undefined }, circular, deep];
    for (const request of invalidRequests) {
      const failure = await capture(
        run(store, () =>
          store.service.execute('op.a', 'key-req-1', request, () => Promise.resolve({})),
        ),
      );
      expect(failure).toBeInstanceOf(BadRequestException);
      expect((failure as BadRequestException).getResponse()).toMatchObject({
        code: 'IDEMPOTENCY_INVALID_REQUEST',
      });
    }
    expect(store.connection.startSession).not.toHaveBeenCalled();
  });

  it('响应含敏感键：失败关闭，抛 IDEMPOTENCY_SENSITIVE_RESPONSE 且不落 completed', async () => {
    const store = assemble([null]);
    const failure = await capture(
      run(store, () =>
        store.service.execute('op.a', 'key-sensitive-1', {}, () =>
          Promise.resolve({ data: { accessToken: '上游令牌' } }),
        ),
      ),
    );

    expect(failure).toBeInstanceOf(InternalServerErrorException);
    expect((failure as InternalServerErrorException).getResponse()).toMatchObject({
      code: 'IDEMPOTENCY_SENSITIVE_RESPONSE',
    });
    expect(store.model.updateOne).not.toHaveBeenCalled();
  });

  it('并发唯一键冲突 11000：事务外重读，同 hash 已完成则重放，否则 409', async () => {
    const makeRacedStore = (reRead: unknown) => {
      const store = assemble([null, reRead]);
      store.model.create.mockRejectedValueOnce(
        Object.assign(new Error('E11000 duplicate key error'), { code: 11000 }),
      );
      return store;
    };

    // 先取真实 hash：让首笔正常执行，捕获其 requestHash
    const winHash = assemble([null]);
    await run(winHash, () =>
      winHash.service.execute('op.a', 'key-race-0', { name: '财务部' }, () =>
        Promise.resolve({ id: 'w' }),
      ),
    );
    const realHash = (winHash.model.create.mock.calls[0]?.[0] as Array<Record<string, unknown>>)[0]?.['requestHash'];

    // 重读命中：completed 且同 hash → 重放冻结快照
    const replay = makeRacedStore({
      status: 'completed',
      requestHash: realHash,
      response: { id: 'winner-result' },
    });
    const handler = vi.fn(() => Promise.resolve({ id: 'loser' }));
    const replayed = await run(replay, () =>
      replay.service.execute('op.a', 'key-race-1', { name: '财务部' }, handler),
    );
    expect(replayed).toEqual({ id: 'winner-result' });
    expect(handler).not.toHaveBeenCalled();
    expect(Object.isFrozen(replayed)).toBe(true);

    // 重读命中：completed 但异 hash → 409 KEY_REUSED
    const reused = makeRacedStore({
      status: 'completed',
      requestHash: 'other-hash',
      response: { id: 'winner-result' },
    });
    const reusedFailure = await capture(
      run(reused, () => reused.service.execute('op.a', 'key-race-2', { name: '别的' }, handler)),
    );
    expect(reusedFailure).toBeInstanceOf(ConflictException);
    expect((reusedFailure as ConflictException).getResponse()).toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
    });

    // 重读命中：仍在 processing → 409 IN_PROGRESS
    const racing = makeRacedStore({ status: 'processing', requestHash: 'any', response: null });
    const racingFailure = await capture(
      run(racing, () => racing.service.execute('op.a', 'key-race-3', { name: '财务部' }, handler)),
    );
    expect(racingFailure).toBeInstanceOf(ConflictException);
    expect((racingFailure as ConflictException).getResponse()).toMatchObject({
      code: 'IDEMPOTENCY_IN_PROGRESS',
    });
  });

  it('业务 handler 的 11000 在不存在对应幂等记录时原样抛出', async () => {
    const store = assemble([null, null]);
    const businessConflict = Object.assign(new Error('employeeNo duplicate'), { code: 11000 });

    const failure = await capture(
      run(store, () =>
        store.service.execute('org.employee.create', 'key-business-1', {}, () =>
          Promise.reject(businessConflict),
        ),
      ),
    );

    expect(failure).toBe(businessConflict);
  });
});
