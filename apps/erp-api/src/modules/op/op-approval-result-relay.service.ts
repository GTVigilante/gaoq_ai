import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Injectable } from '@nestjs/common';
import type { ClientSession, Connection, Model } from 'mongoose';
import { z } from 'zod';

import { OutboxRecord, type OutboxDocument } from '../org/persistence/outbox.schema.js';
import { calculateOpApprovalNextAttemptAt } from './op-approval.policy.js';
import {
  OpApprovalBridgeRecord,
  type OpApprovalBridgeDocument,
  OpApprovalResultDeliveryRecord,
  type OpApprovalResultDeliveryDocument,
} from './persistence/op.schemas.js';

const LOCK_TIMEOUT_MS = 5 * 60 * 1_000;
const MAX_RELAY_ATTEMPTS = 6;
const WORKER_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const terminalEventSchema = z.object({
  specversion: z.literal('1.0'),
  id: z.string().min(1).max(128),
  source: z.literal('//gaoq-erp/approval-module'),
  type: z.enum([
    'cn.gaoq.erp.approval_instance.decided.v1',
    'cn.gaoq.erp.approval_instance.withdrawn.v1',
  ]),
  subject: z.string().min(1).max(512),
  time: z.string().datetime({ offset: true }),
  datacontenttype: z.literal('application/json'),
  tenantId: z.string().min(1).max(128),
  idempotencyKey: z.string().min(1).max(512),
  schemaVersion: z.literal('1'),
  data: z.object({
    tenantId: z.string().min(1).max(128),
    aggregateId: z.string().min(1).max(128),
    version: z.number().int().positive(),
    resultingStatus: z.enum(['running', 'approved', 'rejected']).optional(),
  }).passthrough(),
}).passthrough();

interface ClaimedApprovalEvent {
  readonly eventId: string;
  readonly tenantId: string;
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  readonly eventType: string;
  readonly envelope: Record<string, unknown>;
  readonly attempts: number;
}

/** 消费审批 Outbox；只为 OP 来源审批的终态创建可靠结果投递。 */
@Injectable()
export class OpApprovalResultRelayService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(OutboxRecord.name) private readonly outbox: Model<OutboxDocument>,
    @InjectModel(OpApprovalBridgeRecord.name)
    private readonly bridges: Model<OpApprovalBridgeDocument>,
    @InjectModel(OpApprovalResultDeliveryRecord.name)
    private readonly deliveries: Model<OpApprovalResultDeliveryDocument>,
  ) {}

  async relayBatch(workerId: string, limit = 50): Promise<number> {
    this.assertInput(workerId, limit);
    let count = 0;
    for (let index = 0; index < limit; index += 1) {
      const event = await this.claim(workerId, new Date());
      if (event === null) break;
      try {
        await this.relay(event, workerId);
        count += 1;
      } catch {
        await this.release(event, workerId, new Date());
      }
    }
    return count;
  }

  private async claim(workerId: string, now: Date): Promise<ClaimedApprovalEvent | null> {
    const event = await this.outbox.findOneAndUpdate({
      aggregateType: 'approval.instance', nextAttemptAt: { $lte: now },
      $or: [
        { status: 'pending' },
        { status: 'dispatching', lockedAt: { $lt: new Date(now.getTime() - LOCK_TIMEOUT_MS) } },
      ],
    }, {
      $set: { status: 'dispatching', lockedAt: now, lockedBy: workerId },
    }, { sort: { createdAt: 1 }, returnDocument: 'after' }).lean().exec();
    return event === null ? null : {
      eventId: event.eventId, tenantId: event.tenantId, aggregateId: event.aggregateId,
      aggregateVersion: event.aggregateVersion, eventType: event.eventType,
      envelope: structuredClone(event.envelope), attempts: event.attempts,
    };
  }

  private async relay(event: ClaimedApprovalEvent, workerId: string): Promise<void> {
    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        const terminal = this.terminal(event);
        if (terminal !== null) {
          const bridge = await this.bridges.findOne({
            tenantId: event.tenantId, approvalInstanceId: event.aggregateId,
          }).session(session).lean().exec();
          if (bridge !== null) {
            this.assertBridgeTransition(bridge, terminal);
            await this.createDelivery(event, bridge, terminal, session);
            const updated = await this.bridges.updateOne({
              tenantId: bridge.tenantId, approvalInstanceId: bridge.approvalInstanceId,
              approvalStatus: bridge.approvalStatus,
              approvalVersion: bridge.approvalVersion,
            }, { $set: {
              approvalStatus: terminal.result, approvalVersion: terminal.version,
              completedAt: terminal.occurredAt,
            } }, { session, timestamps: false, runValidators: true });
            if (updated.matchedCount !== 1) {
              throw new Error('OP_APPROVAL_BRIDGE_VERSION_CONFLICT');
            }
          }
        }
        const updated = await this.outbox.updateOne(
          { eventId: event.eventId, status: 'dispatching', lockedBy: workerId },
          { $set: {
            status: 'dispatched', dispatchedAt: new Date(), lockedAt: null, lockedBy: null,
            lastErrorCode: null,
          } },
          { session, timestamps: false },
        );
        if (updated.matchedCount !== 1) throw new Error('OP_APPROVAL_OUTBOX_LEASE_LOST');
      });
    } finally {
      await session.endSession();
    }
  }

  private terminal(event: ClaimedApprovalEvent): {
    readonly result: 'approved' | 'rejected' | 'withdrawn';
    readonly version: number;
    readonly occurredAt: Date;
  } | null {
    if (!event.eventType.startsWith('cn.gaoq.erp.approval_instance.')) return null;
    if (event.eventType !== 'cn.gaoq.erp.approval_instance.decided.v1' &&
      event.eventType !== 'cn.gaoq.erp.approval_instance.withdrawn.v1') return null;
    const parsed = terminalEventSchema.parse(event.envelope);
    if (
      parsed.id !== event.eventId ||
      parsed.type !== event.eventType ||
      parsed.tenantId !== event.tenantId ||
      parsed.subject !==
        `tenant/${event.tenantId}/approval.instance/${event.aggregateId}` ||
      parsed.idempotencyKey !==
        `${event.tenantId}:${event.eventType}:${event.aggregateId}:${event.aggregateVersion}` ||
      parsed.data.tenantId !== event.tenantId ||
      parsed.data.aggregateId !== event.aggregateId ||
      parsed.data.version !== event.aggregateVersion
    ) throw new Error('OP_APPROVAL_OUTBOX_IDENTITY_MISMATCH');
    if (parsed.type.endsWith('.withdrawn.v1')) return {
      result: 'withdrawn', version: parsed.data.version, occurredAt: new Date(parsed.time),
    };
    const result = parsed.data.resultingStatus;
    if (result !== 'approved' && result !== 'rejected') return null;
    return { result, version: parsed.data.version, occurredAt: new Date(parsed.time) };
  }

  private assertBridgeTransition(
    bridge: OpApprovalBridgeRecord,
    terminal: {
      readonly result: 'approved' | 'rejected' | 'withdrawn';
      readonly version: number;
    },
  ): void {
    const newTerminal = bridge.approvalStatus === 'running' &&
      terminal.version > bridge.approvalVersion;
    const idempotentTerminal = bridge.approvalStatus === terminal.result &&
      terminal.version === bridge.approvalVersion;
    if (!newTerminal && !idempotentTerminal) {
      throw new Error('OP_APPROVAL_BRIDGE_VERSION_CONFLICT');
    }
  }

  private async createDelivery(
    event: ClaimedApprovalEvent,
    bridge: OpApprovalBridgeRecord,
    terminal: {
      readonly result: 'approved' | 'rejected' | 'withdrawn';
      readonly version: number;
      readonly occurredAt: Date;
    },
    session: ClientSession,
  ): Promise<void> {
    const delivery = await this.deliveries.findOneAndUpdate(
      { eventId: event.eventId },
      { $setOnInsert: {
        eventId: event.eventId, tenantId: bridge.tenantId, clientId: bridge.clientId,
        externalEventId: bridge.externalEventId,
        sourceDocumentType: bridge.sourceDocumentType, sourceDocumentId: bridge.sourceDocumentId,
        approvalInstanceId: bridge.approvalInstanceId, approvalVersion: terminal.version,
        result: terminal.result, occurredAt: terminal.occurredAt,
        status: 'pending', attempts: 0, operatorRetryCount: 0, nextAttemptAt: new Date(),
        lockedAt: null, lockedBy: null, lastErrorCode: null, succeededAt: null,
      } },
      {
        upsert: true, returnDocument: 'after', session,
        runValidators: true, setDefaultsOnInsert: true,
      },
    ).lean().exec();
    if (
      delivery === null ||
      delivery.tenantId !== bridge.tenantId ||
      delivery.clientId !== bridge.clientId ||
      delivery.externalEventId !== bridge.externalEventId ||
      delivery.sourceDocumentType !== bridge.sourceDocumentType ||
      delivery.sourceDocumentId !== bridge.sourceDocumentId ||
      delivery.approvalInstanceId !== bridge.approvalInstanceId ||
      delivery.approvalVersion !== terminal.version ||
      delivery.result !== terminal.result ||
      delivery.occurredAt.getTime() !== terminal.occurredAt.getTime()
    ) {
      throw new Error('OP_APPROVAL_DELIVERY_CONFLICT');
    }
  }

  private async release(
    event: ClaimedApprovalEvent,
    workerId: string,
    now: Date,
  ): Promise<void> {
    const attempts = event.attempts + 1;
    const exhausted = attempts >= MAX_RELAY_ATTEMPTS;
    const updated = await this.outbox.updateOne(
      { eventId: event.eventId, status: 'dispatching', lockedBy: workerId },
      { $set: {
        status: exhausted ? 'dead' : 'pending', attempts,
        nextAttemptAt: exhausted ? now : calculateOpApprovalNextAttemptAt(attempts, now),
        lockedAt: null, lockedBy: null, lastErrorCode: 'OP_APPROVAL_RELAY_FAILED',
      } },
      { timestamps: false },
    );
    if (updated.matchedCount !== 1) throw new Error('OP_APPROVAL_OUTBOX_LEASE_LOST');
  }

  private assertInput(workerId: string, limit: number): void {
    if (!WORKER_ID.test(workerId) || !Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('OP 审批 relay 参数非法');
    }
  }
}
