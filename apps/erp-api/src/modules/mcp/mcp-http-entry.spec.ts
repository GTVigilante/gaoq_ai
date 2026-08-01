import { ForbiddenException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

import type { ErpRequest } from '../../core/http/request-context.js';
import { REQUIRED_SCOPES_KEY } from '../identity/auth.decorators.js';
import { McpOriginGuard } from './mcp-origin.guard.js';
import type { McpRuntimeService } from './mcp-runtime.service.js';
import { McpController } from './mcp.controller.js';

function requestFixture(path: string, origin?: string): ErpRequest {
  return {
    path,
    header: vi.fn((name: string) => name === 'origin' ? origin : undefined),
  } as unknown as ErpRequest;
}

function contextFixture(request: ErpRequest): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;
}

describe('McpOriginGuard', () => {
  it.each(['/mcp', '/mcp/'])('在认证前校验 %s 的精确 Origin', (path) => {
    const request = requestFixture(path, 'https://agent.example.com');
    const isOriginAllowed = vi.fn().mockReturnValue(true);
    const guard = new McpOriginGuard({
      isOriginAllowed,
    } as unknown as McpRuntimeService);

    expect(guard.canActivate(contextFixture(request))).toBe(true);
    expect(isOriginAllowed).toHaveBeenCalledWith('https://agent.example.com');
  });

  it('缺失或不可信 MCP Origin 失败关闭', () => {
    const request = requestFixture('/mcp');
    const isOriginAllowed = vi.fn().mockReturnValue(false);
    const guard = new McpOriginGuard({
      isOriginAllowed,
    } as unknown as McpRuntimeService);

    expect(() => guard.canActivate(contextFixture(request))).toThrow(ForbiddenException);
  });

  it('非 MCP 路由不调用 MCP Origin 策略', () => {
    const request = requestFixture('/api/org/me', 'https://untrusted.example.com');
    const isOriginAllowed = vi.fn();
    const guard = new McpOriginGuard({
      isOriginAllowed,
    } as unknown as McpRuntimeService);

    expect(guard.canActivate(contextFixture(request))).toBe(true);
    expect(isOriginAllowed).not.toHaveBeenCalled();
  });
});

describe('McpController', () => {
  it('声明标准 MCP 连接 Scope', () => {
    const handle = Object.getOwnPropertyDescriptor(
      McpController.prototype,
      'handle',
    )?.value as object;
    expect(Reflect.getMetadata(
      REQUIRED_SCOPES_KEY,
      handle,
    )).toEqual(['erp:mcp:server:connect']);
  });

  it('可信 Origin 才转交标准 MCP 运行时', async () => {
    const request = requestFixture('/mcp', 'https://agent.example.com');
    const response = {} as Response;
    const runtime = {
      isOriginAllowed: vi.fn().mockReturnValue(true),
      handle: vi.fn().mockResolvedValue(undefined),
    };
    const controller = new McpController(runtime as unknown as McpRuntimeService);

    await controller.handle(request, response);

    expect(runtime.isOriginAllowed).toHaveBeenCalledWith('https://agent.example.com');
    expect(runtime.handle).toHaveBeenCalledWith(request, response);
  });

  it('控制器二次拒绝不可信 Origin 且不启动 MCP 运行时', async () => {
    const request = requestFixture('/mcp', 'https://untrusted.example.com');
    const runtime = {
      isOriginAllowed: vi.fn().mockReturnValue(false),
      handle: vi.fn(),
    };
    const controller = new McpController(runtime as unknown as McpRuntimeService);

    await expect(controller.handle(
      request,
      {} as Response,
    )).rejects.toBeInstanceOf(ForbiddenException);
    expect(runtime.handle).not.toHaveBeenCalled();
  });
});
