import { Injectable, ServiceUnavailableException } from '@nestjs/common';

import type { CourseVersion } from '../domain/index.js';

export interface KnowledgeGradingResult {
  readonly scoreBps: number;
  readonly questionBankDigest: string;
  readonly questionSetDigest: string;
  readonly gradingEvidenceId: string;
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
