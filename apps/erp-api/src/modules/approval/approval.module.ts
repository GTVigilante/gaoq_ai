import { Module } from '@nestjs/common';

import { AuditModule } from '../../core/audit/audit.module.js';
import { ApprovalNotificationOperationsController } from './approval-notification-operations.controller.js';
import { ApprovalController } from './approval.controller.js';
import { ApprovalCoreModule } from './approval-core.module.js';

/** 审批 HTTP 外壳；后台任务复用无 Controller 的 ApprovalCoreModule。 */
@Module({
  imports: [ApprovalCoreModule, AuditModule],
  controllers: [ApprovalController, ApprovalNotificationOperationsController],
  exports: [ApprovalCoreModule],
})
export class ApprovalModule {}
