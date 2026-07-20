import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { firstValueFrom, of } from 'rxjs';
import { describe, expect, it } from 'vitest';

import { ApiResponseInterceptor } from './api-response.interceptor.js';

const handler = (): void => undefined;
class TestController {}

describe('ApiResponseInterceptor', () => {
  it('按 PRD 契约包装成功响应', async () => {
    const context = {
      getHandler: () => handler,
      getClass: () => TestController,
      switchToHttp: () => ({ getRequest: () => ({ traceId: 'trace-001' }) }),
    } as unknown as ExecutionContext;
    const next: CallHandler<{ id: string }> = { handle: () => of({ id: 'record-001' }) };
    const interceptor = new ApiResponseInterceptor<{ id: string }>(new Reflector());

    const response = await firstValueFrom(interceptor.intercept(context, next));

    expect(response).toMatchObject({
      code: 'SUCCESS',
      message: '成功',
      data: { id: 'record-001' },
      traceId: 'trace-001',
    });
    expect(response.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
