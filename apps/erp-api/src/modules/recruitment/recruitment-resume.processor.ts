import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { z } from 'zod';

import { AuditService } from '../../core/audit/audit.service.js';
import { TenantContextService } from '../../core/tenant/tenant-context.service.js';
import { RecruitmentResumeService } from './application/recruitment-resume.service.js';
import {
  RECRUITMENT_RESUME_ANALYZE_JOB,
  RECRUITMENT_RESUME_QUEUE,
  createRecruitmentResumeAnalysisJobId,
  type RecruitmentResumeAnalysisJobData,
} from './recruitment-resume.queue.js';

const jobSchema = z.object({
  tenantId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  analysisId: z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/),
}).strict();

/** 独立 Worker 完成简历提取与 AI 建议，不在 API 请求进程执行模型调用。 */
@Processor(RECRUITMENT_RESUME_QUEUE, { concurrency: 2, limiter: { max: 5, duration: 1_000 } })
export class RecruitmentResumeProcessor extends WorkerHost {
  private readonly logger = new Logger(RecruitmentResumeProcessor.name);

  constructor(
    private readonly context: TenantContextService,
    private readonly resumes: RecruitmentResumeService,
    private readonly audit: AuditService,
  ) { super(); }

  override async process(job: Job<RecruitmentResumeAnalysisJobData>): Promise<void> {
    if (job.name !== RECRUITMENT_RESUME_ANALYZE_JOB) {
      throw new Error('RECRUITMENT_RESUME_JOB_UNKNOWN');
    }
    const data = jobSchema.parse(job.data);
    if (
      String(job.id ?? '') !== createRecruitmentResumeAnalysisJobId(
        data.tenantId,
        data.analysisId,
      )
    ) throw new Error('RECRUITMENT_RESUME_JOB_ID_MISMATCH');
    await this.context.run({
      tenant: { tenantId: data.tenantId, source: 'service_identity' },
      actor: {
        actorId: 'system:recruitment-resume',
        actorType: 'system_job',
        tenantId: data.tenantId,
        roleCodes: ['RECRUITMENT_RESUME_WORKER'],
        scopes: ['erp:recruitment:resume:process'],
        departmentIds: [],
        traceId: data.analysisId,
      },
    }, async () => {
      try {
        const result = await this.resumes.processAnalysis(data.analysisId);
        if (result === null) return;
        await this.recordAuditSafely({
          action: 'recruitment.resume.analysis.complete',
          resourceType: 'recruitment_resume_analysis',
          resourceId: result.id,
          riskLevel: 'R1',
          outcome: 'success',
          metadata: {
            candidateId: result.candidateId,
            suggestedTagCount: result.tags.length,
            ...(result.aiModel === null ? {} : { model: result.aiModel }),
          },
        });
      } catch (error) {
        await this.recordAuditSafely({
          action: 'recruitment.resume.analysis.complete',
          resourceType: 'recruitment_resume_analysis',
          resourceId: data.analysisId,
          riskLevel: 'R1',
          outcome: 'failure',
          metadata: { failureCode: failureCode(error) },
        });
        throw error;
      }
    });
  }

  private async recordAuditSafely(
    input: Parameters<AuditService['record']>[0],
  ): Promise<void> {
    try {
      await this.audit.record(input);
    } catch {
      // 业务已提交后的审计故障不得触发模型重放或把成功终态回写为失败。
      this.logger.error('简历分析审计写入失败');
    }
  }
}

function failureCode(error: unknown): string {
  if (error instanceof Error && /^[A-Z0-9_]{3,128}$/.test(error.message)) return error.message;
  return 'RECRUITMENT_RESUME_PROCESSING_FAILED';
}
