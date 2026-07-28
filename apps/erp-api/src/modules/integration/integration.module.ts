import { Module } from '@nestjs/common';

import { ESignWebhookController } from './esign-webhook.controller.js';
import { IntegrationCoreModule } from './integration-core.module.js';
import { IntegrationController } from './integration.controller.js';
import { OrgEmployeeProvisioningController } from './org-employee-provisioning.controller.js';
import { PayrollMasterDataSnapshotController } from './payroll-master-data-snapshot.controller.js';
import { AttendanceProviderCoverageController } from './attendance-provider-coverage.controller.js';
import {
  RecruitmentCalendarOperationsController,
} from './recruitment-calendar-operations.controller.js';

/** 集成 HTTP/Webhook 外壳；后台消费者只导入 IntegrationCoreModule。 */
@Module({
  imports: [IntegrationCoreModule],
  controllers: [
    IntegrationController,
    OrgEmployeeProvisioningController,
    ESignWebhookController,
    PayrollMasterDataSnapshotController,
    AttendanceProviderCoverageController,
    RecruitmentCalendarOperationsController,
  ],
  exports: [IntegrationCoreModule],
})
export class IntegrationModule {}
