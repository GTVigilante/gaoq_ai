import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import type { Queue } from 'bullmq';

import {
  RECRUITMENT_CHANNEL_QUEUE,
  RECRUITMENT_CHANNEL_SCAN_JOB,
  RECRUITMENT_CHANNEL_RELAY_POSITIONS_JOB,
  RECRUITMENT_CHANNEL_DELIVER_POSITIONS_JOB,
  RECRUITMENT_CHANNEL_RELAY_STAGES_JOB,
  RECRUITMENT_CHANNEL_DELIVER_STAGES_JOB,
  type RecruitmentChannelJobData,
} from './recruitment-channel.queue.js';

const SCAN_EVERY_MS = 60 * 1_000;

/** 多 Worker 幂等注册渠道扫描器，扫描器再为每个租户绑定创建独立任务。 */
@Injectable()
export class RecruitmentChannelScheduler implements OnApplicationBootstrap {
  constructor(
    @InjectQueue(RECRUITMENT_CHANNEL_QUEUE)
    private readonly queue: Queue<RecruitmentChannelJobData>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    for (const name of [
      RECRUITMENT_CHANNEL_SCAN_JOB,
      RECRUITMENT_CHANNEL_RELAY_POSITIONS_JOB,
      RECRUITMENT_CHANNEL_DELIVER_POSITIONS_JOB,
      RECRUITMENT_CHANNEL_RELAY_STAGES_JOB,
      RECRUITMENT_CHANNEL_DELIVER_STAGES_JOB,
    ]) await this.queue.upsertJobScheduler(
      `recruitment-channel:${name}`,
      { every: name === RECRUITMENT_CHANNEL_SCAN_JOB ? SCAN_EVERY_MS : 1_000 },
      { name, data: {}, opts: { removeOnComplete: 100, removeOnFail: 1_000 } },
    );
  }
}
