import { Injectable, ServiceUnavailableException } from '@nestjs/common';

import type { CareTaskCode } from '../domain/index.js';

export abstract class CareTaskEvidenceVerificationPort {
  abstract verify(input: {
    readonly tenantId: string;
    readonly careCaseId: string;
    readonly employeeId: string;
    readonly taskCode: CareTaskCode;
    readonly evidenceId: string;
  }): Promise<{ readonly verified: boolean }>;
}

export abstract class AlumniConsentVerificationPort {
  abstract verify(input: {
    readonly tenantId: string;
    readonly careCaseId: string;
    readonly personId: string;
    readonly purpose: 'alumni_network' | 'rehire_contact' | 'alumni_events';
    readonly channels: readonly ('email' | 'sms' | 'phone' | 'wechat')[];
    readonly consentVersion: string;
    readonly consentEvidenceId: string;
    readonly grantedAt: string;
    readonly expiresAt: string;
  }): Promise<{ readonly verified: boolean }>;
}

@Injectable()
export class UnconfiguredCareTaskEvidenceVerifier extends CareTaskEvidenceVerificationPort {
  verify(): Promise<{ readonly verified: boolean }> {
    throw new ServiceUnavailableException({
      code: 'CARE_EVIDENCE_VERIFIER_UNAVAILABLE', message: '清算证据校验器未配置',
    });
  }
}

@Injectable()
export class UnconfiguredAlumniConsentVerifier extends AlumniConsentVerificationPort {
  verify(): Promise<{ readonly verified: boolean }> {
    throw new ServiceUnavailableException({
      code: 'CARE_CONSENT_VERIFIER_UNAVAILABLE', message: '校友授权校验器未配置',
    });
  }
}
