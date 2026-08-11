import { Injectable, type OnModuleInit } from '@nestjs/common';

import { SupplierQualificationQueueService } from './supplier-qualification-queue.service.js';

@Injectable()
export class SupplierQualificationScheduleBootstrap implements OnModuleInit {
  constructor(private readonly queue: SupplierQualificationQueueService) {}
  async onModuleInit(): Promise<void> { await this.queue.ensureSchedule(); }
}
