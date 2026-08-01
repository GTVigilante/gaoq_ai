import { ConfigService } from '@nestjs/config';
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type { Connection, Model } from 'mongoose';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const webauthn = vi.hoisted(() => ({
  generateAuthenticationOptions: vi.fn(),
  generateRegistrationOptions: vi.fn(),
  verifyAuthenticationResponse: vi.fn(),
  verifyRegistrationResponse: vi.fn(),
}));

vi.mock('@simplewebauthn/server', () => webauthn);

import type { AppEnvironment } from '../../../config/environment.js';
import type { BrowserOAuthIdentity } from '../token-grant.service.js';
import type {
  WebAuthnCeremonyDocument,
  WebAuthnCredentialDocument,
} from './webauthn.schemas.js';
import { WebAuthnService } from './webauthn.service.js';

const OPERATION_ID = '01J8ZQK7V0A2M4N6P8R0T2W4Y7';
const CEREMONY_ID = '01J8ZQK7V0A2M4N6P8R0T2W4Y6';
const CREDENTIAL_ID = 'credential_1234567890';
const identity: BrowserOAuthIdentity = {
  refreshToken: 'redacted',
  tenantId: 'tenant-001',
  actorId: 'actor-001',
  sessionId: 'session-001',
  roleCodes: [],
  scopes: ['erp:identity:passkey:manage'],
  departmentIds: [],
};

function query<T>(value: T) {
  return { lean: () => ({ exec: () => Promise.resolve(value) }) };
}

function createService(
  credentials: Record<string, unknown>,
  ceremonies: Record<string, unknown>,
  connection?: Connection,
): WebAuthnService {
  const defaultConnection = {
    transaction: async (work: (session: object) => Promise<void>) => work({ id: 'session' }),
  } as unknown as Connection;
  return new WebAuthnService(
    connection ?? defaultConnection,
    credentials as unknown as Model<WebAuthnCredentialDocument>,
    ceremonies as unknown as Model<WebAuthnCeremonyDocument>,
    new ConfigService<AppEnvironment, true>({ WEB_ORIGIN: 'https://erp.example.com' } as AppEnvironment),
  );
}

function registrationResponse(
  transports?: RegistrationResponseJSON['response']['transports'],
): RegistrationResponseJSON {
  return {
    id: CREDENTIAL_ID,
    rawId: CREDENTIAL_ID,
    type: 'public-key',
    clientExtensionResults: {},
    response: {
      attestationObject: 'attestation-object',
      clientDataJSON: 'client-data',
      ...(transports === undefined ? {} : { transports }),
    },
  };
}

function authenticationResponse(
  id = CREDENTIAL_ID,
): AuthenticationResponseJSON {
  return {
    id,
    rawId: id,
    type: 'public-key',
    clientExtensionResults: {},
    response: {
      authenticatorData: 'authenticator-data',
      clientDataJSON: 'client-data',
      signature: 'signature',
    },
  };
}

function ceremonyFixture(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    ceremonyId: CEREMONY_ID,
    challenge: 'c'.repeat(43),
    tenantId: identity.tenantId,
    actorId: identity.actorId,
    sessionId: identity.sessionId,
    operationId: OPERATION_ID,
    credentialId: CREDENTIAL_ID,
    verifiedAt: new Date(),
    ...overrides,
  };
}

function storedCredential(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    credentialId: CREDENTIAL_ID,
    publicKey: Buffer.from([1, 2, 3]),
    counter: 7,
    transports: ['internal'],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('WebAuthnService', () => {
  it('业务证据复核同时绑定租户、人员、会话和操作', async () => {
    const verifiedAt = new Date();
    const findOne = vi.fn().mockReturnValue(query({
      ceremonyId: CEREMONY_ID, credentialId: CREDENTIAL_ID,
      tenantId: identity.tenantId, actorId: identity.actorId,
      sessionId: identity.sessionId, operationId: OPERATION_ID, verifiedAt,
    }));
    const service = createService({}, { findOne });
    const result = await service.requireVerifiedEvidence({
      evidenceId: CEREMONY_ID, tenantId: identity.tenantId, actorId: identity.actorId,
      sessionId: identity.sessionId, operationId: OPERATION_ID,
    });
    expect(result).toMatchObject({
      evidenceId: CEREMONY_ID, operationId: OPERATION_ID, method: 'webauthn_uv',
    });
    expect(findOne).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: identity.tenantId, actorId: identity.actorId,
      sessionId: identity.sessionId, operationId: OPERATION_ID,
    }));
  });

  it('注册参数强制常驻凭据、用户验证和受控算法', async () => {
    webauthn.generateRegistrationOptions.mockResolvedValue({ challenge: 'a'.repeat(43) });
    const create = vi.fn().mockResolvedValue(undefined);
    const service = createService({ find: vi.fn().mockReturnValue(query([])) }, { create });

    await service.startRegistration(identity);

    expect(webauthn.generateRegistrationOptions).toHaveBeenCalledWith(expect.objectContaining({
      rpID: 'erp.example.com',
      attestationType: 'none',
      supportedAlgorithmIDs: [-7, -257],
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    }));
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-001', actorId: 'actor-001', sessionId: 'session-001',
      type: 'registration', operationId: null,
    }));
  });

  it('无登记授权时拒绝注册且不生成 challenge', async () => {
    const service = createService({}, {});
    await expect(service.startRegistration({ ...identity, scopes: [] }))
      .rejects.toMatchObject({ response: { code: 'PASSKEY_MANAGEMENT_DENIED' } });
    expect(webauthn.generateRegistrationOptions).not.toHaveBeenCalled();
  });

  it('认证参数强制 UV 并将仪式绑定当前业务操作', async () => {
    webauthn.generateAuthenticationOptions.mockResolvedValue({ challenge: 'b'.repeat(43) });
    const create = vi.fn().mockResolvedValue(undefined);
    const credentials = {
      find: vi.fn().mockReturnValue(query([{ credentialId: CREDENTIAL_ID, transports: ['internal'] }])),
    };
    const service = createService(credentials, { create });

    await service.startAuthentication(identity, OPERATION_ID);

    expect(webauthn.generateAuthenticationOptions).toHaveBeenCalledWith(expect.objectContaining({
      rpID: 'erp.example.com', userVerification: 'required',
      allowCredentials: [{ id: CREDENTIAL_ID, transports: ['internal'] }],
    }));
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      operationId: OPERATION_ID, type: 'authentication', sessionId: 'session-001',
    }));
  });

  it('验证断言时校验 RP、Origin、UV，并原子消费 challenge 与推进计数器', async () => {
    webauthn.verifyAuthenticationResponse.mockResolvedValue({
      verified: true,
      authenticationInfo: { userVerified: true, newCounter: 8 },
    });
    const ceremony = {
      ceremonyId: CEREMONY_ID,
      challenge: 'c'.repeat(43),
      operationId: OPERATION_ID,
    };
    const ceremonies = {
      findOne: vi.fn().mockReturnValue(query(ceremony)),
      updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
    };
    const credentials = {
      findOne: vi.fn().mockReturnValue(query({
        credentialId: CREDENTIAL_ID,
        publicKey: Buffer.from([1, 2, 3]),
        counter: 7,
        transports: ['internal'],
      })),
      updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
    };
    const service = createService(credentials, ceremonies);

    const evidence = await service.finishAuthentication(
      identity,
      OPERATION_ID,
      CEREMONY_ID,
      {
        id: CREDENTIAL_ID,
        rawId: CREDENTIAL_ID,
        type: 'public-key',
        clientExtensionResults: {},
        response: {
          authenticatorData: 'authenticator-data',
          clientDataJSON: 'client-data',
          signature: 'signature',
        },
      },
    );

    expect(webauthn.verifyAuthenticationResponse).toHaveBeenCalledWith(expect.objectContaining({
      expectedChallenge: ceremony.challenge,
      expectedOrigin: 'https://erp.example.com',
      expectedRPID: 'erp.example.com',
      requireUserVerification: true,
      advancedFIDOConfig: { userVerification: 'required' },
    }));
    expect(ceremonies.updateOne).toHaveBeenCalledWith(expect.objectContaining({
      ceremonyId: CEREMONY_ID,
      tenantId: 'tenant-001',
      actorId: 'actor-001',
      sessionId: 'session-001',
      operationId: OPERATION_ID,
      status: 'pending',
    }), expect.anything(), expect.anything());
    const credentialUpdate = credentials.updateOne.mock.calls[0] as unknown as [
      Record<string, unknown>, { $set: Record<string, unknown> }, Record<string, unknown>,
    ];
    expect(credentialUpdate[0]).toMatchObject({
      credentialId: CREDENTIAL_ID, counter: 7, tenantId: 'tenant-001', actorId: 'actor-001',
    });
    expect(credentialUpdate[1].$set).toMatchObject({ counter: 8 });
    expect(evidence).toMatchObject({
      evidenceId: CEREMONY_ID,
      credentialId: CREDENTIAL_ID,
      tenantId: 'tenant-001',
      actorId: 'actor-001',
      sessionId: 'session-001',
      operationId: OPERATION_ID,
      method: 'webauthn_uv',
    });
  });

  it('凭据撤销限定可信租户和当前主体，撤销后不再可用', async () => {
    const updateOne = vi.fn().mockResolvedValue({ modifiedCount: 1 });
    const service = createService({ updateOne }, {});
    await service.revokeCredential(identity, CREDENTIAL_ID);
    expect(updateOne).toHaveBeenCalledWith({
      credentialId: CREDENTIAL_ID,
      tenantId: 'tenant-001',
      actorId: 'actor-001',
      status: 'active',
    }, { $set: { status: 'revoked' } }, { runValidators: true });
  });

  it('注册参数排除当前主体已有凭据并保留认证器传输方式', async () => {
    webauthn.generateRegistrationOptions.mockResolvedValue({ challenge: 'a'.repeat(43) });
    const create = vi.fn().mockResolvedValue(undefined);
    const find = vi.fn().mockReturnValue(query([
      { credentialId: CREDENTIAL_ID, transports: ['internal', 'hybrid'] },
    ]));
    const service = createService({ find }, { create });

    await service.startRegistration(identity);

    expect(webauthn.generateRegistrationOptions).toHaveBeenCalledWith(expect.objectContaining({
      excludeCredentials: [{
        id: CREDENTIAL_ID,
        transports: ['internal', 'hybrid'],
      }],
    }));
  });

  it('凭据列表只返回当前主体活动凭据并规范化时间', async () => {
    const createdAt = new Date('2026-07-01T00:00:00.000Z');
    const lastUsedAt = new Date('2026-07-02T00:00:00.000Z');
    const exec = vi.fn().mockResolvedValue([
      {
        credentialId: CREDENTIAL_ID,
        deviceType: 'multiDevice',
        backedUp: true,
        createdAt,
        lastUsedAt,
      },
      {
        credentialId: 'credential_0987654321',
        deviceType: 'singleDevice',
        backedUp: false,
        createdAt,
        lastUsedAt: null,
      },
    ]);
    const sort = vi.fn().mockReturnValue({ lean: () => ({ exec }) });
    const find = vi.fn().mockReturnValue({ sort });
    const service = createService({ find }, {});

    const result = await service.listCredentials(identity);

    expect(find).toHaveBeenCalledWith({
      tenantId: identity.tenantId,
      actorId: identity.actorId,
      status: 'active',
    }, {
      credentialId: 1,
      deviceType: 1,
      backedUp: 1,
      createdAt: 1,
      lastUsedAt: 1,
      _id: 0,
    });
    expect(sort).toHaveBeenCalledWith({ createdAt: 1 });
    expect(result).toEqual([
      {
        credentialId: CREDENTIAL_ID,
        deviceType: 'multiDevice',
        backedUp: true,
        createdAt: createdAt.toISOString(),
        lastUsedAt: lastUsedAt.toISOString(),
      },
      {
        credentialId: 'credential_0987654321',
        deviceType: 'singleDevice',
        backedUp: false,
        createdAt: createdAt.toISOString(),
        lastUsedAt: null,
      },
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result[0])).toBe(true);
  });

  it.each([
    ['list', async (service: WebAuthnService, denied: BrowserOAuthIdentity) => service.listCredentials(denied)],
    ['revoke', async (service: WebAuthnService, denied: BrowserOAuthIdentity) => service.revokeCredential(
      denied,
      CREDENTIAL_ID,
    )],
  ])('%s 在缺少管理 Scope 时失败关闭', async (_operation, invoke) => {
    const find = vi.fn();
    const updateOne = vi.fn();
    const service = createService({ find, updateOne }, {});

    await expect(invoke(service, { ...identity, scopes: [] }))
      .rejects.toMatchObject({ response: { code: 'PASSKEY_MANAGEMENT_DENIED' } });
    expect(find).not.toHaveBeenCalled();
    expect(updateOne).not.toHaveBeenCalled();
  });

  it('撤销拒绝非法、已撤销或跨主体凭据标识', async () => {
    const invalidStore = { updateOne: vi.fn() };
    const invalidService = createService(invalidStore, {});
    await expect(invalidService.revokeCredential(identity, 'short'))
      .rejects.toMatchObject({ response: { code: 'PASSKEY_NOT_FOUND' } });
    expect(invalidStore.updateOne).not.toHaveBeenCalled();

    const missingStore = { updateOne: vi.fn().mockResolvedValue({ modifiedCount: 0 }) };
    const missingService = createService(missingStore, {});
    await expect(missingService.revokeCredential(identity, CREDENTIAL_ID))
      .rejects.toMatchObject({ response: { code: 'PASSKEY_NOT_FOUND' } });
  });

  it('完成登记重新校验管理 Scope，权限撤销后禁止落库', async () => {
    const findOne = vi.fn();
    const create = vi.fn();
    const service = createService({ create }, { findOne });

    await expect(service.finishRegistration(
      { ...identity, scopes: [] },
      CEREMONY_ID,
      registrationResponse(),
    )).rejects.toMatchObject({ response: { code: 'PASSKEY_MANAGEMENT_DENIED' } });

    expect(findOne).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(webauthn.verifyRegistrationResponse).not.toHaveBeenCalled();
  });

  it('完成登记验证 RP、Origin、UV 并原子消费仪式后保存公钥', async () => {
    webauthn.verifyRegistrationResponse.mockResolvedValue({
      verified: true,
      registrationInfo: {
        userVerified: true,
        credential: {
          id: CREDENTIAL_ID,
          publicKey: new Uint8Array([1, 2, 3]),
          counter: 0,
        },
        credentialDeviceType: 'multiDevice',
        credentialBackedUp: true,
      },
    });
    const ceremonies = {
      findOne: vi.fn().mockReturnValue(query(ceremonyFixture({ operationId: null }))),
      updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
    };
    const credentials = { create: vi.fn().mockResolvedValue(undefined) };
    const service = createService(credentials, ceremonies);

    const result = await service.finishRegistration(
      identity,
      CEREMONY_ID,
      registrationResponse(['internal', 'hybrid']),
    );

    expect(webauthn.verifyRegistrationResponse).toHaveBeenCalledWith(expect.objectContaining({
      expectedChallenge: 'c'.repeat(43),
      expectedOrigin: 'https://erp.example.com',
      expectedRPID: 'erp.example.com',
      requireUserVerification: true,
      supportedAlgorithmIDs: [-7, -257],
    }));
    expect(ceremonies.updateOne).toHaveBeenCalledWith(expect.objectContaining({
      ceremonyId: CEREMONY_ID,
      tenantId: identity.tenantId,
      actorId: identity.actorId,
      sessionId: identity.sessionId,
      type: 'registration',
      status: 'pending',
    }), expect.anything(), expect.objectContaining({ runValidators: true }));
    expect(credentials.create).toHaveBeenCalledWith([expect.objectContaining({
      credentialId: CREDENTIAL_ID,
      tenantId: identity.tenantId,
      actorId: identity.actorId,
      publicKey: Buffer.from([1, 2, 3]),
      counter: 0,
      transports: ['internal', 'hybrid'],
      deviceType: 'multiDevice',
      backedUp: true,
      status: 'active',
      lastUsedAt: null,
    })], { session: { id: 'session' } });
    expect(result).toEqual({
      credentialId: CREDENTIAL_ID,
      deviceType: 'multiDevice',
      backedUp: true,
    });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('登记响应缺少 transports 时保存空白名单', async () => {
    webauthn.verifyRegistrationResponse.mockResolvedValue({
      verified: true,
      registrationInfo: {
        userVerified: true,
        credential: {
          id: CREDENTIAL_ID,
          publicKey: new Uint8Array([1]),
          counter: 0,
        },
        credentialDeviceType: 'singleDevice',
        credentialBackedUp: false,
      },
    });
    const credentials = { create: vi.fn().mockResolvedValue(undefined) };
    const service = createService(credentials, {
      findOne: vi.fn().mockReturnValue(query(ceremonyFixture({ operationId: null }))),
      updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
    });

    await service.finishRegistration(identity, CEREMONY_ID, registrationResponse());

    expect(credentials.create).toHaveBeenCalledWith([
      expect.objectContaining({ transports: [] }),
    ], expect.anything());
  });

  it.each([
    ['验证器异常', new Error('invalid attestation'), true, true],
    ['签名未验证', null, false, true],
    ['用户验证缺失', null, true, false],
  ])('登记%s时返回稳定协议错误', async (_case, thrown, verified, userVerified) => {
    if (thrown !== null) {
      webauthn.verifyRegistrationResponse.mockRejectedValue(thrown);
    } else {
      webauthn.verifyRegistrationResponse.mockResolvedValue({
        verified,
        registrationInfo: {
          userVerified,
          credential: {
            id: CREDENTIAL_ID,
            publicKey: new Uint8Array([1]),
            counter: 0,
          },
          credentialDeviceType: 'singleDevice',
          credentialBackedUp: false,
        },
      });
    }
    const updateOne = vi.fn();
    const create = vi.fn();
    const service = createService({ create }, {
      findOne: vi.fn().mockReturnValue(query(ceremonyFixture({ operationId: null }))),
      updateOne,
    });

    await expect(service.finishRegistration(
      identity,
      CEREMONY_ID,
      registrationResponse(),
    )).rejects.toMatchObject({ response: { code: 'PASSKEY_REGISTRATION_INVALID' } });

    expect(updateOne).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('登记拒绝认证器返回的非法凭据标识', async () => {
    webauthn.verifyRegistrationResponse.mockResolvedValue({
      verified: true,
      registrationInfo: {
        userVerified: true,
        credential: {
          id: 'short',
          publicKey: new Uint8Array([1]),
          counter: 0,
        },
        credentialDeviceType: 'singleDevice',
        credentialBackedUp: false,
      },
    });
    const service = createService({ create: vi.fn() }, {
      findOne: vi.fn().mockReturnValue(query(ceremonyFixture({ operationId: null }))),
    });

    await expect(service.finishRegistration(
      identity,
      CEREMONY_ID,
      registrationResponse(),
    )).rejects.toThrow('WebAuthn 凭据标识非法');
  });

  it('登记仪式并发消费失败时回滚且返回稳定冲突', async () => {
    webauthn.verifyRegistrationResponse.mockResolvedValue({
      verified: true,
      registrationInfo: {
        userVerified: true,
        credential: {
          id: CREDENTIAL_ID,
          publicKey: new Uint8Array([1]),
          counter: 0,
        },
        credentialDeviceType: 'singleDevice',
        credentialBackedUp: false,
      },
    });
    const create = vi.fn();
    const service = createService({ create }, {
      findOne: vi.fn().mockReturnValue(query(ceremonyFixture({ operationId: null }))),
      updateOne: vi.fn().mockResolvedValue({ modifiedCount: 0 }),
    });

    await expect(service.finishRegistration(
      identity,
      CEREMONY_ID,
      registrationResponse(),
    )).rejects.toMatchObject({ response: { code: 'PASSKEY_CEREMONY_CONSUMED' } });
    expect(create).not.toHaveBeenCalled();
  });

  it('登记重复键映射为稳定冲突，其他存储异常保持传播', async () => {
    webauthn.verifyRegistrationResponse.mockResolvedValue({
      verified: true,
      registrationInfo: {
        userVerified: true,
        credential: {
          id: CREDENTIAL_ID,
          publicKey: new Uint8Array([1]),
          counter: 0,
        },
        credentialDeviceType: 'singleDevice',
        credentialBackedUp: false,
      },
    });
    const ceremonies = {
      findOne: vi.fn().mockReturnValue(query(ceremonyFixture({ operationId: null }))),
      updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
    };

    const duplicateService = createService({
      create: vi.fn().mockRejectedValue({ code: 11_000 }),
    }, ceremonies);
    await expect(duplicateService.finishRegistration(
      identity,
      CEREMONY_ID,
      registrationResponse(),
    )).rejects.toMatchObject({ response: { code: 'PASSKEY_ALREADY_REGISTERED' } });

    const failure = new Error('credential storage unavailable');
    const failedService = createService({
      create: vi.fn().mockRejectedValue(failure),
    }, ceremonies);
    await expect(failedService.finishRegistration(
      identity,
      CEREMONY_ID,
      registrationResponse(),
    )).rejects.toBe(failure);
  });

  it('认证开始时无活动凭据则失败且不生成 challenge', async () => {
    const service = createService({
      find: vi.fn().mockReturnValue(query([])),
    }, { create: vi.fn() });

    await expect(service.startAuthentication(identity, OPERATION_ID))
      .rejects.toMatchObject({ response: { code: 'PASSKEY_NOT_REGISTERED' } });
    expect(webauthn.generateAuthenticationOptions).not.toHaveBeenCalled();
  });

  it('认证拒绝非法凭据标识、缺失凭据和缺失仪式', async () => {
    const invalidService = createService({}, {});
    await expect(invalidService.finishAuthentication(
      identity,
      OPERATION_ID,
      CEREMONY_ID,
      authenticationResponse('short'),
    )).rejects.toMatchObject({ response: { code: 'PASSKEY_ASSERTION_INVALID' } });

    const missingCredentialService = createService({
      findOne: vi.fn().mockReturnValue(query(null)),
    }, {
      findOne: vi.fn().mockReturnValue(query(ceremonyFixture())),
    });
    await expect(missingCredentialService.finishAuthentication(
      identity,
      OPERATION_ID,
      CEREMONY_ID,
      authenticationResponse(),
    )).rejects.toMatchObject({ response: { code: 'PASSKEY_NOT_FOUND' } });

    const missingCeremonyService = createService({
      findOne: vi.fn().mockReturnValue(query(storedCredential())),
    }, {
      findOne: vi.fn().mockReturnValue(query(null)),
    });
    await expect(missingCeremonyService.finishAuthentication(
      identity,
      OPERATION_ID,
      CEREMONY_ID,
      authenticationResponse(),
    )).rejects.toMatchObject({ response: { code: 'PASSKEY_CEREMONY_NOT_FOUND' } });
  });

  it.each([
    ['验证器异常', new Error('invalid assertion'), true, true],
    ['签名未验证', null, false, true],
    ['用户验证缺失', null, true, false],
  ])('认证%s时返回稳定协议错误', async (_case, thrown, verified, userVerified) => {
    if (thrown !== null) {
      webauthn.verifyAuthenticationResponse.mockRejectedValue(thrown);
    } else {
      webauthn.verifyAuthenticationResponse.mockResolvedValue({
        verified,
        authenticationInfo: { userVerified, newCounter: 8 },
      });
    }
    const ceremonyUpdate = vi.fn();
    const service = createService({
      findOne: vi.fn().mockReturnValue(query(storedCredential())),
      updateOne: vi.fn(),
    }, {
      findOne: vi.fn().mockReturnValue(query(ceremonyFixture())),
      updateOne: ceremonyUpdate,
    });

    await expect(service.finishAuthentication(
      identity,
      OPERATION_ID,
      CEREMONY_ID,
      authenticationResponse(),
    )).rejects.toMatchObject({ response: { code: 'PASSKEY_ASSERTION_INVALID' } });
    expect(ceremonyUpdate).not.toHaveBeenCalled();
  });

  it('认证仪式与凭据计数器竞争分别失败关闭', async () => {
    webauthn.verifyAuthenticationResponse.mockResolvedValue({
      verified: true,
      authenticationInfo: { userVerified: true, newCounter: 8 },
    });
    const ceremonyConflictService = createService({
      findOne: vi.fn().mockReturnValue(query(storedCredential())),
      updateOne: vi.fn(),
    }, {
      findOne: vi.fn().mockReturnValue(query(ceremonyFixture())),
      updateOne: vi.fn().mockResolvedValue({ modifiedCount: 0 }),
    });
    await expect(ceremonyConflictService.finishAuthentication(
      identity,
      OPERATION_ID,
      CEREMONY_ID,
      authenticationResponse(),
    )).rejects.toMatchObject({ response: { code: 'PASSKEY_CEREMONY_CONSUMED' } });

    const credentialUpdate = vi.fn().mockResolvedValue({ modifiedCount: 0 });
    const counterConflictService = createService({
      findOne: vi.fn().mockReturnValue(query(storedCredential())),
      updateOne: credentialUpdate,
    }, {
      findOne: vi.fn().mockReturnValue(query(ceremonyFixture())),
      updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
    });
    await expect(counterConflictService.finishAuthentication(
      identity,
      OPERATION_ID,
      CEREMONY_ID,
      authenticationResponse(),
    )).rejects.toMatchObject({ response: { code: 'PASSKEY_COUNTER_CONFLICT' } });
    expect(credentialUpdate).toHaveBeenCalledWith(expect.objectContaining({
      credentialId: CREDENTIAL_ID,
      tenantId: identity.tenantId,
      actorId: identity.actorId,
      counter: 7,
    }), expect.anything(), expect.anything());
  });

  it.each([
    ['不存在', null],
    ['缺少凭据', ceremonyFixture({ credentialId: null })],
    ['缺少验证时间', ceremonyFixture({ verifiedAt: null })],
    ['缺少操作绑定', ceremonyFixture({ operationId: null })],
  ])('业务证据复核拒绝%s的证据', async (_case, stored) => {
    const service = createService({}, {
      findOne: vi.fn().mockReturnValue(query(stored)),
    });

    await expect(service.requireVerifiedEvidence({
      evidenceId: CEREMONY_ID,
      tenantId: identity.tenantId,
      actorId: identity.actorId,
      sessionId: identity.sessionId,
      operationId: OPERATION_ID,
    })).rejects.toMatchObject({ response: { code: 'PASSKEY_EVIDENCE_INVALID' } });
  });
});
