import { createHash } from 'node:crypto';

import { HttpException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ULID_PATTERN } from '@gaoq/shared-utils';
import type { Model } from 'mongoose';
import { z } from 'zod';

import { AuditService } from '../../core/audit/audit.service.js';
import { TenantContextService } from '../../core/tenant/tenant-context.service.js';
import { ApprovalApplicationService } from '../approval/application/approval-application.service.js';
import {
  hashOpApprovalPayload,
  opApprovalRequestEnvelopeSchema,
} from './op-approval.contract.js';
import { OpApprovalWebhookCryptoService } from './op-approval-webhook-crypto.service.js';
import {
  OpApprovalBridgeRecord,
  type OpApprovalBridgeDocument,
  OpApprovalRequestInboxRecord,
  type OpApprovalRequestInboxDocument,
  OpApprovalRouteRecord,
  type OpApprovalRouteDocument,
} from './persistence/op.schemas.js';

const LOCK_TIMEOUT_MS = 5 * 60 * 1_000;
const jobSchema = z.object({
  tenantId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  inboxId: z.string().regex(ULID_PATTERN),
}).strict();

/** 解密 OP 请求并复用 ApprovalApplicationService 原子创建、提交 CanonicalApproval。 */
@Injectable()
export class OpApprovalRequestService {
  constructor(
    @InjectModel(OpApprovalRequestInboxRecord.name)
    private readonly inbox: Model<OpApprovalRequestInboxDocument>,
    @InjectModel(OpApprovalRouteRecord.name)
    private readonly routes: Model<OpApprovalRouteDocument>,
    @InjectModel(OpApprovalBridgeRecord.name)
    private readonly bridges: Model<OpApprovalBridgeDocument>,
    private readonly crypto: OpApprovalWebhookCryptoService,
    private readonly approvals: ApprovalApplicationService,
    private readonly context: TenantContextService,
    private readonly audit: AuditService,
  ) {}

  async process(input: unknown): Promise<number> {
    const data = jobSchema.parse(input);
    const now = new Date();
    const claimed = await this.inbox.findOneAndUpdate({
      tenantId: data.tenantId, id: data.inboxId,
      $or: [
        { status: { $in: ['pending', 'failed'] } },
        { status: 'processing', processingStartedAt: { $lt: new Date(now.getTime() - LOCK_TIMEOUT_MS) } },
      ],
    }, {
      $set: { status: 'processing', processingStartedAt: now, failureCode: null },
      $inc: { attempts: 1 },
    }, { returnDocument: 'after', runValidators: true }).lean().exec();
    if (claimed === null) return 0;
    try {
      const raw = this.crypto.unprotect(claimed.tenantId, claimed.id, claimed);
      if (hashOpApprovalPayload(raw) !== claimed.payloadHash) {
        throw new Error('OP_APPROVAL_PAYLOAD_HASH_MISMATCH');
      }
      const envelope = opApprovalRequestEnvelopeSchema.parse(
        JSON.parse(raw.toString('utf8')) as unknown,
      );
      if (new Date(envelope.occurredAt).getTime() !== claimed.providerOccurredAt.getTime()) {
        throw new Error('OP_APPROVAL_ENVELOPE_TIME_MISMATCH');
      }
      const route = await this.routes.findOne({
        tenantId: claimed.tenantId, inboundClientId: claimed.clientId,
        sourceDocumentType: envelope.data.sourceDocumentType, status: 'active',
      }).lean().exec();
      if (route === null) throw new Error('OP_APPROVAL_ROUTE_DISABLED');
      await this.reserveBridge(claimed, route.templateCode, envelope.data);
      const result = await this.context.run({
        tenant: { tenantId: claimed.tenantId, source: 'service_identity' },
        actor: {
          actorType: 'system_job', actorId: 'system:op-approval-bridge',
          tenantId: claimed.tenantId, roleCodes: ['INTEGRATION_WORKER'],
          scopes: ['erp:approval:op:ingest'], departmentIds: [], traceId: claimed.id,
        },
      }, async () => this.approvals.createAndSubmitFromOp(
        this.idempotencyKey(claimed.tenantId, claimed.clientId, claimed.externalEventId),
        {
          instanceId: claimed.id,
          templateCode: route.templateCode,
          title: envelope.data.title,
          formData: envelope.data.formData,
          initiatorEmployeeId: envelope.data.initiatorEmployeeId,
          sourceDocumentType: envelope.data.sourceDocumentType,
          sourceDocumentId: envelope.data.sourceDocumentId,
        },
      ));
      await this.ensureBridge(claimed, route.templateCode, envelope.data, result.instance);
      await this.finish(claimed.tenantId, claimed.id, 'completed', null);
      await this.audit.recordSystem(claimed.tenantId, {
        action: 'op.approval.create_submit', resourceType: 'approval_instance',
        resourceId: result.instance.id, riskLevel: 'R2', outcome: 'success', traceId: claimed.id,
        metadata: {
          clientId: claimed.clientId, sourceDocumentType: envelope.data.sourceDocumentType,
          sourceDocumentId: envelope.data.sourceDocumentId, templateCode: route.templateCode,
        },
      });
      return 1;
    } catch (error) {
      const code = failureCode(error);
      await this.finish(claimed.tenantId, claimed.id, 'failed', code);
      await this.audit.recordSystem(claimed.tenantId, {
        action: 'op.approval.create_submit', resourceType: 'op_approval_request',
        resourceId: claimed.id, riskLevel: 'R2', outcome: 'failure', traceId: claimed.id,
        metadata: { failureCode: code },
      });
      if (isPermanent(error)) return 1;
      throw error;
    }
  }

  private async ensureBridge(
    claimed: OpApprovalRequestInboxRecord,
    templateCode: string,
    data: {
      readonly sourceDocumentType: string;
      readonly sourceDocumentId: string;
    },
    instance: {
      readonly id: string;
      readonly status: 'draft' | 'running' | 'approved' | 'rejected' | 'withdrawn' | 'archived';
      readonly version: number;
      readonly completedAt: string | null;
    },
  ): Promise<void> {
    if (instance.status !== 'running') throw new Error('OP_APPROVAL_INITIAL_STATUS_INVALID');
    const updated = await this.bridges.updateOne({
      tenantId: claimed.tenantId, clientId: claimed.clientId,
      externalEventId: claimed.externalEventId, approvalInstanceId: instance.id,
      payloadHash: claimed.payloadHash, approvalStatus: { $in: ['processing', 'running'] },
    }, { $set: {
      approvalStatus: 'running', approvalVersion: instance.version, completedAt: null,
    } }, { runValidators: true });
    if (updated.matchedCount !== 1) throw new Error('OP_APPROVAL_BRIDGE_CONFLICT');
    const bridge = await this.bridges.findOne({
      tenantId: claimed.tenantId, clientId: claimed.clientId,
      externalEventId: claimed.externalEventId,
    }).lean().exec();
    if (
      bridge === null || bridge.payloadHash !== claimed.payloadHash ||
      bridge.approvalInstanceId !== instance.id ||
      bridge.sourceDocumentType !== data.sourceDocumentType ||
      bridge.sourceDocumentId !== data.sourceDocumentId
    ) throw new Error('OP_APPROVAL_BRIDGE_CONFLICT');
  }

  /** 先占用来源单据唯一键，再创建审批，阻止并发不同 eventId 生成重复实例。 */
  private async reserveBridge(
    claimed: OpApprovalRequestInboxRecord,
    templateCode: string,
    data: {
      readonly sourceDocumentType: string;
      readonly sourceDocumentId: string;
    },
  ): Promise<void> {
    await this.bridges.updateOne({
      tenantId: claimed.tenantId, clientId: claimed.clientId,
      externalEventId: claimed.externalEventId,
    }, { $setOnInsert: {
      id: claimed.id, tenantId: claimed.tenantId, clientId: claimed.clientId,
      externalEventId: claimed.externalEventId,
      sourceDocumentType: data.sourceDocumentType, sourceDocumentId: data.sourceDocumentId,
      templateCode, approvalInstanceId: claimed.id, payloadHash: claimed.payloadHash,
      approvalStatus: 'processing', approvalVersion: 0, completedAt: null,
    } }, { upsert: true, runValidators: true, setDefaultsOnInsert: true });
    const bridge = await this.bridges.findOne({
      tenantId: claimed.tenantId, clientId: claimed.clientId,
      externalEventId: claimed.externalEventId,
    }).lean().exec();
    if (
      bridge === null || bridge.payloadHash !== claimed.payloadHash ||
      bridge.approvalInstanceId !== claimed.id || bridge.templateCode !== templateCode ||
      bridge.sourceDocumentType !== data.sourceDocumentType ||
      bridge.sourceDocumentId !== data.sourceDocumentId
    ) throw new Error('OP_APPROVAL_BRIDGE_CONFLICT');
  }

  private async finish(
    tenantId: string,
    id: string,
    status: 'completed' | 'failed',
    code: string | null,
  ): Promise<void> {
    const updated = await this.inbox.updateOne(
      { tenantId, id, status: 'processing' },
      { $set: {
        status, failureCode: code, processedAt: status === 'completed' ? new Date() : null,
        processingStartedAt: null,
      } },
      { runValidators: true },
    );
    if (updated.modifiedCount !== 1) throw new Error('OP_APPROVAL_INBOX_LEASE_LOST');
  }

  private idempotencyKey(tenantId: string, clientId: string, externalEventId: string): string {
    return `opapp:${createHash('sha256')
      .update(JSON.stringify([tenantId, clientId, externalEventId]), 'utf8').digest('base64url')}`;
  }
}

function isPermanent(error: unknown): boolean {
  return error instanceof z.ZodError || error instanceof SyntaxError ||
    (error instanceof HttpException && error.getStatus() >= 400 && error.getStatus() < 500) ||
    (error instanceof Error && [
      'OP_APPROVAL_PAYLOAD_HASH_MISMATCH', 'OP_APPROVAL_ENVELOPE_TIME_MISMATCH',
      'OP_APPROVAL_ROUTE_DISABLED', 'OP_APPROVAL_INITIAL_STATUS_INVALID',
      'OP_APPROVAL_BRIDGE_CONFLICT', 'OP_APPROVAL_PAYLOAD_INVALID',
    ].includes(error.message)) || isDuplicateKeyError(error);
}

function failureCode(error: unknown): string {
  if (error instanceof z.ZodError || error instanceof SyntaxError) return 'OP_APPROVAL_BODY_INVALID';
  if (error instanceof HttpException) {
    const response = error.getResponse();
    if (typeof response === 'object' && response !== null &&
      typeof (response as { code?: unknown }).code === 'string') {
      return (response as { code: string }).code;
    }
  }
  if (isDuplicateKeyError(error)) return 'OP_APPROVAL_UNIQUE_CONFLICT';
  if (error instanceof Error && /^[A-Z0-9_]{3,128}$/.test(error.message)) return error.message;
  return 'OP_APPROVAL_PROCESSING_FAILED';
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11_000;
}
