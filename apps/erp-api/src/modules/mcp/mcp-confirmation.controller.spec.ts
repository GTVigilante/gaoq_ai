import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
  RequestMethod,
} from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import type { Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../../core/audit/audit.service.js';
import {
  PUBLIC_ROUTE_KEY,
  RAW_RESPONSE_KEY,
} from '../../core/http/public-route.decorator.js';
import type { ErpRequest } from '../../core/http/request-context.js';
import type { MetricsService } from '../../core/observability/metrics.service.js';
import type { BrowserRefreshCookieService } from '../identity/browser-refresh-cookie.service.js';
import type {
  BrowserOAuthIdentity,
  TokenGrantService,
} from '../identity/token-grant.service.js';
import type { WebAuthnService } from '../identity/strong-auth/webauthn.service.js';
import { McpConfirmationController } from './mcp-confirmation.controller.js';
import type { McpConfirmationService } from './mcp-confirmation.service.js';

const OPERATION_ID = '01J8ZQK7V0A2M4N6P8R0T2W4Y6';
const CEREMONY_ID = '01J8ZQK7V0A2M4N6P8R0T2W4Y7';
const EVIDENCE_ID = 'evidence-001';
const REFRESH_TOKEN = `rt_${'A'.repeat(64)}`;
const CONFIRMATION_CREDENTIAL = `mcpc_${'B'.repeat(43)}`;

const identity: BrowserOAuthIdentity = Object.freeze({
  refreshToken: REFRESH_TOKEN,
  tenantId: 'tenant-001',
  actorId: 'actor-001',
  sessionId: 'session-001',
  roleCodes: [],
  scopes: ['erp:mcp:confirmation:write'],
  departmentIds: [],
});

const authenticationResponse = {
  id: 'credential-001',
  rawId: 'credential-001',
  type: 'public-key',
  clientExtensionResults: {},
  response: {
    authenticatorData: 'authenticator-data',
    clientDataJSON: 'client-data',
    signature: 'signature',
  },
} as AuthenticationResponseJSON;

function responseFixture() {
  const setHeader = vi.fn();
  const status = vi.fn();
  const json = vi.fn();
  const response = { setHeader, status, json } as unknown as Response;
  status.mockReturnValue(response);
  return { response, setHeader, status, json };
}

function requestFixture(): ErpRequest {
  return {
    traceId: 'trace-mcp-confirmation-001',
    header: vi.fn(),
  } as unknown as ErpRequest;
}

function fixture(
  riskLevel: 'R1' | 'R2' = 'R1',
  status: 'pending_confirmation' | 'ready' = 'pending_confirmation',
) {
  const view = Object.freeze({
    operationId: OPERATION_ID,
    operation: 'approval.submit',
    riskLevel,
    digest: 'digest',
    expiresAt: '2026-07-28T04:00:00.000Z',
    status,
    impact: { instanceId: OPERATION_ID },
  });
  const result = Object.freeze({
    operationId: OPERATION_ID,
    confirmationCredential: CONFIRMATION_CREDENTIAL,
    expiresAt: '2026-07-28T04:00:00.000Z',
  });
  const evidence = Object.freeze({
    evidenceId: EVIDENCE_ID,
    method: 'webauthn_uv' as const,
    tenantId: identity.tenantId,
    actorId: identity.actorId,
    sessionId: identity.sessionId,
    operationId: OPERATION_ID,
    verifiedAt: '2026-07-28T03:55:00.000Z',
  });
  const confirmations = {
    describe: vi.fn().mockResolvedValue(view),
    confirm: vi.fn().mockResolvedValue(result),
    confirmR2: vi.fn().mockResolvedValue(result),
  };
  const authenticateBrowserForOAuth = vi.fn().mockResolvedValue(identity);
  const assertTrustedOrigin = vi.fn();
  const readRequired = vi.fn().mockReturnValue(REFRESH_TOKEN);
  const set = vi.fn();
  const recordTrustedUser = vi.fn().mockResolvedValue(undefined);
  const startAuthentication = vi.fn().mockResolvedValue({
    ceremonyId: CEREMONY_ID,
    options: { challenge: 'C'.repeat(43) },
  });
  const finishAuthentication = vi.fn().mockResolvedValue(evidence);
  const recordMcpConfirmation = vi.fn();
  const controller = new McpConfirmationController(
    confirmations as unknown as McpConfirmationService,
    { authenticateBrowserForOAuth } as unknown as TokenGrantService,
    {
      assertTrustedOrigin,
      readRequired,
      set,
    } as unknown as BrowserRefreshCookieService,
    { recordTrustedUser } as unknown as AuditService,
    {
      startAuthentication,
      finishAuthentication,
    } as unknown as WebAuthnService,
    { recordMcpConfirmation } as unknown as MetricsService,
  );
  return {
    controller,
    confirmations,
    authenticateBrowserForOAuth,
    assertTrustedOrigin,
    readRequired,
    set,
    recordTrustedUser,
    startAuthentication,
    finishAuthentication,
    recordMcpConfirmation,
    view,
    result,
    evidence,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('McpConfirmationController', () => {
  it('固定公共原始响应路由与 HTTP 方法契约', () => {
    expect(Reflect.getMetadata(PATH_METADATA, McpConfirmationController))
      .toBe('mcp/confirmations');
    expect(Reflect.getMetadata(PUBLIC_ROUTE_KEY, McpConfirmationController)).toBe(true);
    expect(Reflect.getMetadata(RAW_RESPONSE_KEY, McpConfirmationController)).toBe(true);
    const routes = [
      ['describe', ':operationId', RequestMethod.GET],
      ['confirm', ':operationId/confirm', RequestMethod.POST],
      ['strongAuthOptions', ':operationId/webauthn/options', RequestMethod.POST],
      ['strongAuthVerify', ':operationId/webauthn/verify', RequestMethod.POST],
    ] as const;
    for (const [name, path, method] of routes) {
      const handler = Object.getOwnPropertyDescriptor(
        McpConfirmationController.prototype,
        name,
      )?.value as object;
      expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(path);
      expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(method);
    }
  });

  it('描述入口只接受可信 Origin 与 HttpOnly 会话并禁止缓存', async () => {
    const store = fixture();
    const request = requestFixture();
    const response = responseFixture();

    await store.controller.describe(OPERATION_ID, request, response.response);

    expect(store.assertTrustedOrigin).toHaveBeenCalledWith(request);
    expect(store.readRequired).toHaveBeenCalledWith(request);
    expect(store.authenticateBrowserForOAuth).toHaveBeenCalledWith(REFRESH_TOKEN);
    expect(store.set).toHaveBeenCalledWith(response.response, identity.refreshToken);
    expect(store.confirmations.describe).toHaveBeenCalledWith(OPERATION_ID, identity);
    expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.json).toHaveBeenCalledWith(store.view);
  });

  it('Origin 拒绝发生在 Cookie 读取和会话认证之前', async () => {
    const store = fixture();
    const rejection = new ForbiddenException({
      code: 'AUTH_ORIGIN_REJECTED',
      message: '请求来源不受信任',
    });
    store.assertTrustedOrigin.mockImplementation(() => {
      throw rejection;
    });

    await expect(store.controller.describe(
      OPERATION_ID,
      requestFixture(),
      responseFixture().response,
    )).rejects.toBe(rejection);

    expect(store.readRequired).not.toHaveBeenCalled();
    expect(store.authenticateBrowserForOAuth).not.toHaveBeenCalled();
    expect(store.set).not.toHaveBeenCalled();
  });

  it('会话认证失败时不轮换浏览器 Cookie', async () => {
    const store = fixture();
    const rejection = new Error('session rejected');
    store.authenticateBrowserForOAuth.mockRejectedValue(rejection);

    await expect(store.controller.describe(
      OPERATION_ID,
      requestFixture(),
      responseFixture().response,
    )).rejects.toBe(rejection);

    expect(store.set).not.toHaveBeenCalled();
    expect(store.confirmations.describe).not.toHaveBeenCalled();
  });

  it('R1 确认使用显式可信用户上下文审计并返回一次性凭据', async () => {
    const store = fixture();
    const response = responseFixture();

    await store.controller.confirm(
      OPERATION_ID,
      requestFixture(),
      response.response,
    );

    expect(store.confirmations.confirm).toHaveBeenCalledWith(OPERATION_ID, identity);
    expect(store.recordTrustedUser).toHaveBeenCalledWith(identity.tenantId, {
      action: 'mcp.confirmation.confirm',
      resourceType: 'mcp_confirmation',
      resourceId: OPERATION_ID,
      riskLevel: 'R1',
      outcome: 'success',
      actorId: identity.actorId,
      traceId: identity.sessionId,
    });
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.json).toHaveBeenCalledWith(store.result);
  });

  it('R1 确认提交后的审计故障只告警且不反向暴露失败', async () => {
    const store = fixture();
    store.recordTrustedUser.mockRejectedValue(new Error('audit unavailable'));
    const logger = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const response = responseFixture();

    await store.controller.confirm(
      OPERATION_ID,
      requestFixture(),
      response.response,
    );

    expect(response.status).toHaveBeenCalledWith(200);
    expect(logger).toHaveBeenCalledWith({
      code: 'MCP_CONFIRMATION_AUDIT_AFTER_DECISION_FAILED',
      tenantId: identity.tenantId,
    });
  });

  it('R1 确认失败且审计不可用时保留原始业务异常', async () => {
    const store = fixture();
    const failure = new ConflictException({
      code: 'MCP_CONFIRMATION_RACE',
      message: '确认状态已变化',
    });
    store.confirmations.confirm.mockRejectedValue(failure);
    store.recordTrustedUser.mockRejectedValue(new Error('audit unavailable'));
    const logger = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    await expect(store.controller.confirm(
      OPERATION_ID,
      requestFixture(),
      responseFixture().response,
    )).rejects.toBe(failure);

    expect(store.recordTrustedUser).toHaveBeenCalledWith(
      identity.tenantId,
      expect.objectContaining({ outcome: 'failure', riskLevel: 'R1' }),
    );
    expect(logger).toHaveBeenCalledWith({
      code: 'MCP_CONFIRMATION_FAILURE_AUDIT_FAILED',
      tenantId: identity.tenantId,
    });
  });

  it('R2 强认证选项只为待确认操作生成', async () => {
    const store = fixture('R2');
    const response = responseFixture();

    await store.controller.strongAuthOptions(
      OPERATION_ID,
      requestFixture(),
      response.response,
    );

    expect(store.startAuthentication).toHaveBeenCalledWith(identity, OPERATION_ID);
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.json).toHaveBeenCalledWith({
      ceremonyId: CEREMONY_ID,
      options: { challenge: 'C'.repeat(43) },
    });
  });

  it.each([
    ['R1 操作', 'R1', 'pending_confirmation'],
    ['非待确认 R2 操作', 'R2', 'ready'],
  ] as const)('强认证选项拒绝%s并写失败审计', async (_name, riskLevel, status) => {
    const store = fixture(riskLevel, status);

    await expect(store.controller.strongAuthOptions(
      OPERATION_ID,
      requestFixture(),
      responseFixture().response,
    )).rejects.toBeInstanceOf(ConflictException);

    expect(store.startAuthentication).not.toHaveBeenCalled();
    expect(store.recordMcpConfirmation).toHaveBeenCalledWith(
      'confirm', 'R2', 'denied',
    );
    expect(store.recordTrustedUser).toHaveBeenCalledWith(
      identity.tenantId,
      expect.objectContaining({
        action: 'mcp.confirmation.strong_auth',
        outcome: 'failure',
      }),
    );
  });

  it('强认证选项生成失败且审计不可用时保留原始异常', async () => {
    const store = fixture('R2');
    const failure = new Error('webauthn unavailable');
    store.startAuthentication.mockRejectedValue(failure);
    store.recordTrustedUser.mockRejectedValue(new Error('audit unavailable'));
    const logger = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    await expect(store.controller.strongAuthOptions(
      OPERATION_ID,
      requestFixture(),
      responseFixture().response,
    )).rejects.toBe(failure);

    expect(store.recordMcpConfirmation).toHaveBeenCalledWith(
      'confirm', 'R2', 'denied',
    );
    expect(logger).toHaveBeenCalledWith({
      code: 'MCP_STRONG_AUTH_FAILURE_AUDIT_FAILED',
      tenantId: identity.tenantId,
    });
  });

  it.each([
    ['R1 状态', 'R1', 'pending_confirmation', CEREMONY_ID, authenticationResponse],
    ['已决定状态', 'R2', 'ready', CEREMONY_ID, authenticationResponse],
    ['缺失仪式标识', 'R2', 'pending_confirmation', undefined, authenticationResponse],
    ['缺失断言响应', 'R2', 'pending_confirmation', CEREMONY_ID, undefined],
  ] as const)(
    '强认证验证拒绝%s且不消费仪式',
    async (_name, riskLevel, status, ceremonyId, assertion) => {
      const store = fixture(riskLevel, status);
      const body = {
        ...(ceremonyId === undefined ? {} : { ceremonyId }),
        ...(assertion === undefined ? {} : { response: assertion }),
      };

      await expect(store.controller.strongAuthVerify(
        OPERATION_ID,
        body,
        requestFixture(),
        responseFixture().response,
      )).rejects.toBeInstanceOf(BadRequestException);

      expect(store.finishAuthentication).not.toHaveBeenCalled();
      expect(store.confirmations.confirmR2).not.toHaveBeenCalled();
      expect(store.recordMcpConfirmation).toHaveBeenCalledWith(
        'confirm', 'R2', 'denied',
      );
      expect(store.recordTrustedUser).toHaveBeenCalledWith(
        identity.tenantId,
        expect.objectContaining({ outcome: 'failure' }),
      );
    },
  );

  it('R2 强认证验证绑定仪式证据并使用显式可信用户审计', async () => {
    const store = fixture('R2');
    const response = responseFixture();

    await store.controller.strongAuthVerify(
      OPERATION_ID,
      { ceremonyId: CEREMONY_ID, response: authenticationResponse },
      requestFixture(),
      response.response,
    );

    expect(store.finishAuthentication).toHaveBeenCalledWith(
      identity,
      OPERATION_ID,
      CEREMONY_ID,
      authenticationResponse,
    );
    expect(store.confirmations.confirmR2).toHaveBeenCalledWith(
      OPERATION_ID,
      identity,
      store.evidence,
    );
    expect(store.recordTrustedUser).toHaveBeenCalledWith(identity.tenantId, {
      action: 'mcp.confirmation.strong_auth',
      resourceType: 'mcp_confirmation',
      resourceId: OPERATION_ID,
      riskLevel: 'R2',
      outcome: 'success',
      actorId: identity.actorId,
      traceId: identity.sessionId,
      metadata: {
        method: 'webauthn_uv',
        evidenceId: EVIDENCE_ID,
      },
    });
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.json).toHaveBeenCalledWith(store.result);
  });

  it('R2 确认提交后的审计故障不覆盖已生成的一次性凭据', async () => {
    const store = fixture('R2');
    store.recordTrustedUser.mockRejectedValue(new Error('audit unavailable'));
    const logger = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const response = responseFixture();

    await store.controller.strongAuthVerify(
      OPERATION_ID,
      { ceremonyId: CEREMONY_ID, response: authenticationResponse },
      requestFixture(),
      response.response,
    );

    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.json).toHaveBeenCalledWith(store.result);
    expect(logger).toHaveBeenCalledWith({
      code: 'MCP_STRONG_AUTH_AUDIT_AFTER_DECISION_FAILED',
      tenantId: identity.tenantId,
    });
  });

  it.each(['finish', 'confirm'] as const)(
    'R2 %s 失败且审计不可用时保留原始异常',
    async (stage) => {
      const store = fixture('R2');
      const failure = new Error(`${stage} failed`);
      if (stage === 'finish') {
        store.finishAuthentication.mockRejectedValue(failure);
      } else {
        store.confirmations.confirmR2.mockRejectedValue(failure);
      }
      store.recordTrustedUser.mockRejectedValue(new Error('audit unavailable'));
      const logger = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      await expect(store.controller.strongAuthVerify(
        OPERATION_ID,
        { ceremonyId: CEREMONY_ID, response: authenticationResponse },
        requestFixture(),
        responseFixture().response,
      )).rejects.toBe(failure);

      expect(store.recordMcpConfirmation).toHaveBeenCalledWith(
        'confirm', 'R2', 'denied',
      );
      expect(logger).toHaveBeenCalledWith({
        code: 'MCP_STRONG_AUTH_FAILURE_AUDIT_FAILED',
        tenantId: identity.tenantId,
      });
    },
  );
});
