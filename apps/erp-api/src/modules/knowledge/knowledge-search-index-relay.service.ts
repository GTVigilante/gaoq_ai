import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';

import { MetricsService } from '../../core/observability/metrics.service.js';
import { KnowledgeSearchIndexPort } from './application/knowledge-ports.js';
import {
  KnowledgeSearchIndexTaskRecord,
  type KnowledgeSearchIndexTaskDocument,
  type KnowledgeSearchIndexTaskStatus,
} from './persistence/knowledge-search.schemas.js';

const LOCK_TIMEOUT_MS = 5 * 60_000;
const MAX_ATTEMPTS = 8;

interface ClaimedSearchIndexTask {
  readonly eventId: string;
  readonly tenantId: string;
  readonly courseVersionId: string;
  readonly courseCode: string;
  readonly revision: number;
  readonly courseVersion: number;
  readonly contentRef: string;
  readonly operation: 'upsert' | 'delete';
  readonly audienceMode: 'assigned_only' | 'employment_scope';
  readonly audienceDepartmentIds: readonly string[];
  readonly audiencePositionIds: readonly string[];
  readonly attempts: number;
  readonly createdAt: Date;
}

/** 从 Mongo 事实源可靠投递搜索索引任务；失败指数退避，终态进入可对账死信。 */
@Injectable()
export class KnowledgeSearchIndexRelayService {
  private readonly logger = new Logger(KnowledgeSearchIndexRelayService.name);

  constructor(
    @InjectModel(KnowledgeSearchIndexTaskRecord.name)
    private readonly records: Model<KnowledgeSearchIndexTaskDocument>,
    private readonly index: KnowledgeSearchIndexPort,
    private readonly metrics: MetricsService,
  ) {}

  async relayBatch(workerId: string, limit = 100): Promise<number> {
    assertWorker(workerId, limit);
    let completed = 0;
    for (let index = 0; index < limit; index += 1) {
      const task = await this.claim(workerId);
      if (task === null) break;
      try {
        const receipt = await this.index.apply({
          eventId: task.eventId,
          tenantId: task.tenantId,
          courseVersionId: task.courseVersionId,
          courseCode: task.courseCode,
          revision: task.revision,
          courseVersion: task.courseVersion,
          contentRef: task.contentRef,
          operation: task.operation,
          audienceMode: task.audienceMode,
          audienceDepartmentIds: task.audienceDepartmentIds,
          audiencePositionIds: task.audiencePositionIds,
        });
        const indexedAt = new Date(receipt.indexedAt);
        if (
          Number.isNaN(indexedAt.getTime()) ||
          indexedAt.getTime() > Date.now() + 5 * 60_000 ||
          indexedAt.getTime() < task.createdAt.getTime() - 5 * 60_000
        ) throw new Error('KNOWLEDGE_SEARCH_INDEX_RECEIPT_TIME_INVALID');
        const updated = await this.records.updateOne(
          {
            tenantId: task.tenantId,
            eventId: task.eventId,
            status: 'processing',
            lockedBy: workerId,
          },
          {
            $set: {
              status: 'completed',
              completedAt: new Date(),
              receiptId: receipt.receiptId,
              indexedContentDigest: receipt.indexedContentDigest,
              indexedAt,
              lockedAt: null,
              lockedBy: null,
              lastErrorCode: null,
            },
          },
          { timestamps: false, runValidators: true },
        );
        if (updated.matchedCount !== 1) {
          throw new Error('KNOWLEDGE_SEARCH_INDEX_CLAIM_LOST');
        }
        this.metrics.recordKnowledgeSearchIndex(
          task.operation,
          'success',
          (indexedAt.getTime() - task.createdAt.getTime()) / 1_000,
          indexedAt,
        );
        completed += 1;
      } catch (caught) {
        await this.release(workerId, task, failureCode(caught));
      }
    }
    return completed;
  }

  private async claim(workerId: string): Promise<ClaimedSearchIndexTask | null> {
    const now = new Date();
    const task = await this.records.findOneAndUpdate(
      {
        nextAttemptAt: { $lte: now },
        $or: [
          { status: 'pending' satisfies KnowledgeSearchIndexTaskStatus },
          {
            status: 'processing' satisfies KnowledgeSearchIndexTaskStatus,
            lockedAt: { $lt: new Date(now.getTime() - LOCK_TIMEOUT_MS) },
          },
        ],
      },
      {
        $set: {
          status: 'processing',
          lockedAt: now,
          lockedBy: workerId,
        },
      },
      { sort: { createdAt: 1 }, returnDocument: 'after', lean: true },
    ).exec();
    if (task === null) return null;
    return Object.freeze({
      eventId: task.eventId,
      tenantId: task.tenantId,
      courseVersionId: task.courseVersionId,
      courseCode: task.courseCode,
      revision: task.revision,
      courseVersion: task.courseVersion,
      contentRef: task.contentRef,
      operation: task.operation,
      audienceMode: task.audienceMode,
      audienceDepartmentIds: Object.freeze([...task.audienceDepartmentIds]),
      audiencePositionIds: Object.freeze([...task.audiencePositionIds]),
      attempts: task.attempts,
      createdAt: new Date(task.createdAt),
    });
  }

  private async release(
    workerId: string,
    task: ClaimedSearchIndexTask,
    errorCode: string,
  ): Promise<void> {
    const attempts = task.attempts + 1;
    const dead = attempts >= MAX_ATTEMPTS;
    const updated = await this.records.updateOne(
      {
        tenantId: task.tenantId,
        eventId: task.eventId,
        status: 'processing',
        lockedBy: workerId,
      },
      {
        $set: {
          status: dead ? 'dead' : 'pending',
          attempts,
          nextAttemptAt: dead
            ? new Date()
            : new Date(Date.now() + Math.min(15 * 60_000, 1_000 * (2 ** attempts))),
          completedAt: null,
          lockedAt: null,
          lockedBy: null,
          lastErrorCode: errorCode,
        },
      },
      { timestamps: false, runValidators: true },
    );
    if (updated.matchedCount !== 1) {
      throw new Error('KNOWLEDGE_SEARCH_INDEX_CLAIM_LOST');
    }
    this.metrics.recordKnowledgeSearchIndex(
      task.operation,
      dead ? 'dead' : 'retry',
    );
    if (dead) this.logger.error({
      code: 'KNOWLEDGE_SEARCH_INDEX_DEAD_LETTERED',
      eventId: task.eventId,
      courseVersionId: task.courseVersionId,
      operation: task.operation,
      attempts,
      failureCode: errorCode,
    });
  }
}

function assertWorker(workerId: string, limit: number): void {
  if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(workerId)) {
    throw new Error('KNOWLEDGE_SEARCH_INDEX_WORKER_INVALID');
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new Error('KNOWLEDGE_SEARCH_INDEX_LIMIT_INVALID');
  }
}

function failureCode(caught: unknown): string {
  return caught instanceof Error && /^[A-Z0-9_]{3,128}$/u.test(caught.message)
    ? caught.message
    : 'KNOWLEDGE_SEARCH_INDEX_FAILED';
}
