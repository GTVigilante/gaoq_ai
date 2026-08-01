import type { NextFunction, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

import type { ErpRequest } from './request-context.js';
import { TraceMiddleware } from './trace.middleware.js';

describe('TraceMiddleware', () => {
  it('保留规范外部追踪标识并回写响应头', () => {
    const request = {
      header: vi.fn().mockReturnValue('external-trace_1.0'),
    } as unknown as ErpRequest;
    const setHeader = vi.fn();
    const response = { setHeader } as unknown as Response;
    const next = vi.fn() as NextFunction;

    new TraceMiddleware().use(request, response, next);

    expect(request.traceId).toBe('external-trace_1.0');
    expect(setHeader).toHaveBeenCalledWith('x-trace-id', 'external-trace_1.0');
    expect(next).toHaveBeenCalledOnce();
  });

  it('拒绝非法或缺失外部值并生成服务端追踪标识', () => {
    for (const external of ['trace with space', undefined]) {
      const request = {
        header: vi.fn().mockReturnValue(external),
      } as unknown as ErpRequest;
      const setHeader = vi.fn();
      const response = { setHeader } as unknown as Response;
      const next = vi.fn() as NextFunction;

      new TraceMiddleware().use(request, response, next);

      expect(request.traceId).toMatch(/^[A-Za-z0-9._-]{1,64}$/);
      expect(request.traceId).not.toBe(external);
      expect(setHeader).toHaveBeenCalledWith('x-trace-id', request.traceId);
      expect(next).toHaveBeenCalledOnce();
    }
  });
});
