import type { RecruitmentResumeTagDefinition } from './recruitment-resume.taxonomy.js';

export interface RedactedResumeText {
  readonly candidateId: string;
  readonly resumeEvidenceId: string;
  readonly sourceChecksum: string;
  readonly mimeType:
    | 'application/pdf'
    | 'application/msword'
    | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    | 'text/plain';
  readonly text: string;
}

/** 隔离附件网关端口；网关必须先校验归属、扫描恶意文件并去除直接身份信息。 */
export abstract class RecruitmentResumeSourceGateway {
  abstract readRedactedText(input: {
    readonly tenantId: string;
    readonly candidateId: string;
    readonly resumeEvidenceId: string;
  }): Promise<RedactedResumeText>;
}

export interface RecruitmentResumeAiResult {
  readonly model: string;
  readonly headline: string;
  readonly summary: string;
  readonly yearsExperience: number;
  readonly educationLevel:
    | 'unknown' | 'high_school' | 'associate' | 'bachelor' | 'master' | 'doctorate';
  readonly skills: readonly string[];
  readonly jobTitles: readonly string[];
  readonly industries: readonly string[];
  readonly languages: readonly string[];
  readonly tags: readonly {
    readonly code: string;
    readonly confidence: number;
    readonly evidence: string;
  }[];
}

/** AI 只接收已去标识化文本与受控词表，不访问数据库，也不执行候选人状态变更。 */
export abstract class RecruitmentResumeAiAnalyzer {
  abstract analyze(input: {
    readonly redactedText: string;
    readonly taxonomy: readonly RecruitmentResumeTagDefinition[];
    /** 租户与候选人引用的单向摘要，不得发送 ERP 标识原文。 */
    readonly safetyIdentifier: string;
  }): Promise<RecruitmentResumeAiResult>;
}
