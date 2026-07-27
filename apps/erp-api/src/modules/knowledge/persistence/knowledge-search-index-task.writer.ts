import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { CourseVersion } from '../domain/index.js';
import {
  KnowledgeSearchIndexTaskRecord,
  type KnowledgeSearchIndexTaskDocument,
  type KnowledgeSearchIndexOperation,
} from './knowledge-search.schemas.js';

/** 在课程发布/下架事务内追加搜索索引任务，禁止同步调用外部搜索服务。 */
@Injectable()
export class KnowledgeSearchIndexTaskWriter {
  constructor(
    private readonly context: TenantContextService,
    @InjectModel(KnowledgeSearchIndexTaskRecord.name)
    private readonly records: Model<KnowledgeSearchIndexTaskDocument>,
  ) {}

  async append(
    eventId: string,
    course: CourseVersion,
    operation: KnowledgeSearchIndexOperation,
    session: ClientSession,
  ): Promise<void> {
    const tenantId = this.context.getTenantRequired().tenantId;
    if (course.tenantId !== tenantId) {
      throw new Error('KNOWLEDGE_SEARCH_INDEX_TASK_CROSS_TENANT');
    }
    await this.records.create([{
      eventId,
      tenantId,
      courseVersionId: course.id,
      courseCode: course.courseCode,
      revision: course.revision,
      courseVersion: course.version,
      contentRef: course.contentRef,
      operation,
      audienceMode: course.audienceMode,
      audienceDepartmentIds: [...course.audienceDepartmentIds],
      audiencePositionIds: [...course.audiencePositionIds],
      status: 'pending',
      attempts: 0,
      nextAttemptAt: new Date(course.updatedAt),
      lockedAt: null,
      lockedBy: null,
      completedAt: null,
      receiptId: null,
      indexedContentDigest: null,
      indexedAt: null,
      lastErrorCode: null,
    }], { session });
  }
}
