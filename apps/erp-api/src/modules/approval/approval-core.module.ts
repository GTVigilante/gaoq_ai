import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { IdempotencyModule } from '../../core/idempotency/idempotency.module.js';
import { TenantContextModule } from '../../core/tenant/tenant-context.module.js';
import { OrgCoreModule } from '../org/org-core.module.js';
import { IdentityPersistenceModule } from '../identity/identity-persistence.module.js';
import { OutboxRecord, OutboxRecordSchema } from '../org/persistence/outbox.schema.js';
import { ApprovalDataCryptoService } from './persistence/approval-data-crypto.service.js';
import { ApprovalActorResolverService } from './application/approval-actor-resolver.service.js';
import { ApprovalApplicationService } from './application/approval-application.service.js';
import {
  ApprovalActionRepository,
  ApprovalDelegationRepository,
  ApprovalInstanceRepository,
  ApprovalLegacyHistoryRepository,
  ApprovalTemplateRepository,
} from './persistence/approval.repositories.js';
import {
  ApprovalActionRecord,
  ApprovalActionRecordSchema,
  ApprovalDelegationRecord,
  ApprovalDelegationRecordSchema,
  ApprovalInstanceRecord,
  ApprovalInstanceRecordSchema,
  ApprovalLegacyHistoryRecord,
  ApprovalLegacyHistoryRecordSchema,
  ApprovalTemplateRecord,
  ApprovalTemplateRecordSchema,
} from './persistence/approval.schemas.js';
import { ApprovalOutboxWriter } from './persistence/approval-outbox.writer.js';
import {
  ApprovalNotificationRecord,
  ApprovalNotificationRecordSchema,
} from './notification/approval-notification.schema.js';
import { ApprovalNotificationWriter } from './notification/approval-notification.writer.js';
import { ApprovalNotificationOperationsService } from './notification/approval-notification-operations.service.js';

/** Phase 2 审批模块：领域状态机、加密持久化、可靠事件和多通道契约的统一边界。 */
@Module({
  imports: [
    IdempotencyModule,
    IdentityPersistenceModule,
    TenantContextModule,
    OrgCoreModule,
    MongooseModule.forFeature([
      { name: ApprovalTemplateRecord.name, schema: ApprovalTemplateRecordSchema },
      { name: ApprovalLegacyHistoryRecord.name, schema: ApprovalLegacyHistoryRecordSchema },
      { name: ApprovalInstanceRecord.name, schema: ApprovalInstanceRecordSchema },
      { name: ApprovalActionRecord.name, schema: ApprovalActionRecordSchema },
      { name: ApprovalDelegationRecord.name, schema: ApprovalDelegationRecordSchema },
      { name: ApprovalNotificationRecord.name, schema: ApprovalNotificationRecordSchema },
      { name: OutboxRecord.name, schema: OutboxRecordSchema },
    ]),
  ],
  providers: [
    ApprovalDataCryptoService,
    ApprovalActorResolverService,
    ApprovalApplicationService,
    ApprovalTemplateRepository,
    ApprovalLegacyHistoryRepository,
    ApprovalInstanceRepository,
    ApprovalActionRepository,
    ApprovalDelegationRepository,
    ApprovalOutboxWriter,
    ApprovalNotificationWriter,
    ApprovalNotificationOperationsService,
  ],
  exports: [
    ApprovalApplicationService,
    ApprovalTemplateRepository,
    ApprovalLegacyHistoryRepository,
    ApprovalInstanceRepository,
    ApprovalActionRepository,
    ApprovalDelegationRepository,
    ApprovalOutboxWriter,
    ApprovalNotificationWriter,
    ApprovalNotificationOperationsService,
  ],
})
export class ApprovalCoreModule {}
