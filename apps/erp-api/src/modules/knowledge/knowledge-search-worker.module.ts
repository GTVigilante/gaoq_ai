import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { KnowledgeSearchIndexPort } from './application/knowledge-ports.js';
import {
  HttpKnowledgeSearchIndexAdapter,
  KnowledgeEvidenceHttpClient,
} from './integration/knowledge-evidence-http.adapters.js';
import { KnowledgeSearchIndexProcessor } from './knowledge-search-index.processor.js';
import { KNOWLEDGE_SEARCH_INDEX_QUEUE } from './knowledge-search-index.queue.js';
import { KnowledgeSearchIndexRelayService } from './knowledge-search-index-relay.service.js';
import { KnowledgeSearchIndexScheduler } from './knowledge-search-index.scheduler.js';
import {
  KnowledgeSearchIndexTaskRecord,
  KnowledgeSearchIndexTaskRecordSchema,
} from './persistence/knowledge-search.schemas.js';

/** Knowledge Worker 只装配索引任务、严格网关 Adapter 与队列，不引入 HTTP 控制器。 */
@Module({
  imports: [
    MongooseModule.forFeature([{
      name: KnowledgeSearchIndexTaskRecord.name,
      schema: KnowledgeSearchIndexTaskRecordSchema,
    }]),
    BullModule.registerQueue({ name: KNOWLEDGE_SEARCH_INDEX_QUEUE }),
  ],
  providers: [
    KnowledgeEvidenceHttpClient,
    HttpKnowledgeSearchIndexAdapter,
    { provide: KnowledgeSearchIndexPort, useExisting: HttpKnowledgeSearchIndexAdapter },
    KnowledgeSearchIndexRelayService,
    KnowledgeSearchIndexProcessor,
    KnowledgeSearchIndexScheduler,
  ],
})
export class KnowledgeSearchWorkerModule {}
