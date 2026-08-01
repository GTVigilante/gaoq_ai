/** 审批领域稳定错误；应用层负责映射为 HTTP/MCP 错误。 */
export class ApprovalDomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApprovalDomainError';
  }
}
