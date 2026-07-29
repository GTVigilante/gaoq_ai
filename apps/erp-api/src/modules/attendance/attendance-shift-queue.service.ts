import { createHash } from 'node:crypto';

import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Queue } from 'bullmq';
import type { Model } from 'mongoose';

import {
  ATTENDANCE_SHIFT_EVALUATE_JOB,
  ATTENDANCE_SHIFT_QUEUE,
  type AttendanceShiftJobData,
} from './attendance-shift.queue.js';
import {
  AttendanceShiftPlanRecord,
  type AttendanceShiftPlanDocument,
} from './persistence/attendance.schemas.js';

@Injectable()
export class AttendanceShiftQueueService {
  constructor(
    @InjectModel(AttendanceShiftPlanRecord.name)
    private readonly plans: Model<AttendanceShiftPlanDocument>,
    @InjectQueue(ATTENDANCE_SHIFT_QUEUE)
    private readonly queue: Queue<AttendanceShiftJobData>,
  ) {}

  async enqueueDue(limit = 200): Promise<number> {
    const due = await this.plans.find({
      evaluationStatus: 'pending',
      evaluationDueAt: { $lte: new Date() },
    }, {
      tenantId: 1,
      id: 1,
      evaluationDueAt: 1,
      _id: 0,
    }).sort({ evaluationDueAt: 1, id: 1 }).limit(limit).lean().exec();
    for (const plan of due) {
      const jobId = createHash('sha256').update(JSON.stringify([
        'attendance-shift-evaluate-v1',
        plan.tenantId,
        plan.id,
      ]), 'utf8').digest('base64url');
      const existing = await this.queue.getJob(jobId);
      if (existing !== undefined) {
        if (await existing.getState() === 'failed') await existing.retry();
        continue;
      }
      await this.queue.add(
        ATTENDANCE_SHIFT_EVALUATE_JOB,
        { tenantId: plan.tenantId, shiftPlanId: plan.id },
        {
          jobId,
          attempts: 12,
          backoff: { type: 'exponential', delay: 5_000 },
          removeOnComplete: 1_000,
          removeOnFail: 10_000,
        },
      );
    }
    return due.length;
  }
}
