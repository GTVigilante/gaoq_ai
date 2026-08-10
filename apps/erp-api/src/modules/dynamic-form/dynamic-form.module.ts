import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { IdempotencyModule } from '../../core/idempotency/idempotency.module.js';
import { TenantContextModule } from '../../core/tenant/tenant-context.module.js';
import { OutboxRecord, OutboxRecordSchema } from '../org/persistence/outbox.schema.js';
import { ApprovalCoreModule } from '../approval/approval-core.module.js';
import { OpCoreModule } from '../op/op-core.module.js';
import { DynamicFormService } from './application/dynamic-form.service.js';
import { DynamicFormApprovalBridgeService } from './application/dynamic-form-approval-bridge.service.js';
import { MultidimensionalBaseService } from './application/multidimensional-base.service.js';
import { DatasetRuntimeController } from './dataset-runtime.controller.js';
import { DynamicFormController } from './dynamic-form.controller.js';
import { MultidimensionalBaseController } from './multidimensional-base.controller.js';
import { DynamicFormDataCryptoService } from './persistence/dynamic-form-data-crypto.service.js';
import { DynamicFormRepository } from './persistence/dynamic-form.repository.js';
import { DynamicFormOutboxWriter } from './persistence/dynamic-form-outbox.writer.js';
import { MultidimensionalBaseRepository } from './persistence/multidimensional-base.repository.js';
import { MultidimensionalBaseRecord, MultidimensionalBaseRecordSchema } from './persistence/multidimensional-base.schema.js';
import { BaseAutomationRunRecord, BaseAutomationRunRecordSchema } from './persistence/base-automation-run.schema.js';
import { BaseAutomationRunRepository } from './persistence/base-automation-run.repository.js';
import { BaseAutomationSchedulerService } from './application/base-automation-scheduler.service.js';
import { DynamicFormDataRecord, DynamicFormDataRecordSchema, DynamicFormDefinitionRecord, DynamicFormDefinitionRecordSchema, DynamicFormRelationRecord, DynamicFormRelationRecordSchema } from './persistence/dynamic-form.schemas.js';
import { DatasetRuntimeService } from './runtime/dataset-runtime.service.js';
import { ExternalDatasetReferenceService } from './runtime/external-dataset-reference.service.js';
import { NativeDynamicFormDatasetAdapter } from './runtime/native-dynamic-form-dataset.adapter.js';
import { OpOperatingSummaryDatasetAdapter } from './runtime/op-operating-summary-dataset.adapter.js';

/** 动态表单 Module：定义、加密记录与关系索引共用单一事务边界。 */
@Module({
  imports: [IdempotencyModule, TenantContextModule, ApprovalCoreModule, OpCoreModule, MongooseModule.forFeature([
    { name: DynamicFormDefinitionRecord.name, schema: DynamicFormDefinitionRecordSchema },
    { name: DynamicFormDataRecord.name, schema: DynamicFormDataRecordSchema },
    { name: DynamicFormRelationRecord.name, schema: DynamicFormRelationRecordSchema },
    { name: OutboxRecord.name, schema: OutboxRecordSchema },
    { name: MultidimensionalBaseRecord.name, schema: MultidimensionalBaseRecordSchema },
    { name: BaseAutomationRunRecord.name, schema: BaseAutomationRunRecordSchema },
  ])],
  controllers: [DynamicFormController, MultidimensionalBaseController, DatasetRuntimeController],
  providers: [
    DynamicFormDataCryptoService, DynamicFormRepository, DynamicFormOutboxWriter,
    DynamicFormService, DynamicFormApprovalBridgeService, MultidimensionalBaseRepository, MultidimensionalBaseService,
    BaseAutomationRunRepository, BaseAutomationSchedulerService,
    NativeDynamicFormDatasetAdapter, OpOperatingSummaryDatasetAdapter,
    DatasetRuntimeService, ExternalDatasetReferenceService,
  ],
  exports: [DynamicFormService, DynamicFormApprovalBridgeService, MultidimensionalBaseService, DatasetRuntimeService, BaseAutomationRunRepository],
})
export class DynamicFormModule {}
