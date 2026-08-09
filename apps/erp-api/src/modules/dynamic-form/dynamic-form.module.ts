import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { IdempotencyModule } from '../../core/idempotency/idempotency.module.js';
import { TenantContextModule } from '../../core/tenant/tenant-context.module.js';
import { OutboxRecord, OutboxRecordSchema } from '../org/persistence/outbox.schema.js';
import { DynamicFormService } from './application/dynamic-form.service.js';
import { MultidimensionalBaseService } from './application/multidimensional-base.service.js';
import { DynamicFormController } from './dynamic-form.controller.js';
import { MultidimensionalBaseController } from './multidimensional-base.controller.js';
import { DynamicFormDataCryptoService } from './persistence/dynamic-form-data-crypto.service.js';
import { DynamicFormRepository } from './persistence/dynamic-form.repository.js';
import { DynamicFormOutboxWriter } from './persistence/dynamic-form-outbox.writer.js';
import { MultidimensionalBaseRepository } from './persistence/multidimensional-base.repository.js';
import { MultidimensionalBaseRecord, MultidimensionalBaseRecordSchema } from './persistence/multidimensional-base.schema.js';
import { DynamicFormDataRecord, DynamicFormDataRecordSchema, DynamicFormDefinitionRecord, DynamicFormDefinitionRecordSchema, DynamicFormRelationRecord, DynamicFormRelationRecordSchema } from './persistence/dynamic-form.schemas.js';

/** 动态表单 Module：定义、加密记录与关系索引共用单一事务边界。 */
@Module({
  imports: [IdempotencyModule, TenantContextModule, MongooseModule.forFeature([
    { name: DynamicFormDefinitionRecord.name, schema: DynamicFormDefinitionRecordSchema },
    { name: DynamicFormDataRecord.name, schema: DynamicFormDataRecordSchema },
    { name: DynamicFormRelationRecord.name, schema: DynamicFormRelationRecordSchema },
    { name: OutboxRecord.name, schema: OutboxRecordSchema },
    { name: MultidimensionalBaseRecord.name, schema: MultidimensionalBaseRecordSchema },
  ])],
  controllers: [DynamicFormController, MultidimensionalBaseController],
  providers: [DynamicFormDataCryptoService, DynamicFormRepository, DynamicFormOutboxWriter, DynamicFormService, MultidimensionalBaseRepository, MultidimensionalBaseService],
  exports: [DynamicFormService, MultidimensionalBaseService],
})
export class DynamicFormModule {}
