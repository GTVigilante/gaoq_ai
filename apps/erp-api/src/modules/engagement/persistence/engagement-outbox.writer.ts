import{Injectable}from'@nestjs/common';import{InjectModel}from'@nestjs/mongoose';import{createEventId}from'@gaoq/shared-utils';import type{ClientSession,Model}from'mongoose';import{TenantContextService}from'../../../core/tenant/tenant-context.service.js';import{OutboxRecord,type OutboxDocument}from'../../org/persistence/outbox.schema.js';import type{ServiceEngagement}from'../domain/engagement.js';
export const EVENT_TYPES=['engagement.service.created','engagement.service.submitted','engagement.service.approved','engagement.signature.requested','engagement.service.activated','engagement.service.delivered','engagement.service.accepted','engagement.service.disputed','engagement.service.cancelled']as const;
@Injectable()
export class EngagementOutboxWriter {
  constructor(
    private readonly context: TenantContextService,
    @InjectModel(OutboxRecord.name) private readonly records: Model<OutboxDocument>,
  ) {}

  async append(
    value: ServiceEngagement,
    action: 'created' | 'submitted' | 'approved' | 'activated' | 'delivered' |
      'accepted' | 'disputed' | 'cancelled',
    session: ClientSession,
  ): Promise<void> {
    const domainType = `engagement.service.${action}` as (typeof EVENT_TYPES)[number];
    if (!EVENT_TYPES.some((candidate) => candidate === domainType)) {
      throw new Error('ENGAGEMENT_OUTBOX_ACTION_INVALID');
    }
    await this.write(value, domainType, {
      tenantId: value.tenantId,
      engagementId: value.id,
      sourcingRequestId: value.sourcingRequestId,
      supplierId: value.supplierId,
      serviceCategoryCode: value.serviceCategoryCode,
      agreedAmountMinor: value.agreedAmountMinor,
      currency: value.currency,
      status: value.status,
      version: value.version,
      deliveryVersion: value.deliveries.at(-1)?.version ?? null,
      statusReasonCode: value.statusReasonCode,
    }, session);
  }

  /**
   * 在审批终态的同一事务中发布电子签发起意图。
   * Integration 只能使用不透明审批证据解析受控合同文件与签署主体，事件不携带姓名、联系方式或签署链接。
   */
  async appendSignatureRequest(value: ServiceEngagement, session: ClientSession): Promise<void> {
    if (value.status !== 'pending_signature' || value.approvalEvidenceRef === null) {
      throw new Error('ENGAGEMENT_SIGNATURE_REQUEST_STATE_INVALID');
    }
    await this.write(value, 'engagement.signature.requested', {
      tenantId: value.tenantId,
      engagementId: value.id,
      supplierId: value.supplierId,
      approvalEvidenceRef: value.approvalEvidenceRef,
      serviceCategoryCode: value.serviceCategoryCode,
      agreedAmountMinor: value.agreedAmountMinor,
      currency: value.currency,
      version: value.version,
    }, session);
  }

  private async write(
    value: ServiceEngagement,
    domainType: (typeof EVENT_TYPES)[number],
    data: Readonly<Record<string, unknown>>,
    session: ClientSession,
  ): Promise<void> {
    if (!session.inTransaction()) throw new Error('ENGAGEMENT_TRANSACTION_REQUIRED');
    if (value.tenantId !== this.context.getTenantRequired().tenantId) {
      throw new Error('ENGAGEMENT_OUTBOX_TENANT_MISMATCH');
    }
    const trusted = this.context.getRequired();
    const eventId = createEventId(new Date(value.updatedAt));
    const eventType = `cn.gaoq.erp.${domainType}.v1`;
    const envelope = {
      specversion: '1.0', id: eventId, source: '//gaoq-erp/engagement-module',
      type: eventType,
      subject: `tenant/${trusted.tenant.tenantId}/engagement/${value.id}`,
      time: value.updatedAt, datacontenttype: 'application/json',
      tenantId: trusted.tenant.tenantId, traceId: trusted.actor.traceId,
      idempotencyKey: `${trusted.tenant.tenantId}:${eventType}:${value.id}:${value.version}`,
      schemaVersion: '1', data,
    };
    await this.records.create([{
      eventId, tenantId: trusted.tenant.tenantId, aggregateType: 'engagement.service',
      aggregateId: value.id, aggregateVersion: value.version, eventType, envelope,
      status: 'pending', attempts: 0, nextAttemptAt: new Date(value.updatedAt),
    }], { session });
  }
}
