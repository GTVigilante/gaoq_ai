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

export abstract class ESignAdapter {
  abstract getFlow(credential: ESignCredential, externalFlowId: string): Promise<number>;
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

  override async getFlow(credential: ESignCredential, externalFlowId: string): Promise<number> {
    const path = `/v3/sign-flow/${safeExternalId(externalFlowId)}/detail`;
    const body = await this.call(credential, 'GET', path);
    return flowDataSchema.parse(body.data).signFlowStatus;
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
      signFlowId: externalFlowId, async: false,
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
  if (!EXTERNAL_ID_PATTERN.test(value)) throw new Error('ESIGN_EXTERNAL_ID_INVALID');
  return encodeURIComponent(value);
}

function assertCredential(credential: ESignCredential): void {
  if (
    !/^[A-Za-z0-9_-]{4,128}$/.test(credential.appId) ||
    credential.appSecret.length < 16 || credential.appSecret.length > 2_048
  ) throw new Error('ESIGN_CREDENTIAL_INVALID');
}
