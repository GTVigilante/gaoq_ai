import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AuditModule } from '../../core/audit/audit.module.js';
import { TenantContextModule } from '../../core/tenant/tenant-context.module.js';
import { OutboxRecord, OutboxRecordSchema } from '../org/persistence/outbox.schema.js';
import { KnowledgeExamOrchestrationPort } from './application/knowledge-ports.js';
import {
  HttpKnowledgeExamOrchestrationAdapter,
  KnowledgeEvidenceHttpClient,
} from './integration/knowledge-evidence-http.adapters.js';
import { KnowledgeExamRunProcessor } from './knowledge-exam-run.processor.js';
import { KNOWLEDGE_EXAM_RUN_QUEUE } from './knowledge-exam-run.queue.js';
import { KnowledgeExamRunRelayService } from './knowledge-exam-run-relay.service.js';
import { KnowledgeExamRunScheduler } from './knowledge-exam-run.scheduler.js';
import {
  KnowledgeExamRunRecord,
  KnowledgeExamRunRecordSchema,
} from './persistence/knowledge-exam-run.schemas.js';
import {
  KnowledgeExamAttemptRecord,
  KnowledgeExamAttemptRecordSchema,
} from './persistence/knowledge.schemas.js';
import { KnowledgeOutboxWriter } from './persistence/knowledge-outbox.writer.js';

/** 考试 Worker 只装配考试运行、最终尝试、签名网关和唤醒队列。 */
@Module({
  imports: [
    AuditModule,
    TenantContextModule,
    MongooseModule.forFeature([
      { name: KnowledgeExamRunRecord.name, schema: KnowledgeExamRunRecordSchema },
      { name: KnowledgeExamAttemptRecord.name, schema: KnowledgeExamAttemptRecordSchema },
      { name: OutboxRecord.name, schema: OutboxRecordSchema },
    ]),
    BullModule.registerQueue({ name: KNOWLEDGE_EXAM_RUN_QUEUE }),
  ],
  providers: [
    KnowledgeEvidenceHttpClient,
    HttpKnowledgeExamOrchestrationAdapter,
    {
      provide: KnowledgeExamOrchestrationPort,
      useExisting: HttpKnowledgeExamOrchestrationAdapter,
    },
    KnowledgeExamRunRelayService,
    KnowledgeOutboxWriter,
    KnowledgeExamRunProcessor,
    KnowledgeExamRunScheduler,
  ],
})
export class KnowledgeExamWorkerModule {}
