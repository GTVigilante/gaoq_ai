import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { MongooseModule } from '@nestjs/mongoose';

import { validateEnvironment, type AppEnvironment } from './config/environment.js';
import { HealthController } from './health.controller.js';
import { BearerAuthGuard } from './identity/bearer-auth.guard.js';
import { IdentityModule } from './identity/identity.module.js';
import { MasterDataModule } from './master-data/master-data.module.js';
import { PayrollModule } from './payroll/payroll.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnvironment,
    }),
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppEnvironment, true>) => ({
        uri: config.get('MONGODB_URI', { infer: true }),
        autoIndex: config.get('NODE_ENV', { infer: true }) !== 'production',
      }),
    }),
    IdentityModule,
    MasterDataModule,
    PayrollModule,
  ],
  controllers: [HealthController],
  providers: [
    {
      provide: APP_GUARD,
      useClass: BearerAuthGuard,
    },
  ],
})
export class AppModule {}
