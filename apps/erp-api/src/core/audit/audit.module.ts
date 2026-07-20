import { Global, Module } from '@nestjs/common';

import { AuditService } from './audit.service.js';
import { AuditEventSink } from './audit.types.js';
import { LoggerAuditEventSink } from './logger-audit-event.sink.js';

@Global()
@Module({
  providers: [
    AuditService,
    {
      provide: AuditEventSink,
      useClass: LoggerAuditEventSink,
    },
  ],
  exports: [AuditService],
})
export class AuditModule {}
