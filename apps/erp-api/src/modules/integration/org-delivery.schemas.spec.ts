import { Mongoose } from 'mongoose';
import type { Model } from 'mongoose';
import { describe, expect, it } from 'vitest';

import {
  OrgDeliveryRecordSchema,
  OrgExternalVersionStateSchema,
  type OrgDeliveryRecord,
  type OrgExternalVersionState,
} from './org-delivery.schemas.js';
import {
  ORG_DELIVERY_MAX_ATTEMPTS,
  ORG_DELIVERY_RETRY_DELAYS_MS,
  calculateNextAttemptAt,
  classifyOrgDeliveryFailure,
} from './org-delivery.policy.js';

/**
 * 不连库校验：独立 Mongoose 实例仅用于注册模型，
 * document.validate() 在内存中执行校验器，不发起任何连接。
 */
const mongoose = new Mongoose();

const DeliveryModel = mongoose.model<OrgDeliveryRecord>(
  'SpecOrgDelivery',
  OrgDeliveryRecordSchema,
);
const VersionStateModel = mongoose.model<OrgExternalVersionState>(
  'SpecOrgExternalVersionState',
  OrgExternalVersionStateSchema,
);

const VALID_ULID = '01J8ZQK7V0A2M4N6P8R0T2W4Y6';
const VALID_ULID_2 = '01J8ZQK7V0A2M4N6P8R0T2W4Y7';

/** 校验文档，期望通过；失败时抛出带校验明细的异常。 */
async function expectValid(doc: unknown): Promise<void> {
  await (doc as { validate(): Promise<void> }).validate();
}

/** 校验文档，期望失败且错误信息命中指定字段。 */
async function expectInvalid(doc: unknown, path: string): Promise<void> {
  await expect((doc as { validate(): Promise<void> }).validate()).rejects.toThrowError(
    new RegExp(path),
  );
}

function validDelivery(): Record<string, unknown> {
  return {
    eventId: VALID_ULID,
    tenantId: 'tenant-a',
    channel: 'dingtalk',
    aggregateType: 'org.department',
    aggregateId: 'dept-1',
    aggregateVersion: 1,
    eventType: 'org.department.created',
    envelope: { payload: { name: '人力资源部' } },
    status: 'pending',
    attempts: 0,
    nextAttemptAt: new Date('2026-01-01T00:00:00.000Z'),
  };
}

function validVersionState(): Record<string, unknown> {
  return {
    tenantId: 'tenant-a',
    channel: 'feishu',
    aggregateType: 'org.employee',
    aggregateId: 'emp-1',
    appliedVersion: 3,
    externalId: 'ou_xxx',
    lastEventId: VALID_ULID,
  };
}

/** 构造指定层数的纯嵌套对象（不含任何敏感键）。 */
function buildNested(depth: number): Record<string, unknown> {
  let current: Record<string, unknown> = {};
  for (let index = 0; index < depth; index += 1) {
    current = { nested: current };
  }
  return current;
}

describe('OrgDeliveryRecordSchema 校验', () => {
  it('合法文档通过校验', async () => {
    await expectValid(new DeliveryModel(validDelivery()));
  });

  it('eventId 必须为严格 ULID', async () => {
    await expectInvalid(new DeliveryModel({ ...validDelivery(), eventId: 'not-a-ulid' }), 'eventId');
    await expectInvalid(
      new DeliveryModel({ ...validDelivery(), eventId: VALID_ULID.toLowerCase() }),
      'eventId',
    );
  });

  it('channel 仅允许 dingtalk/feishu/op', async () => {
    await expectValid(new DeliveryModel({ ...validDelivery(), channel: 'op' }));
    await expectInvalid(new DeliveryModel({ ...validDelivery(), channel: 'wecom' }), 'channel');
  });

  it('aggregateType 仅允许 org.department/org.employee', async () => {
    await expectInvalid(
      new DeliveryModel({ ...validDelivery(), aggregateType: 'org.position' }),
      'aggregateType',
    );
  });

  it('aggregateVersion 必须为正整数', async () => {
    await expectInvalid(
      new DeliveryModel({ ...validDelivery(), aggregateVersion: 0 }),
      'aggregateVersion',
    );
    await expectInvalid(
      new DeliveryModel({ ...validDelivery(), aggregateVersion: -1 }),
      'aggregateVersion',
    );
    await expectInvalid(
      new DeliveryModel({ ...validDelivery(), aggregateVersion: 1.5 }),
      'aggregateVersion',
    );
  });

  it('status 仅允许 pending/processing/succeeded/dead/manual_review', async () => {
    for (const status of ['pending', 'processing', 'succeeded', 'dead', 'manual_review']) {
      await expectValid(new DeliveryModel({ ...validDelivery(), status }));
    }
    await expectInvalid(new DeliveryModel({ ...validDelivery(), status: 'dispatched' }), 'status');
  });

  it('attempts 必须为非负整数', async () => {
    await expectInvalid(new DeliveryModel({ ...validDelivery(), attempts: -1 }), 'attempts');
    await expectInvalid(new DeliveryModel({ ...validDelivery(), attempts: 0.5 }), 'attempts');
  });

  it('operatorRetryCount 默认 0 且必须为非负整数', async () => {
    const doc = new DeliveryModel(validDelivery());
    expect(doc.operatorRetryCount).toBe(0);
    await expectInvalid(
      new DeliveryModel({ ...validDelivery(), operatorRetryCount: -1 }),
      'operatorRetryCount',
    );
  });

  it('lastErrorCategory 仅允许 retryable/business/conflict，默认 null', async () => {
    const doc = new DeliveryModel(validDelivery());
    expect(doc.lastErrorCategory).toBeNull();
    await expectValid(
      new DeliveryModel({ ...validDelivery(), lastErrorCategory: 'conflict' }),
    );
    await expectInvalid(
      new DeliveryModel({ ...validDelivery(), lastErrorCategory: 'fatal' }),
      'lastErrorCategory',
    );
  });

  it('envelope 命中浅层敏感键即拒绝', async () => {
    const cases = [
      { accessToken: 'x' },
      { appSecret: 'x' },
      { password: 'x' },
      { credential: 'x' },
      { authorization: 'Bearer x' },
      { idCard: '1101' },
      { bankCard: '6222' },
      { mobile: '138' },
      { phone: '138' },
      { email: 'a@b.c' },
    ];
    for (const envelope of cases) {
      await expectInvalid(new DeliveryModel({ ...validDelivery(), envelope }), 'envelope');
    }
  });

  it('envelope 深层嵌套敏感键同样拒绝', async () => {
    const envelope = { a: { b: { c: { d: { contactEmail: 'a@b.c' } } } } };
    await expectInvalid(new DeliveryModel({ ...validDelivery(), envelope }), 'envelope');
  });

  it('envelope 数组元素内敏感键拒绝', async () => {
    const envelope = { items: [{ name: 'ok' }, { mobile: '138' }] };
    await expectInvalid(new DeliveryModel({ ...validDelivery(), envelope }), 'envelope');
  });

  it('envelope 递归过深失败关闭', async () => {
    // 8 层纯嵌套（不含敏感键）超过 MAX_SCAN_DEPTH=6，按命中处理。
    await expectInvalid(
      new DeliveryModel({ ...validDelivery(), envelope: buildNested(8) }),
      'envelope',
    );
    // 5 层纯嵌套在深度限制内，正常通过。
    await expectValid(new DeliveryModel({ ...validDelivery(), envelope: buildNested(5) }));
  });
});

describe('OrgDeliveryRecordSchema 索引', () => {
  const indexes = OrgDeliveryRecordSchema.indexes();

  it('eventId+channel 唯一索引', () => {
    const hit = indexes.find(
      ([spec]) => spec.eventId === 1 && spec.channel === 1,
    );
    expect(hit?.[1]?.unique).toBe(true);
  });

  it('status+nextAttemptAt+createdAt 轮询索引', () => {
    const hit = indexes.find(
      ([spec]) => spec.status === 1 && spec.nextAttemptAt === 1 && spec.createdAt === 1,
    );
    expect(hit).toBeDefined();
  });

  it('tenant/channel/aggregate/version 查询索引', () => {
    const hit = indexes.find(
      ([spec]) =>
        spec.tenantId === 1 &&
        spec.channel === 1 &&
        spec.aggregateType === 1 &&
        spec.aggregateId === 1 &&
        spec.aggregateVersion === 1,
    );
    expect(hit).toBeDefined();
  });

  it('succeededAt 90 天 partial TTL 索引', () => {
    const hit = indexes.find(([spec]) => spec.succeededAt === 1);
    expect(hit?.[1]?.expireAfterSeconds).toBe(90 * 24 * 60 * 60);
    expect(hit?.[1]?.partialFilterExpression).toEqual({ status: 'succeeded' });
  });
});

describe('OrgExternalVersionStateSchema 校验', () => {
  it('合法文档通过校验', async () => {
    await expectValid(new VersionStateModel(validVersionState()));
  });

  it('appliedVersion 必须为非负整数', async () => {
    await expectInvalid(
      new VersionStateModel({ ...validVersionState(), appliedVersion: -1 }),
      'appliedVersion',
    );
    await expectInvalid(
      new VersionStateModel({ ...validVersionState(), appliedVersion: 0.5 }),
      'appliedVersion',
    );
    await expectValid(new VersionStateModel({ ...validVersionState(), appliedVersion: 0 }));
  });

  it('externalId 允许为 null', async () => {
    await expectValid(new VersionStateModel({ ...validVersionState(), externalId: null }));
  });

  it('lastEventId 必须为严格 ULID', async () => {
    await expectInvalid(
      new VersionStateModel({ ...validVersionState(), lastEventId: 'evt-001' }),
      'lastEventId',
    );
  });

  it('首次成功前 lastEventId 可为空，处理租约字段受严格校验', async () => {
    await expectValid(new VersionStateModel({
      ...validVersionState(),
      appliedVersion: 0,
      externalId: null,
      lastEventId: null,
      processingVersion: 1,
      processingEventId: VALID_ULID_2,
      lockedAt: new Date('2026-01-01T00:00:00.000Z'),
      lockedBy: 'worker-001',
    }));
    await expectInvalid(
      new VersionStateModel({ ...validVersionState(), processingVersion: 0 }),
      'processingVersion',
    );
    await expectInvalid(
      new VersionStateModel({ ...validVersionState(), processingEventId: 'event-invalid' }),
      'processingEventId',
    );
  });

  it('tenantId+channel+aggregateType+aggregateId 唯一索引', () => {
    const hit = OrgExternalVersionStateSchema.indexes().find(
      ([spec]) =>
        spec.tenantId === 1 &&
        spec.channel === 1 &&
        spec.aggregateType === 1 &&
        spec.aggregateId === 1,
    );
    expect(hit?.[1]?.unique).toBe(true);
  });
});

describe('calculateNextAttemptAt 退避策略', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');

  it('1..6 档基准延迟命中配置表（random=0.5 时抖动因子为 1）', () => {
    for (let attempts = 1; attempts <= ORG_DELIVERY_MAX_ATTEMPTS; attempts += 1) {
      const result = calculateNextAttemptAt(attempts, now, () => 0.5);
      const base = ORG_DELIVERY_RETRY_DELAYS_MS[attempts - 1];
      expect(result.getTime() - now.getTime()).toBe(base);
    }
  });

  it('attempts 超界或非法即抛 RangeError', () => {
    for (const attempts of [0, 7, -1, 1.5, Number.NaN]) {
      expect(() => calculateNextAttemptAt(attempts, now)).toThrowError(RangeError);
    }
  });

  it('非法 now 抛 TypeError', () => {
    expect(() => calculateNextAttemptAt(1, new Date('invalid'))).toThrowError(TypeError);
  });

  it('非法随机数抛 RangeError（<0 / >=1 / NaN）', () => {
    for (const sample of [-0.1, 1, 1.5, Number.NaN]) {
      expect(() => calculateNextAttemptAt(1, now, () => sample)).toThrowError(RangeError);
    }
  });

  it('抖动范围 [0.8x, 1.2x)：random=0 取下界，random 趋近 1 取上界', () => {
    const base = ORG_DELIVERY_RETRY_DELAYS_MS[0];
    expect(base).toBeDefined();
    if (base === undefined) {
      return;
    }
    const lower = calculateNextAttemptAt(1, now, () => 0).getTime() - now.getTime();
    expect(lower).toBe(Math.round(base * 0.8));
    const upper = calculateNextAttemptAt(1, now, () => 0.999999999).getTime() - now.getTime();
    // 上界经 Math.round 取整，允许等于四舍五入后的 1.2x。
    expect(upper).toBeLessThanOrEqual(Math.round(base * 1.2));
    expect(upper).toBeGreaterThan(base);
  });

  it('抖动结果确定性：给定 random 值可复算', () => {
    const base = ORG_DELIVERY_RETRY_DELAYS_MS[2];
    expect(base).toBeDefined();
    if (base === undefined) {
      return;
    }
    const sample = 0.25;
    const result = calculateNextAttemptAt(3, now, () => sample);
    const expected = Math.round(base * (1 + (sample * 2 - 1) * 0.2));
    expect(result.getTime() - now.getTime()).toBe(expected);
  });
});

describe('classifyOrgDeliveryFailure 失败分类', () => {
  it('网络失败（undefined / 非整数状态码）为 retryable', () => {
    expect(classifyOrgDeliveryFailure(undefined)).toBe('retryable');
    expect(classifyOrgDeliveryFailure(Number.NaN)).toBe('retryable');
  });

  it('408 / 429 / 5xx 为 retryable', () => {
    for (const status of [408, 429, 500, 502, 503, 599]) {
      expect(classifyOrgDeliveryFailure(status)).toBe('retryable');
    }
  });

  it('其余 4xx 为 business', () => {
    for (const status of [400, 401, 403, 404, 409, 422]) {
      expect(classifyOrgDeliveryFailure(status)).toBe('business');
    }
  });

  it('非失败语义的状态码归入 business（保守拦截，不盲目重试）', () => {
    for (const status of [200, 301]) {
      expect(classifyOrgDeliveryFailure(status)).toBe('business');
    }
  });
});

describe('类型导出冒烟', () => {
  it('Model 泛型可用', () => {
    const check: Model<OrgDeliveryRecord> = DeliveryModel;
    expect(check).toBeDefined();
  });

  it('两个 ULID 样例互不相同（防误用同值）', () => {
    expect(VALID_ULID).not.toBe(VALID_ULID_2);
  });
});
