import { Module } from '@nestjs/common';

import { RecruitmentInterviewController } from './recruitment-interview.controller.js';
import { RecruitmentManagementController } from './recruitment-management.controller.js';
import { RecruitmentOfferController } from './recruitment-offer.controller.js';
import { RecruitmentController } from './recruitment.controller.js';
import { RecruitmentCoreModule } from './recruitment-core.module.js';

/** 招聘 HTTP 外壳；渠道 Worker 复用无 Controller 的核心服务。 */
@Module({
  imports: [RecruitmentCoreModule],
  controllers: [
    RecruitmentController,
    RecruitmentManagementController,
    RecruitmentInterviewController,
    RecruitmentOfferController,
  ],
  exports: [RecruitmentCoreModule],
})
export class RecruitmentModule {}
