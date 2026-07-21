import { Injectable } from '@nestjs/common';

export interface ESignMalwareScanResult {
  readonly clean: boolean;
  readonly evidenceId: string;
}

export abstract class ESignMalwareScanner {
  abstract scan(input: {
    readonly tenantId: string;
    readonly flowId: string;
    readonly sha256: string;
    readonly bytes: Buffer;
  }): Promise<ESignMalwareScanResult>;
}

export interface ESignArchiveReceipt {
  readonly objectRef: string;
  readonly receiptId: string;
  readonly immutable: boolean;
}

export abstract class ESignImmutableArchive {
  /** objectKey 是幂等键；重试必须返回同一不可变对象回执。 */
  abstract put(input: {
    readonly tenantId: string;
    readonly objectKey: string;
    readonly contentType: 'application/pdf';
    readonly classification: 'L4';
    readonly retentionPolicy: 'employment_contract';
    readonly sha256: string;
    readonly bytes: Buffer;
  }): Promise<ESignArchiveReceipt>;
}

/** 未装配病毒扫描时失败关闭，禁止以“未发现”冒充已扫描。 */
@Injectable()
export class UnavailableESignMalwareScanner extends ESignMalwareScanner {
  override scan(): Promise<ESignMalwareScanResult> {
    return Promise.reject(new Error('ESIGN_MALWARE_SCANNER_UNAVAILABLE'));
  }
}

/** 未装配 WORM 对象归档时失败关闭，不允许只写 Mongo 伪造归档成功。 */
@Injectable()
export class UnavailableESignImmutableArchive extends ESignImmutableArchive {
  override put(): Promise<ESignArchiveReceipt> {
    return Promise.reject(new Error('ESIGN_IMMUTABLE_ARCHIVE_UNAVAILABLE'));
  }
}
