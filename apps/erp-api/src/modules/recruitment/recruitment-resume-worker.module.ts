import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { AuditModule } from '../../core/audit/audit.module.js';
import { RecruitmentCoreModule } from './recruitment-core.module.js';
import { RecruitmentResumeProcessor } from './recruitment-resume.processor.js';
import { RECRUITMENT_RESUME_QUEUE } from './recruitment-resume.queue.js';

/** Worker 仅装配简历分析核心服务与队列消费者，不引入招聘 HTTP Controller。 */
@Module({
  imports: [
    AuditModule,
    RecruitmentCoreModule,
    BullModule.registerQueue({ name: RECRUITMENT_RESUME_QUEUE }),
  ],
  providers: [RecruitmentResumeProcessor],
})
export class RecruitmentResumeWorkerModule {}
