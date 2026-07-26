import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { IdentityModule } from '../identity/identity.module.js';
import { MasterDataController } from './master-data.controller.js';
import {
  MasterDataInboxRecord,
  MasterDataInboxSchema,
  MasterDataProjectionRecord,
  MasterDataProjectionSchema,
} from './master-data.schemas.js';
import { MasterDataService } from './master-data.service.js';

@Module({
  imports: [
    IdentityModule,
    MongooseModule.forFeature([
      { name: MasterDataProjectionRecord.name, schema: MasterDataProjectionSchema },
      { name: MasterDataInboxRecord.name, schema: MasterDataInboxSchema },
    ]),
  ],
  controllers: [MasterDataController],
  providers: [MasterDataService],
  exports: [MongooseModule],
})
export class MasterDataModule {}
