import { randomUUID } from 'node:crypto';

import { InjectQueue } from '@nestjs/bullmq';
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createEventId, ULID_PATTERN } from '@gaoq/shared-utils';
import type { Queue } from 'bullmq';
import type { ClientSession, Model } from 'mongoose';

import { AuditService } from '../../core/audit/audit.service.js';
import { IdempotencyService } from '../../core/idempotency/idempotency.service.js';
import { TenantContextService } from '../../core/tenant/tenant-context.service.js';
import { RecruitmentOfferService } from '../recruitment/application/recruitment-offer.service.js';
import {
  RecruitmentESignSourceService,
} from '../recruitment/application/recruitment-esign-source.service.js';
import { calculateNextAttemptAt } from './org-delivery.policy.js';
import { ESignAdapter } from './esign.adapter.js';
import { ESignBinding, type ESignBindingDocument } from './esign-binding.schema.js';
import { ESignFlowService } from './esign-flow.service.js';
import {
  ESignIssuanceRequestRecord,
  type ESignIssuanceRequestDocument,
  type ESignIssuanceStatus,
} from './esign-issuance.schema.js';
import { ESignWebhookCryptoService } from './esign-webhook-crypto.service.js';
import {
  ESIGN_ISSUE_FLOW_JOB,
  ESIGN_WEBHOOK_QUEUE,
  createESignIssuanceJobId,
  type ESignQueueJobData,
} from './esign-webhook.queue.js';
import { ESignSecretResolver } from './esign-webhook.service.js';

const MAX_ATTEMPTS = 12;
const LOCK_TIMEOUT_MS = 15 * 60 * 1_000;
const MIN_REQUEST_LIFETIME_MS = 20 * 60 * 1_000;
const MAX_REQUEST_LIFETIME_MS = 90 * 24 * 60 * 60 * 1_000;
const EXTERNAL_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const TENANT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ACTOR_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SECRET_REF_PATTERN = /^GAOQ_ESIGN_APP_[A-Z0-9_]{1,96}$/;
const APP_ID_PATTERN = /^[A-Za-z0-9_-]{4,128}$/;
const RESOLUTION_REASONS = new Set<ESignIssuanceResolutionReason>([
  'credentials_fixed',
  'offer_state_fixed',
  'provider_recovered',
  'approved_exception',
]);

class ESignIssuanceOutcomeUnknownError extends Error {}

export type ESignIssuanceResolutionReason =
  | 'credentials_fixed'
  | 'offer_state_fixed'
  | 'provider_recovered'
  | 'approved_exception';

export interface ESignIssuanceSummary extends Record<string, unknown> {
  readonly id: string;
  readonly offerId: string;
  readonly offerVersion: number;
  readonly status: ESignIssuanceStatus;
  readonly attempts: number;
  readonly failureCode: string | null;
  readonly flowId: string | null;
  readonly operatorResolutionCount: number;
  readonly updatedAt: string;
}

/** eSign 发起状态机；外部创建结果未知时永久禁止自动重放。 */
@Injectable()
export class ESignIssuanceService {
  private readonly workerId = `esign-issuance-${randomUUID()}`;
  private readonly logger = new Logger(ESignIssuanceService.name);

  constructor(
    @InjectModel(ESignIssuanceRequestRecord.name)
    private readonly requests: Model<ESignIssuanceRequestDocument>,
    @InjectModel(ESignBinding.name)
    private readonly bindings: Model<ESignBindingDocument>,
    private readonly context: TenantContextService,
    private readonly idempotency: IdempotencyService,
    private readonly offers: RecruitmentOfferService,
    private readonly source: RecruitmentESignSourceService,
    private readonly adapter: ESignAdapter,
    private readonly secrets: ESignSecretResolver,
    private readonly crypto: ESignWebhookCryptoService,
    private readonly flows: ESignFlowService,
    private readonly audit: AuditService,
    @InjectQueue(ESIGN_WEBHOOK_QUEUE)
    private readonly queue: Queue<ESignQueueJobData>,
  ) {}

  async request(input: {
    readonly offerId: string;
    readonly providerFileId: string;
    readonly expiresAt: string;
    readonly signaturePosition: {
      readonly page: number;
      readonly x: number;
      readonly y: number;
    };
    readonly idempotencyKey: string;
  }): Promise<{ readonly request: ESignIssuanceSummary }> {
    this.requireScope('erp:integration:esign:initiate');
    this.assertRequestInput(input);
    const offer = await this.offers.get(input.offerId);
    if (offer.status !== 'accepted' || offer.esignFlowId !== null) {
      throw new ConflictException({
        code: 'ESIGN_ISSUANCE_OFFER_STATE_INVALID',
        message: '只有未绑定签署流程的已接受 Offer 可发起签署',
      });
    }
    const tenantId = this.context.getTenantRequired().tenantId;
    const actorId = this.context.getActorRequired().actorId;
    if (!ACTOR_ID_PATTERN.test(actorId)) throw new ForbiddenException({
      code: 'ESIGN_ISSUANCE_ACTOR_INVALID',
      message: '发起主体标识无效',
    });
    const result = await this.idempotency.execute(
      'integration.esign.issuance.request',
      input.idempotencyKey,
      {
        offerId: input.offerId,
        providerFileId: input.providerFileId,
        expiresAt: input.expiresAt,
        signaturePosition: input.signaturePosition,
      },
      async (session) => this.createRequest(
        tenantId,
        actorId,
        offer.version,
        input,
        session,
      ),
    );
    await this.enqueue(result.request.id, tenantId);
    return result;
  }

  async listTerminal(input: {
    readonly status: 'manual_review' | 'dead';
    readonly beforeId?: string;
    readonly limit: number;
  }): Promise<{
    readonly items: readonly ESignIssuanceSummary[];
    readonly nextCursor: string | null;
  }> {
    this.requireScope('erp:integration:esign:operate');
    if (
      !['manual_review', 'dead'].includes(input.status) ||
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100 ||
      (input.beforeId !== undefined && !ULID_PATTERN.test(input.beforeId))
    ) throw new ConflictException({
      code: 'ESIGN_ISSUANCE_LIST_QUERY_INVALID',
      message: 'eSign 终态查询参数无效',
    });
    const tenantId = this.context.getTenantRequired().tenantId;
    const records = await this.requests.find(
      {
        tenantId,
        status: input.status,
        ...(input.beforeId === undefined ? {} : { id: { $lt: input.beforeId } }),
      },
      {
        id: 1, offerId: 1, offerVersion: 1, status: 1, attempts: 1,
        failureCode: 1, flowId: 1, operatorResolutionCount: 1, updatedAt: 1, _id: 0,
      },
    ).sort({ id: -1 }).limit(input.limit + 1).lean().exec();
    const hasMore = records.length > input.limit;
    const page = records.slice(0, input.limit);
    return {
      items: Object.freeze(page.map((record) => summary(record))),
      nextCursor: hasMore ? page.at(-1)?.id ?? null : null,
    };
  }

  async resolve(input: {
    readonly requestId: string;
    readonly decision: 'retry' | 'attach_external_flow';
    readonly reason: ESignIssuanceResolutionReason;
    readonly providerConfirmedNotCommitted: boolean;
    readonly providerConfirmedMatchesRequest: boolean;
    readonly externalFlowId?: string;
    readonly idempotencyKey: string;
  }): Promise<{ readonly request: ESignIssuanceSummary }> {
    this.requireScope('erp:integration:esign:operate');
    this.assertResolutionInput(input);
    const tenantId = this.context.getTenantRequired().tenantId;
    const result = await this.idempotency.execute(
      'integration.esign.issuance.resolve',
      input.idempotencyKey,
      input,
      async (session) => {
        const update = input.decision === 'retry'
          ? {
              $set: {
                status: 'pending',
                attempts: 0,
                nextAttemptAt: new Date(),
                lockedAt: null,
                lockedBy: null,
                failureCode: null,
                operatorResolvedAt: new Date(),
              },
              $inc: { operatorResolutionCount: 1 },
            }
          : this.attachExternalUpdate(
              tenantId,
              input.requestId,
              input.externalFlowId ?? '',
            );
        const updated = input.decision === 'retry'
          ? await this.requests.findOneAndUpdate(
              {
                tenantId,
                id: input.requestId,
                status: { $in: ['manual_review', 'dead'] },
                externalFlowKeyId: null,
              },
              update,
              { session, returnDocument: 'after', runValidators: true },
            ).lean().exec()
          : await this.requests.findOneAndUpdate(
              {
                tenantId,
                id: input.requestId,
                status: { $in: ['manual_review', 'dead'] },
              },
              update,
              { session, returnDocument: 'after', runValidators: true },
            ).lean().exec();
        if (updated === null) throw new NotFoundException({
          code: 'ESIGN_ISSUANCE_NOT_RESOLVABLE',
          message: '发起请求不存在、状态不可处置或外部结果已绑定',
        });
        return { request: summary(updated) };
      },
    );
    await this.enqueue(result.request.id, tenantId);
    return result;
  }

  async process(requestId: string): Promise<number> {
    if (!ULID_PATTERN.test(requestId)) {
      throw new Error('ESIGN_ISSUANCE_REQUEST_ID_INVALID');
    }
    const tenantId = this.context.getTenantRequired().tenantId;
    const now = new Date();
    const request = await this.requests.findOneAndUpdate(
      {
        tenantId,
        id: requestId,
        status: { $in: ['pending', 'local_finalize'] },
        nextAttemptAt: { $lte: now },
        attempts: { $lt: MAX_ATTEMPTS },
      },
      {
        $set: {
          status: 'processing',
          lockedAt: now,
          lockedBy: this.workerId,
          failureCode: null,
        },
        $inc: { attempts: 1 },
      },
      { returnDocument: 'after', runValidators: true },
    ).lean().exec();
    if (request === null) return 0;
    this.assertClaim(request);
    let externalResultStored = hasExternalResult(request);
    try {
      let externalFlowId: string;
      if (externalResultStored) {
        externalFlowId = this.decryptExternalFlow(request);
      } else {
        const [binding, subject] = await Promise.all([
          this.loadBinding(request),
          this.source.getAcceptedOfferSubject(request.offerId),
        ]);
        if (
          subject.offerId !== request.offerId ||
          subject.offerVersion !== request.offerVersion
        ) throw new Error('ESIGN_ISSUANCE_OFFER_VERSION_MISMATCH');
        const providerFileId = this.decryptProviderFile(request);
        this.assertExecutionInput(request, providerFileId, subject);
        try {
          externalFlowId = await this.adapter.createFlow(
            {
              appId: binding.appId,
              appSecret: this.secrets.resolve(binding.credentialSecretRef),
            },
            {
              providerFileId,
              signerAccount: subject.signerAccount,
              signerName: subject.signerName,
              expiresAtEpochMs: request.expiresAt.getTime(),
              signaturePosition: {
                page: request.signaturePage,
                x: request.signatureX,
                y: request.signatureY,
              },
            },
          );
        } catch (error) {
          throw new ESignIssuanceOutcomeUnknownError(
            'ESIGN_ISSUANCE_OUTCOME_UNKNOWN',
            { cause: error },
          );
        }
        if (
          !EXTERNAL_ID_PATTERN.test(externalFlowId) ||
          externalFlowId.normalize('NFKC') !== externalFlowId
        ) throw new ESignIssuanceOutcomeUnknownError(
          'ESIGN_ISSUANCE_RESPONSE_INVALID',
        );
        await this.storeExternalResult(request, externalFlowId);
        externalResultStored = true;
      }
      const flow = await this.flows.registerForOffer(request.offerId, externalFlowId);
      await this.finish(request, flow.id);
      await this.auditAfterState(request, 'success', null);
      return 1;
    } catch (error) {
      const code = failureCode(error);
      if (error instanceof ESignIssuanceOutcomeUnknownError) {
        await this.markManualReview(request, code);
      } else if (externalResultStored) {
        await this.releaseLocalFinalize(request, code);
      } else {
        await this.failBeforeExternal(request, code);
      }
      await this.auditAfterState(request, 'failure', code);
      if (error instanceof ESignIssuanceOutcomeUnknownError) return 0;
      throw error;
    }
  }

  /** 十五分钟调度恢复：有外部回执只补本地终态，无回执的过期租约转人工核验。 */
  async recoverAndEnqueue(now = new Date(), limit = 100): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new Error('ESIGN_ISSUANCE_RECOVERY_LIMIT_INVALID');
    }
    const staleAt = new Date(now.getTime() - LOCK_TIMEOUT_MS);
    await this.requests.updateMany(
      {
        status: 'processing',
        lockedAt: { $lte: staleAt },
        externalFlowKeyId: null,
      },
      {
        $set: {
          status: 'manual_review',
          lockedAt: null,
          lockedBy: null,
          nextAttemptAt: now,
          failureCode: 'ESIGN_ISSUANCE_OUTCOME_UNKNOWN',
        },
      },
      { runValidators: true },
    );
    await this.requests.updateMany(
      {
        status: 'processing',
        lockedAt: { $lte: staleAt },
        externalFlowKeyId: { $ne: null },
      },
      {
        $set: {
          status: 'local_finalize',
          lockedAt: null,
          lockedBy: null,
          nextAttemptAt: now,
          failureCode: 'ESIGN_ISSUANCE_LOCAL_FINALIZE_INTERRUPTED',
        },
      },
      { runValidators: true },
    );
    const records = await this.requests.find(
      {
        status: { $in: ['pending', 'local_finalize'] },
        nextAttemptAt: { $lte: now },
        attempts: { $lt: MAX_ATTEMPTS },
      },
      { id: 1, tenantId: 1, _id: 0 },
    ).sort({ createdAt: 1 }).limit(limit).lean().exec();
    let enqueued = 0;
    for (const record of records) {
      if (
        !ULID_PATTERN.test(record.id) ||
        !TENANT_ID_PATTERN.test(record.tenantId)
      ) {
        this.logger.error({ code: 'ESIGN_ISSUANCE_RECOVERY_RECORD_INVALID' });
        continue;
      }
      await this.enqueue(record.id, record.tenantId);
      enqueued += 1;
    }
    return enqueued;
  }

  private async createRequest(
    tenantId: string,
    actorId: string,
    offerVersion: number,
    input: {
      readonly offerId: string;
      readonly providerFileId: string;
      readonly expiresAt: string;
      readonly signaturePosition: {
        readonly page: number;
        readonly x: number;
        readonly y: number;
      };
    },
    session: ClientSession,
  ): Promise<{ readonly request: ESignIssuanceSummary }> {
    const now = new Date();
    const id = createEventId(now);
    const protectedFile = this.crypto.protectExternalId(
      tenantId,
      id,
      input.providerFileId,
    );
    try {
      const [created] = await this.requests.create([{
        id,
        tenantId,
        offerId: input.offerId,
        offerVersion,
        providerFileKeyId: protectedFile.externalIdKeyId,
        providerFileIv: protectedFile.externalIdIv,
        providerFileCiphertext: protectedFile.externalIdCiphertext,
        providerFileAuthTag: protectedFile.externalIdAuthTag,
        expiresAt: new Date(input.expiresAt),
        signaturePage: input.signaturePosition.page,
        signatureX: input.signaturePosition.x,
        signatureY: input.signaturePosition.y,
        status: 'pending',
        attempts: 0,
        nextAttemptAt: now,
        lockedAt: null,
        lockedBy: null,
        failureCode: null,
        externalFlowKeyId: null,
        externalFlowIv: null,
        externalFlowCiphertext: null,
        externalFlowAuthTag: null,
        flowId: null,
        createdByActorId: actorId,
        operatorResolutionCount: 0,
        operatorResolvedAt: null,
        succeededAt: null,
      }], { session });
      if (created === undefined) throw new Error('ESIGN_ISSUANCE_CREATE_EMPTY');
      return { request: summary(created.toObject()) };
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      throw new ConflictException({
        code: 'ESIGN_ISSUANCE_OFFER_ALREADY_REQUESTED',
        message: '该 Offer 已存在 eSign 发起请求',
      });
    }
  }

  private async loadBinding(
    request: ESignIssuanceRequestRecord,
  ): Promise<ESignBinding> {
    const binding = await this.bindings.findOne({
      tenantId: request.tenantId,
      provider: 'esign_cn',
      status: 'active',
    }).lean().exec();
    if (
      binding === null ||
      binding.tenantId !== request.tenantId ||
      binding.provider !== 'esign_cn' ||
      binding.status !== 'active' ||
      !APP_ID_PATTERN.test(binding.appId) ||
      !SECRET_REF_PATTERN.test(binding.credentialSecretRef)
    ) throw new Error('ESIGN_ISSUANCE_BINDING_INVALID');
    return binding;
  }

  private decryptProviderFile(request: ESignIssuanceRequestRecord): string {
    const value = this.crypto.unprotectExternalId(
      request.tenantId,
      request.id,
      {
        externalIdKeyId: request.providerFileKeyId,
        externalIdIv: request.providerFileIv,
        externalIdCiphertext: request.providerFileCiphertext,
        externalIdAuthTag: request.providerFileAuthTag,
      },
    );
    if (
      !EXTERNAL_ID_PATTERN.test(value) ||
      value.normalize('NFKC') !== value
    ) throw new Error('ESIGN_ISSUANCE_PROVIDER_FILE_INVALID');
    return value;
  }

  private decryptExternalFlow(request: ESignIssuanceRequestRecord): string {
    if (!hasExternalResult(request)) throw new Error('ESIGN_ISSUANCE_EXTERNAL_RESULT_MISSING');
    const value = this.crypto.unprotectExternalId(
      request.tenantId,
      request.id,
      {
        externalIdKeyId: request.externalFlowKeyId,
        externalIdIv: request.externalFlowIv,
        externalIdCiphertext: request.externalFlowCiphertext,
        externalIdAuthTag: request.externalFlowAuthTag,
      },
    );
    if (
      !EXTERNAL_ID_PATTERN.test(value) ||
      value.normalize('NFKC') !== value
    ) throw new Error('ESIGN_ISSUANCE_EXTERNAL_RESULT_INVALID');
    return value;
  }

  private async storeExternalResult(
    request: ESignIssuanceRequestRecord,
    externalFlowId: string,
  ): Promise<void> {
    const protectedFlow = this.crypto.protectExternalId(
      request.tenantId,
      request.id,
      externalFlowId,
    );
    const updated = await this.requests.updateOne(
      this.leaseFilter(request),
      {
        $set: {
          externalFlowKeyId: protectedFlow.externalIdKeyId,
          externalFlowIv: protectedFlow.externalIdIv,
          externalFlowCiphertext: protectedFlow.externalIdCiphertext,
          externalFlowAuthTag: protectedFlow.externalIdAuthTag,
        },
      },
      { runValidators: true },
    );
    if (updated.modifiedCount !== 1) throw new ESignIssuanceOutcomeUnknownError(
      'ESIGN_ISSUANCE_RESULT_PERSIST_FAILED',
    );
  }

  private async finish(
    request: ESignIssuanceRequestRecord,
    flowId: string,
  ): Promise<void> {
    const now = new Date();
    const updated = await this.requests.updateOne(
      this.leaseFilter(request),
      {
        $set: {
          status: 'succeeded',
          flowId,
          failureCode: null,
          lockedAt: null,
          lockedBy: null,
          succeededAt: now,
        },
      },
      { runValidators: true },
    );
    if (updated.modifiedCount !== 1) {
      throw new Error('ESIGN_ISSUANCE_FINALIZE_LEASE_LOST');
    }
  }

  private async markManualReview(
    request: ESignIssuanceRequestRecord,
    code: string,
  ): Promise<void> {
    const updated = await this.requests.updateOne(
      this.leaseFilter(request),
      {
        $set: {
          status: 'manual_review',
          failureCode: safeFailureCode(code, 'ESIGN_ISSUANCE_OUTCOME_UNKNOWN'),
          nextAttemptAt: new Date(),
          lockedAt: null,
          lockedBy: null,
        },
      },
      { runValidators: true },
    );
    if (updated.modifiedCount !== 1) {
      throw new Error('ESIGN_ISSUANCE_MANUAL_REVIEW_LEASE_LOST');
    }
  }

  private async releaseLocalFinalize(
    request: ESignIssuanceRequestRecord,
    code: string,
  ): Promise<void> {
    const now = new Date();
    const updated = await this.requests.updateOne(
      this.leaseFilter(request),
      {
        $set: {
          status: request.attempts >= MAX_ATTEMPTS ? 'dead' : 'local_finalize',
          failureCode: safeFailureCode(code, 'ESIGN_ISSUANCE_LOCAL_FINALIZE_FAILED'),
          nextAttemptAt: request.attempts >= MAX_ATTEMPTS
            ? now
            : calculateNextAttemptAt(request.attempts, now),
          lockedAt: null,
          lockedBy: null,
        },
      },
      { runValidators: true },
    );
    if (updated.modifiedCount !== 1) {
      throw new Error('ESIGN_ISSUANCE_LOCAL_FINALIZE_LEASE_LOST');
    }
  }

  private async failBeforeExternal(
    request: ESignIssuanceRequestRecord,
    code: string,
  ): Promise<void> {
    const now = new Date();
    const exhausted = request.attempts >= MAX_ATTEMPTS;
    const updated = await this.requests.updateOne(
      this.leaseFilter(request),
      {
        $set: {
          status: exhausted ? 'dead' : 'pending',
          failureCode: safeFailureCode(code, 'ESIGN_ISSUANCE_PREFLIGHT_FAILED'),
          nextAttemptAt: exhausted
            ? now
            : calculateNextAttemptAt(request.attempts, now),
          lockedAt: null,
          lockedBy: null,
        },
      },
      { runValidators: true },
    );
    if (updated.modifiedCount !== 1) {
      throw new Error('ESIGN_ISSUANCE_FAILURE_LEASE_LOST');
    }
  }

  private attachExternalUpdate(
    tenantId: string,
    requestId: string,
    externalFlowId: string,
  ) {
    const protectedFlow = this.crypto.protectExternalId(
      tenantId,
      requestId,
      externalFlowId,
    );
    return {
      $set: {
        status: 'local_finalize',
        attempts: 0,
        nextAttemptAt: new Date(),
        lockedAt: null,
        lockedBy: null,
        failureCode: null,
        externalFlowKeyId: protectedFlow.externalIdKeyId,
        externalFlowIv: protectedFlow.externalIdIv,
        externalFlowCiphertext: protectedFlow.externalIdCiphertext,
        externalFlowAuthTag: protectedFlow.externalIdAuthTag,
        operatorResolvedAt: new Date(),
      },
      $inc: { operatorResolutionCount: 1 },
    };
  }

  private async enqueue(requestId: string, tenantId: string): Promise<void> {
    try {
      await this.queue.add(
        ESIGN_ISSUE_FLOW_JOB,
        { requestId, tenantId },
        {
          jobId: createESignIssuanceJobId(tenantId, requestId),
          attempts: MAX_ATTEMPTS,
          backoff: { type: 'exponential', delay: 10_000 },
          // 状态机记录是事实源；完成 Job 必须立即删除，人工处置后才能复用确定性 JobId。
          removeOnComplete: true,
          removeOnFail: true,
        },
      );
    } catch (error) {
      throw new ServiceUnavailableException({
        code: 'ESIGN_ISSUANCE_QUEUE_UNAVAILABLE',
        message: 'eSign 发起请求已保存，但任务队列暂不可用，请使用相同幂等键重试',
      }, { cause: error });
    }
  }

  private async auditAfterState(
    request: ESignIssuanceRequestRecord,
    outcome: 'success' | 'failure',
    code: string | null,
  ): Promise<void> {
    try {
      await this.audit.recordSystem(request.tenantId, {
        action: 'integration.esign.issuance.process',
        resourceType: 'esign_issuance_request',
        resourceId: request.id,
        riskLevel: 'R2',
        outcome,
        traceId: request.id,
        metadata: {
          offerId: request.offerId,
          offerVersion: request.offerVersion,
          ...(code === null ? {} : { failureCode: code }),
        },
      });
    } catch {
      this.logger.error({
        code: 'ESIGN_ISSUANCE_AUDIT_AFTER_STATE_FAILED',
        tenantId: request.tenantId,
        requestId: request.id,
        outcome,
      });
    }
  }

  private assertClaim(request: ESignIssuanceRequestRecord): void {
    if (
      !isPlainRecord(request) ||
      !ULID_PATTERN.test(request.id) ||
      !TENANT_ID_PATTERN.test(request.tenantId) ||
      !ULID_PATTERN.test(request.offerId) ||
      !Number.isSafeInteger(request.offerVersion) ||
      request.offerVersion < 1 ||
      request.status !== 'processing' ||
      !Number.isInteger(request.attempts) ||
      request.attempts < 1 ||
      request.attempts > MAX_ATTEMPTS ||
      !(request.lockedAt instanceof Date) ||
      request.lockedBy !== this.workerId
    ) throw new Error('ESIGN_ISSUANCE_CLAIM_INVALID');
  }

  private assertExecutionInput(
    request: ESignIssuanceRequestRecord,
    providerFileId: string,
    subject: {
      readonly signerName: string;
      readonly signerAccount: string;
    },
  ): void {
    if (
      !EXTERNAL_ID_PATTERN.test(providerFileId) ||
      request.expiresAt.getTime() < Date.now() + 5 * 60 * 1_000 ||
      request.expiresAt.getTime() > Date.now() + MAX_REQUEST_LIFETIME_MS ||
      !Number.isInteger(request.signaturePage) ||
      request.signaturePage < 1 ||
      request.signaturePage > 10_000 ||
      !Number.isFinite(request.signatureX) ||
      request.signatureX < 0 ||
      request.signatureX > 100_000 ||
      !Number.isFinite(request.signatureY) ||
      request.signatureY < 0 ||
      request.signatureY > 100_000 ||
      !safeText(subject.signerName, 128) ||
      !safeText(subject.signerAccount, 256)
    ) throw new Error('ESIGN_ISSUANCE_EXECUTION_INPUT_INVALID');
  }

  private assertRequestInput(input: {
    readonly offerId: string;
    readonly providerFileId: string;
    readonly expiresAt: string;
    readonly signaturePosition: {
      readonly page: number;
      readonly x: number;
      readonly y: number;
    };
  }): void {
    const expiresAt = Date.parse(input.expiresAt);
    const now = Date.now();
    if (
      !ULID_PATTERN.test(input.offerId) ||
      !EXTERNAL_ID_PATTERN.test(input.providerFileId) ||
      input.providerFileId.normalize('NFKC') !== input.providerFileId ||
      !Number.isFinite(expiresAt) ||
      new Date(expiresAt).toISOString() !== input.expiresAt ||
      expiresAt < now + MIN_REQUEST_LIFETIME_MS ||
      expiresAt > now + MAX_REQUEST_LIFETIME_MS ||
      !Number.isInteger(input.signaturePosition.page) ||
      input.signaturePosition.page < 1 ||
      input.signaturePosition.page > 10_000 ||
      !Number.isFinite(input.signaturePosition.x) ||
      input.signaturePosition.x < 0 ||
      input.signaturePosition.x > 100_000 ||
      !Number.isFinite(input.signaturePosition.y) ||
      input.signaturePosition.y < 0 ||
      input.signaturePosition.y > 100_000
    ) throw new ConflictException({
      code: 'ESIGN_ISSUANCE_REQUEST_INVALID',
      message: 'eSign 发起参数无效',
    });
  }

  private assertResolutionInput(input: {
    readonly requestId: string;
    readonly decision: 'retry' | 'attach_external_flow';
    readonly reason: ESignIssuanceResolutionReason;
    readonly providerConfirmedNotCommitted: boolean;
    readonly providerConfirmedMatchesRequest: boolean;
    readonly externalFlowId?: string;
  }): void {
    if (!ULID_PATTERN.test(input.requestId)) throw new ConflictException({
      code: 'ESIGN_ISSUANCE_REQUEST_ID_INVALID',
      message: 'eSign 发起请求标识无效',
    });
    if (
      !['retry', 'attach_external_flow'].includes(input.decision) ||
      !RESOLUTION_REASONS.has(input.reason) ||
      typeof input.providerConfirmedNotCommitted !== 'boolean' ||
      typeof input.providerConfirmedMatchesRequest !== 'boolean'
    ) throw new ConflictException({
      code: 'ESIGN_ISSUANCE_RESOLUTION_INVALID',
      message: 'eSign 人工处置参数无效',
    });
    if (
      input.decision === 'retry' &&
      (
        input.reason !== 'approved_exception' ||
        !input.providerConfirmedNotCommitted ||
        input.providerConfirmedMatchesRequest ||
        input.externalFlowId !== undefined
      )
    ) throw new ConflictException({
      code: 'ESIGN_ISSUANCE_RETRY_CONFIRMATION_REQUIRED',
      message: '重新外呼必须经批准例外并确认供应商未创建流程',
    });
    if (
      input.decision === 'attach_external_flow' &&
      (
        !input.providerConfirmedMatchesRequest ||
        input.providerConfirmedNotCommitted ||
        input.externalFlowId === undefined ||
        !EXTERNAL_ID_PATTERN.test(input.externalFlowId) ||
        input.externalFlowId.normalize('NFKC') !== input.externalFlowId
      )
    ) throw new ConflictException({
      code: 'ESIGN_ISSUANCE_EXTERNAL_FLOW_CONFIRMATION_REQUIRED',
      message: '绑定外部流程必须确认其与本次发起请求一致',
    });
  }

  private leaseFilter(
    request: ESignIssuanceRequestRecord,
  ): {
    readonly tenantId: string;
    readonly id: string;
    readonly status: 'processing';
    readonly lockedBy: string;
    readonly attempts: number;
  } {
    return {
      tenantId: request.tenantId,
      id: request.id,
      status: 'processing' as const,
      lockedBy: this.workerId,
      attempts: request.attempts,
    };
  }

  private requireScope(scope: string): void {
    if (!this.context.getActorRequired().scopes.includes(scope)) {
      throw new ForbiddenException({
        code: 'ESIGN_ISSUANCE_SCOPE_DENIED',
        message: '缺少 eSign 发起处置权限',
      });
    }
  }
}

function summary(record: ESignIssuanceRequestRecord): ESignIssuanceSummary {
  return Object.freeze({
    id: record.id,
    offerId: record.offerId,
    offerVersion: record.offerVersion,
    status: record.status,
    attempts: record.attempts,
    failureCode: record.failureCode,
    flowId: record.flowId,
    operatorResolutionCount: record.operatorResolutionCount ?? 0,
    updatedAt: record.updatedAt.toISOString(),
  });
}

function hasExternalResult(
  request: ESignIssuanceRequestRecord,
): request is ESignIssuanceRequestRecord & {
  readonly externalFlowKeyId: string;
  readonly externalFlowIv: string;
  readonly externalFlowCiphertext: string;
  readonly externalFlowAuthTag: string;
} {
  return [
    request.externalFlowKeyId,
    request.externalFlowIv,
    request.externalFlowCiphertext,
    request.externalFlowAuthTag,
  ].every((value) => typeof value === 'string');
}

function safeText(value: unknown, maxLength: number): value is string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > maxLength ||
    value.normalize('NFKC') !== value ||
    value.trim() !== value
  ) return false;
  return ![...value].some((character) => {
    const point = character.codePointAt(0) ?? 0;
    return point <= 31 || point === 127;
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function failureCode(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const response = (error as { response?: unknown }).response;
    if (typeof response === 'object' && response !== null) {
      const code = (response as { code?: unknown }).code;
      if (typeof code === 'string' && /^[A-Z0-9_]{3,128}$/.test(code)) {
        return code;
      }
    }
  }
  if (error instanceof Error && /^[A-Z0-9_]{3,128}$/.test(error.message)) {
    return error.message;
  }
  return 'ESIGN_ISSUANCE_FAILED';
}

function safeFailureCode(code: string, fallback: string): string {
  return /^[A-Z0-9_]{3,128}$/.test(code) ? code : fallback;
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null &&
    (error as { code?: unknown }).code === 11_000;
}
