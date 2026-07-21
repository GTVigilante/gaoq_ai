import { createHash } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { createEventId, ULID_PATTERN } from '@gaoq/shared-utils';
import type { Connection, Model } from 'mongoose';

import { AuditService } from '../../core/audit/audit.service.js';
import { TenantContextService } from '../../core/tenant/tenant-context.service.js';
import { AccessProfileRepository } from '../identity/access-profile.repository.js';
import { ExternalIdentityRepository } from '../identity/external-identity.repository.js';
import {
  OrgEmployeeRecord,
  type OrgEmployeeDocument,
} from '../org/persistence/org.schemas.js';
import type { CreateOrgEmployeeProvisioningRequestDto } from './org-employee-provisioning.dto.js';
import {
  OrgEmployeeProvisioningRequest,
  type OrgEmployeeProvisioningRequestDocument,
  type OrgEmployeeProvisioningStatus,
} from './org-employee-provisioning.schema.js';
import { calculateNextAttemptAt, ORG_DELIVERY_MAX_ATTEMPTS } from './org-delivery.policy.js';
import {
  OrgExternalVersionState,
  type OrgExternalVersionStateDocument,
} from './org-delivery.schemas.js';
import { OrgPlatformCredentialService } from './org-platform-credential.service.js';
import {
  OrgProvisioningCryptoService,
  type OrgProvisioningContact,
} from './org-provisioning-crypto.service.js';
import { OrgPushAdapterRegistry, OrgPushError, type OrgPushChannel } from './org-push.adapter.js';

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const WORKER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const LOCK_TIMEOUT_MS = 5 * 60 * 1_000;
const SENSITIVE_TTL_MS = 15 * 60 * 1_000;
const RECORD_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const DUPLICATE_KEY_CODE = 11_000;

/** 外部与本地事务已成功，但后置审计不可用；禁止再改写业务终态。 */
class ProvisioningPostCommitAuditError extends Error {}

interface ProvisioningResponse {
  readonly requestId: string;
  readonly status: OrgEmployeeProvisioningStatus;
  readonly sensitiveExpiresAt: string;
}

interface ClaimedProvisioning {
  readonly tenantId: string;
  readonly requestId: string;
  readonly employeeId: string;
  readonly channel: OrgPushChannel;
  readonly idempotencyKey: string;
  readonly payloadKeyId: string;
  readonly payloadIv: string | null;
  readonly payloadCiphertext: string | null;
  readonly payloadAuthTag: string | null;
  readonly attempts: number;
  readonly sensitiveExpiresAt: Date;
}

/**
 * 员工首次平台开户的加密存储转发编排。
 * API 进程只加密入队；Worker 解密后调用适配器，并在事务内提交最小权限主体、外部身份和请求终态。
 */
@Injectable()
export class OrgEmployeeProvisioningService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(OrgEmployeeProvisioningRequest.name)
    private readonly requests: Model<OrgEmployeeProvisioningRequestDocument>,
    @InjectModel(OrgEmployeeRecord.name)
    private readonly employees: Model<OrgEmployeeDocument>,
    @InjectModel(OrgExternalVersionState.name)
    private readonly versions: Model<OrgExternalVersionStateDocument>,
    private readonly context: TenantContextService,
    private readonly crypto: OrgProvisioningCryptoService,
    private readonly profiles: AccessProfileRepository,
    private readonly identities: ExternalIdentityRepository,
    private readonly credentials: OrgPlatformCredentialService,
    private readonly adapters: OrgPushAdapterRegistry,
    private readonly audit: AuditService,
  ) {}

  /** 将联系方式在当前请求内立即加密，不经过通用幂等响应快照。 */
  async submit(
    input: CreateOrgEmployeeProvisioningRequestDto,
    idempotencyKey: string,
  ): Promise<ProvisioningResponse> {
    const { tenant, actor } = this.context.getRequired();
    if (actor.actorType !== 'user') {
      throw new ForbiddenException({
        code: 'ORG_PROVISIONING_HUMAN_REQUIRED',
        message: 'R3 开户操作只允许已验证人员发起',
      });
    }
    if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
      throw new BadRequestException({
        code: 'ORG_PROVISIONING_IDEMPOTENCY_KEY_INVALID',
        message: '必须提供 8..128 位白名单字符 Idempotency-Key',
      });
    }
    if (input.contact.email === undefined && input.contact.mobile === undefined) {
      throw new BadRequestException({
        code: 'ORG_PROVISIONING_CONTACT_REQUIRED',
        message: '必须提供手机号或邮箱',
      });
    }
    if (input.channel === 'dingtalk' && input.contact.mobile === undefined) {
      throw new BadRequestException({
        code: 'DINGTALK_PROVISIONING_MOBILE_REQUIRED',
        message: '钉钉首次开户必须提供手机号',
      });
    }
    if (
      input.contact.mobile !== undefined &&
      input.contact.mobile.countryCode.length - 1 +
        input.contact.mobile.subscriberNumber.length > 15
    ) {
      throw new BadRequestException({
        code: 'ORG_PROVISIONING_MOBILE_INVALID',
        message: '手机号超过 E.164 15 位数字上限',
      });
    }
    const tenantId = tenant.tenantId;
    const existing = await this.requests.findOne(
      { tenantId, channel: input.channel, idempotencyKey },
      {
        requestId: 1,
        employeeId: 1,
        requestedByActorId: 1,
        inputDigest: 1,
        payloadKeyId: 1,
        status: 1,
        sensitiveExpiresAt: 1,
        _id: 0,
      },
    ).lean().exec();
    if (existing !== null) {
      return this.replayOrReject(existing, actor.actorId, input);
    }

    const employee = await this.employees.findOne(
      { tenantId, id: input.employeeId },
      { id: 1, status: 1, _id: 0 },
    ).lean().exec();
    if (employee === null) {
      throw new NotFoundException({ code: 'ORG_EMPLOYEE_NOT_FOUND', message: '员工不存在' });
    }
    if (employee.status !== 'probation' && employee.status !== 'active') {
      throw new ConflictException({
        code: 'ORG_PROVISIONING_EMPLOYEE_STATUS_INVALID',
        message: '仅试用或在职员工可申请首次开户',
      });
    }
    const externalTenantId = await this.credentials.resolveExternalTenantId(tenantId, input.channel);
    const bound = await this.identities.findBoundByEmployee(
      tenantId,
      input.channel,
      externalTenantId,
      input.employeeId,
    );
    if (bound !== null) {
      throw new ConflictException({
        code: 'ORG_PROVISIONING_ALREADY_BOUND',
        message: '员工已绑定该平台身份',
      });
    }
    const identity = await this.profiles.resolveEmployeeIdentity(tenantId, input.employeeId);
    if (identity?.status === 'disabled') {
      throw new ConflictException({
        code: 'ORG_PROVISIONING_IDENTITY_DISABLED',
        message: '员工授权主体已停用',
      });
    }

    const requestId = createEventId();
    const now = new Date();
    const sensitiveExpiresAt = new Date(now.getTime() + SENSITIVE_TTL_MS);
    const protectedPayload = await this.crypto.protect(
      { tenantId, requestId, employeeId: input.employeeId, channel: input.channel },
      input.contact,
    );
    try {
      await this.requests.create({
        tenantId,
        requestId,
        employeeId: input.employeeId,
        channel: input.channel,
        requestedByActorId: actor.actorId,
        idempotencyKey,
        ...protectedPayload,
        status: 'pending',
        attempts: 0,
        nextAttemptAt: now,
        lockedAt: null,
        lockedBy: null,
        lastErrorCode: null,
        externalUserId: null,
        platformRequestId: null,
        sensitiveExpiresAt,
        purgeAt: new Date(now.getTime() + RECORD_TTL_MS),
      });
    } catch (error) {
      if (!this.isDuplicateKeyError(error)) throw error;
      const concurrent = await this.requests.findOne(
        { tenantId, channel: input.channel, idempotencyKey },
        {
          requestId: 1,
          employeeId: 1,
          requestedByActorId: 1,
          inputDigest: 1,
          payloadKeyId: 1,
          status: 1,
          sensitiveExpiresAt: 1,
          _id: 0,
        },
      ).lean().exec();
      if (concurrent !== null) return this.replayOrReject(concurrent, actor.actorId, input);
      throw error;
    }
    return Object.freeze({
      requestId,
      status: 'pending',
      sensitiveExpiresAt: sensitiveExpiresAt.toISOString(),
    });
  }

  async getStatus(requestId: string): Promise<ProvisioningResponse & {
    readonly attempts: number;
    readonly lastErrorCode: string | null;
  }> {
    if (!ULID_PATTERN.test(requestId)) {
      throw new BadRequestException({ code: 'ORG_PROVISIONING_REQUEST_ID_INVALID', message: '开户请求标识无效' });
    }
    const tenantId = this.context.getTenantRequired().tenantId;
    const record = await this.requests.findOne(
      { tenantId, requestId },
      { requestId: 1, status: 1, attempts: 1, lastErrorCode: 1, sensitiveExpiresAt: 1, _id: 0 },
    ).lean().exec();
    if (record === null) {
      throw new NotFoundException({ code: 'ORG_PROVISIONING_REQUEST_NOT_FOUND', message: '开户请求不存在' });
    }
    return Object.freeze({
      requestId: record.requestId,
      status: record.status,
      attempts: record.attempts,
      lastErrorCode: record.lastErrorCode,
      sensitiveExpiresAt: record.sensitiveExpiresAt.toISOString(),
    });
  }

  /** 后台按租约顺序处理；数据库租约解决多 Worker 崩溃恢复。 */
  async processBatch(workerId: string, limit = 10): Promise<number> {
    this.assertWorker(workerId, limit);
    await this.expireSensitivePayloads(new Date());
    let succeeded = 0;
    for (let index = 0; index < limit; index += 1) {
      const claim = await this.claimNext(workerId, new Date());
      if (claim === null) break;
      try {
        await this.processOne(claim, workerId);
        succeeded += 1;
      } catch (error) {
        if (error instanceof ProvisioningPostCommitAuditError) throw error;
        await this.markFailure(claim, workerId, error, new Date());
      }
    }
    return succeeded;
  }

  private async replayOrReject(
    existing: Pick<
      OrgEmployeeProvisioningRequest,
      | 'requestId' | 'employeeId' | 'requestedByActorId' | 'inputDigest' | 'payloadKeyId'
      | 'status' | 'sensitiveExpiresAt'
    >,
    actorId: string,
    input: CreateOrgEmployeeProvisioningRequestDto,
  ): Promise<ProvisioningResponse> {
    if (existing.employeeId !== input.employeeId || existing.requestedByActorId !== actorId) {
      throw this.idempotencyConflict();
    }
    const tenantId = this.context.getTenantRequired().tenantId;
    const matches = await this.crypto.matchesDigest(
      { tenantId, employeeId: input.employeeId, channel: input.channel },
      existing.payloadKeyId,
      existing.inputDigest,
      input.contact,
    );
    if (!matches) throw this.idempotencyConflict();
    return Object.freeze({
      requestId: existing.requestId,
      status: existing.status,
      sensitiveExpiresAt: existing.sensitiveExpiresAt.toISOString(),
    });
  }

  private async claimNext(workerId: string, now: Date): Promise<ClaimedProvisioning | null> {
    const staleBefore = new Date(now.getTime() - LOCK_TIMEOUT_MS);
    const record = await this.requests.findOneAndUpdate(
      {
        nextAttemptAt: { $lte: now },
        sensitiveExpiresAt: { $gt: now },
        payloadCiphertext: { $ne: null },
        $or: [
          { status: 'pending' },
          { status: 'processing', lockedAt: { $lt: staleBefore } },
        ],
      },
      { $set: { status: 'processing', lockedAt: now, lockedBy: workerId } },
      { sort: { createdAt: 1 }, returnDocument: 'after', runValidators: true },
    ).lean().exec();
    if (record === null) return null;
    return {
      tenantId: record.tenantId,
      requestId: record.requestId,
      employeeId: record.employeeId,
      channel: record.channel,
      idempotencyKey: record.idempotencyKey,
      payloadKeyId: record.payloadKeyId,
      payloadIv: record.payloadIv,
      payloadCiphertext: record.payloadCiphertext,
      payloadAuthTag: record.payloadAuthTag,
      attempts: record.attempts,
      sensitiveExpiresAt: record.sensitiveExpiresAt,
    };
  }

  private async processOne(claim: ClaimedProvisioning, workerId: string): Promise<void> {
    const employee = await this.employees.findOne(
      { tenantId: claim.tenantId, id: claim.employeeId },
      {
        id: 1,
        employeeNo: 1,
        displayName: 1,
        status: 1,
        departmentIds: 1,
        _id: 0,
      },
    ).lean().exec();
    if (employee === null) {
      throw new OrgPushError('ORG_PROVISIONING_EMPLOYEE_MISSING', 'business', '开户员工不存在');
    }
    if (employee.status !== 'probation' && employee.status !== 'active') {
      throw new OrgPushError('ORG_PROVISIONING_EMPLOYEE_INACTIVE', 'business', '开户员工状态不允许');
    }
    const profile = await this.profiles.resolveEmployeeIdentity(claim.tenantId, claim.employeeId);
    if (profile?.status === 'disabled') {
      throw new OrgPushError('ORG_PROVISIONING_IDENTITY_DISABLED', 'conflict', '开户员工主体已停用');
    }
    const actorId = profile?.actorId ?? employee.id;
    const externalTenantId = await this.credentials.resolveExternalTenantId(
      claim.tenantId,
      claim.channel,
    );
    const alreadyBound = await this.identities.findBoundByEmployee(
      claim.tenantId,
      claim.channel,
      externalTenantId,
      claim.employeeId,
    );
    if (alreadyBound !== null) {
      await this.complete(
        claim,
        workerId,
        actorId,
        employee.departmentIds,
        externalTenantId,
        alreadyBound.externalUserId,
        alreadyBound.unionId,
      );
      return;
    }
    const departmentExternalIds = await this.resolveDepartments(
      claim.tenantId,
      claim.channel,
      employee.departmentIds,
    );
    if (
      claim.payloadIv === null ||
      claim.payloadCiphertext === null ||
      claim.payloadAuthTag === null
    ) throw new OrgPushError('ORG_PROVISIONING_PAYLOAD_MISSING', 'business', '私密开户资料已缺失');
    let contact: OrgProvisioningContact | undefined;
    try {
      contact = await this.crypto.unprotect({
        tenantId: claim.tenantId,
        requestId: claim.requestId,
        employeeId: claim.employeeId,
        channel: claim.channel,
        payloadKeyId: claim.payloadKeyId,
        payloadIv: claim.payloadIv,
        payloadCiphertext: claim.payloadCiphertext,
        payloadAuthTag: claim.payloadAuthTag,
      });
      const result = await this.adapters.get(claim.channel).provisionEmployee({
        tenantId: claim.tenantId,
        employeeId: claim.employeeId,
        externalUserId: this.externalUserId(externalTenantId, claim.employeeId, claim.channel),
        employeeNo: employee.employeeNo,
        displayName: employee.displayName,
        departmentExternalIds,
        idempotencyKey: claim.idempotencyKey,
        contact,
      });
      await this.complete(
        claim,
        workerId,
        actorId,
        employee.departmentIds,
        externalTenantId,
        result.externalUserId,
        result.unionId,
        result.requestId,
      );
    } finally {
      if (contact !== undefined) this.crypto.erase(contact);
    }
  }

  private async complete(
    claim: ClaimedProvisioning,
    workerId: string,
    actorId: string,
    departmentIds: readonly string[],
    externalTenantId: string,
    externalUserId: string,
    unionId: string,
    platformRequestId?: string,
  ): Promise<void> {
    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        await this.profiles.ensureProvisionedEmployee(
          claim.tenantId,
          claim.employeeId,
          actorId,
          departmentIds,
          session,
        );
        await this.identities.bindProvisioned(
          claim.tenantId,
          {
            provider: claim.channel,
            externalTenantId,
            unionId,
            externalUserId,
            actorId,
            employeeId: claim.employeeId,
          },
          session,
        );
        const result = await this.requests.updateOne(
          {
            tenantId: claim.tenantId,
            requestId: claim.requestId,
            status: 'processing',
            lockedBy: workerId,
          },
          {
            $set: {
              status: 'succeeded',
              attempts: Math.min(claim.attempts + 1, ORG_DELIVERY_MAX_ATTEMPTS),
              lockedAt: null,
              lockedBy: null,
              lastErrorCode: null,
              externalUserId,
              platformRequestId: this.safePlatformRequestId(platformRequestId),
              payloadIv: null,
              payloadCiphertext: null,
              payloadAuthTag: null,
            },
          },
          { session, runValidators: true },
        );
        if (result.modifiedCount !== 1) throw new Error('开户请求租约已丢失');
      });
    } finally {
      await session.endSession();
    }
    try {
      await this.audit.recordSystem(claim.tenantId, {
        action: 'integration.org_employee.provision',
        resourceType: 'org_employee_provisioning',
        resourceId: claim.requestId,
        riskLevel: 'R3',
        outcome: 'success',
        traceId: claim.requestId,
        metadata: { channel: claim.channel, attempts: claim.attempts + 1 },
      });
    } catch {
      throw new ProvisioningPostCommitAuditError('开户已提交但审计不可用');
    }
  }

  private async markFailure(
    claim: ClaimedProvisioning,
    workerId: string,
    error: unknown,
    now: Date,
  ): Promise<void> {
    const pushError = error instanceof OrgPushError
      ? error
      : new OrgPushError('ORG_PROVISIONING_INTERNAL', 'retryable', '开户处理暂时失败');
    const attempts = Math.min(claim.attempts + 1, ORG_DELIVERY_MAX_ATTEMPTS);
    const nextAttemptAt = calculateNextAttemptAt(attempts, now);
    const expired = nextAttemptAt >= claim.sensitiveExpiresAt;
    const retry = pushError.category === 'retryable' &&
      attempts < ORG_DELIVERY_MAX_ATTEMPTS && !expired;
    const status: OrgEmployeeProvisioningStatus = retry
      ? 'pending'
      : expired ? 'expired' : 'manual_review';
    const result = await this.requests.updateOne(
      {
        tenantId: claim.tenantId,
        requestId: claim.requestId,
        status: 'processing',
        lockedBy: workerId,
      },
      {
        $set: {
          status,
          attempts,
          nextAttemptAt: retry ? nextAttemptAt : now,
          lockedAt: null,
          lockedBy: null,
          lastErrorCode: this.safeErrorCode(pushError.code),
          ...(retry ? {} : {
            payloadIv: null,
            payloadCiphertext: null,
            payloadAuthTag: null,
          }),
        },
      },
      { runValidators: true },
    );
    if (result.modifiedCount !== 1) throw new Error('开户失败状态租约已丢失');
    await this.audit.recordSystem(claim.tenantId, {
      action: 'integration.org_employee.provision',
      resourceType: 'org_employee_provisioning',
      resourceId: claim.requestId,
      riskLevel: 'R3',
      outcome: 'failure',
      traceId: claim.requestId,
      metadata: { channel: claim.channel, status, errorCode: this.safeErrorCode(pushError.code), attempts },
    });
  }

  private async expireSensitivePayloads(now: Date): Promise<void> {
    await this.requests.updateMany(
      {
        status: { $in: ['pending', 'processing'] },
        sensitiveExpiresAt: { $lte: now },
        payloadCiphertext: { $ne: null },
      },
      {
        $set: {
          status: 'expired',
          nextAttemptAt: now,
          lockedAt: null,
          lockedBy: null,
          lastErrorCode: 'ORG_PROVISIONING_EXPIRED',
          payloadIv: null,
          payloadCiphertext: null,
          payloadAuthTag: null,
        },
      },
      { runValidators: true },
    );
  }

  private async resolveDepartments(
    tenantId: string,
    channel: OrgPushChannel,
    departmentIds: readonly string[],
  ): Promise<readonly string[]> {
    if (
      departmentIds.length < 1 || departmentIds.length > 500 ||
      !departmentIds.every((departmentId) => ID_PATTERN.test(departmentId))
    ) throw new OrgPushError('ORG_PROVISIONING_DEPARTMENTS_INVALID', 'business', '员工部门主数据无效');
    const records = await this.versions.find(
      {
        tenantId,
        channel,
        aggregateType: 'org.department',
        aggregateId: { $in: [...new Set(departmentIds)] },
        appliedVersion: { $gte: 1 },
        externalId: { $ne: null },
      },
      { aggregateId: 1, externalId: 1, _id: 0 },
    ).lean().exec();
    const byId = new Map(records.map((record) => [record.aggregateId, record.externalId]));
    const resolved: string[] = [];
    for (const departmentId of departmentIds) {
      const externalId = byId.get(departmentId);
      if (externalId === undefined || externalId === null) {
        throw new OrgPushError('ORG_PROVISIONING_DEPARTMENT_NOT_READY', 'retryable', '平台部门映射尚未就绪');
      }
      resolved.push(externalId);
    }
    return Object.freeze(resolved);
  }

  private externalUserId(
    externalTenantId: string,
    employeeId: string,
    channel: OrgPushChannel,
  ): string {
    const digest = createHash('sha256')
      .update(JSON.stringify([externalTenantId, employeeId, channel]), 'utf8')
      .digest('base64url')
      .slice(0, 32);
    return `gq_${digest}`;
  }

  private safePlatformRequestId(value: string | undefined): string | null {
    return value !== undefined && ID_PATTERN.test(value) ? value : null;
  }

  private safeErrorCode(value: string): string {
    return /^[A-Z][A-Z0-9_]{1,63}$/.test(value) ? value : 'ORG_PROVISIONING_FAILURE';
  }

  private assertWorker(workerId: string, limit: number): void {
    if (!WORKER_ID_PATTERN.test(workerId) || !Number.isInteger(limit) || limit < 1 || limit > 25) {
      throw new Error('开户 Worker 参数非法');
    }
  }

  private isDuplicateKeyError(error: unknown): boolean {
    return typeof error === 'object' && error !== null &&
      (error as { readonly code?: unknown }).code === DUPLICATE_KEY_CODE;
  }

  private idempotencyConflict(): ConflictException {
    return new ConflictException({
      code: 'ORG_PROVISIONING_IDEMPOTENCY_KEY_REUSED',
      message: '幂等键已被不同开户请求占用',
    });
  }
}
