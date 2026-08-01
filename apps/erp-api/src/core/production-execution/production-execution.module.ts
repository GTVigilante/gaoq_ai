import { Module } from '@nestjs/common';

import { ProductionExecutionAuthorizationService } from './production-execution-authorization.service.js';

@Module({
  providers: [ProductionExecutionAuthorizationService],
  exports: [ProductionExecutionAuthorizationService],
})
export class ProductionExecutionModule {}
