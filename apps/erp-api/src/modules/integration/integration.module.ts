import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { MongooseModule } from '@nestjs/mongoose';

import { AuditModule } from '../../core/audit/audit.module.js';
import { IdempotencyModule } from '../../core/idempotency/idempotency.module.js';
import { TenantContextModule } from '../../core/tenant/tenant-context.module.js';
import { AccessProfileRepository } from '../identity/access-profile.repository.js';
import { AccessProfile, AccessProfileSchema } from '../identity/access-profile.schema.js';
import { ExternalIdentityRepository } from '../identity/external-identity.repository.js';
import {
  ExternalIdentity,
  ExternalIdentitySchema,
} from '../identity/external-identity.schema.js';
import { OutboxRecord, OutboxRecordSchema } from '../org/persistence/outbox.schema.js';
import { RecruitmentModule } from '../recruitment/recruitment.module.js';
import {
  OrgDepartmentRecord,
  OrgDepartmentRecordSchema,
  OrgEmployeeRecord,
  OrgEmployeeRecordSchema,
} from '../org/persistence/org.schemas.js';
import { DingTalkOrgPushAdapter } from './dingtalk-org-push.adapter.js';
import { FeishuOrgPushAdapter } from './feishu-org-push.adapter.js';
import { ESignBinding, ESignBindingSchema } from './esign-binding.schema.js';
import { ESignFlowRecord, ESignFlowRecordSchema } from './esign-flow.schema.js';
import { ESignFlowService } from './esign-flow.service.js';
import { ESignWebhookController } from './esign-webhook.controller.js';
import { ESignWebhookCryptoService } from './esign-webhook-crypto.service.js';
import {
  ESignWebhookInboxRecord,
  ESignWebhookInboxRecordSchema,
} from './esign-webhook-inbox.schema.js';
import { ESIGN_WEBHOOK_QUEUE } from './esign-webhook.queue.js';
import { ESignSecretResolver, ESignWebhookService } from './esign-webhook.service.js';
import { IntegrationController } from './integration.controller.js';
import { OrgEmployeeProvisioningController } from './org-employee-provisioning.controller.js';
import { OrgEmployeeProvisioningService } from './org-employee-provisioning.service.js';
import {
  OrgEmployeeProvisioningRequest,
  OrgEmployeeProvisioningRequestSchema,
} from './org-employee-provisioning.schema.js';
import { OrgDeliveryOperationsService } from './org-delivery-operations.service.js';
import { OrgDeliveryService } from './org-delivery.service.js';
import {
  OrgDeliveryRecord,
  OrgDeliveryRecordSchema,
  OrgExternalVersionState,
  OrgExternalVersionStateSchema,
} from './org-delivery.schemas.js';
import { OrgExternalIdentityResolver } from './org-external-identity.resolver.js';
import { OrgOutboxRelayService } from './org-outbox-relay.service.js';
import {
  OrgPlatformBinding,
  OrgPlatformBindingSchema,
} from './org-platform-binding.schema.js';
import {
  EnvironmentOrgSecretResolver,
  OrgPlatformCredentialService,
  OrgSecretResolver,
} from './org-platform-credential.service.js';
import {
  FetchOrgPlatformHttpClient,
  OrgPlatformHttpClient,
} from './org-platform-http.client.js';
import { OrgPlatformTokenService } from './org-platform-token.service.js';
import { OrgProvisioningCryptoService } from './org-provisioning-crypto.service.js';
import {
  OrgReconciliationReport,
  OrgReconciliationReportSchema,
} from './org-reconciliation.schema.js';
import {
  RecruitmentCalendarDeliveryRecord,
  RecruitmentCalendarDeliveryRecordSchema,
} from './recruitment-calendar-delivery.schema.js';
import { RecruitmentCalendarOutboxRelayService } from './recruitment-calendar-outbox-relay.service.js';
import {
  RecruitmentCalendarBinding,
  RecruitmentCalendarBindingSchema,
} from './recruitment-calendar-binding.schema.js';
import { RecruitmentCalendarDeliveryService } from './recruitment-calendar-delivery.service.js';
import { DingTalkRecruitmentCalendarAdapter } from './dingtalk-recruitment-calendar.adapter.js';
import { FeishuRecruitmentCalendarAdapter } from './feishu-recruitment-calendar.adapter.js';
import {
  DINGTALK_RECRUITMENT_CALENDAR_ADAPTER,
  FEISHU_RECRUITMENT_CALENDAR_ADAPTER,
  RecruitmentCalendarAdapter,
  RecruitmentCalendarAdapterRegistry,
} from './recruitment-calendar.adapter.js';
import { OrgReconciliationService } from './org-reconciliation.service.js';
import {
  DINGTALK_ORG_PUSH_ADAPTER,
  FEISHU_ORG_PUSH_ADAPTER,
  OrgPushAdapter,
  OrgPushAdapterRegistry,
} from './org-push.adapter.js';

/** 外部集成底座：Outbox 扇出、双平台投递、版本防乱序、重试与对账。 */
@Module({
  imports: [
    AuditModule,
    IdempotencyModule,
    TenantContextModule,
    RecruitmentModule,
    BullModule.registerQueue({ name: ESIGN_WEBHOOK_QUEUE }),
    MongooseModule.forFeature([
      { name: OutboxRecord.name, schema: OutboxRecordSchema },
      { name: OrgDeliveryRecord.name, schema: OrgDeliveryRecordSchema },
      { name: OrgExternalVersionState.name, schema: OrgExternalVersionStateSchema },
      { name: OrgPlatformBinding.name, schema: OrgPlatformBindingSchema },
      { name: RecruitmentCalendarBinding.name, schema: RecruitmentCalendarBindingSchema },
      { name: AccessProfile.name, schema: AccessProfileSchema },
      { name: ExternalIdentity.name, schema: ExternalIdentitySchema },
      { name: OrgDepartmentRecord.name, schema: OrgDepartmentRecordSchema },
      { name: OrgEmployeeRecord.name, schema: OrgEmployeeRecordSchema },
      { name: OrgReconciliationReport.name, schema: OrgReconciliationReportSchema },
      {
        name: RecruitmentCalendarDeliveryRecord.name,
        schema: RecruitmentCalendarDeliveryRecordSchema,
      },
      {
        name: OrgEmployeeProvisioningRequest.name,
        schema: OrgEmployeeProvisioningRequestSchema,
      },
      { name: ESignBinding.name, schema: ESignBindingSchema },
      { name: ESignFlowRecord.name, schema: ESignFlowRecordSchema },
      { name: ESignWebhookInboxRecord.name, schema: ESignWebhookInboxRecordSchema },
    ]),
  ],
  providers: [
    OrgOutboxRelayService,
    RecruitmentCalendarOutboxRelayService,
    RecruitmentCalendarDeliveryService,
    OrgDeliveryService,
    OrgDeliveryOperationsService,
    OrgExternalIdentityResolver,
    OrgPlatformCredentialService,
    OrgPlatformTokenService,
    OrgReconciliationService,
    OrgEmployeeProvisioningService,
    OrgProvisioningCryptoService,
    ESignSecretResolver,
    ESignFlowService,
    ESignWebhookCryptoService,
    ESignWebhookService,
    AccessProfileRepository,
    ExternalIdentityRepository,
    EnvironmentOrgSecretResolver,
    { provide: OrgSecretResolver, useExisting: EnvironmentOrgSecretResolver },
    FetchOrgPlatformHttpClient,
    { provide: OrgPlatformHttpClient, useExisting: FetchOrgPlatformHttpClient },
    DingTalkOrgPushAdapter,
    FeishuOrgPushAdapter,
    DingTalkRecruitmentCalendarAdapter,
    FeishuRecruitmentCalendarAdapter,
    { provide: DINGTALK_ORG_PUSH_ADAPTER, useExisting: DingTalkOrgPushAdapter },
    { provide: FEISHU_ORG_PUSH_ADAPTER, useExisting: FeishuOrgPushAdapter },
    {
      provide: DINGTALK_RECRUITMENT_CALENDAR_ADAPTER,
      useExisting: DingTalkRecruitmentCalendarAdapter,
    },
    {
      provide: FEISHU_RECRUITMENT_CALENDAR_ADAPTER,
      useExisting: FeishuRecruitmentCalendarAdapter,
    },
    {
      provide: OrgPushAdapterRegistry,
      inject: [DINGTALK_ORG_PUSH_ADAPTER, FEISHU_ORG_PUSH_ADAPTER],
      useFactory: (dingtalk: OrgPushAdapter, feishu: OrgPushAdapter) =>
        new OrgPushAdapterRegistry(dingtalk, feishu),
    },
    {
      provide: RecruitmentCalendarAdapterRegistry,
      inject: [
        DINGTALK_RECRUITMENT_CALENDAR_ADAPTER,
        FEISHU_RECRUITMENT_CALENDAR_ADAPTER,
      ],
      useFactory: (
        dingtalk: RecruitmentCalendarAdapter,
        feishu: RecruitmentCalendarAdapter,
      ) => new RecruitmentCalendarAdapterRegistry(dingtalk, feishu),
    },
  ],
  controllers: [
    IntegrationController, OrgEmployeeProvisioningController, ESignWebhookController,
  ],
  exports: [
    OrgOutboxRelayService,
    RecruitmentCalendarOutboxRelayService,
    RecruitmentCalendarDeliveryService,
    OrgDeliveryService,
    OrgReconciliationService,
    OrgEmployeeProvisioningService,
    OrgPlatformTokenService,
    OrgPlatformHttpClient,
    ESignWebhookService,
    ESignFlowService,
  ],
})
export class IntegrationModule {}
