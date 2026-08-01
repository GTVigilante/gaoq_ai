import { Module } from '@nestjs/common';

import { CareController } from './care.controller.js';
import { CareCoreModule } from './care-core.module.js';
import { CareOccasionController } from './care-occasion.controller.js';

/** 关怀 HTTP 外壳；执行 Worker 只复用领域核心。 */
@Module({
  imports: [CareCoreModule],
  controllers: [CareController, CareOccasionController],
  exports: [CareCoreModule],
})
export class CareModule {}
