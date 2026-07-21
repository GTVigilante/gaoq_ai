import { ConfigService } from '@nestjs/config';
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
): WebAuthnService {
  const connection = {
    transaction: async (work: (session: object) => Promise<void>) => work({ id: 'session' }),
  } as unknown as Connection;
  return new WebAuthnService(
    connection,
    credentials as unknown as Model<WebAuthnCredentialDocument>,
    ceremonies as unknown as Model<WebAuthnCeremonyDocument>,
    new ConfigService<AppEnvironment, true>({ WEB_ORIGIN: 'https://erp.example.com' } as AppEnvironment),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('WebAuthnService', () => {
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
});
