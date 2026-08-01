import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { IdentityPersistenceModule } from '../../identity/identity-persistence.module.js';
import { IntegrationCoreModule } from '../../integration/integration-core.module.js';
import {
  ApprovalNotificationAdapter,
  ApprovalNotificationAdapterRegistry,
  DINGTALK_APPROVAL_NOTIFICATION_ADAPTER,
  FEISHU_APPROVAL_NOTIFICATION_ADAPTER,
} from './approval-notification.adapter.js';
import { ApprovalNotificationDeliveryService } from './approval-notification-delivery.service.js';
import {
  ApprovalNotificationRecord,
  ApprovalNotificationRecordSchema,
} from './approval-notification.schema.js';
import { DingTalkApprovalNotificationAdapter } from './dingtalk-approval-notification.adapter.js';
import { FeishuApprovalNotificationAdapter } from './feishu-approval-notification.adapter.js';

/** 审批通知 Worker 基础设施，API 业务事务不导入任何外部平台发送能力。 */
@Module({
  imports: [
    IdentityPersistenceModule,
    IntegrationCoreModule,
    MongooseModule.forFeature([
      { name: ApprovalNotificationRecord.name, schema: ApprovalNotificationRecordSchema },
    ]),
  ],
  providers: [
    ApprovalNotificationDeliveryService,
    DingTalkApprovalNotificationAdapter,
    FeishuApprovalNotificationAdapter,
    {
      provide: DINGTALK_APPROVAL_NOTIFICATION_ADAPTER,
      useExisting: DingTalkApprovalNotificationAdapter,
    },
    {
      provide: FEISHU_APPROVAL_NOTIFICATION_ADAPTER,
      useExisting: FeishuApprovalNotificationAdapter,
    },
    {
      provide: ApprovalNotificationAdapterRegistry,
      inject: [
        DINGTALK_APPROVAL_NOTIFICATION_ADAPTER,
        FEISHU_APPROVAL_NOTIFICATION_ADAPTER,
      ],
      useFactory: (dingtalk: ApprovalNotificationAdapter, feishu: ApprovalNotificationAdapter) =>
        new ApprovalNotificationAdapterRegistry(dingtalk, feishu),
    },
  ],
  exports: [ApprovalNotificationDeliveryService],
})
export class ApprovalNotificationInfrastructureModule {}
