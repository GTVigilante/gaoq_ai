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
    if (!known) this.logger.error('OAuth 协议端点发生未处理异常');
    response.setHeader('Cache-Control', 'no-store');
    response.status(status).json({ error: known ? 'invalid_request' : 'server_error' });
  }
}
