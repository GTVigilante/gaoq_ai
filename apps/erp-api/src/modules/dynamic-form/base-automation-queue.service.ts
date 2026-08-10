import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';

import {
  BASE_AUTOMATION_EXECUTE_JOB, BASE_AUTOMATION_QUEUE, BASE_AUTOMATION_RELAY_JOB,
  baseAutomationJobId, type BaseAutomationJobData,
} from './base-automation.queue.js';

@Injectable()
export class BaseAutomationQueueService {
  constructor(@InjectQueue(BASE_AUTOMATION_QUEUE) private readonly queue: Queue<BaseAutomationJobData>) {}

  async ensureRelaySchedule(): Promise<void> {
    await this.queue.add(BASE_AUTOMATION_RELAY_JOB, {}, {
      jobId: 'base-automation-relay-v1', repeat: { every: 30_000 },
      removeOnComplete: 100, removeOnFail: 1_000,
    });
  }

  async enqueue(tenantId: string, runId: string): Promise<void> {
    await this.queue.add(BASE_AUTOMATION_EXECUTE_JOB, { tenantId, runId }, {
      jobId: baseAutomationJobId(tenantId, runId), attempts: 8,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: 1_000, removeOnFail: 10_000,
    });
  }
}
