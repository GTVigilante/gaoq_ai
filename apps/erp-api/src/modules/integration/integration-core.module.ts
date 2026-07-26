import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { MongooseModule } from '@nestjs/mongoose';

import { AuditModule } from '../../core/audit/audit.module.js';
import { IdempotencyModule } from '../../core/idempotency/idempotency.module.js';
import { TenantContextModule } from '../../core/tenant/tenant-context.module.js';
import { AccessProfileRepository } from '../identity/access-profile.repository.js';
import { AttendanceCoreModule } from '../attendance/attendance-core.module.js';
import { AccessProfile, AccessProfileSchema } from '../identity/access-profile.schema.js';
import { ExternalIdentityRepository } from '../identity/external-identity.repository.js';
import {
  ExternalIdentity,
  ExternalIdentitySchema,
} from '../identity/external-identity.schema.js';
import { OutboxRecord, OutboxRecordSchema } from '../org/persistence/outbox.schema.js';
import { RecruitmentCoreModule } from '../recruitment/recruitment-core.module.js';
import { OrgCoreModule } from '../org/org-core.module.js';
import {
  OrgDepartmentRecord,
  OrgDepartmentRecordSchema,
  OrgEmployeeRecord,
  OrgEmployeeRecordSchema,
} from '../org/persistence/org.schemas.js';
import { DingTalkOrgPushAdapter } from './dingtalk-org-push.adapter.js';
import { FeishuOrgPushAdapter } from './feishu-org-push.adapter.js';
import { OpOrgPushAdapter } from './op-org-push.adapter.js';
import { FetchOpOrgHttpClient, OpOrgHttpClient } from './op-org-http.client.js';
import { ESignBinding, ESignBindingSchema } from './esign-binding.schema.js';
import { ESignAdapter, ESignCnAdapter } from './esign.adapter.js';
import {
  ESignEvidenceRecord,
  ESignEvidenceRecordSchema,
} from './esign-evidence.schema.js';
import { ESignEvidenceService } from './esign-evidence.service.js';
import {
  ESignImmutableArchive,
  ESignMalwareScanner,
} from './esign-evidence.ports.js';
import {
  HttpESignImmutableArchive,
  HttpESignMalwareScanner,
} from './esign-evidence-http.adapters.js';
import { ESignFlowRecord, ESignFlowRecordSchema } from './esign-flow.schema.js';
import { ESignFlowService } from './esign-flow.service.js';
import { ESignHttpClient, FetchESignHttpClient } from './esign-http.client.js';
import { ESignReconciliationService } from './esign-reconciliation.service.js';
import { ESignWebhookCryptoService } from './esign-webhook-crypto.service.js';
import {
  ESignWebhookInboxRecord,
  ESignWebhookInboxRecordSchema,
} from './esign-webhook-inbox.schema.js';
import { ESIGN_WEBHOOK_QUEUE } from './esign-webhook.queue.js';
import { ESignSecretResolver, ESignWebhookService } from './esign-webhook.service.js';
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
  OP_ORG_PUSH_ADAPTER,
  OrgPushAdapter,
  OrgPushAdapterRegistry,
} from './org-push.adapter.js';
import {
  RECRUITMENT_CHANNEL_ADAPTERS,
  RECRUITMENT_CHANNEL_EVIDENCE_VERIFIERS,
  RECRUITMENT_CHANNEL_NORMALIZERS,
  RecruitmentChannelRegistry,
  type RecruitmentChannelAdapter,
  type RecruitmentChannelEvidenceVerifier,
  type RecruitmentChannelNormalizer,
} from './recruitment-channel.adapter.js';
import {
  RecruitmentChannelPullService,
  RecruitmentChannelSecretResolver,
} from './recruitment-channel-pull.service.js';
import { RECRUITMENT_CHANNEL_QUEUE } from './recruitment-channel.queue.js';
import {
  RecruitmentChannelBindingRecord,
  RecruitmentChannelBindingRecordSchema,
  RecruitmentChannelInboxRecord,
  RecruitmentChannelInboxRecordSchema,
  RecruitmentExternalMappingRecord,
  RecruitmentExternalMappingRecordSchema,
  RecruitmentChannelPositionDeliveryRecord,
  RecruitmentChannelPositionDeliveryRecordSchema,
  RecruitmentChannelStageDeliveryRecord,
  RecruitmentChannelStageDeliveryRecordSchema,
} from './recruitment-channel.schemas.js';
import { RecruitmentChannelPositionRelayService } from './recruitment-channel-position-relay.service.js';
import { RecruitmentChannelPositionDeliveryService } from './recruitment-channel-position-delivery.service.js';
import { RecruitmentChannelStageRelayService } from './recruitment-channel-stage-relay.service.js';
import { RecruitmentChannelStageDeliveryService } from './recruitment-channel-stage-delivery.service.js';
import {
  AttendanceProviderRegistry,
  DingTalkAttendanceProvider,
  FeishuAttendanceProvider,
} from './attendance-provider.adapter.js';
import { AttendanceProviderPullService } from './attendance-provider-pull.service.js';
import { AttendanceProviderMappingRepository } from './attendance-provider-mapping.repository.js';
import { ATTENDANCE_PROVIDER_QUEUE } from './attendance-provider.queue.js';
import {
  AttendanceProviderEmployeeMappingRecord,
  AttendanceProviderEmployeeMappingRecordSchema,
  AttendanceProviderInboxRecord,
  AttendanceProviderInboxRecordSchema,
  AttendanceProviderStateRecord,
  AttendanceProviderStateRecordSchema,
} from './attendance-provider.schemas.js';
import { PayrollMasterDataSnapshotService } from './payroll-master-data-snapshot.service.js';

/** 外部集成底座：Outbox 多渠道扇出、版本防乱序、重试与对账。 */
@Module({
  imports: [
    AuditModule,
    IdempotencyModule,
    TenantContextModule,
    AttendanceCoreModule,
    RecruitmentCoreModule,
    OrgCoreModule,
    BullModule.registerQueue({ name: ESIGN_WEBHOOK_QUEUE }),
    BullModule.registerQueue({ name: RECRUITMENT_CHANNEL_QUEUE }),
    BullModule.registerQueue({ name: ATTENDANCE_PROVIDER_QUEUE }),
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
      { name: ESignEvidenceRecord.name, schema: ESignEvidenceRecordSchema },
      { name: ESignFlowRecord.name, schema: ESignFlowRecordSchema },
      { name: ESignWebhookInboxRecord.name, schema: ESignWebhookInboxRecordSchema },
      {
        name: RecruitmentChannelBindingRecord.name,
        schema: RecruitmentChannelBindingRecordSchema,
      },
      {
        name: RecruitmentChannelInboxRecord.name,
        schema: RecruitmentChannelInboxRecordSchema,
      },
      {
        name: RecruitmentExternalMappingRecord.name,
        schema: RecruitmentExternalMappingRecordSchema,
      },
      {
        name: RecruitmentChannelPositionDeliveryRecord.name,
        schema: RecruitmentChannelPositionDeliveryRecordSchema,
      },
      {
        name: RecruitmentChannelStageDeliveryRecord.name,
        schema: RecruitmentChannelStageDeliveryRecordSchema,
      },
      { name: AttendanceProviderStateRecord.name, schema: AttendanceProviderStateRecordSchema },
      {
        name: AttendanceProviderEmployeeMappingRecord.name,
        schema: AttendanceProviderEmployeeMappingRecordSchema,
      },
      { name: AttendanceProviderInboxRecord.name, schema: AttendanceProviderInboxRecordSchema },
    ]),
  ],
  providers: [
    PayrollMasterDataSnapshotService,
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
    ESignEvidenceService,
    ESignReconciliationService,
    ESignWebhookCryptoService,
    ESignWebhookService,
    RecruitmentChannelPullService,
    RecruitmentChannelSecretResolver,
    RecruitmentChannelPositionRelayService,
    RecruitmentChannelPositionDeliveryService,
    RecruitmentChannelStageRelayService,
    RecruitmentChannelStageDeliveryService,
    AttendanceProviderPullService,
    AttendanceProviderMappingRepository,
    ESignCnAdapter,
    { provide: ESignAdapter, useExisting: ESignCnAdapter },
    FetchESignHttpClient,
    { provide: ESignHttpClient, useExisting: FetchESignHttpClient },
    HttpESignMalwareScanner,
    { provide: ESignMalwareScanner, useExisting: HttpESignMalwareScanner },
    HttpESignImmutableArchive,
    { provide: ESignImmutableArchive, useExisting: HttpESignImmutableArchive },
    AccessProfileRepository,
    ExternalIdentityRepository,
    EnvironmentOrgSecretResolver,
    { provide: OrgSecretResolver, useExisting: EnvironmentOrgSecretResolver },
    FetchOrgPlatformHttpClient,
    { provide: OrgPlatformHttpClient, useExisting: FetchOrgPlatformHttpClient },
    FetchOpOrgHttpClient,
    { provide: OpOrgHttpClient, useExisting: FetchOpOrgHttpClient },
    DingTalkOrgPushAdapter,
    FeishuOrgPushAdapter,
    OpOrgPushAdapter,
    DingTalkRecruitmentCalendarAdapter,
    FeishuRecruitmentCalendarAdapter,
    DingTalkAttendanceProvider,
    FeishuAttendanceProvider,
    { provide: DINGTALK_ORG_PUSH_ADAPTER, useExisting: DingTalkOrgPushAdapter },
    { provide: FEISHU_ORG_PUSH_ADAPTER, useExisting: FeishuOrgPushAdapter },
    { provide: OP_ORG_PUSH_ADAPTER, useExisting: OpOrgPushAdapter },
    { provide: RECRUITMENT_CHANNEL_ADAPTERS, useValue: [] },
    { provide: RECRUITMENT_CHANNEL_NORMALIZERS, useValue: [] },
    { provide: RECRUITMENT_CHANNEL_EVIDENCE_VERIFIERS, useValue: [] },
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
      inject: [DINGTALK_ORG_PUSH_ADAPTER, FEISHU_ORG_PUSH_ADAPTER, OP_ORG_PUSH_ADAPTER],
      useFactory: (dingtalk: OrgPushAdapter, feishu: OrgPushAdapter, op: OrgPushAdapter) =>
        new OrgPushAdapterRegistry(dingtalk, feishu, op),
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
    {
      provide: RecruitmentChannelRegistry,
      inject: [
        RECRUITMENT_CHANNEL_ADAPTERS,
        RECRUITMENT_CHANNEL_NORMALIZERS,
        RECRUITMENT_CHANNEL_EVIDENCE_VERIFIERS,
      ],
      useFactory: (
        adapters: readonly RecruitmentChannelAdapter[],
        normalizers: readonly RecruitmentChannelNormalizer[],
        verifiers: readonly RecruitmentChannelEvidenceVerifier[],
      ) => new RecruitmentChannelRegistry(adapters, normalizers, verifiers),
    },
    {
      provide: AttendanceProviderRegistry,
      inject: [DingTalkAttendanceProvider, FeishuAttendanceProvider],
      useFactory: (
        dingtalk: DingTalkAttendanceProvider,
        feishu: FeishuAttendanceProvider,
      ) => new AttendanceProviderRegistry(
        [dingtalk, feishu], [dingtalk, feishu], [dingtalk, feishu],
      ),
    },
  ],
  exports: [
    PayrollMasterDataSnapshotService,
    MongooseModule,
    OrgOutboxRelayService,
    RecruitmentCalendarOutboxRelayService,
    RecruitmentCalendarDeliveryService,
    OrgDeliveryService,
    OrgDeliveryOperationsService,
    OrgReconciliationService,
    OrgEmployeeProvisioningService,
    OrgPlatformTokenService,
    OrgPlatformHttpClient,
    ESignWebhookService,
    ESignWebhookCryptoService,
    ESignFlowService,
    ESignEvidenceService,
    ESignReconciliationService,
    ESignAdapter,
    RecruitmentChannelPullService,
    RecruitmentChannelSecretResolver,
    RecruitmentChannelRegistry,
    RecruitmentChannelPositionRelayService,
    RecruitmentChannelPositionDeliveryService,
    RecruitmentChannelStageRelayService,
    RecruitmentChannelStageDeliveryService,
    AttendanceProviderPullService,
    AttendanceProviderRegistry,
  ],
})
export class IntegrationCoreModule {}
