import { Module } from '@nestjs/common';
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
import {
  OrgDepartmentRecord,
  OrgDepartmentRecordSchema,
  OrgEmployeeRecord,
  OrgEmployeeRecordSchema,
} from '../org/persistence/org.schemas.js';
import { DingTalkOrgPushAdapter } from './dingtalk-org-push.adapter.js';
import { FeishuOrgPushAdapter } from './feishu-org-push.adapter.js';
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
    MongooseModule.forFeature([
      { name: OutboxRecord.name, schema: OutboxRecordSchema },
      { name: OrgDeliveryRecord.name, schema: OrgDeliveryRecordSchema },
      { name: OrgExternalVersionState.name, schema: OrgExternalVersionStateSchema },
      { name: OrgPlatformBinding.name, schema: OrgPlatformBindingSchema },
      { name: AccessProfile.name, schema: AccessProfileSchema },
      { name: ExternalIdentity.name, schema: ExternalIdentitySchema },
      { name: OrgDepartmentRecord.name, schema: OrgDepartmentRecordSchema },
      { name: OrgEmployeeRecord.name, schema: OrgEmployeeRecordSchema },
      { name: OrgReconciliationReport.name, schema: OrgReconciliationReportSchema },
      {
        name: OrgEmployeeProvisioningRequest.name,
        schema: OrgEmployeeProvisioningRequestSchema,
      },
    ]),
  ],
  providers: [
    OrgOutboxRelayService,
    OrgDeliveryService,
    OrgDeliveryOperationsService,
    OrgExternalIdentityResolver,
    OrgPlatformCredentialService,
    OrgPlatformTokenService,
    OrgReconciliationService,
    OrgEmployeeProvisioningService,
    OrgProvisioningCryptoService,
    AccessProfileRepository,
    ExternalIdentityRepository,
    EnvironmentOrgSecretResolver,
    { provide: OrgSecretResolver, useExisting: EnvironmentOrgSecretResolver },
    FetchOrgPlatformHttpClient,
    { provide: OrgPlatformHttpClient, useExisting: FetchOrgPlatformHttpClient },
    DingTalkOrgPushAdapter,
    FeishuOrgPushAdapter,
    { provide: DINGTALK_ORG_PUSH_ADAPTER, useExisting: DingTalkOrgPushAdapter },
    { provide: FEISHU_ORG_PUSH_ADAPTER, useExisting: FeishuOrgPushAdapter },
    {
      provide: OrgPushAdapterRegistry,
      inject: [DINGTALK_ORG_PUSH_ADAPTER, FEISHU_ORG_PUSH_ADAPTER],
      useFactory: (dingtalk: OrgPushAdapter, feishu: OrgPushAdapter) =>
        new OrgPushAdapterRegistry(dingtalk, feishu),
    },
  ],
  controllers: [IntegrationController, OrgEmployeeProvisioningController],
  exports: [
    OrgOutboxRelayService,
    OrgDeliveryService,
    OrgReconciliationService,
    OrgEmployeeProvisioningService,
  ],
})
export class IntegrationModule {}
