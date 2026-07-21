/** 组织领域错误码，供上层映射为业务异常。 */
export type OrgErrorCode =
  | 'INVALID_TENANT'
  | 'INVALID_ID'
  | 'INVALID_CODE'
  | 'INVALID_NAME'
  | 'INVALID_SORT_ORDER'
  | 'SELF_PARENT'
  | 'CROSS_TENANT'
  | 'INVALID_STATUS'
  | 'INVALID_STATUS_TRANSITION'
  | 'TERMINATED_IRREVERSIBLE'
  | 'PRIMARY_DEPARTMENT_NOT_MEMBER'
  | 'EMPTY_DEPARTMENT_IDS'
  | 'INVALID_TRACK'
  | 'INVALID_RANK'
  | 'INVALID_TIME'
  | 'PERSON_EVIDENCE_INVALID'
  | 'EMPLOYMENT_EFFECTIVE_DATE_INVALID'
  | 'EMPLOYMENT_CROSS_TENANT'
  | 'EMPLOYMENT_VERSION_CONFLICT'
  | 'EMPLOYMENT_ALREADY_TERMINATED'
  | 'EMPLOYMENT_END_BEFORE_START'
  | 'EMPLOYMENT_STATUS_TRANSITION_INVALID'
  | 'IMMUTABLE_FIELD';

/** 组织领域错误；纯领域层不依赖 Nest 异常体系。 */
export class OrgDomainError extends Error {
  /** 机器可读错误码。 */
  readonly code: OrgErrorCode;

  constructor(code: OrgErrorCode, message: string) {
    super(message);
    this.name = 'OrgDomainError';
    this.code = code;
  }
}
