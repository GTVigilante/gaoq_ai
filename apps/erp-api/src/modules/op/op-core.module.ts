import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AuditModule } from '../../core/audit/audit.module.js';
import { IdempotencyModule } from '../../core/idempotency/idempotency.module.js';
import { TenantContextModule } from '../../core/tenant/tenant-context.module.js';
import { ApprovalCoreModule } from '../approval/approval-core.module.js';
import { OutboxRecord, OutboxRecordSchema } from '../org/persistence/outbox.schema.js';
import { FetchOpApprovalHttpClient, OpApprovalHttpClient } from './op-approval-http.client.js';
import { OP_APPROVAL_BRIDGE_QUEUE } from './op-approval.queue.js';
import { OpApprovalWebhookCryptoService } from './op-approval-webhook-crypto.service.js';
import { OpApprovalRequestService } from './op-approval-request.service.js';
import {
  OpApprovalOutboundSecretResolver,
  OpApprovalResultDeliveryService,
} from './op-approval-result-delivery.service.js';
import { OpApprovalResultRelayService } from './op-approval-result-relay.service.js';
import { OpApprovalWebhookService } from './op-approval-webhook.service.js';
import { OpOperatingSummaryService } from './application/op-operating-summary.service.js';
import { OpApprovalBridgeService } from './application/op-approval-bridge.service.js';
import { OpApprovalResultOperationsService } from './application/op-approval-result-operations.service.js';
import { OP_OPERATING_SUMMARY_QUEUE } from './op-operating-summary.queue.js';
import { OpWebhookCryptoService } from './op-webhook-crypto.service.js';
import { OpWebhookSecretResolver, OpWebhookService } from './op-webhook.service.js';
import { OpOutboxWriter } from './persistence/op-outbox.writer.js';
import {
  OpClientBindingRecord,
  OpClientBindingRecordSchema,
  OpApprovalBridgeRecord,
  OpApprovalBridgeRecordSchema,
  OpApprovalRequestInboxRecord,
  OpApprovalRequestInboxRecordSchema,
  OpApprovalResultDeliveryRecord,
  OpApprovalResultDeliveryRecordSchema,
  OpApprovalRouteRecord,
  OpApprovalRouteRecordSchema,
  OpOperatingSummaryInboxRecord,
  OpOperatingSummaryInboxRecordSchema,
  OpOperatingSummaryRecord,
  OpOperatingSummaryRecordSchema,
} from './persistence/op.schemas.js';

/** Phase 5 OP 外部系统边界：经营摘要、组织关联查询与审批双向桥接。 */
@Module({
  imports: [
    AuditModule,
    IdempotencyModule,
    TenantContextModule,
    ApprovalCoreModule,
    BullModule.registerQueue({ name: OP_OPERATING_SUMMARY_QUEUE }),
    BullModule.registerQueue({ name: OP_APPROVAL_BRIDGE_QUEUE }),
    MongooseModule.forFeature([
      { name: OpClientBindingRecord.name, schema: OpClientBindingRecordSchema },
      { name: OpApprovalRouteRecord.name, schema: OpApprovalRouteRecordSchema },
      { name: OpApprovalRequestInboxRecord.name, schema: OpApprovalRequestInboxRecordSchema },
      { name: OpApprovalBridgeRecord.name, schema: OpApprovalBridgeRecordSchema },
      { name: OpApprovalResultDeliveryRecord.name, schema: OpApprovalResultDeliveryRecordSchema },
      { name: OpOperatingSummaryInboxRecord.name, schema: OpOperatingSummaryInboxRecordSchema },
      { name: OpOperatingSummaryRecord.name, schema: OpOperatingSummaryRecordSchema },
      { name: OutboxRecord.name, schema: OutboxRecordSchema },
    ]),
  ],
  providers: [
    OpWebhookSecretResolver, OpWebhookCryptoService, OpWebhookService,
    OpOperatingSummaryService, OpOutboxWriter,
    OpApprovalBridgeService, OpApprovalResultOperationsService,
    OpApprovalWebhookCryptoService,
    OpApprovalWebhookService, OpApprovalRequestService, OpApprovalResultRelayService,
    OpApprovalOutboundSecretResolver, OpApprovalResultDeliveryService,
    FetchOpApprovalHttpClient,
    { provide: OpApprovalHttpClient, useExisting: FetchOpApprovalHttpClient },
  ],
  exports: [
    MongooseModule,
    AuditModule,
    TenantContextModule,
    OpOperatingSummaryService, OpApprovalBridgeService, OpWebhookCryptoService,
    OpWebhookService, OpApprovalWebhookService, OpApprovalResultOperationsService,
    OpApprovalRequestService, OpApprovalResultRelayService, OpApprovalResultDeliveryService,
  ],
})
export class OpCoreModule {}
