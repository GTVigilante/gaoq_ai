import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { IdempotencyModule } from '../../core/idempotency/idempotency.module.js';
import { OrgCoreModule } from '../org/org-core.module.js';
import { OutboxRecord, OutboxRecordSchema } from '../org/persistence/outbox.schema.js';
import { SupplierService } from './application/supplier.service.js';
import { SupplierMemberAuthorizationService } from './application/supplier-member-authorization.service.js';
import { SupplierMemberService } from './application/supplier-member.service.js';
import { SupplierDataCryptoService } from './persistence/supplier-data-crypto.service.js';
import { SupplierOutboxWriter } from './persistence/supplier-outbox.writer.js';
import { SupplierRepository } from './persistence/supplier.repository.js';
import { SupplierMemberOutboxWriter } from './persistence/supplier-member-outbox.writer.js';
import { SupplierMemberRepository } from './persistence/supplier-member.repository.js';
import { SupplierMemberRecord, SupplierMemberSchema } from './persistence/supplier-member.schema.js';
import { SupplierRelationshipRecord, SupplierRelationshipRecordSchema } from './persistence/supplier.schemas.js';
import { SupplierController } from './supplier.controller.js';
import { SupplierMemberController } from './supplier-member.controller.js';
import { SupplierSelfController } from './supplier-self.controller.js';

@Module({
  imports: [IdempotencyModule, OrgCoreModule, MongooseModule.forFeature([
    { name: SupplierRelationshipRecord.name, schema: SupplierRelationshipRecordSchema },
    { name: SupplierMemberRecord.name, schema: SupplierMemberSchema },
    { name: OutboxRecord.name, schema: OutboxRecordSchema },
  ])],
  controllers: [SupplierController, SupplierMemberController, SupplierSelfController],
  providers: [
    SupplierService, SupplierRepository, SupplierDataCryptoService, SupplierOutboxWriter,
    SupplierMemberService, SupplierMemberAuthorizationService, SupplierMemberRepository,
    SupplierMemberOutboxWriter,
  ],
  exports: [SupplierService, SupplierMemberAuthorizationService],
})
export class SupplierModule {}
