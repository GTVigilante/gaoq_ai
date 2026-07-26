import { Module } from '@nestjs/common';

import { RecruitmentInterviewController } from './recruitment-interview.controller.js';
import { RecruitmentManagementController } from './recruitment-management.controller.js';
import { RecruitmentOfferController } from './recruitment-offer.controller.js';
import { RecruitmentPortalController } from './recruitment-portal.controller.js';
import { RecruitmentController } from './recruitment.controller.js';
import { RecruitmentResumeController } from './recruitment-resume.controller.js';
import { RecruitmentCoreModule } from './recruitment-core.module.js';

/** 招聘 HTTP 外壳；渠道 Worker 复用无 Controller 的核心服务。 */
@Module({
  imports: [RecruitmentCoreModule],
  controllers: [
    RecruitmentController,
    RecruitmentManagementController,
    RecruitmentInterviewController,
    RecruitmentOfferController,
    RecruitmentPortalController,
    RecruitmentResumeController,
  ],
  exports: [RecruitmentCoreModule],
})
export class RecruitmentModule {}
