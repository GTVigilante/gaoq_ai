import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { CareExecutionProcessor } from './care-execution.processor.js';
import { CARE_EXECUTION_QUEUE } from './care-execution.queue.js';
import { CareCoreModule } from './care-core.module.js';
import { AuditModule } from '../../core/audit/audit.module.js';

@Module({
  imports: [AuditModule, CareCoreModule, BullModule.registerQueue({ name: CARE_EXECUTION_QUEUE })],
  providers: [CareExecutionProcessor],
})
export class CareWorkerModule {}
