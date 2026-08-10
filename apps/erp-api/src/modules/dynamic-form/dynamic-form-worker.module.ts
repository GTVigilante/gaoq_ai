import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { AuditModule } from '../../core/audit/audit.module.js';
import { BASE_AUTOMATION_QUEUE } from './base-automation.queue.js';
import { BaseAutomationProcessor } from './base-automation.processor.js';
import { BaseAutomationQueueService } from './base-automation-queue.service.js';
import { BaseAutomationScheduleBootstrap } from './base-automation-schedule.bootstrap.js';
import { DynamicFormModule } from './dynamic-form.module.js';

@Module({
  imports: [AuditModule, DynamicFormModule, BullModule.registerQueue({ name: BASE_AUTOMATION_QUEUE })],
  providers: [BaseAutomationQueueService, BaseAutomationScheduleBootstrap, BaseAutomationProcessor],
})
export class DynamicFormWorkerModule {}
