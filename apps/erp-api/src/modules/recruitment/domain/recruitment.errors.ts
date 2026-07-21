/** 招聘领域稳定错误；接入层只映射错误码，不泄漏候选人数据。 */
export class RecruitmentDomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RecruitmentDomainError';
  }
}
