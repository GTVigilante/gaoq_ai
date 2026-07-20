/** 统一错误字段明细，禁止包含敏感明文。 */
export interface ErrorDetail {
  /** 请求字段或业务对象路径。 */
  readonly field?: string;
  /** 可选的稳定错误码。 */
  readonly code?: string;
  /** 面向调用方的中文错误说明。 */
  readonly message: string;
}

/** 错误响应中的结构化数据。 */
export interface ApiErrorData {
  readonly errors: readonly ErrorDetail[];
}

/** 所有 HTTP 响应共享的可观测字段。 */
export interface ApiResponseBase {
  /** 稳定业务状态码。 */
  readonly code: string;
  /** 面向调用方的中文说明。 */
  readonly message: string;
  /** 当前请求的追踪标识。 */
  readonly traceId: string;
  /** 响应生成时间，UTC ISO 8601。 */
  readonly timestamp: string;
}

/** 统一成功响应信封，与 PRD 的 REST 契约保持一致。 */
export interface ApiSuccessResponse<TData> extends ApiResponseBase {
  readonly data: TData;
}

/** 统一失败响应信封。 */
export interface ApiErrorResponse extends ApiResponseBase {
  readonly data: ApiErrorData | null;
}

/** 统一 API 响应信封。 */
export type ApiResponse<TData> = ApiSuccessResponse<TData> | ApiErrorResponse;
