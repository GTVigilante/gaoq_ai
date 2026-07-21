import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { IdempotencyModule } from '../../core/idempotency/idempotency.module.js';
import { TenantContextModule } from '../../core/tenant/tenant-context.module.js';
import { OrgModule } from '../org/org.module.js';
import { ApprovalDataCryptoService } from './persistence/approval-data-crypto.service.js';
import {
  ApprovalActionRepository,
  ApprovalDelegationRepository,
  ApprovalInstanceRepository,
  ApprovalTemplateRepository,
} from './persistence/approval.repositories.js';
import {
  ApprovalActionRecord,
  ApprovalActionRecordSchema,
  ApprovalDelegationRecord,
  ApprovalDelegationRecordSchema,
  ApprovalInstanceRecord,
  ApprovalInstanceRecordSchema,
  ApprovalTemplateRecord,
  ApprovalTemplateRecordSchema,
} from './persistence/approval.schemas.js';

/** Phase 2 审批模块：领域状态机、加密持久化、可靠事件和多通道契约的统一边界。 */
@Module({
  imports: [
    IdempotencyModule,
    TenantContextModule,
    OrgModule,
    MongooseModule.forFeature([
      { name: ApprovalTemplateRecord.name, schema: ApprovalTemplateRecordSchema },
      { name: ApprovalInstanceRecord.name, schema: ApprovalInstanceRecordSchema },
      { name: ApprovalActionRecord.name, schema: ApprovalActionRecordSchema },
      { name: ApprovalDelegationRecord.name, schema: ApprovalDelegationRecordSchema },
    ]),
  ],
  providers: [
    ApprovalDataCryptoService,
    ApprovalTemplateRepository,
    ApprovalInstanceRepository,
    ApprovalActionRepository,
    ApprovalDelegationRepository,
  ],
  exports: [
    ApprovalTemplateRepository,
    ApprovalInstanceRepository,
    ApprovalActionRepository,
    ApprovalDelegationRepository,
  ],
})
export class ApprovalModule {}
