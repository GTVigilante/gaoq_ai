import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { createHash } from 'node:crypto';
import type { ClientSession, Connection, Model } from 'mongoose';

import { TenantContextService } from '../tenant/tenant-context.service.js';
import {
  IDEMPOTENCY_TTL_SECONDS,
  IdempotencyRecord,
  type IdempotencyRecordDocument,
} from './idempotency.schema.js';

/** 幂等键白名单：字母数字及 . _ : -，长度 8..128。 */
const KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
/** 操作标识白名单：同字符集，长度 1..128。 */
const OPERATION_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
/** 禁止出现在响应中的敏感键名（token/secret/password/authorization）。 */
const FORBIDDEN_RESPONSE_KEY = /token|secret|password|authorization/i;
/** 稳定规范 JSON 的最大嵌套深度。 */
const MAX_CANONICAL_DEPTH = 20;
/** 响应敏感键递归扫描的最大深度，超过即失败关闭。 */
const MAX_SCAN_DEPTH = 20;
/** Mongo 唯一键冲突错误码。 */
const DUPLICATE_KEY_CODE = 11000;

/**
 * 生成稳定规范 JSON：对象键递归排序、数组保序；
 * 拒绝 undefined/function/symbol/BigInt/循环引用/非纯对象/深度超限。
 */
function canonicalize(value: unknown, depth: number, seen: ReadonlySet<object>): string {
  if (depth > MAX_CANONICAL_DEPTH) {
    throw new Error('嵌套深度超过限制');
  }
  if (value === null) {
    return 'null';
  }
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) {
        throw new Error('数值必须为有限数');
      }
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'object':
      break;
    default:
      // undefined / function / symbol / bigint 均不属于纯 JSON
      throw new Error(`不支持的类型 ${typeof value}`);
  }
  if (seen.has(value)) {
    throw new Error('存在循环引用');
  }
  const nextSeen = new Set(seen);
  nextSeen.add(value);
  if (Array.isArray(value)) {
    const items = value.map((item) => canonicalize(item, depth + 1, nextSeen));
    return `[${items.join(',')}]`;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error('仅允许纯对象');
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  const pairs = entries.map(
    ([key, item]) => `${JSON.stringify(key)}:${canonicalize(item, depth + 1, nextSeen)}`,
  );
  return `{${pairs.join(',')}}`;
}

/** 递归扫描响应键名；命中敏感键或递归过深均返回 true（失败关闭）。 */
function containsForbiddenKey(value: unknown, depth = 0): boolean {
  if (depth > MAX_SCAN_DEPTH) {
    return true;
  }
  if (value === null || typeof value !== 'object') {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsForbiddenKey(item, depth + 1));
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_RESPONSE_KEY.test(key)) {
      return true;
    }
    if (containsForbiddenKey(nested, depth + 1)) {
      return true;
    }
  }
  return false;
}

/** 深拷贝并递归冻结，防止重放响应被调用方篡改后污染快照语义。 */
function freezeClone<T>(value: T): T {
  const clone = structuredClone(value);
  deepFreeze(clone, new Set());
  return clone;
}

function deepFreeze(value: unknown, seen: Set<object>): void {
  if (value === null || typeof value !== 'object' || seen.has(value)) {
    return;
  }
  seen.add(value);
  Object.freeze(value);
  for (const item of Object.values(value)) {
    deepFreeze(item, seen);
  }
}

/** 判断是否为 Mongo 唯一键冲突（11000）。 */
function isDuplicateKeyError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  const message = error instanceof Error ? error.message : '';
  return code === DUPLICATE_KEY_CODE || message.includes('E11000');
}

@Injectable()
export class IdempotencyService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(IdempotencyRecord.name)
    private readonly records: Model<IdempotencyRecordDocument>,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * 以幂等语义执行写操作：
   * 1. 租户标识只取自已验证身份上下文，禁止信任入参；
   * 2. 请求体经稳定规范 JSON 计算 SHA-256（base64url）；
   * 3. 事务内查重：同键同 hash 直接重放冻结快照，同键异 hash 或处理中抛 409；
   * 4. 未命中则先落 processing 记录，再以同一 ClientSession 执行业务 handler；
   * 5. 响应必须为纯 JSON 且通过敏感键扫描，完成后落 completed 快照（TTL 24h）；
   * 6. 并发唯一键冲突（11000）在事务外重读一次裁决；handler 异常不吞掉，事务回滚。
   */
  async execute<T extends Record<string, unknown>>(
    operation: string,
    idempotencyKey: string,
    request: unknown,
    handler: (session: ClientSession) => Promise<T>,
  ): Promise<T> {
    if (!OPERATION_PATTERN.test(operation)) {
      throw new BadRequestException({
        code: 'IDEMPOTENCY_INVALID_OPERATION',
        message: 'operation 不符合白名单规则（1..128 位字母数字及 . _ : -）',
      });
    }
    if (!KEY_PATTERN.test(idempotencyKey)) {
      throw new BadRequestException({
        code: 'IDEMPOTENCY_INVALID_KEY',
        message: 'idempotencyKey 不符合白名单规则（8..128 位字母数字及 . _ : -）',
      });
    }
    const requestHash = this.hashRequest(request);
    const tenantId = this.tenantContext.getTenantRequired().tenantId;
    const filter = { tenantId, operation, idempotencyKey };

    const session = await this.connection.startSession();
    try {
      return await session.withTransaction(async () => {
        const existing = await this.records.findOne(filter).session(session).lean().exec();
        if (existing !== null) {
          return this.replayOrReject<T>(existing, requestHash);
        }
        const expiresAt = new Date(Date.now() + IDEMPOTENCY_TTL_SECONDS * 1000);
        await this.records.create(
          [{ ...filter, requestHash, status: 'processing', response: null, expiresAt }],
          { session },
        );
        const result = await handler(session);
        this.assertStorableResponse(result);
        await this.records.updateOne(
          filter,
          { $set: { status: 'completed', response: structuredClone(result) } },
          { session },
        );
        return result;
      });
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        // 并发同键插入冲突：事务外重读一次裁决
        const existing = await this.records.findOne(filter).lean().exec();
        if (existing !== null) {
          return this.replayOrReject<T>(existing, requestHash);
        }
        // 对应幂等记录不存在，说明 11000 来自业务 handler 的唯一约束；不得掩盖真实业务冲突。
        throw error;
      }
      throw error;
    } finally {
      await session.endSession();
    }
  }

  /** 请求体稳定规范 JSON 的 SHA-256（base64url）。 */
  private hashRequest(request: unknown): string {
    let canonical: string;
    try {
      canonical = canonicalize(request, 0, new Set());
    } catch (error) {
      throw new BadRequestException({
        code: 'IDEMPOTENCY_INVALID_REQUEST',
        message: `请求体无法序列化为稳定规范 JSON：${error instanceof Error ? error.message : '未知原因'}`,
      });
    }
    return createHash('sha256').update(canonical, 'utf8').digest('base64url');
  }

  /** 已存在记录的裁决：同 hash 已完成则重放冻结快照，否则抛 409。 */
  private replayOrReject<T extends Record<string, unknown>>(
    existing: Pick<IdempotencyRecord, 'status' | 'requestHash' | 'response'>,
    requestHash: string,
  ): T {
    if (existing.status === 'completed') {
      if (existing.requestHash === requestHash && existing.response !== null) {
        return freezeClone(existing.response) as T;
      }
      throw new ConflictException({
        code: 'IDEMPOTENCY_KEY_REUSED',
        message: '幂等键已被不同请求占用',
      });
    }
    throw new ConflictException({
      code: 'IDEMPOTENCY_IN_PROGRESS',
      message: '相同幂等键的请求正在处理中',
    });
  }

  /** 响应必须为纯 JSON 且不含敏感键，违反即失败关闭（不落 completed）。 */
  private assertStorableResponse(response: unknown): void {
    if (response === null || typeof response !== 'object' || Array.isArray(response)) {
      throw new InternalServerErrorException({
        code: 'IDEMPOTENCY_INVALID_RESPONSE',
        message: '响应必须为纯 JSON 对象',
      });
    }
    try {
      canonicalize(response, 0, new Set());
    } catch (error) {
      throw new InternalServerErrorException({
        code: 'IDEMPOTENCY_INVALID_RESPONSE',
        message: `响应必须为纯 JSON 对象：${error instanceof Error ? error.message : '未知原因'}`,
      });
    }
    if (containsForbiddenKey(response)) {
      throw new InternalServerErrorException({
        code: 'IDEMPOTENCY_SENSITIVE_RESPONSE',
        message: '响应包含 token/secret/password/authorization 等敏感键，禁止写入幂等记录',
      });
    }
  }
}
