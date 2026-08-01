import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Logger,
  type ArgumentsHost,
} from '@nestjs/common';
import type { Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

import { OAuthProtocolExceptionFilter } from './oauth-protocol-exception.filter.js';

const fixture = () => {
  const status = vi.fn();
  const json = vi.fn();
  const setHeader = vi.fn();
  const response = { status, json, setHeader } as unknown as Response;
  status.mockReturnValue(response);
  const host = {
    switchToHttp: () => ({ getResponse: () => response }),
  } as unknown as ArgumentsHost;
  return { response, status, json, setHeader, host };
};

describe('OAuthProtocolExceptionFilter', () => {
  it('将 ValidationPipe 等 HTTP 异常收敛为 invalid_request', () => {
    const store = fixture();

    new OAuthProtocolExceptionFilter().catch(new BadRequestException(['invalid']), store.host);

    expect(store.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(store.status).toHaveBeenCalledWith(400);
    expect(store.json).toHaveBeenCalledWith({ error: 'invalid_request' });
  });

  it('未知异常不泄露细节并返回 server_error', () => {
    const store = fixture();
    const log = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    new OAuthProtocolExceptionFilter().catch(new Error('secret detail'), store.host);

    expect(store.status).toHaveBeenCalledWith(500);
    expect(store.json).toHaveBeenCalledWith({ error: 'server_error' });
    expect(log).toHaveBeenCalledWith(
      'OAuth 协议端点发生未处理异常 failure=Error',
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret detail');
    log.mockRestore();
  });

  it('保留 429 状态且覆盖所有安全故障码归一化分支', () => {
    const limited = fixture();
    new OAuthProtocolExceptionFilter().catch(
      new HttpException('limited', HttpStatus.TOO_MANY_REQUESTS),
      limited.host,
    );
    expect(limited.status).toHaveBeenCalledWith(429);
    expect(limited.json).toHaveBeenCalledWith({ error: 'invalid_request' });

    const log = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    for (const exception of [
      'not-an-error',
      new Error('STABLE_INTERNAL_CODE'),
      Object.assign(new Error('free text'), { name: '<unsafe>', code: 17 }),
    ]) {
      new OAuthProtocolExceptionFilter().catch(exception, fixture().host);
    }
    expect(log).toHaveBeenCalledWith(expect.stringContaining('failure=UNKNOWN'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('failure=STABLE_INTERNAL_CODE'));
    log.mockRestore();
  });
});
