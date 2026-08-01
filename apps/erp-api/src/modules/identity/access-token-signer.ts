import { createPublicKey, randomUUID } from 'node:crypto';

import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ActorType } from '@gaoq/shared-types';
import {
  exportJWK,
  importPKCS8,
  importSPKI,
  SignJWT,
  type CryptoKey,
  type JWK,
} from 'jose';

import type { AppEnvironment } from '../../config/environment.js';
import { parseVerifyOnlySigningJwks } from '../../config/auth-signing-key-ring.js';
import { requireAuthorizationResource } from './authorization-resources.js';

export interface AccessTokenSigningInput {
  readonly tenantId: string;
  readonly actorId: string;
  readonly actorType: ActorType;
  readonly sessionId: string;
  readonly clientId: string;
  readonly roleCodes: readonly string[];
  readonly scopes: readonly string[];
  readonly departmentIds: readonly string[];
  /** 人员主体绑定的 GaoQ employeeId；服务主体可省略。 */
  readonly employeeId?: string | null;
  /** 目标资源；未传时仅为兼容内部旧调用而使用主资源。 */
  readonly resource?: string;
}

export interface SignedAccessToken {
  readonly accessToken: string;
  readonly tokenType: 'Bearer';
  readonly expiresIn: number;
}

/** 访问令牌签名端口，生产实现后续可替换为 KMS 非导出私钥。 */
export abstract class AccessTokenSigner {
  abstract sign(input: AccessTokenSigningInput): Promise<SignedAccessToken>;
  abstract getPublicJwks(): Promise<{ readonly keys: JWK[] }>;
}

@Injectable()
export class SecretManagedRsaAccessTokenSigner extends AccessTokenSigner {
  private privateKeyPromise?: Promise<CryptoKey>;
  private publicJwksPromise?: Promise<readonly JWK[]>;

  constructor(private readonly config: ConfigService<AppEnvironment, true>) {
    super();
  }

  /** 使用 RS256 和显式 at+jwt 类型签发短期、受众及资源约束的访问令牌。 */
  override async sign(input: AccessTokenSigningInput): Promise<SignedAccessToken> {
    const expiresIn = this.config.get('AUTH_ACCESS_TOKEN_TTL_SECONDS', { infer: true });
    const issuedAt = Math.floor(Date.now() / 1000);
    const keyId = this.getKeyId();
    const authorizationResource = requireAuthorizationResource(
      this.config,
      input.resource ?? this.config.get('AUTH_RESOURCE', { infer: true }),
    );
    const token = await new SignJWT({
      resource: authorizationResource.resource,
      tenant_id: input.tenantId,
      actor_id: input.actorId,
      actor_type: input.actorType,
      roles: [...input.roleCodes],
      scope: input.scopes.join(' '),
      department_ids: [...input.departmentIds],
      employee_id: input.employeeId ?? null,
      sid: input.sessionId,
      client_id: input.clientId,
      azp: input.clientId,
    })
      .setProtectedHeader({ alg: 'RS256', typ: 'at+jwt', kid: keyId })
      .setIssuer(this.config.get('AUTH_ISSUER', { infer: true }))
      .setSubject(`${input.tenantId}:${input.actorId}`)
      .setAudience(authorizationResource.audience)
      .setJti(randomUUID())
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + expiresIn)
      .sign(await this.getPrivateKey());
    return { accessToken: token, tokenType: 'Bearer', expiresIn };
  }

  /** 只导出公钥参数；私钥材料不得进入响应、日志或 JWKS。 */
  override async getPublicJwks(): Promise<{ readonly keys: JWK[] }> {
    if (this.publicJwksPromise === undefined) {
      this.publicJwksPromise = this.loadPublicJwks();
    }
    const keys = await this.publicJwksPromise;
    return {
      keys: keys.map((key) => ({
        ...key,
        ...(key.key_ops === undefined ? {} : { key_ops: [...key.key_ops] }),
      })),
    };
  }

  private getPrivateKey(): Promise<CryptoKey> {
    if (this.privateKeyPromise === undefined) {
      this.privateKeyPromise = this.loadPrivateKey();
    }
    return this.privateKeyPromise;
  }

  private async loadPrivateKey(): Promise<CryptoKey> {
    try {
      return await importPKCS8(this.getPrivatePem(), 'RS256');
    } catch {
      throw this.signingUnavailable();
    }
  }

  private async loadPublicJwks(): Promise<readonly JWK[]> {
    try {
      const publicPem = createPublicKey(this.getPrivatePem()).export({ type: 'spki', format: 'pem' });
      const key = await importSPKI(publicPem, 'RS256', { extractable: true });
      const jwk = await exportJWK(key);
      const current = Object.freeze<JWK>({
        ...jwk,
        alg: 'RS256',
        use: 'sig',
        key_ops: Object.freeze(['verify']) as string[],
        kid: this.getKeyId(),
      });
      const verifyOnly = parseVerifyOnlySigningJwks(
        this.config.get('AUTH_SIGNING_VERIFY_ONLY_JWKS_JSON', { infer: true }) ?? '[]',
        current.kid,
      );
      if (
        verifyOnly.some((candidate) =>
          candidate.n === current.n && candidate.e === current.e)
      ) {
        throw new Error('活动公钥不得以其他 kid 重复出现在历史验签集合');
      }
      return Object.freeze([current, ...verifyOnly]);
    } catch {
      throw this.signingUnavailable();
    }
  }

  private getPrivatePem(): string {
    const encoded = this.config.get('AUTH_SIGNING_PRIVATE_KEY_BASE64', { infer: true });
    if (encoded === undefined || encoded.length === 0) {
      throw this.signingUnavailable();
    }
    return Buffer.from(encoded, 'base64').toString('utf8');
  }

  private getKeyId(): string {
    const keyId = this.config.get('AUTH_SIGNING_KEY_ID', { infer: true });
    if (keyId === undefined || keyId.length === 0) {
      throw this.signingUnavailable();
    }
    return keyId;
  }

  private signingUnavailable(): ServiceUnavailableException {
    return new ServiceUnavailableException({
      code: 'AUTH_SIGNING_UNAVAILABLE',
      message: '授权签名设施不可用',
    });
  }
}
