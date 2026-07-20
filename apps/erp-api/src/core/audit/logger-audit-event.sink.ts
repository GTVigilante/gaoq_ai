import { Injectable, Logger } from '@nestjs/common';

import type { AuditEvent } from './audit.types.js';
import { AuditEventSink } from './audit.types.js';

@Injectable()
export class LoggerAuditEventSink extends AuditEventSink {
  private readonly logger = new Logger('Audit');

  /** Phase 1 默认输出结构化事件；生产阶段必须替换为持久化审计设施。 */
  override append(event: AuditEvent): Promise<void> {
    this.logger.log(JSON.stringify(event));
    return Promise.resolve();
  }
}
