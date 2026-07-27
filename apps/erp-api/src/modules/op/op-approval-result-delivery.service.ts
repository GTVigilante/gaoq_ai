import { createHash, createHmac, randomBytes } from 'node:crypto';

import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { z } from 'zod';

import {
  AuditService,
  type SystemAuditRecordInput,
} from '../../core/audit/audit.service.js';
import {
  calculateOpApprovalNextAttemptAt,
  OP_APPROVAL_MAX_ATTEMPTS,
} from './op-approval.policy.js';
import { OpApprovalDeliveryError, OpApprovalHttpClient } from './op-approval-http.client.js';
import {
  OpApprovalResultDeliveryRecord,
  type OpApprovalResultDeliveryDocument,
  OpApprovalRouteRecord,
  type OpApprovalRouteDocument,
} from './persistence/op.schemas.js';

const LOCK_TIMEOUT_MS = 5 * 60 * 1_000;
const WORKER_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const SECRET_REF = /^GAOQ_OP_APPROVAL_OUTBOUND_[A-Z0-9_]{1,96}$/;
const responseSchema = z.object({
  code: z.literal('OK'),
  data: z.object({
    externalEventId: z.string().min(8).max(128),
    approvalInstanceId: z.string().min(26).max(26),
    approvalVersion: z.number().int().positive(),
  }).strict(),
}).strict();

/** OP 审批结果专用 Secret 解析器；禁止复用入站与组织下发凭据前缀。 */
@Injectable()
export class OpApprovalOutboundSecretResolver {
  resolve(reference: string): string {
    if (!SECRET_REF.test(reference)) throw new Error('OP_APPROVAL_SECRET_REF_INVALID');
    const secret = process.env[reference];
    if (secret === undefined || secret.length < 32 || secret.length > 2_048) {
      throw new ServiceUnavailableException({
        code: 'OP_APPROVAL_OUTBOUND_SECRET_UNAVAILABLE', message: 'OP 审批结果凭据暂不可用',
      });
    }
    return secret;
  }
}

/** 按持久化租约向 OP 可靠回推审批终态；仅发送状态与控制标识。 */
@Injectable()
export class OpApprovalResultDeliveryService {
  private readonly logger = new Logger(OpApprovalResultDeliveryService.name);

  constructor(
    @InjectModel(OpApprovalResultDeliveryRecord.name)
    private readonly deliveries: Model<OpApprovalResultDeliveryDocument>,
    @InjectModel(OpApprovalRouteRecord.name)
    private readonly routes: Model<OpApprovalRouteDocument>,
    private readonly secrets: OpApprovalOutboundSecretResolver,
    private readonly http: OpApprovalHttpClient,
    private readonly audit: AuditService,
  ) {}

  async processBatch(workerId: string, limit = 25): Promise<number> {
    this.assertInput(workerId, limit);
    let succeeded = 0;
    for (let index = 0; index < limit; index += 1) {
      const delivery = await this.claim(workerId, new Date());
      if (delivery === null) break;
      try {
        await this.deliver(delivery);
        await this.markSucceeded(delivery, workerId, new Date());
        succeeded += 1;
        await this.auditAfterCommit(delivery.tenantId, {
          action: 'op.approval.result.deliver', resourceType: 'op_approval_result',
          resourceId: delivery.approvalInstanceId, riskLevel: 'R2', outcome: 'success',
          traceId: delivery.eventId,
          metadata: {
            result: delivery.result, approvalVersion: delivery.approvalVersion,
            sourceDocumentType: delivery.sourceDocumentType,
          },
        });
      } catch (error) {
        await this.markFailed(delivery, workerId, error, new Date());
        await this.auditAfterCommit(delivery.tenantId, {
          action: 'op.approval.result.deliver', resourceType: 'op_approval_result',
          resourceId: delivery.approvalInstanceId, riskLevel: 'R2', outcome: 'failure',
          traceId: delivery.eventId, metadata: { failureCode: failureCode(error) },
        });
      }
    }
    return succeeded;
  }

  private async claim(
    workerId: string,
    now: Date,
  ): Promise<OpApprovalResultDeliveryRecord | null> {
    return this.deliveries.findOneAndUpdate({
      nextAttemptAt: { $lte: now },
      $or: [
        { status: 'pending' },
        { status: 'processing', lockedAt: { $lt: new Date(now.getTime() - LOCK_TIMEOUT_MS) } },
      ],
    }, {
      $set: { status: 'processing', lockedAt: now, lockedBy: workerId },
    }, { sort: { createdAt: 1 }, returnDocument: 'after' }).lean().exec();
  }

  private async deliver(delivery: OpApprovalResultDeliveryRecord): Promise<void> {
    const route = await this.routes.findOne({
      tenantId: delivery.tenantId, inboundClientId: delivery.clientId,
      sourceDocumentType: delivery.sourceDocumentType, status: 'active',
    }).lean().exec();
    if (route === null) throw new OpApprovalDeliveryError(
      'OP_APPROVAL_ROUTE_DISABLED', 'business', 'OP 审批结果路由已停用',
    );
    const body = JSON.stringify({
      schemaVersion: '1.0', externalEventId: delivery.externalEventId,
      sourceDocumentType: delivery.sourceDocumentType,
      sourceDocumentId: delivery.sourceDocumentId,
      approvalInstanceId: delivery.approvalInstanceId,
      approvalVersion: delivery.approvalVersion,
      result: delivery.result,
      occurredAt: delivery.occurredAt.toISOString(),
    });
    const path = `/erp/v1/approval-results/${delivery.externalEventId}`;
    const timestamp = String(Date.now());
    const nonce = randomBytes(16).toString('base64url');
    const idempotencyKey = delivery.eventId;
    const bodyHash = createHash('sha256').update(body, 'utf8').digest('base64url');
    const canonical = [
      timestamp, nonce, 'PUT', path, route.externalTenantId, idempotencyKey, bodyHash,
    ].join('\n');
    const signature = createHmac(
      'sha256', this.secrets.resolve(route.outboundCredentialSecretRef),
    ).update(canonical, 'utf8').digest('hex');
    const response = await this.http.put({
      path, body,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'x-gaoq-erp-client-id': route.outboundClientId,
        'x-gaoq-erp-external-tenant-id': route.externalTenantId,
        'x-gaoq-erp-timestamp': timestamp,
        'x-gaoq-erp-nonce': nonce,
        'x-gaoq-erp-idempotency-key': idempotencyKey,
        'x-gaoq-erp-signature-algorithm': 'hmac-sha256',
        'x-gaoq-erp-signature': signature,
      },
    });
    const parsed = responseSchema.safeParse(response.body);
    if (!parsed.success || parsed.data.data.externalEventId !== delivery.externalEventId ||
      parsed.data.data.approvalInstanceId !== delivery.approvalInstanceId ||
      parsed.data.data.approvalVersion !== delivery.approvalVersion) {
      throw new OpApprovalDeliveryError(
        'OP_APPROVAL_RESPONSE_INVALID', 'retryable', 'OP 审批结果响应与请求不一致',
      );
    }
  }

  private async markSucceeded(
    delivery: OpApprovalResultDeliveryRecord,
    workerId: string,
    now: Date,
  ): Promise<void> {
    const updated = await this.deliveries.updateOne(
      { eventId: delivery.eventId, status: 'processing', lockedBy: workerId },
      { $set: {
        status: 'succeeded', succeededAt: now, lockedAt: null, lockedBy: null,
        lastErrorCode: null,
      } },
      { timestamps: false },
    );
    if (updated.modifiedCount !== 1) throw new Error('OP_APPROVAL_DELIVERY_LEASE_LOST');
  }

  private async markFailed(
    delivery: OpApprovalResultDeliveryRecord,
    workerId: string,
    error: unknown,
    now: Date,
  ): Promise<void> {
    const attempts = delivery.attempts + 1;
    const category = error instanceof OpApprovalDeliveryError ? error.category : 'retryable';
    const terminal = category !== 'retryable' || attempts >= OP_APPROVAL_MAX_ATTEMPTS;
    const updated = await this.deliveries.updateOne(
      { eventId: delivery.eventId, status: 'processing', lockedBy: workerId },
      { $set: {
        status: terminal ? (category === 'retryable' ? 'dead' : 'manual_review') : 'pending',
        attempts, nextAttemptAt: terminal ? now : calculateOpApprovalNextAttemptAt(attempts, now),
        lockedAt: null, lockedBy: null, lastErrorCode: failureCode(error),
      } },
      { timestamps: false },
    );
    if (updated.modifiedCount !== 1) throw new Error('OP_APPROVAL_DELIVERY_LEASE_LOST');
  }

  private async auditAfterCommit(
    tenantId: string,
    input: SystemAuditRecordInput,
  ): Promise<void> {
    try {
      await this.audit.recordSystem(tenantId, input);
    } catch {
      this.logger.error({
        code: 'OP_APPROVAL_RESULT_AUDIT_AFTER_COMMIT_FAILED',
        outcome: input.outcome,
      });
    }
  }

  private assertInput(workerId: string, limit: number): void {
    if (!WORKER_ID.test(workerId) || !Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('OP 审批结果投递参数非法');
    }
  }
}

const FAILURE_CODE_PATTERN = /^[A-Z0-9_]{3,128}$/;

function failureCode(error: unknown): string {
  if (error instanceof OpApprovalDeliveryError && FAILURE_CODE_PATTERN.test(error.code)) {
    return error.code;
  }
  if (error instanceof ServiceUnavailableException) {
    const response = error.getResponse();
    if (typeof response === 'object' && response !== null &&
      typeof (response as { code?: unknown }).code === 'string' &&
      FAILURE_CODE_PATTERN.test((response as { code: string }).code)) {
      return (response as { code: string }).code;
    }
  }
  return 'OP_APPROVAL_DELIVERY_UNEXPECTED';
}
