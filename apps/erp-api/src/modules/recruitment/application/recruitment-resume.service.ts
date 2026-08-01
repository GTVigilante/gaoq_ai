import { createHash } from 'node:crypto';

import { InjectQueue } from '@nestjs/bullmq';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createEventId, ULID_PATTERN } from '@gaoq/shared-utils';
import type { Queue } from 'bullmq';
import type { Model } from 'mongoose';

import { IdempotencyService } from '../../../core/idempotency/idempotency.service.js';
import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import {
  RECRUITMENT_RESUME_ANALYZE_JOB,
  RECRUITMENT_RESUME_QUEUE,
  createRecruitmentResumeAnalysisJobId,
  type RecruitmentResumeAnalysisJobData,
} from '../recruitment-resume.queue.js';
import {
  RecruitmentResumeAnalysisRecord,
  type RecruitmentResumeAnalysisDocument,
  type RecruitmentResumeProfileRecord,
  type RecruitmentResumeTagRecord,
} from '../persistence/recruitment-resume.schemas.js';
import { RecruitmentCandidateRepository } from '../persistence/recruitment.repositories.js';
import { RecruitmentOutboxWriter } from '../persistence/recruitment-outbox.writer.js';
import {
  buildRecruitmentResumeAnalysisEvent,
} from '../domain/recruitment-events.js';
import {
  RecruitmentResumeAiAnalyzer,
  RecruitmentResumeSourceGateway,
} from './recruitment-resume.ports.js';
import {
  RECRUITMENT_RESUME_TAG_TAXONOMY,
  recruitmentResumeTag,
} from './recruitment-resume.taxonomy.js';
import type {
  ListRecruitmentResumeAnalysesDto,
  RequestRecruitmentResumeAnalysisDto,
  ReviewRecruitmentResumeAnalysisDto,
} from './recruitment-resume.dto.js';

const PROMPT_VERSION = 'resume_v1';
const PROCESSING_LEASE_MS = 10 * 60 * 1_000;
const EVIDENCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface RecruitmentResumeAnalysisView extends Record<string, unknown> {
  readonly id: string;
  readonly candidateId: string;
  readonly candidateName: string | null;
  readonly resumeEvidenceId: string;
  readonly status: RecruitmentResumeAnalysisRecord['status'];
  readonly profile: {
    readonly headline: string;
    readonly summary: string;
    readonly yearsExperience: number;
    readonly educationLevel: RecruitmentResumeProfileRecord['educationLevel'];
    readonly skills: readonly string[];
    readonly jobTitles: readonly string[];
    readonly industries: readonly string[];
    readonly languages: readonly string[];
  } | null;
  readonly tags: readonly RecruitmentResumeTagRecord[];
  readonly aiModel: string | null;
  readonly failureCode: string | null;
  readonly attempts: number;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 简历库应用服务：异步解析、受控标签建议、人工确认和租户内检索。 */
@Injectable()
export class RecruitmentResumeService {
  constructor(
    private readonly context: TenantContextService,
    private readonly idempotency: IdempotencyService,
    private readonly candidates: RecruitmentCandidateRepository,
    private readonly outbox: RecruitmentOutboxWriter,
    @InjectModel(RecruitmentResumeAnalysisRecord.name)
    private readonly analyses: Model<RecruitmentResumeAnalysisDocument>,
    @InjectQueue(RECRUITMENT_RESUME_QUEUE)
    private readonly queue: Queue<RecruitmentResumeAnalysisJobData>,
    private readonly source: RecruitmentResumeSourceGateway,
    private readonly ai: RecruitmentResumeAiAnalyzer,
  ) {}

  async requestAnalysis(
    key: string,
    candidateId: string,
    input: RequestRecruitmentResumeAnalysisDto,
  ): Promise<{ readonly analysis: RecruitmentResumeAnalysisView }> {
    this.assertCandidateId(candidateId);
    if (!EVIDENCE_ID_PATTERN.test(input.resumeEvidenceId)) throw invalidInput();
    const candidate = await this.requireActiveCandidate(candidateId);
    const result = await this.idempotency.execute(
      'recruitment.resume.request_analysis',
      key,
      { candidateId, resumeEvidenceId: input.resumeEvidenceId },
      async (session) => {
        const existing = await this.analyses.findOne({
          tenantId: this.tenantId(),
          candidateId,
          resumeEvidenceId: input.resumeEvidenceId,
          promptVersion: PROMPT_VERSION,
        }).session(session).lean().exec();
        if (existing !== null) {
          return { analysis: this.view(existing, null) };
        }
        const now = new Date();
        const record: RecruitmentResumeAnalysisRecord = {
          id: createEventId(now),
          tenantId: this.tenantId(),
          candidateId,
          resumeEvidenceId: input.resumeEvidenceId,
          promptVersion: PROMPT_VERSION,
          status: 'queued',
          profile: null,
          tags: [],
          aiModel: null,
          sourceChecksum: null,
          failureCode: null,
          processingStartedAt: null,
          analyzedAt: null,
          reviewedBy: null,
          reviewedAt: null,
          retentionExpiresAt: new Date(candidate.retentionExpiresAt),
          attempts: 0,
          version: 1,
          createdAt: now,
          updatedAt: now,
        };
        await this.analyses.create([record], { session });
        await this.outbox.append(
          buildRecruitmentResumeAnalysisEvent(record, 'requested'),
          session,
        );
        return { analysis: this.view(record, null) };
      },
    );
    if (
      result.analysis.status === 'queued' ||
      (result.analysis.status === 'failed' && result.analysis.attempts < 5)
    ) {
      await this.enqueue(result.analysis.id);
    }
    return { analysis: withCandidateName(result.analysis, candidate.name) };
  }

  /** 已验证渠道/附件 Worker 窄入口；取得简历证据后自动创建分类任务。 */
  async requestAnalysisFromTrustedEvidence(
    key: string,
    candidateId: string,
    resumeEvidenceId: string,
  ): Promise<{ readonly analysis: RecruitmentResumeAnalysisView }> {
    const actor = this.context.getActorRequired();
    if (
      !['service', 'system_job'].includes(actor.actorType) ||
      !actor.scopes.some((scope) => [
        'erp:recruitment:channel:ingest',
        'erp:document:migration:write',
      ].includes(scope))
    ) throw new ForbiddenException({
      code: 'RECRUITMENT_RESUME_TRUSTED_EVIDENCE_REQUIRED',
      message: '自动简历分析必须由已验证附件证据链触发',
    });
    return this.requestAnalysis(key, candidateId, { resumeEvidenceId });
  }

  async getAnalysis(id: string): Promise<RecruitmentResumeAnalysisView> {
    this.assertAnalysisId(id);
    const record = await this.analyses.findOne({
      tenantId: this.tenantId(), id,
    }).lean().exec();
    if (record === null) throw new NotFoundException({
      code: 'RECRUITMENT_RESUME_ANALYSIS_NOT_FOUND',
      message: '简历分析不存在',
    });
    const candidate = await this.candidates.findById(record.candidateId);
    return this.view(record, candidate?.name ?? null);
  }

  async listAnalyses(input: ListRecruitmentResumeAnalysesDto): Promise<{
    readonly items: readonly RecruitmentResumeAnalysisView[];
    readonly taxonomy: typeof RECRUITMENT_RESUME_TAG_TAXONOMY;
  }> {
    const limit = input.limit ?? 50;
    const filter: Record<string, unknown> = { tenantId: this.tenantId() };
    if (input.status !== undefined) filter.status = input.status;
    if (input.tag !== undefined) {
      if (recruitmentResumeTag(input.tag) === null) throw invalidInput();
      filter.tags = { $elemMatch: { code: input.tag, status: 'confirmed' } };
    }
    const records = await this.analyses.find(filter)
      .sort({ updatedAt: -1, id: 1 })
      .limit(limit)
      .lean()
      .exec();
    const items = await Promise.all(records.map(async (record) => {
      const candidate = await this.candidates.findById(record.candidateId);
      return this.view(record, candidate?.name ?? null);
    }));
    return Object.freeze({
      items: Object.freeze(items),
      taxonomy: RECRUITMENT_RESUME_TAG_TAXONOMY,
    });
  }

  async review(
    key: string,
    id: string,
    expectedVersion: number,
    input: ReviewRecruitmentResumeAnalysisDto,
  ): Promise<{ readonly analysis: RecruitmentResumeAnalysisView }> {
    this.assertAnalysisId(id);
    assertReviewInput(input);
    const actorId = this.context.getActorRequired().actorId;
    const result = await this.idempotency.execute(
      'recruitment.resume.review',
      key,
      { id, expectedVersion, input },
      async (session) => {
        const record = await this.analyses.findOne({
          tenantId: this.tenantId(), id,
        }).session(session).lean().exec();
        if (record === null) throw new NotFoundException({
          code: 'RECRUITMENT_RESUME_ANALYSIS_NOT_FOUND',
          message: '简历分析不存在',
        });
        if (record.version !== expectedVersion) throw new ConflictException({
          code: 'RECRUITMENT_RESUME_VERSION_CONFLICT',
          message: '简历分析版本已变化，请刷新后重试',
        });
        if (!['review_required', 'approved'].includes(record.status)) {
          throw new ConflictException({
            code: 'RECRUITMENT_RESUME_REVIEW_NOT_READY',
            message: '简历分析尚未进入人工复核阶段',
          });
        }
        const tags = reviewTags(record.tags, input);
        const now = new Date();
        const updated = await this.analyses.findOneAndUpdate(
          { tenantId: this.tenantId(), id, version: expectedVersion },
          { $set: {
            status: 'approved',
            tags,
            reviewedBy: actorId,
            reviewedAt: now,
            failureCode: null,
            processingStartedAt: null,
            version: expectedVersion + 1,
            updatedAt: now,
          } },
          { session, returnDocument: 'after', runValidators: true, timestamps: false },
        ).lean().exec();
        if (updated === null) throw new ConflictException({
          code: 'RECRUITMENT_RESUME_VERSION_CONFLICT',
          message: '简历分析版本已变化，请刷新后重试',
        });
        await this.outbox.append(
          buildRecruitmentResumeAnalysisEvent(updated, 'reviewed'),
          session,
        );
        return { analysis: this.view(updated, null) };
      },
    );
    const candidate = await this.candidates.findById(result.analysis.candidateId);
    return { analysis: withCandidateName(result.analysis, candidate?.name ?? null) };
  }

  /**
   * Worker 入口；正文只存在于当前函数内存，不写日志、不写库。
   */
  async processAnalysis(id: string): Promise<RecruitmentResumeAnalysisView | null> {
    const actor = this.context.getActorRequired();
    if (
      actor.actorType !== 'system_job' ||
      !actor.scopes.includes('erp:recruitment:resume:process')
    ) throw new ForbiddenException({
      code: 'RECRUITMENT_RESUME_PROCESSOR_DENIED',
      message: '简历分析只允许受信任 Worker 执行',
    });
    this.assertAnalysisId(id);
    const now = new Date();
    const claimed = await this.analyses.findOneAndUpdate(
      {
        tenantId: this.tenantId(),
        id,
        attempts: { $lt: 5 },
        $or: [
          { status: { $in: ['queued', 'failed'] } },
          {
            status: 'processing',
            processingStartedAt: { $lte: new Date(now.getTime() - PROCESSING_LEASE_MS) },
          },
        ],
      },
      { $set: {
        status: 'processing',
        processingStartedAt: now,
        failureCode: null,
        reviewedBy: null,
        reviewedAt: null,
      }, $inc: { attempts: 1, version: 1 } },
      { returnDocument: 'after', runValidators: true },
    ).lean().exec();
    if (claimed === null) return null;
    try {
      const candidate = await this.requireActiveCandidate(claimed.candidateId);
      const source = await this.source.readRedactedText({
        tenantId: claimed.tenantId,
        candidateId: claimed.candidateId,
        resumeEvidenceId: claimed.resumeEvidenceId,
      });
      const result = await this.ai.analyze({
        redactedText: source.text,
        taxonomy: RECRUITMENT_RESUME_TAG_TAXONOMY,
        safetyIdentifier: createSafetyIdentifier(
          claimed.tenantId,
          claimed.candidateId,
        ),
      });
      const tags = result.tags.map((item): RecruitmentResumeTagRecord => {
        const definition = recruitmentResumeTag(item.code);
        if (definition === null) throw new Error('RECRUITMENT_RESUME_AI_TAG_INVALID');
        return {
          category: definition.category,
          code: definition.code,
          label: definition.label,
          confidence: item.confidence,
          evidence: item.evidence,
          source: 'ai',
          status: 'suggested',
        };
      });
      const profile: RecruitmentResumeProfileRecord = {
        headline: result.headline,
        summary: result.summary,
        yearsExperience: result.yearsExperience,
        educationLevel: result.educationLevel,
        skills: [...result.skills],
        jobTitles: [...result.jobTitles],
        industries: [...result.industries],
        languages: [...result.languages],
      };
      const completedAt = new Date();
      const updated = await this.analyses.findOneAndUpdate(
        { tenantId: this.tenantId(), id, status: 'processing', version: claimed.version },
        { $set: {
          status: 'review_required',
          profile,
          tags,
          aiModel: result.model,
          sourceChecksum: source.sourceChecksum,
          analyzedAt: completedAt,
          processingStartedAt: null,
          failureCode: null,
          version: claimed.version + 1,
          updatedAt: completedAt,
        } },
        { returnDocument: 'after', runValidators: true, timestamps: false },
      ).lean().exec();
      if (updated === null) throw new Error('RECRUITMENT_RESUME_PROCESSING_LEASE_LOST');
      return this.view(updated, candidate.name);
    } catch (error) {
      const marked = await this.markFailed(claimed, failureCode(error));
      if (!marked) {
        throw new Error('RECRUITMENT_RESUME_PROCESSING_LEASE_LOST', { cause: error });
      }
      throw error;
    }
  }

  private async markFailed(
    claimed: RecruitmentResumeAnalysisRecord,
    code: string,
  ): Promise<boolean> {
    const result = await this.analyses.updateOne(
      {
        tenantId: claimed.tenantId,
        id: claimed.id,
        status: 'processing',
        version: claimed.version,
      },
      { $set: {
        status: 'failed',
        processingStartedAt: null,
        failureCode: code,
        updatedAt: new Date(),
      }, $inc: { version: 1 } },
      { runValidators: true, timestamps: false },
    ).exec();
    return result.modifiedCount === 1;
  }

  private async enqueue(analysisId: string): Promise<void> {
    const tenantId = this.tenantId();
    await this.queue.add(
      RECRUITMENT_RESUME_ANALYZE_JOB,
      { tenantId, analysisId },
      {
        jobId: createRecruitmentResumeAnalysisJobId(tenantId, analysisId),
        attempts: 5,
        backoff: { type: 'exponential', delay: 2_000 },
        removeOnComplete: 100,
        removeOnFail: true,
      },
    );
  }

  private async requireActiveCandidate(candidateId: string) {
    const candidate = await this.candidates.findById(candidateId);
    if (
      candidate === null ||
      candidate.status !== 'active' ||
      candidate.name === null ||
      Date.parse(candidate.consent.expiresAt) <= Date.now() ||
      Date.parse(candidate.retentionExpiresAt) <= Date.now()
    ) throw new ForbiddenException({
      code: 'RECRUITMENT_RESUME_CANDIDATE_NOT_ELIGIBLE',
      message: '候选人不存在、授权无效或已到保留期限',
    });
    return candidate;
  }

  private tenantId(): string {
    return this.context.getTenantRequired().tenantId;
  }

  private assertCandidateId(value: string): void {
    if (!ULID_PATTERN.test(value)) throw invalidInput();
  }

  private assertAnalysisId(value: string): void {
    if (!ULID_PATTERN.test(value)) throw invalidInput();
  }

  private view(
    record: RecruitmentResumeAnalysisRecord,
    candidateName: string | null,
  ): RecruitmentResumeAnalysisView {
    return Object.freeze({
      id: record.id,
      candidateId: record.candidateId,
      candidateName,
      resumeEvidenceId: record.resumeEvidenceId,
      status: record.status,
      profile: record.profile === null ? null : Object.freeze({
        headline: record.profile.headline,
        summary: record.profile.summary,
        yearsExperience: record.profile.yearsExperience,
        educationLevel: record.profile.educationLevel,
        skills: Object.freeze([...record.profile.skills]),
        jobTitles: Object.freeze([...record.profile.jobTitles]),
        industries: Object.freeze([...record.profile.industries]),
        languages: Object.freeze([...record.profile.languages]),
      }),
      tags: Object.freeze(record.tags.map((tag) => Object.freeze({
        category: tag.category,
        code: tag.code,
        label: tag.label,
        confidence: tag.confidence,
        evidence: tag.evidence,
        source: tag.source,
        status: tag.status,
      }))),
      aiModel: record.aiModel,
      failureCode: record.failureCode,
      attempts: record.attempts,
      version: record.version,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    });
  }
}

function assertReviewInput(input: ReviewRecruitmentResumeAnalysisDto): void {
  const decisionCodes = input.decisions.map((item) => item.code);
  const manualCodes = input.manualTagCodes;
  if (
    new Set(decisionCodes).size !== decisionCodes.length ||
    new Set(manualCodes).size !== manualCodes.length ||
    [...decisionCodes, ...manualCodes].some((code) => recruitmentResumeTag(code) === null)
  ) throw invalidInput();
}

function reviewTags(
  existing: readonly RecruitmentResumeTagRecord[],
  input: ReviewRecruitmentResumeAnalysisDto,
): RecruitmentResumeTagRecord[] {
  const decisions = new Map(input.decisions.map((item) => [item.code, item.status]));
  if (input.decisions.some((item) => !existing.some((tag) => tag.code === item.code))) {
    throw invalidInput();
  }
  const result = existing.map((tag) => ({
    ...tag,
    status: decisions.get(tag.code) ?? tag.status,
  }));
  for (const code of input.manualTagCodes) {
    const definition = recruitmentResumeTag(code);
    if (definition === null) throw invalidInput();
    const current = result.find((tag) => tag.code === code);
    if (current !== undefined) {
      current.status = 'confirmed';
      continue;
    }
    result.push({
      category: definition.category,
      code: definition.code,
      label: definition.label,
      confidence: 1,
      evidence: '招聘人员人工确认',
      source: 'manual',
      status: 'confirmed',
    });
  }
  return result;
}

function invalidInput(): BadRequestException {
  return new BadRequestException({
    code: 'RECRUITMENT_RESUME_INPUT_INVALID',
    message: '简历分析输入非法',
  });
}

function failureCode(error: unknown): string {
  if (error instanceof Error && /^[A-Z0-9_]{3,128}$/.test(error.message)) return error.message;
  return 'RECRUITMENT_RESUME_PROCESSING_FAILED';
}

function createSafetyIdentifier(tenantId: string, candidateId: string): string {
  return createHash('sha256')
    .update(JSON.stringify(['recruitment-resume-safety', tenantId, candidateId]), 'utf8')
    .digest('base64url');
}

function withCandidateName(
  analysis: RecruitmentResumeAnalysisView,
  candidateName: string | null,
): RecruitmentResumeAnalysisView {
  return Object.freeze({ ...analysis, candidateName });
}
