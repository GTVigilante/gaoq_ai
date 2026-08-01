import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { IdempotencyRecord, IdempotencyRecordSchema } from './idempotency.schema.js';
import { IdempotencyService } from './idempotency.service.js';

/** 为所有写接口提供租户隔离、事务一致的统一幂等能力。 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: IdempotencyRecord.name, schema: IdempotencyRecordSchema },
    ]),
  ],
  providers: [IdempotencyService],
  exports: [IdempotencyService],
})
export class IdempotencyModule {}
