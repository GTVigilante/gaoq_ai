import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { IdentityModule } from '../identity/identity.module.js';
import { PayrollDataCryptoService } from './payroll-data-crypto.service.js';
import { MasterDataModule } from '../master-data/master-data.module.js';
import { PayrollApplicationService } from './payroll-application.service.js';
import { PayrollController } from './payroll.controller.js';
import {
  PayrollCompensationProfileRecord,
  PayrollCompensationProfileSchema,
  PayrollResultRecord,
  PayrollResultSchema,
  PayrollRunRecord,
  PayrollRunSchema,
} from './payroll.schemas.js';

@Module({
  imports: [
    IdentityModule,
    MasterDataModule,
    MongooseModule.forFeature([
      {
        name: PayrollCompensationProfileRecord.name,
        schema: PayrollCompensationProfileSchema,
      },
      { name: PayrollRunRecord.name, schema: PayrollRunSchema },
      { name: PayrollResultRecord.name, schema: PayrollResultSchema },
    ]),
  ],
  controllers: [PayrollController],
  providers: [PayrollDataCryptoService, PayrollApplicationService],
  exports: [PayrollApplicationService, PayrollDataCryptoService, MongooseModule],
})
export class PayrollModule {}
