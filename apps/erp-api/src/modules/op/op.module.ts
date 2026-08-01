import { Module } from '@nestjs/common';

import { OpApprovalWebhookController } from './op-approval-webhook.controller.js';
import { OpCoreModule } from './op-core.module.js';
import { OpController } from './op.controller.js';
import { OpWebhookController } from './op-webhook.controller.js';

/** OP HTTP/Webhook 外壳；双向桥接 Worker 只装配 OpCoreModule。 */
@Module({
  imports: [OpCoreModule],
  controllers: [OpWebhookController, OpApprovalWebhookController, OpController],
  exports: [OpCoreModule],
})
export class OpModule {}
