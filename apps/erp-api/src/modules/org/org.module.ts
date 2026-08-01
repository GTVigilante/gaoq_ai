import { Module } from '@nestjs/common';

import { OrgCoreModule } from './org-core.module.js';
import { OrgController } from './org.controller.js';
import { OrgPersonBirthdayController } from './org-person-birthday.controller.js';

/** 组织 REST 外壳；领域服务与仓储由 OrgCoreModule 统一提供。 */
@Module({
  imports: [OrgCoreModule],
  controllers: [OrgController, OrgPersonBirthdayController],
  exports: [OrgCoreModule],
})
export class OrgModule {}
