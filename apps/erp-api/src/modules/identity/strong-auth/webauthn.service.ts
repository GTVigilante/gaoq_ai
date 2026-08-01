import { createHash } from 'node:crypto';

import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { createEventId } from '@gaoq/shared-utils';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
  type WebAuthnCredential,
} from '@simplewebauthn/server';
import type { Connection, Model } from 'mongoose';

import type { AppEnvironment } from '../../../config/environment.js';
import type { BrowserOAuthIdentity } from '../token-grant.service.js';
import {
  WebAuthnCeremonyRecord,
  type WebAuthnCeremonyDocument,
  WebAuthnCredentialRecord,
  type WebAuthnCredentialDocument,
} from './webauthn.schemas.js';

const CEREMONY_TTL_MS = 5 * 60 * 1_000;
const CREDENTIAL_ID_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;
const PASSKEY_MANAGE_SCOPE = 'erp:identity:passkey:manage';

export interface VerifiedStrongAuthEvidence {
  readonly evidenceId: string;
  readonly credentialId: string;
  readonly tenantId: string;
  readonly actorId: string;
  readonly sessionId: string;
  readonly operationId: string;
  readonly method: 'webauthn_uv';
  readonly verifiedAt: string;
}

export interface StrongAuthEvidenceQuery {
  readonly evidenceId: string;
  readonly tenantId: string;
  readonly actorId: string;
  readonly sessionId: string;
  readonly operationId: string;
}

/** WebAuthn 强认证服务；服务端生成随机 challenge，严格校验 RP、Origin 和 UV 标志。 */
@Injectable()
export class WebAuthnService {
  private readonly origin: string;
  private readonly rpId: string;

  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(WebAuthnCredentialRecord.name)
    private readonly credentials: Model<WebAuthnCredentialDocument>,
    @InjectModel(WebAuthnCeremonyRecord.name)
    private readonly ceremonies: Model<WebAuthnCeremonyDocument>,
    config: ConfigService<AppEnvironment, true>,
  ) {
    this.origin = new URL(config.get('WEB_ORIGIN', { infer: true })).origin;
    this.rpId = new URL(this.origin).hostname;
  }

  async startRegistration(identity: BrowserOAuthIdentity): Promise<{
    readonly ceremonyId: string;
    readonly options: PublicKeyCredentialCreationOptionsJSON;
  }> {
    this.assertManageScope(identity);
    const existing = await this.credentials.find({
      tenantId: identity.tenantId, actorId: identity.actorId, status: 'active',
    }, { credentialId: 1, transports: 1, _id: 0 }).lean().exec();
    const options = await generateRegistrationOptions({
      rpName: 'GaoQ-OS',
      rpID: this.rpId,
      userName: identity.actorId,
      userDisplayName: identity.actorId,
      userID: createHash('sha256').update(`${identity.tenantId}:${identity.actorId}`).digest(),
      attestationType: 'none',
      timeout: CEREMONY_TTL_MS,
      excludeCredentials: existing.map((credential) => ({
        id: credential.credentialId,
        transports: [...credential.transports],
      })),
      authenticatorSelection: {
        residentKey: 'required',
        userVerification: 'required',
      },
      supportedAlgorithmIDs: [-7, -257],
    });
    const ceremonyId = await this.createCeremony(identity, 'registration', options.challenge, null);
    return Object.freeze({ ceremonyId, options });
  }

  async listCredentials(identity: BrowserOAuthIdentity): Promise<readonly {
    readonly credentialId: string;
    readonly deviceType: 'singleDevice' | 'multiDevice';
    readonly backedUp: boolean;
    readonly createdAt: string;
    readonly lastUsedAt: string | null;
  }[]> {
    this.assertManageScope(identity);
    const credentials = await this.credentials.find({
      tenantId: identity.tenantId,
      actorId: identity.actorId,
      status: 'active',
    }, {
      credentialId: 1, deviceType: 1, backedUp: 1, createdAt: 1, lastUsedAt: 1, _id: 0,
    }).sort({ createdAt: 1 }).lean().exec();
    return Object.freeze(credentials.map((credential) => Object.freeze({
      credentialId: credential.credentialId,
      deviceType: credential.deviceType,
      backedUp: credential.backedUp,
      createdAt: credential.createdAt.toISOString(),
      lastUsedAt: credential.lastUsedAt?.toISOString() ?? null,
    })));
  }

  async revokeCredential(identity: BrowserOAuthIdentity, credentialId: string): Promise<void> {
    this.assertManageScope(identity);
    if (!CREDENTIAL_ID_PATTERN.test(credentialId)) throw new NotFoundException({
      code: 'PASSKEY_NOT_FOUND', message: '强认证凭据不存在或已撤销',
    });
    const revoked = await this.credentials.updateOne(
      {
        credentialId,
        tenantId: identity.tenantId,
        actorId: identity.actorId,
        status: 'active',
      },
      { $set: { status: 'revoked' } },
      { runValidators: true },
    );
    if (revoked.modifiedCount !== 1) throw new NotFoundException({
      code: 'PASSKEY_NOT_FOUND', message: '强认证凭据不存在或已撤销',
    });
  }

  async finishRegistration(
    identity: BrowserOAuthIdentity,
    ceremonyId: string,
    response: RegistrationResponseJSON,
  ): Promise<{ readonly credentialId: string; readonly deviceType: string; readonly backedUp: boolean }> {
    this.assertManageScope(identity);
    const ceremony = await this.requireCeremony(identity, ceremonyId, 'registration', null);
    let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: ceremony.challenge,
        expectedOrigin: this.origin,
        expectedRPID: this.rpId,
        requireUserVerification: true,
        supportedAlgorithmIDs: [-7, -257],
      });
    } catch {
      throw new ForbiddenException({
        code: 'PASSKEY_REGISTRATION_INVALID', message: '强认证凭据登记验证失败',
      });
    }
    if (!verification.verified || !verification.registrationInfo.userVerified) {
      throw new ForbiddenException({ code: 'PASSKEY_REGISTRATION_INVALID', message: '强认证凭据登记验证失败' });
    }
    const info = verification.registrationInfo;
    if (!CREDENTIAL_ID_PATTERN.test(info.credential.id)) throw new Error('WebAuthn 凭据标识非法');
    try {
      await this.connection.transaction(async (session) => {
        const consumed = await this.ceremonies.updateOne(
          {
            ceremonyId, tenantId: identity.tenantId, actorId: identity.actorId,
            sessionId: identity.sessionId, type: 'registration', status: 'pending',
            expiresAt: { $gt: new Date() },
          },
          {
            $set: {
              status: 'verified', credentialId: info.credential.id, verifiedAt: new Date(),
            },
          },
          { session, runValidators: true },
        );
        if (consumed.modifiedCount !== 1) throw new ConflictException({
          code: 'PASSKEY_CEREMONY_CONSUMED', message: '登记仪式已使用或过期',
        });
        await this.credentials.create([{
          credentialId: info.credential.id,
          tenantId: identity.tenantId,
          actorId: identity.actorId,
          publicKey: Buffer.from(info.credential.publicKey),
          counter: info.credential.counter,
          transports: response.response.transports ?? [],
          deviceType: info.credentialDeviceType,
          backedUp: info.credentialBackedUp,
          status: 'active',
          lastUsedAt: null,
        }], { session });
      });
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      throw new ConflictException({
        code: 'PASSKEY_ALREADY_REGISTERED', message: '该强认证凭据已登记',
      });
    }
    return Object.freeze({
      credentialId: info.credential.id,
      deviceType: info.credentialDeviceType,
      backedUp: info.credentialBackedUp,
    });
  }

  async startAuthentication(
    identity: BrowserOAuthIdentity,
    operationId: string,
  ): Promise<{ readonly ceremonyId: string; readonly options: PublicKeyCredentialRequestOptionsJSON }> {
    const credentials = await this.credentials.find({
      tenantId: identity.tenantId, actorId: identity.actorId, status: 'active',
    }, { credentialId: 1, transports: 1, _id: 0 }).lean().exec();
    if (credentials.length === 0) throw new NotFoundException({
      code: 'PASSKEY_NOT_REGISTERED', message: '当前主体尚未登记强认证凭据',
    });
    const options = await generateAuthenticationOptions({
      rpID: this.rpId,
      timeout: CEREMONY_TTL_MS,
      userVerification: 'required',
      allowCredentials: credentials.map((credential) => ({
        id: credential.credentialId,
        transports: [...credential.transports],
      })),
    });
    const ceremonyId = await this.createCeremony(
      identity, 'authentication', options.challenge, operationId,
    );
    return Object.freeze({ ceremonyId, options });
  }

  async finishAuthentication(
    identity: BrowserOAuthIdentity,
    operationId: string,
    ceremonyId: string,
    response: AuthenticationResponseJSON,
  ): Promise<VerifiedStrongAuthEvidence> {
    if (!CREDENTIAL_ID_PATTERN.test(response.id)) throw new ForbiddenException({
      code: 'PASSKEY_ASSERTION_INVALID', message: '强认证响应无效',
    });
    const [ceremony, stored] = await Promise.all([
      this.requireCeremony(identity, ceremonyId, 'authentication', operationId),
      this.credentials.findOne({
        credentialId: response.id,
        tenantId: identity.tenantId,
        actorId: identity.actorId,
        status: 'active',
      }).lean().exec(),
    ]);
    if (stored === null) throw new NotFoundException({
      code: 'PASSKEY_NOT_FOUND', message: '强认证凭据不存在或已撤销',
    });
    const credential: WebAuthnCredential = {
      id: stored.credentialId,
      publicKey: new Uint8Array(stored.publicKey),
      counter: stored.counter,
      transports: [...stored.transports],
    };
    let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: ceremony.challenge,
        expectedOrigin: this.origin,
        expectedRPID: this.rpId,
        credential,
        requireUserVerification: true,
        advancedFIDOConfig: { userVerification: 'required' },
      });
    } catch {
      throw new ForbiddenException({
        code: 'PASSKEY_ASSERTION_INVALID', message: '强认证验证失败',
      });
    }
    if (!verification.verified || !verification.authenticationInfo.userVerified) {
      throw new ForbiddenException({ code: 'PASSKEY_ASSERTION_INVALID', message: '强认证验证失败' });
    }
    const verifiedAt = new Date();
    await this.connection.transaction(async (session) => {
      const consumed = await this.ceremonies.updateOne(
        {
          ceremonyId, tenantId: identity.tenantId, actorId: identity.actorId,
          sessionId: identity.sessionId, operationId, type: 'authentication', status: 'pending',
          expiresAt: { $gt: verifiedAt },
        },
        {
          $set: { status: 'verified', credentialId: stored.credentialId, verifiedAt },
        },
        { session, runValidators: true },
      );
      if (consumed.modifiedCount !== 1) throw new ConflictException({
        code: 'PASSKEY_CEREMONY_CONSUMED', message: '强认证仪式已使用或过期',
      });
      const updated = await this.credentials.updateOne(
        {
          credentialId: stored.credentialId,
          tenantId: identity.tenantId,
          actorId: identity.actorId,
          status: 'active',
          counter: stored.counter,
        },
        { $set: { counter: verification.authenticationInfo.newCounter, lastUsedAt: verifiedAt } },
        { session, runValidators: true },
      );
      if (updated.modifiedCount !== 1) throw new ConflictException({
        code: 'PASSKEY_COUNTER_CONFLICT', message: '强认证计数器冲突，请重新验证',
      });
    });
    return Object.freeze({
      evidenceId: ceremonyId,
      credentialId: stored.credentialId,
      tenantId: identity.tenantId,
      actorId: identity.actorId,
      sessionId: identity.sessionId,
      operationId,
      method: 'webauthn_uv',
      verifiedAt: verifiedAt.toISOString(),
    });
  }

  /** 业务服务复核短时强认证证据；所有绑定字段必须来自已验证访问令牌和固化操作。 */
  async requireVerifiedEvidence(
    input: StrongAuthEvidenceQuery,
  ): Promise<VerifiedStrongAuthEvidence> {
    const now = new Date();
    const evidence = await this.ceremonies.findOne({
      ceremonyId: input.evidenceId,
      tenantId: input.tenantId,
      actorId: input.actorId,
      sessionId: input.sessionId,
      operationId: input.operationId,
      type: 'authentication',
      status: 'verified',
      credentialId: { $type: 'string' },
      verifiedAt: { $gte: new Date(now.getTime() - CEREMONY_TTL_MS), $lte: now },
      expiresAt: { $gt: now },
    }).lean().exec();
    if (
      evidence === null || evidence.credentialId === null || evidence.verifiedAt === null ||
      evidence.operationId === null
    ) throw new ForbiddenException({
      code: 'PASSKEY_EVIDENCE_INVALID', message: '强认证证据不存在、已过期或与当前操作不匹配',
    });
    return Object.freeze({
      evidenceId: evidence.ceremonyId, credentialId: evidence.credentialId,
      tenantId: evidence.tenantId, actorId: evidence.actorId, sessionId: evidence.sessionId,
      operationId: evidence.operationId, method: 'webauthn_uv',
      verifiedAt: evidence.verifiedAt.toISOString(),
    });
  }

  private async createCeremony(
    identity: BrowserOAuthIdentity,
    type: 'registration' | 'authentication',
    challenge: string,
    operationId: string | null,
  ): Promise<string> {
    const now = new Date();
    const ceremonyId = createEventId(now);
    await this.ceremonies.create({
      ceremonyId,
      tenantId: identity.tenantId,
      actorId: identity.actorId,
      sessionId: identity.sessionId,
      type,
      challenge,
      operationId,
      status: 'pending',
      credentialId: null,
      verifiedAt: null,
      expiresAt: new Date(now.getTime() + CEREMONY_TTL_MS),
    });
    return ceremonyId;
  }

  private async requireCeremony(
    identity: BrowserOAuthIdentity,
    ceremonyId: string,
    type: 'registration' | 'authentication',
    operationId: string | null,
  ) {
    const ceremony = await this.ceremonies.findOne({
      ceremonyId,
      tenantId: identity.tenantId,
      actorId: identity.actorId,
      sessionId: identity.sessionId,
      type,
      operationId,
      status: 'pending',
      expiresAt: { $gt: new Date() },
    }).lean().exec();
    if (ceremony === null) throw new NotFoundException({
      code: 'PASSKEY_CEREMONY_NOT_FOUND', message: '强认证仪式不存在、已使用或过期',
    });
    return ceremony;
  }

  private assertManageScope(identity: BrowserOAuthIdentity): void {
    if (!identity.scopes.includes(PASSKEY_MANAGE_SCOPE)) {
      throw new ForbiddenException({
        code: 'PASSKEY_MANAGEMENT_DENIED', message: '无权管理强认证凭据',
      });
    }
  }
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 11_000;
}
