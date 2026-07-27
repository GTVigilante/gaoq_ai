import { Injectable, ServiceUnavailableException } from '@nestjs/common';

import type { CourseVersion } from '../domain/index.js';

export interface KnowledgeGradingResult {
  readonly scoreBps: number;
  readonly questionBankDigest: string;
  readonly questionSetDigest: string;
  readonly gradingEvidenceId: string;
}

export interface KnowledgeExamStartReceipt {
  readonly gatewaySessionRef: string;
  readonly questionSetDigest: string;
  readonly startedAt: string;
  readonly deadlineAt: string;
}

export interface KnowledgeExamTimeoutReceipt {
  readonly submissionRef: string;
  readonly submittedAt: string;
}

export type KnowledgeExamFinalizationReceipt =
  | {
      readonly status: 'pending_review';
      readonly reviewEvidenceId: string;
      readonly reviewRequestedAt: string;
    }
  | {
      readonly status: 'graded';
      readonly scoreBps: number;
      readonly passed: boolean;
      readonly gradingEvidenceId: string;
      readonly gradedAt: string;
    };

export interface KnowledgeExamOrchestrationInput {
  readonly runId: string;
  readonly tenantId: string;
  readonly assignmentId: string;
  readonly courseVersionId: string;
  readonly attemptNumber: number;
  readonly questionBankRef: string;
  readonly questionBankDigest: string;
  readonly questionMode: 'objective' | 'subjective' | 'mixed';
  readonly gradingPolicyVersion: string;
  readonly passingRule: 'score_threshold' | 'all_required_sections';
  readonly passingScoreBps: number;
  readonly timeLimitMinutes: number;
  readonly manualReviewRequired: boolean;
  readonly gradingSlaMinutes: number;
  readonly manualReviewSlaMinutes: number;
}

export interface KnowledgeSearchHit {
  readonly courseVersionId: string;
  readonly revision: number;
  readonly snippetText: string;
  readonly highlights: readonly {
    readonly start: number;
    readonly end: number;
  }[];
  readonly scoreBps: number;
  readonly indexedAt: string;
}

export interface KnowledgeSearchResult {
  readonly items: readonly KnowledgeSearchHit[];
  readonly nextCursor: string | null;
}

export interface KnowledgeSearchIndexReceipt {
  readonly receiptId: string;
  readonly indexedContentDigest: string;
  readonly indexedAt: string;
}

export abstract class KnowledgeGradingPort {
  /** 实现必须按 submissionRef 幂等，且不得把答案或标准答案返回给应用服务。 */
  abstract grade(input: {
    readonly tenantId: string;
    readonly assignmentId: string;
    readonly courseVersionId: string;
    readonly questionBankRef: string;
    readonly questionBankDigest: string;
    readonly submissionRef: string;
  }): Promise<KnowledgeGradingResult>;
}

export abstract class KnowledgeExamOrchestrationPort {
  /** 创建答题会话；回执只含不透明会话引用和摘要，禁止返回题目或访问令牌。 */
  abstract start(input: KnowledgeExamOrchestrationInput): Promise<KnowledgeExamStartReceipt>;

  /** 到时由隔离评分域封存当前答卷并签发不透明提交引用。 */
  abstract timeout(input: KnowledgeExamOrchestrationInput & {
    readonly gatewaySessionRef: string;
    readonly questionSetDigest: string;
    readonly deadlineAt: string;
  }): Promise<KnowledgeExamTimeoutReceipt>;

  /** 提交或超时终结答题；结果可能进入人工复核，不得返回答案或评分细目。 */
  abstract finalize(input: KnowledgeExamOrchestrationInput & {
    readonly gatewaySessionRef: string;
    readonly questionSetDigest: string;
    readonly submissionRef: string;
    readonly timedOut: boolean;
    readonly submittedAt: string;
  }): Promise<KnowledgeExamFinalizationReceipt>;

  /** 查询人工复核结果；必须按 runId 和会话引用幂等。 */
  abstract status(input: KnowledgeExamOrchestrationInput & {
    readonly gatewaySessionRef: string;
    readonly questionSetDigest: string;
    readonly submissionRef: string;
    readonly reviewEvidenceId: string;
    readonly timedOut: boolean;
    readonly submittedAt: string;
  }): Promise<KnowledgeExamFinalizationReceipt>;
}

export abstract class KnowledgeSearchPort {
  /** 仅传可信授权投影与允许课程集合，禁止向网关透传访问令牌或搜索 DSL。 */
  abstract search(input: {
    readonly tenantId: string;
    readonly employeeId: string;
    readonly departmentIds: readonly string[];
    readonly positionIds: readonly string[];
    readonly allowedCourseVersionIds: readonly string[];
    readonly authorizationDigest: string;
    readonly queryText: string;
    readonly cursor: string | null;
    readonly limit: number;
  }): Promise<KnowledgeSearchResult>;
}

export abstract class KnowledgeSearchIndexPort {
  /** 只发送内容引用与授权投影；搜索网关自行从受信内容域构建或删除索引。 */
  abstract apply(input: {
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
  }): Promise<KnowledgeSearchIndexReceipt>;
}

export abstract class KnowledgeContentVerificationPort {
  abstract verify(course: CourseVersion): Promise<{
    readonly contentVerified: boolean;
    readonly questionBankVerified: boolean;
  }>;
}

/** 未装配真实评分器时失败关闭，禁止使用占位分数推进培训。 */
@Injectable()
export class UnconfiguredKnowledgeGradingAdapter extends KnowledgeGradingPort {
  grade(): Promise<KnowledgeGradingResult> {
    throw new ServiceUnavailableException({
      code: 'KNOWLEDGE_GRADING_ADAPTER_UNAVAILABLE', message: '服务端评分器未配置',
    });
  }
}

/** 未装配内容/题库校验器时禁止发布课程。 */
@Injectable()
export class UnconfiguredKnowledgeContentVerificationAdapter extends KnowledgeContentVerificationPort {
  verify(): Promise<{ readonly contentVerified: boolean; readonly questionBankVerified: boolean }> {
    throw new ServiceUnavailableException({
      code: 'KNOWLEDGE_CONTENT_VERIFIER_UNAVAILABLE', message: '课程内容校验器未配置',
    });
  }
}
