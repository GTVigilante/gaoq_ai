import {
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Response } from 'express';

/** 将 token endpoint 的管道异常收敛为 RFC OAuth 错误对象，禁止泄露内部校验细节。 */
@Catch()
export class OAuthProtocolExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(OAuthProtocolExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const known = exception instanceof HttpException;
    const status = known && exception.getStatus() === 429
      ? HttpStatus.TOO_MANY_REQUESTS
      : known
        ? HttpStatus.BAD_REQUEST
        : HttpStatus.INTERNAL_SERVER_ERROR;
    if (!known) {
      this.logger.error(`OAuth 协议端点发生未处理异常 failure=${this.safeFailureCode(exception)}`);
    }
    response.setHeader('Cache-Control', 'no-store');
    response.status(status).json({ error: known ? 'invalid_request' : 'server_error' });
  }

  /** 只记录异常类型或稳定内部错误码，禁止把凭据、载荷和自由文本写入协议日志。 */
  private safeFailureCode(exception: unknown): string {
    if (!(exception instanceof Error)) return 'UNKNOWN';
    if (/^[A-Z][A-Z0-9_]{2,63}$/.test(exception.message)) return exception.message;
    const name = /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(exception.name)
      ? exception.name
      : 'UNKNOWN';
    const code = (exception as Error & { readonly code?: unknown }).code;
    return typeof code === 'number' && Number.isSafeInteger(code)
      ? `${name}_${code}`
      : name;
  }
}
