import { createHash, timingSafeEqual } from 'node:crypto';

import {
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import {
  decodeJwt,
  decodeProtectedHeader,
  importJWK,
  jwtVerify,
  type JWTPayload,
} from 'jose';

import type { AppEnvironment } from '../../config/environment.js';
import { AuditService } from '../../core/audit/audit.service.js';
import { REDIS_CLIENT } from '../../infrastructure/redis/redis.constants.js';
import { AccessTokenSigner } from './access-token-signer.js';
import {
  OAuthServiceClientRegistry,
  type OAuthJwtCredential,
  type OAuthServiceClient,
} from './oauth-service-client-registry.js';
import { requireAuthorizationResource } from './authorization-resources.js';

const CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
const CLIENT_ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;
const JTI_PATTERN = /^[\x21-\x7E]{8,256}$/;

export interface OAuthClientCredentialsGrant {
  readonly accessToken: string;
  readonly tokenType: 'Bearer';
  readonly expiresIn: number;
  readonly scope: string;
}

export interface OAuthClientCredentialsInput {
  readonly authorization?: string;
  readonly clientId?: string;
  readonly clientAssertionType?: string;
  readonly clientAssertion?: string;
  readonly resource: string;
  readonly scopes?: readonly string[];
  readonly traceId: string;
}

interface AuthenticatedClient {
  readonly client: OAuthServiceClient;
  readonly credentialId: string;
}

/** RFC 6749 Client Credentials 与 MCP OAuth 扩展的服务主体授权应用服务。 */
@Injectable()
export class OAuthClientCredentialsGrantService {
  constructor(
    private readonly config: ConfigService<AppEnvironment, true>,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly clients: OAuthServiceClientRegistry,
    private readonly signer: AccessTokenSigner,
    private readonly audit: AuditService,
  ) {}

  async issue(input: OAuthClientCredentialsInput): Promise<OAuthClientCredentialsGrant> {
    requireAuthorizationResource(this.config, input.resource);
    let authenticated: AuthenticatedClient;
    try {
      authenticated = input.authorization === undefined
        ? await this.authenticatePrivateKeyJwt(input)
        : this.authenticateBasic(input.authorization, input);
    } catch (error) {
      await this.auditKnownFailure(input, 'client_authentication_failed');
      throw error;
    }

    this.clients.assertResource(authenticated.client, input.resource);
    const scopes = this.clients.filterAllowedScopes(authenticated.client, input.scopes);
    let signed;
    try {
      signed = await this.signer.sign({
        tenantId: authenticated.client.tenantId,
        actorId: authenticated.client.actorId,
        actorType: 'mcp_client',
        sessionId: authenticated.credentialId,
        clientId: authenticated.client.clientId,
        roleCodes: authenticated.client.roleCodes,
        scopes,
        departmentIds: authenticated.client.departmentIds,
        resource: input.resource,
      });
    } catch (error) {
      await this.recordFailure(authenticated.client, input.traceId, 'signing_failed');
      throw error;
    }
    await this.audit.recordTrustedService(authenticated.client.tenantId, {
      actorId: authenticated.client.actorId,
      traceId: input.traceId,
      action: 'identity.oauth.service-token.issue',
      resourceType: 'oauth_client',
      resourceId: authenticated.client.clientId,
      riskLevel: 'R1',
      outcome: 'success',
      metadata: {
        authenticationMethod: authenticated.client.authentication.method,
        credentialId: authenticated.credentialId,
        scopeCount: scopes.length,
      },
    });
    return { ...signed, scope: scopes.join(' ') };
  }

  private authenticateBasic(
    authorization: string,
    input: OAuthClientCredentialsInput,
  ): AuthenticatedClient {
    if (input.clientId !== undefined || input.clientAssertion !== undefined || input.clientAssertionType !== undefined) {
      throw this.invalidClient();
    }
    if (authorization.length > 512) throw this.invalidClient();
    const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/.exec(authorization);
    if (match === null) throw this.invalidClient();
    const encoded = match[1] ?? '';
    let decoded: string;
    try {
      const bytes = Buffer.from(encoded, 'base64');
      if (bytes.toString('base64') !== encoded) throw new Error('non-canonical');
      decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw this.invalidClient();
    }
    const separator = decoded.indexOf(':');
    if (separator < 1 || decoded.indexOf(':', separator + 1) !== -1) throw this.invalidClient();
    const clientId = decoded.slice(0, separator);
    const secret = decoded.slice(separator + 1);
    if (!CLIENT_ID_PATTERN.test(clientId) || !SECRET_PATTERN.test(secret)) throw this.invalidClient();
    const client = this.clients.resolveActive(clientId);
    if (client === undefined || client.authentication.method !== 'client_secret_basic') {
      throw this.invalidClient();
    }
    const candidate = createHash('sha256').update(secret, 'utf8').digest();
    const credential = this.clients.listCurrentCredentials(client).find((item) => {
      if (!('secretSha256' in item)) return false;
      const expected = Buffer.from(item.secretSha256, 'base64url');
      return expected.length === candidate.length && timingSafeEqual(expected, candidate);
    });
    if (credential === undefined) throw this.invalidClient();
    return { client, credentialId: credential.credentialId };
  }

  private async authenticatePrivateKeyJwt(
    input: OAuthClientCredentialsInput,
  ): Promise<AuthenticatedClient> {
    if (
      input.clientAssertionType !== CLIENT_ASSERTION_TYPE ||
      input.clientAssertion === undefined || input.clientAssertion.length > 8_192
    ) throw this.invalidClient();
    let header: ReturnType<typeof decodeProtectedHeader>;
    let unverified: JWTPayload;
    try {
      header = decodeProtectedHeader(input.clientAssertion);
      unverified = decodeJwt(input.clientAssertion);
    } catch {
      throw this.invalidClient();
    }
    const assertionClientId = unverified.iss;
    if (
      header.typ !== 'JWT' || (header.alg !== 'RS256' && header.alg !== 'ES256') ||
      typeof assertionClientId !== 'string' || !CLIENT_ID_PATTERN.test(assertionClientId) ||
      unverified.sub !== assertionClientId ||
      (input.clientId !== undefined && input.clientId !== assertionClientId) ||
      typeof unverified.jti !== 'string' || !JTI_PATTERN.test(unverified.jti)
    ) throw this.invalidClient();
    const client = this.clients.resolveActive(assertionClientId);
    if (client === undefined || client.authentication.method !== 'private_key_jwt') {
      throw this.invalidClient();
    }

    const credentials = this.clients.listCurrentCredentials(client).filter(
      (credential): credential is OAuthJwtCredential =>
        'publicJwk' in credential && credential.publicJwk.alg === header.alg &&
        (header.kid === undefined || credential.publicJwk.kid === header.kid),
    );
    let verified: JWTPayload | undefined;
    let credentialId: string | undefined;
    for (const credential of credentials) {
      try {
        const result = await jwtVerify(
          input.clientAssertion,
          await importJWK(this.clients.getPublicJwk(credential), header.alg),
          {
            algorithms: [header.alg],
            issuer: client.clientId,
            subject: client.clientId,
            audience: [...this.validAssertionAudiences()],
            typ: 'JWT',
            clockTolerance: 5,
          },
        );
        verified = result.payload;
        credentialId = credential.credentialId;
        break;
      } catch {
        // 轮换窗口最多尝试五把同算法公钥，错误细节不对外暴露。
      }
    }
    if (verified === undefined || credentialId === undefined) throw this.invalidClient();
    const now = Math.floor(Date.now() / 1000);
    if (
      typeof verified.iat !== 'number' || !Number.isInteger(verified.iat) ||
      typeof verified.exp !== 'number' || !Number.isInteger(verified.exp) ||
      verified.exp <= now - 5 || verified.iat > now + 5 ||
      verified.exp <= verified.iat || verified.exp - verified.iat > 300 ||
      verified.jti !== unverified.jti
    ) throw this.invalidClient();
    await this.consumeAssertion(client.clientId, verified.jti, verified.exp, now);
    return { client, credentialId };
  }

  private async consumeAssertion(clientId: string, jti: string, expiresAt: number, now: number): Promise<void> {
    const digest = createHash('sha256').update(`${clientId}\0${jti}`, 'utf8').digest('base64url');
    try {
      const created = await this.redis.set(
        `oauth:client-assertion:${digest}`,
        '1',
        'EX',
        Math.max(1, expiresAt - now + 5),
        'NX',
      );
      if (created !== 'OK') throw this.invalidClient();
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      throw new ServiceUnavailableException({
        code: 'OAUTH_ASSERTION_STORE_UNAVAILABLE',
        message: '客户端断言防重放设施不可用',
      });
    }
  }

  private validAssertionAudiences(): readonly string[] {
    const issuer = this.config.get('AUTH_ISSUER', { infer: true });
    return [issuer, new URL('/api/auth/oauth/token', issuer).toString()];
  }

  private invalidClient(): UnauthorizedException {
    return new UnauthorizedException({ code: 'OAUTH_INVALID_CLIENT', message: '客户端认证失败' });
  }

  private async auditKnownFailure(input: OAuthClientCredentialsInput, reason: string): Promise<void> {
    const clientId = input.clientId ?? this.basicClientId(input.authorization) ??
      this.assertionClientId(input.clientAssertion);
    if (clientId === undefined) return;
    const client = this.clients.resolveActive(clientId);
    if (client !== undefined) await this.recordFailure(client, input.traceId, reason);
  }

  private assertionClientId(assertion: string | undefined): string | undefined {
    if (assertion === undefined || assertion.length > 8_192) return undefined;
    try {
      const payload = decodeJwt(assertion);
      return typeof payload.iss === 'string' && CLIENT_ID_PATTERN.test(payload.iss)
        ? payload.iss
        : undefined;
    } catch {
      return undefined;
    }
  }

  private basicClientId(authorization: string | undefined): string | undefined {
    const match = authorization === undefined
      ? null
      : /^Basic ([A-Za-z0-9+/]+={0,2})$/.exec(authorization);
    if (match === null) return undefined;
    try {
      const decoded = Buffer.from(match[1] ?? '', 'base64').toString('utf8');
      const separator = decoded.indexOf(':');
      const clientId = separator > 0 ? decoded.slice(0, separator) : '';
      return CLIENT_ID_PATTERN.test(clientId) ? clientId : undefined;
    } catch {
      return undefined;
    }
  }

  private async recordFailure(client: OAuthServiceClient, traceId: string, reason: string): Promise<void> {
    await this.audit.recordTrustedService(client.tenantId, {
      actorId: client.actorId,
      traceId,
      action: 'identity.oauth.service-token.issue',
      resourceType: 'oauth_client',
      resourceId: client.clientId,
      riskLevel: 'R1',
      outcome: 'failure',
      metadata: { reason },
    });
  }
}
