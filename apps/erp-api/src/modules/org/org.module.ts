import { Module } from '@nestjs/common';

import { OrgCoreModule } from './org-core.module.js';
import { OrgController } from './org.controller.js';

/** 组织 REST 外壳；领域服务与仓储由 OrgCoreModule 统一提供。 */
@Module({
  imports: [OrgCoreModule],
  controllers: [OrgController],
  exports: [OrgCoreModule],
})
export class OrgModule {}
