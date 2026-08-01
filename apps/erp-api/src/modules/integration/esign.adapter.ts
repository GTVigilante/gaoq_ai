import { createHash, createHmac } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';

import type { AppEnvironment } from '../../config/environment.js';
import { ESignHttpClient } from './esign-http.client.js';

const EXTERNAL_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const DOWNLOAD_URL_SECONDS = 300;
const CONTENT_TYPE = 'application/json';
const ACCEPT = '*/*';
const MAX_FLOW_LIFETIME_MS = 90 * 24 * 60 * 60 * 1_000;
const MIN_FLOW_LIFETIME_MS = 5 * 60 * 1_000;
const SIGNER_ACCOUNT_PATTERN =
  /^(?:\+?[1-9][0-9]{5,19}|[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,189}[A-Za-z0-9])?\.[A-Za-z]{2,63})$/;
const SIGNER_NAME_PATTERN = /^.{1,128}$/su;

const providerEnvelopeSchema = z.object({
  code: z.number().int(),
  message: z.string().optional(),
  data: z.unknown().optional(),
}).passthrough();

const flowDataSchema = z.object({
  signFlowStatus: z.number().int().min(0).max(99),
}).passthrough();

const downloadDataSchema = z.object({
  files: z.array(z.object({
    fileId: z.string().regex(EXTERNAL_ID_PATTERN),
    downloadUrl: z.string().url(),
  }).passthrough()).min(1).max(50),
}).passthrough();

const verifyDataSchema = z.object({
  signInfos: z.array(z.object({
    signature: z.object({ modify: z.boolean() }).passthrough(),
  }).passthrough()).min(1).max(100),
}).passthrough();

const createFlowDataSchema = z.object({
  signFlowId: z.string().regex(EXTERNAL_ID_PATTERN),
}).passthrough();

const signUrlDataSchema = z.object({
  url: z.string().url(),
}).passthrough();

export interface ESignCredential {
  readonly appId: string;
  readonly appSecret: string;
}

export interface ESignDownloadDescriptor {
  readonly fileId: string;
  readonly downloadUrl: string;
}

export interface ESignVerificationResult {
  readonly valid: boolean;
  readonly signatureCount: number;
  readonly providerResultDigest: string;
}

export interface ESignCreateFlowInput {
  readonly providerFileId: string;
  readonly signerAccount: string;
  readonly signerName: string;
  readonly expiresAtEpochMs: number;
  readonly signaturePosition: {
    readonly page: number;
    readonly x: number;
    readonly y: number;
  };
}

export abstract class ESignAdapter {
  abstract createFlow(
    credential: ESignCredential,
    input: ESignCreateFlowInput,
  ): Promise<string>;
  abstract getFlow(credential: ESignCredential, externalFlowId: string): Promise<number>;
  abstract signUrl(
    credential: ESignCredential,
    externalFlowId: string,
    signerAccount: string,
  ): Promise<string>;
  abstract listSignedFiles(
    credential: ESignCredential,
    externalFlowId: string,
  ): Promise<readonly ESignDownloadDescriptor[]>;
  abstract downloadSignedFile(descriptor: ESignDownloadDescriptor): Promise<Buffer>;
  abstract verifySignedFile(
    credential: ESignCredential,
    externalFlowId: string,
    fileId: string,
  ): Promise<ESignVerificationResult>;
}

/** eSign SaaS API V3 Adapter；严格按 code 和结构处理，不依赖可变 message。 */
@Injectable()
export class ESignCnAdapter extends ESignAdapter {
  constructor(
    private readonly config: ConfigService<AppEnvironment, true>,
    private readonly http: ESignHttpClient,
  ) {
    super();
  }

  override async createFlow(
    credential: ESignCredential,
    input: ESignCreateFlowInput,
  ): Promise<string> {
    const providerFileId = assertExternalId(input.providerFileId);
    const signerAccount = safeSignerAccount(input.signerAccount);
    const signerName = safeSignerName(input.signerName);
    const expiresAtEpochMs = safeFlowExpiry(input.expiresAtEpochMs);
    const position = safeSignaturePosition(input.signaturePosition);
    const body = await this.call(credential, 'POST', '/v3/sign-flow/create-by-file', {
      docs: [{ fileId: providerFileId, fileName: '劳动合同.pdf' }],
      signFlowConfig: {
        signFlowTitle: '员工劳动合同签署',
        signFlowExpireTime: expiresAtEpochMs,
        autoStart: true,
        autoFinish: true,
        identityVerify: true,
        noticeTypes: '',
      },
      signers: [{
        signerType: 0,
        psnSignerInfo: {
          psnAccount: signerAccount,
          psnInfo: { psnName: signerName },
        },
        signFields: [{
          fileId: providerFileId,
          signFieldType: 0,
          normalSignFieldConfig: {
            autoSign: false,
            freeMode: false,
            movableSignField: false,
            signFieldPosition: {
              positionPage: String(position.page),
              positionX: position.x,
              positionY: position.y,
            },
          },
        }],
      }],
    });
    return createFlowDataSchema.parse(body.data).signFlowId;
  }

  override async getFlow(credential: ESignCredential, externalFlowId: string): Promise<number> {
    const path = `/v3/sign-flow/${safeExternalId(externalFlowId)}/detail`;
    const body = await this.call(credential, 'GET', path);
    return flowDataSchema.parse(body.data).signFlowStatus;
  }

  override async signUrl(
    credential: ESignCredential,
    externalFlowId: string,
    signerAccount: string,
  ): Promise<string> {
    const path = `/v3/sign-flow/${safeExternalId(externalFlowId)}/sign-url`;
    const body = await this.call(credential, 'POST', path, {
      clientType: 'ALL',
      needLogin: false,
      operator: { psnAccount: safeSignerAccount(signerAccount) },
      urlType: 2,
    });
    return safeESignPageUrl(signUrlDataSchema.parse(body.data).url);
  }

  override async listSignedFiles(
    credential: ESignCredential,
    externalFlowId: string,
  ): Promise<readonly ESignDownloadDescriptor[]> {
    const path = `/v3/sign-flow/${safeExternalId(externalFlowId)}/file-download-url`;
    const body = await this.call(credential, 'POST', path, {
      urlAvailableDate: DOWNLOAD_URL_SECONDS, internalUrl: false,
    });
    const parsed = downloadDataSchema.parse(body.data);
    return Object.freeze(parsed.files.map((file) => Object.freeze({
      fileId: file.fileId, downloadUrl: file.downloadUrl,
    })));
  }

  override async downloadSignedFile(descriptor: ESignDownloadDescriptor): Promise<Buffer> {
    if (!EXTERNAL_ID_PATTERN.test(descriptor.fileId)) throw new Error('ESIGN_FILE_ID_INVALID');
    return this.http.download(descriptor.downloadUrl);
  }

  override async verifySignedFile(
    credential: ESignCredential,
    externalFlowId: string,
    fileId: string,
  ): Promise<ESignVerificationResult> {
    const path = `/v3/files/${safeExternalId(fileId)}/verify`;
    const response = await this.callRaw(credential, 'POST', path, {
      signFlowId: assertExternalId(externalFlowId), async: false,
    });
    const body = this.parseEnvelope(response.body);
    const data = verifyDataSchema.parse(body.data);
    return Object.freeze({
      valid: data.signInfos.every((info) => !info.signature.modify),
      signatureCount: data.signInfos.length,
      providerResultDigest: createHash('sha256').update(response.body).digest('base64url'),
    });
  }

  private async call(
    credential: ESignCredential,
    method: 'GET' | 'POST',
    path: string,
    payload?: Readonly<Record<string, unknown>>,
  ): Promise<z.infer<typeof providerEnvelopeSchema>> {
    const response = await this.callRaw(credential, method, path, payload);
    return this.parseEnvelope(response.body);
  }

  private async callRaw(
    credential: ESignCredential,
    method: 'GET' | 'POST',
    path: string,
    payload?: Readonly<Record<string, unknown>>,
  ) {
    assertCredential(credential);
    const body = payload === undefined ? undefined : Buffer.from(JSON.stringify(payload), 'utf8');
    const headers = signESignRequest(credential, method, path, body, Date.now());
    const response = await this.http.request({
      url: `${this.config.get('ESIGN_API_BASE_URL', { infer: true })}${path}`,
      method, headers, ...(body === undefined ? {} : { body }),
    });
    if (response.status < 200 || response.status >= 300) throw new Error('ESIGN_API_HTTP_FAILED');
    return response;
  }

  private parseEnvelope(rawBody: Buffer): z.infer<typeof providerEnvelopeSchema> {
    let parsed: z.infer<typeof providerEnvelopeSchema>;
    try {
      parsed = providerEnvelopeSchema.parse(JSON.parse(rawBody.toString('utf8')) as unknown);
    } catch {
      throw new Error('ESIGN_API_RESPONSE_INVALID');
    }
    if (parsed.code !== 0) throw new Error('ESIGN_API_BUSINESS_FAILED');
    return parsed;
  }
}

/** 按官方 HmacSHA256 七段式待签名字符串生成请求头。 */
export function signESignRequest(
  credential: ESignCredential,
  method: 'GET' | 'POST',
  path: string,
  body: Buffer | undefined,
  timestamp: number,
): Readonly<Record<string, string>> {
  assertCredential(credential);
  if (!path.startsWith('/v3/') || path.includes('?') || path.includes('#')) {
    throw new Error('ESIGN_API_PATH_INVALID');
  }
  const contentMd5 = body === undefined
    ? ''
    // MD5 只是供应商协议的 Content-MD5，不用于 ERP 安全证据。
    : createHash('md5').update(body).digest('base64');
  const contentType = body === undefined ? '' : CONTENT_TYPE;
  const stringToSign = [method, ACCEPT, contentMd5, contentType, '', path].join('\n');
  const signature = createHmac('sha256', credential.appSecret)
    .update(stringToSign, 'utf8').digest('base64');
  return Object.freeze({
    'X-Tsign-Open-App-Id': credential.appId,
    'X-Tsign-Open-Auth-Mode': 'Signature',
    'X-Tsign-Open-Ca-Timestamp': String(timestamp),
    'X-Tsign-Open-Ca-Signature': signature,
    Accept: ACCEPT,
    ...(body === undefined ? {} : { 'Content-Type': CONTENT_TYPE, 'Content-MD5': contentMd5 }),
  });
}

function safeExternalId(value: string): string {
  return encodeURIComponent(assertExternalId(value));
}

function assertExternalId(value: string): string {
  if (!EXTERNAL_ID_PATTERN.test(value)) throw new Error('ESIGN_EXTERNAL_ID_INVALID');
  return value;
}

function assertCredential(credential: ESignCredential): void {
  if (
    !/^[A-Za-z0-9_-]{4,128}$/.test(credential.appId) ||
    credential.appSecret.length < 16 || credential.appSecret.length > 2_048
  ) throw new Error('ESIGN_CREDENTIAL_INVALID');
}

function safeSignerAccount(value: string): string {
  if (!SIGNER_ACCOUNT_PATTERN.test(value)) throw new Error('ESIGN_SIGNER_ACCOUNT_INVALID');
  return value;
}

function safeSignerName(value: string): string {
  const containsControlCharacter = [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
  if (
    !SIGNER_NAME_PATTERN.test(value) ||
    containsControlCharacter ||
    value.trim() !== value
  ) {
    throw new Error('ESIGN_SIGNER_NAME_INVALID');
  }
  return value;
}

function safeFlowExpiry(value: number): number {
  const now = Date.now();
  if (
    !Number.isSafeInteger(value) ||
    value < now + MIN_FLOW_LIFETIME_MS ||
    value > now + MAX_FLOW_LIFETIME_MS
  ) throw new Error('ESIGN_FLOW_EXPIRY_INVALID');
  return value;
}

function safeSignaturePosition(
  value: ESignCreateFlowInput['signaturePosition'],
): ESignCreateFlowInput['signaturePosition'] {
  if (
    !Number.isInteger(value.page) ||
    value.page < 1 ||
    value.page > 10_000 ||
    !Number.isFinite(value.x) ||
    value.x < 0 ||
    value.x > 100_000 ||
    !Number.isFinite(value.y) ||
    value.y < 0 ||
    value.y > 100_000
  ) throw new Error('ESIGN_SIGNATURE_POSITION_INVALID');
  return Object.freeze({ page: value.page, x: value.x, y: value.y });
}

function safeESignPageUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    (url.port !== '' && url.port !== '443') ||
    !(url.hostname === 'esign.cn' || url.hostname.endsWith('.esign.cn'))
  ) throw new Error('ESIGN_SIGN_URL_INVALID');
  return url.toString();
}
