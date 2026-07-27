import { Injectable } from '@nestjs/common';
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';

type AuditOutcome = 'success' | 'failure';
type VerificationOutcome = 'success' | 'failure';
type ApprovalNotificationOutcome = 'sent' | 'retry' | 'dead';
type McpConfirmationStage = 'prepare' | 'confirm' | 'execute';
type KnowledgeSearchIndexOutcome = 'success' | 'retry' | 'dead';
type KnowledgeExamRunOutcome = 'success' | 'pending' | 'retry' | 'dead' | 'deferred';

/** 低基数 Prometheus 指标注册中心；严禁使用租户、用户、资源 ID 作为标签。 */
@Injectable()
export class MetricsService {
  private readonly registry = new Registry();
  private readonly httpRequests = new Counter({
    name: 'gaoq_http_requests_total',
    help: 'ERP API HTTP 请求总数。',
    labelNames: ['method', 'controller', 'handler', 'status_code'] as const,
    registers: [this.registry],
  });
  private readonly httpDuration = new Histogram({
    name: 'gaoq_http_request_duration_seconds',
    help: 'ERP API HTTP 请求耗时（秒）。',
    labelNames: ['method', 'controller', 'handler', 'status_code'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [this.registry],
  });
  private readonly auditAppends = new Counter({
    name: 'gaoq_audit_append_total',
    help: '持久审计链追加结果总数。',
    labelNames: ['outcome'] as const,
    registers: [this.registry],
  });
  private readonly auditAppendDuration = new Histogram({
    name: 'gaoq_audit_append_duration_seconds',
    help: '持久审计链追加耗时（秒）。',
    labelNames: ['outcome'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });
  private readonly auditTransactionRetries = new Counter({
    name: 'gaoq_audit_transaction_retries_total',
    help: '审计链事务因并发或瞬时错误发生的重试总数。',
    registers: [this.registry],
  });
  private readonly auditVerifications = new Counter({
    name: 'gaoq_audit_verification_total',
    help: '审计链完整性验证结果总数。',
    labelNames: ['outcome'] as const,
    registers: [this.registry],
  });
  private readonly auditVerificationDuration = new Histogram({
    name: 'gaoq_audit_verification_duration_seconds',
    help: '审计链完整性验证耗时（秒）。',
    labelNames: ['outcome'] as const,
    buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 15, 30, 60, 300],
    registers: [this.registry],
  });
  private readonly auditWormExports = new Counter({
    name: 'gaoq_audit_worm_exports_total',
    help: '外部 WORM 审计锚定结果总数。',
    labelNames: ['outcome'] as const,
    registers: [this.registry],
  });
  private readonly auditWormLastSuccess = new Gauge({
    name: 'gaoq_audit_worm_last_success_timestamp_seconds',
    help: '最近一次外部 WORM 锚定成功的 Unix 时间戳（秒）。',
    registers: [this.registry],
  });
  private readonly queueJobs = new Gauge({
    name: 'gaoq_queue_jobs',
    help: 'BullMQ 各固定队列状态的任务数量。',
    labelNames: ['queue', 'state'] as const,
    registers: [this.registry],
  });
  private readonly queuePollFailures = new Counter({
    name: 'gaoq_queue_metrics_poll_failures_total',
    help: 'BullMQ 队列指标采集失败总数。',
    labelNames: ['queue'] as const,
    registers: [this.registry],
  });
  private readonly approvalNotifications = new Counter({
    name: 'gaoq_approval_notification_delivery_total',
    help: '审批通知双平台投递结果总数。',
    labelNames: ['channel', 'outcome'] as const,
    registers: [this.registry],
  });
  private readonly approvalNotificationDuration = new Histogram({
    name: 'gaoq_approval_notification_delivery_duration_seconds',
    help: '审批通知单次投递耗时（秒）。',
    labelNames: ['channel', 'outcome'] as const,
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [this.registry],
  });
  private readonly mcpConfirmations = new Counter({
    name: 'gaoq_mcp_confirmation_total',
    help: 'MCP 服务端确认各阶段结果总数。',
    labelNames: ['stage', 'risk_level', 'outcome'] as const,
    registers: [this.registry],
  });
  private readonly knowledgeSearchIndexDeliveries = new Counter({
    name: 'gaoq_knowledge_search_index_delivery_total',
    help: 'Knowledge 搜索索引事务任务投递结果总数。',
    labelNames: ['operation', 'outcome'] as const,
    registers: [this.registry],
  });
  private readonly knowledgeSearchIndexConvergence = new Histogram({
    name: 'gaoq_knowledge_search_index_convergence_seconds',
    help: 'Knowledge 搜索索引从事务任务创建到签名回执索引时间的收敛耗时（秒）。',
    labelNames: ['operation'] as const,
    buckets: [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 900, 3_600],
    registers: [this.registry],
  });
  private readonly knowledgeSearchIndexLastSuccess = new Gauge({
    name: 'gaoq_knowledge_search_index_last_success_timestamp_seconds',
    help: 'Knowledge 搜索索引最近一次成功签名回执的 Unix 时间戳（秒）。',
    labelNames: ['operation'] as const,
    registers: [this.registry],
  });
  private readonly knowledgeExamRunTransitions = new Counter({
    name: 'gaoq_knowledge_exam_run_transition_total',
    help: 'Knowledge 考试运行状态推进结果总数。',
    labelNames: ['operation', 'outcome'] as const,
    registers: [this.registry],
  });
  private readonly knowledgeExamRunLastSuccess = new Gauge({
    name: 'gaoq_knowledge_exam_run_last_success_timestamp_seconds',
    help: 'Knowledge 考试运行最近一次成功推进时间。',
    labelNames: ['operation'] as const,
    registers: [this.registry],
  });
  private readonly knowledgeExamRunBacklog = new Gauge({
    name: 'gaoq_knowledge_exam_run_backlog',
    help: 'Knowledge 考试运行各固定状态待处理数量。',
    labelNames: ['status'] as const,
    registers: [this.registry],
  });
  private readonly knowledgeExamRunOldestAge = new Gauge({
    name: 'gaoq_knowledge_exam_run_oldest_age_seconds',
    help: 'Knowledge 考试运行各固定状态最老记录年龄（秒）。',
    labelNames: ['status'] as const,
    registers: [this.registry],
  });
  private readonly knowledgeExamGradingDuration = new Histogram({
    name: 'gaoq_knowledge_exam_grading_duration_seconds',
    help: 'Knowledge 从提交到最终评分完成耗时（秒）。',
    labelNames: ['review_mode'] as const,
    buckets: [1, 5, 15, 30, 60, 120, 300, 900, 3_600, 14_400, 86_400, 604_800],
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry, prefix: 'gaoq_process_' });
  }

  get contentType(): string {
    return this.registry.contentType;
  }

  async render(): Promise<string> {
    return this.registry.metrics();
  }

  recordHttpRequest(input: {
    readonly method: string;
    readonly controller: string;
    readonly handler: string;
    readonly statusCode: number;
    readonly durationSeconds: number;
  }): void {
    const labels = {
      method: input.method,
      controller: input.controller,
      handler: input.handler,
      status_code: String(input.statusCode),
    };
    this.httpRequests.inc(labels);
    this.httpDuration.observe(labels, input.durationSeconds);
  }

  recordAuditAppend(outcome: AuditOutcome, durationSeconds: number): void {
    this.auditAppends.inc({ outcome });
    this.auditAppendDuration.observe({ outcome }, durationSeconds);
  }

  recordAuditTransactionRetry(): void {
    this.auditTransactionRetries.inc();
  }

  recordAuditVerification(outcome: VerificationOutcome, durationSeconds: number): void {
    this.auditVerifications.inc({ outcome });
    this.auditVerificationDuration.observe({ outcome }, durationSeconds);
  }

  recordAuditWormExport(outcome: AuditOutcome, occurredAt = new Date()): void {
    this.auditWormExports.inc({ outcome });
    if (outcome === 'success') this.auditWormLastSuccess.set(occurredAt.getTime() / 1_000);
  }

  setQueueJobs(queue: string, counts: Readonly<Record<string, number>>): void {
    for (const state of ['waiting', 'active', 'delayed', 'failed'] as const) {
      this.queueJobs.set({ queue, state }, counts[state] ?? 0);
    }
  }

  recordQueueMetricsPollFailure(queue: string): void {
    this.queuePollFailures.inc({ queue });
  }

  recordApprovalNotification(
    channel: 'dingtalk' | 'feishu',
    outcome: ApprovalNotificationOutcome,
    durationSeconds: number,
  ): void {
    this.approvalNotifications.inc({ channel, outcome });
    this.approvalNotificationDuration.observe({ channel, outcome }, durationSeconds);
  }

  recordMcpConfirmation(
    stage: McpConfirmationStage,
    riskLevel: 'R1' | 'R2',
    outcome: 'success' | 'failure' | 'denied',
  ): void {
    this.mcpConfirmations.inc({ stage, risk_level: riskLevel, outcome });
  }

  recordKnowledgeSearchIndex(
    operation: 'upsert' | 'delete',
    outcome: KnowledgeSearchIndexOutcome,
    convergenceSeconds?: number,
    indexedAt?: Date,
  ): void {
    this.knowledgeSearchIndexDeliveries.inc({ operation, outcome });
    if (
      outcome === 'success' &&
      convergenceSeconds !== undefined &&
      indexedAt !== undefined
    ) {
      this.knowledgeSearchIndexConvergence.observe(
        { operation },
        Math.max(0, convergenceSeconds),
      );
      this.knowledgeSearchIndexLastSuccess.set(
        { operation },
        indexedAt.getTime() / 1_000,
      );
    }
  }

  recordKnowledgeExamRun(
    operation: 'start' | 'timeout' | 'review' | 'grade' | 'gateway',
    outcome: KnowledgeExamRunOutcome,
  ): void {
    this.knowledgeExamRunTransitions.inc({ operation, outcome });
    if (outcome === 'success') {
      this.knowledgeExamRunLastSuccess.set({ operation }, Date.now() / 1_000);
    }
  }

  setKnowledgeExamRunBacklog(
    status: 'starting' | 'in_progress' | 'submitted' | 'pending_review' | 'dead',
    count: number,
    oldestAgeSeconds: number,
  ): void {
    this.knowledgeExamRunBacklog.set({ status }, Math.max(0, count));
    this.knowledgeExamRunOldestAge.set({ status }, Math.max(0, oldestAgeSeconds));
  }

  observeKnowledgeExamGrading(
    reviewMode: 'automatic' | 'manual',
    durationSeconds: number,
  ): void {
    this.knowledgeExamGradingDuration.observe(
      { review_mode: reviewMode },
      Math.max(0, durationSeconds),
    );
  }
}

/** 单调时钟耗时，避免系统时间校准导致负值。 */
export const elapsedSeconds = (startedAt: bigint): number =>
  Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
