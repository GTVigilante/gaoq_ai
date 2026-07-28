import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { createEventId } from '@gaoq/shared-utils';
import type { Connection, Model } from 'mongoose';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { OpOperatingSummaryEnvelope } from '../op-operating-summary.contract.js';
import { OpOutboxWriter } from '../persistence/op-outbox.writer.js';
import {
  OpOperatingSummaryRecord,
  type OpOperatingSummaryDocument,
} from '../persistence/op.schemas.js';

export interface OpOperatingSummaryView {
  readonly summaryDate: string;
  readonly revision: number;
  readonly currency: 'CNY';
  readonly metrics: {
    readonly gmvMinor: number;
    readonly paidOrderCount: number;
    readonly refundMinor: number;
    readonly refundOrderCount: number;
    readonly activeCustomerCount: number;
  };
}

export interface AppliedOpOperatingSummary extends OpOperatingSummaryView {
  readonly id: string;
  readonly payloadHash: string;
  readonly occurredAt: string;
  readonly receivedAt: string;
}

export interface ApplyOpOperatingSummaryInput {
  readonly tenantId: string;
  readonly clientId: string;
  readonly externalEventId: string;
  readonly inboxId: string;
  readonly payloadHash: string;
  readonly receivedAt: Date;
  readonly envelope: OpOperatingSummaryEnvelope;
}

/** OP 经营摘要应用服务；修订只追加，查询与 MCP 均通过此服务。 */
@Injectable()
export class OpOperatingSummaryService {
  constructor(
    private readonly context: TenantContextService,
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(OpOperatingSummaryRecord.name)
    private readonly summaries: Model<OpOperatingSummaryDocument>,
    private readonly outbox: OpOutboxWriter,
  ) {}

  async getLatest(summaryDate: string): Promise<OpOperatingSummaryView> {
    this.assertScope('erp:op:operating_summary:read', 'OP_OPERATING_SUMMARY_READ_DENIED');
    this.assertDate(summaryDate);
    const tenantId = this.context.getTenantRequired().tenantId;
    const record = await this.summaries.findOne({ tenantId, summaryDate })
      .sort({ revision: -1 }).lean().exec();
    if (record === null) throw new NotFoundException({
      code: 'OP_OPERATING_SUMMARY_NOT_FOUND', message: '未找到该日期的 OP 经营摘要',
    });
    return this.publicView(record);
  }

  async apply(input: ApplyOpOperatingSummaryInput): Promise<AppliedOpOperatingSummary> {
    const actor = this.context.getActorRequired();
    if (
      actor.actorType !== 'system_job' ||
      !actor.scopes.includes('erp:op:operating_summary:ingest')
    ) {
      throw new ForbiddenException({
        code: 'OP_OPERATING_SUMMARY_INGEST_DENIED',
        message: '仅允许可信 OP 入站 Worker 写入经营摘要',
      });
    }
    if (input.tenantId !== this.context.getTenantRequired().tenantId) {
      throw new ForbiddenException({
        code: 'OP_OPERATING_SUMMARY_CROSS_TENANT_DENIED',
        message: '禁止跨租户写入 OP 经营摘要',
      });
    }
    this.assertDate(input.envelope.data.summaryDate);
    this.assertBusinessDate(input.envelope.data.summaryDate, input.envelope.occurredAt);
    const existingEvent = await this.summaries.findOne({
      tenantId: input.tenantId, clientId: input.clientId,
      externalEventId: input.externalEventId,
    }).lean().exec();
    if (existingEvent !== null) {
      if (existingEvent.payloadHash !== input.payloadHash) {
        throw new ConflictException({
          code: 'OP_EVENT_PAYLOAD_CONFLICT', message: '同一 OP 事件标识对应不同载荷',
        });
      }
      return this.internalView(existingEvent);
    }
    const session = await this.connection.startSession();
    let result: AppliedOpOperatingSummary | undefined;
    try {
      await session.withTransaction(async () => {
        const latest = await this.summaries.findOne({
          tenantId: input.tenantId, summaryDate: input.envelope.data.summaryDate,
        }).sort({ revision: -1 }).session(session).lean().exec();
        const expectedRevision = latest === null ? 1 : latest.revision + 1;
        if (input.envelope.data.revision !== expectedRevision) {
          throw new ConflictException({
            code: 'OP_OPERATING_SUMMARY_REVISION_INVALID',
            message: `经营摘要修订必须连续，期望 revision=${expectedRevision}`,
          });
        }
        const id = createEventId(input.receivedAt);
        const metrics = input.envelope.data.metrics;
        const created = await this.summaries.create([{
          id, tenantId: input.tenantId, summaryDate: input.envelope.data.summaryDate,
          revision: input.envelope.data.revision, currency: input.envelope.data.currency,
          gmvMinor: metrics.gmvMinor, paidOrderCount: metrics.paidOrderCount,
          refundMinor: metrics.refundMinor, refundOrderCount: metrics.refundOrderCount,
          activeCustomerCount: metrics.activeCustomerCount, clientId: input.clientId,
          externalEventId: input.externalEventId, inboxId: input.inboxId,
          payloadHash: input.payloadHash, occurredAt: new Date(input.envelope.occurredAt),
          receivedAt: input.receivedAt,
        }], { session });
        const record = created[0];
        if (record === undefined) throw new Error('OP_OPERATING_SUMMARY_CREATE_FAILED');
        await this.outbox.appendOperatingSummary({
          tenantId: input.tenantId, aggregateId: id, version: input.envelope.data.revision,
          occurredAt: input.envelope.occurredAt,
          data: {
            summaryDate: input.envelope.data.summaryDate,
            revision: input.envelope.data.revision, currency: input.envelope.data.currency,
            ...metrics, payloadHash: input.payloadHash,
          },
        }, session);
        result = this.internalView(record.toObject());
      });
    } finally {
      await session.endSession();
    }
    if (result === undefined) throw new Error('OP_OPERATING_SUMMARY_TRANSACTION_EMPTY');
    return result;
  }

  private assertDate(value: string): void {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw invalidDate();
    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
      throw invalidDate();
    }
  }

  private assertBusinessDate(summaryDate: string, occurredAt: string): void {
    const providerTime = new Date(occurredAt);
    const shanghaiDate = new Date(providerTime.getTime() + 8 * 60 * 60 * 1_000)
      .toISOString().slice(0, 10);
    const ageDays = Math.floor(
      (Date.parse(`${shanghaiDate}T00:00:00.000Z`) -
        Date.parse(`${summaryDate}T00:00:00.000Z`)) / (24 * 60 * 60 * 1_000),
    );
    if (ageDays < 0 || ageDays > 31) throw new BadRequestException({
      code: 'OP_OPERATING_SUMMARY_BUSINESS_DATE_INVALID',
      message: '经营摘要日期不得晚于 OP 事件上海业务日，且只接受最近 31 日补传',
    });
  }

  private assertScope(scope: string, code: string): void {
    if (!this.context.getActorRequired().scopes.includes(scope)) {
      throw new ForbiddenException({ code, message: '无权读取 OP 经营摘要' });
    }
  }

  private publicView(record: OpOperatingSummaryRecord): OpOperatingSummaryView {
    return Object.freeze({
      summaryDate: record.summaryDate, revision: record.revision,
      currency: record.currency,
      metrics: Object.freeze({
        gmvMinor: record.gmvMinor, paidOrderCount: record.paidOrderCount,
        refundMinor: record.refundMinor, refundOrderCount: record.refundOrderCount,
        activeCustomerCount: record.activeCustomerCount,
      }),
    });
  }

  private internalView(record: OpOperatingSummaryRecord): AppliedOpOperatingSummary {
    return Object.freeze({
      ...this.publicView(record),
      id: record.id,
      payloadHash: record.payloadHash, occurredAt: record.occurredAt.toISOString(),
      receivedAt: record.receivedAt.toISOString(),
    });
  }
}

function invalidDate(): BadRequestException {
  return new BadRequestException({
    code: 'OP_OPERATING_SUMMARY_DATE_INVALID', message: '经营摘要日期必须是真实 YYYY-MM-DD',
  });
}
