import { BadRequestException, Logger } from '@nestjs/common';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import type { Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../../../core/audit/audit.service.js';
import type { ErpRequest } from '../../../core/http/request-context.js';
import type { BrowserRefreshCookieService } from '../browser-refresh-cookie.service.js';
import type { BrowserOAuthIdentity, TokenGrantService } from '../token-grant.service.js';
import { PasskeyRegistrationController } from './passkey-registration.controller.js';
import type { WebAuthnService } from './webauthn.service.js';

const CREDENTIAL_ID = 'credential_1234567890';
const CEREMONY_ID = '01J8ZQK7V0A2M4N6P8R0T2W4Y6';
const identity: BrowserOAuthIdentity = {
  refreshToken: `rt_${'A'.repeat(64)}`,
  tenantId: 'tenant-001',
  actorId: 'actor-001',
  sessionId: 'session-001',
  roleCodes: [],
  scopes: ['erp:identity:passkey:manage'],
  departmentIds: [],
};

function responseFixture() {
  const status = vi.fn();
  const json = vi.fn();
  const send = vi.fn();
  const setHeader = vi.fn();
  const response = { status, json, send, setHeader } as unknown as Response;
  status.mockReturnValue(response);
  return { response, status, json, send, setHeader };
}

function requestFixture(): ErpRequest {
  return {
    traceId: 'trace-passkey-001',
    header: vi.fn(),
  } as unknown as ErpRequest;
}

function registrationResponse(): RegistrationResponseJSON {
  return {
    id: CREDENTIAL_ID,
    rawId: CREDENTIAL_ID,
    type: 'public-key',
    clientExtensionResults: {},
    response: {
      attestationObject: 'attestation-object',
      clientDataJSON: 'client-data',
    },
  };
}

function fixture() {
  const listCredentials = vi.fn().mockResolvedValue([{
    credentialId: CREDENTIAL_ID,
    deviceType: 'multiDevice',
    backedUp: true,
    createdAt: '2026-07-01T00:00:00.000Z',
    lastUsedAt: null,
  }]);
  const startRegistration = vi.fn().mockResolvedValue({
    ceremonyId: CEREMONY_ID,
    options: { challenge: 'a'.repeat(43) },
  });
  const finishRegistration = vi.fn().mockResolvedValue({
    credentialId: CREDENTIAL_ID,
    deviceType: 'multiDevice',
    backedUp: true,
  });
  const revokeCredential = vi.fn().mockResolvedValue(undefined);
  const authenticateBrowserForOAuth = vi.fn().mockResolvedValue(identity);
  const assertTrustedOrigin = vi.fn();
  const readRequired = vi.fn().mockReturnValue(`rt_${'B'.repeat(64)}`);
  const set = vi.fn();
  const recordTrustedUser = vi.fn().mockResolvedValue(undefined);
  const controller = new PasskeyRegistrationController(
    {
      listCredentials,
      startRegistration,
      finishRegistration,
      revokeCredential,
    } as unknown as WebAuthnService,
    { authenticateBrowserForOAuth } as unknown as TokenGrantService,
    { assertTrustedOrigin, readRequired, set } as unknown as BrowserRefreshCookieService,
    { recordTrustedUser } as unknown as AuditService,
  );
  return {
    controller,
    listCredentials,
    startRegistration,
    finishRegistration,
    revokeCredential,
    authenticateBrowserForOAuth,
    assertTrustedOrigin,
    readRequired,
    set,
    recordTrustedUser,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PasskeyRegistrationController', () => {
  it('凭据列表只使用可信 HttpOnly 会话并返回最小投影', async () => {
    const store = fixture();
    const request = requestFixture();
    const response = responseFixture();

    await store.controller.list(request, response.response);

    expect(store.assertTrustedOrigin).toHaveBeenCalledWith(request);
    expect(store.authenticateBrowserForOAuth).toHaveBeenCalledWith(`rt_${'B'.repeat(64)}`);
    expect(store.set).toHaveBeenCalledWith(response.response, identity.refreshToken);
    expect(store.listCredentials).toHaveBeenCalledWith(identity);
    expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.json).toHaveBeenCalledWith({
      items: [expect.objectContaining({ credentialId: CREDENTIAL_ID })],
    });
  });

  it('登记选项绑定可信身份并返回短时仪式', async () => {
    const store = fixture();
    const response = responseFixture();

    await store.controller.options(requestFixture(), response.response);

    expect(store.startRegistration).toHaveBeenCalledWith(identity);
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.json).toHaveBeenCalledWith({
      ceremonyId: CEREMONY_ID,
      options: { challenge: 'a'.repeat(43) },
    });
  });

  it('登记验证拒绝不完整正文且不调用服务', async () => {
    const store = fixture();

    await expect(store.controller.verify(
      {},
      requestFixture(),
      responseFixture().response,
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(store.finishRegistration).not.toHaveBeenCalled();
  });

  it('登记成功写 R2 审计并返回凭据元数据', async () => {
    const store = fixture();
    const response = responseFixture();
    const credentialResponse = registrationResponse();

    await store.controller.verify({
      ceremonyId: CEREMONY_ID,
      response: credentialResponse,
    }, requestFixture(), response.response);

    expect(store.finishRegistration).toHaveBeenCalledWith(
      identity,
      CEREMONY_ID,
      credentialResponse,
    );
    expect(store.recordTrustedUser).toHaveBeenCalledWith(identity.tenantId, {
      action: 'identity.passkey.register',
      resourceType: 'identity_actor',
      resourceId: identity.actorId,
      riskLevel: 'R2',
      outcome: 'success',
      actorId: identity.actorId,
      traceId: identity.sessionId,
      metadata: { method: 'webauthn_uv' },
    });
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      credentialId: CREDENTIAL_ID,
    }));
  });

  it('登记提交后的审计故障只告警，不反向暴露为失败', async () => {
    const store = fixture();
    store.recordTrustedUser.mockRejectedValue(new Error('audit unavailable'));
    const logger = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const response = responseFixture();

    await store.controller.verify({
      ceremonyId: CEREMONY_ID,
      response: registrationResponse(),
    }, requestFixture(), response.response);

    expect(response.status).toHaveBeenCalledWith(200);
    expect(logger).toHaveBeenCalledWith({
      code: 'PASSKEY_REGISTRATION_AUDIT_AFTER_COMMIT_FAILED',
      tenantId: identity.tenantId,
    });
  });

  it('登记失败审计不可用时保留原始业务异常', async () => {
    const store = fixture();
    const failure = new BadRequestException({
      code: 'PASSKEY_REGISTRATION_INVALID',
      message: '登记失败',
    });
    store.finishRegistration.mockRejectedValue(failure);
    store.recordTrustedUser.mockRejectedValue(new Error('audit unavailable'));
    const logger = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    await expect(store.controller.verify({
      ceremonyId: CEREMONY_ID,
      response: registrationResponse(),
    }, requestFixture(), responseFixture().response)).rejects.toBe(failure);

    expect(store.recordTrustedUser).toHaveBeenCalledWith(identity.tenantId, expect.objectContaining({
      action: 'identity.passkey.register',
      outcome: 'failure',
    }));
    expect(logger).toHaveBeenCalledWith({
      code: 'PASSKEY_REGISTRATION_FAILURE_AUDIT_FAILED',
      tenantId: identity.tenantId,
    });
  });

  it('撤销成功写 R2 审计并返回 204', async () => {
    const store = fixture();
    const response = responseFixture();

    await store.controller.revoke(CREDENTIAL_ID, requestFixture(), response.response);

    expect(store.revokeCredential).toHaveBeenCalledWith(identity, CREDENTIAL_ID);
    expect(store.recordTrustedUser).toHaveBeenCalledWith(identity.tenantId, expect.objectContaining({
      action: 'identity.passkey.revoke',
      resourceType: 'identity_passkey',
      resourceId: CREDENTIAL_ID,
      outcome: 'success',
    }));
    expect(response.status).toHaveBeenCalledWith(204);
    expect(response.send).toHaveBeenCalled();
  });

  it('撤销失败或提交后审计故障均保持真实业务终态', async () => {
    const failedStore = fixture();
    const failure = new BadRequestException({
      code: 'PASSKEY_NOT_FOUND',
      message: '凭据不存在',
    });
    failedStore.revokeCredential.mockRejectedValue(failure);
    failedStore.recordTrustedUser.mockRejectedValue(new Error('audit unavailable'));
    const logger = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    await expect(failedStore.controller.revoke(
      CREDENTIAL_ID,
      requestFixture(),
      responseFixture().response,
    )).rejects.toBe(failure);
    expect(logger).toHaveBeenCalledWith({
      code: 'PASSKEY_REVOCATION_FAILURE_AUDIT_FAILED',
      tenantId: identity.tenantId,
    });

    const successStore = fixture();
    successStore.recordTrustedUser.mockRejectedValue(new Error('audit unavailable'));
    const response = responseFixture();
    await successStore.controller.revoke(CREDENTIAL_ID, requestFixture(), response.response);
    expect(response.status).toHaveBeenCalledWith(204);
    expect(logger).toHaveBeenCalledWith({
      code: 'PASSKEY_REVOCATION_AUDIT_AFTER_COMMIT_FAILED',
      tenantId: identity.tenantId,
    });
  });
});
