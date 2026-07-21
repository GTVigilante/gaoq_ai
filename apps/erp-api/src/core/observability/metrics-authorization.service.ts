import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'node:crypto';

import type { AppEnvironment } from '../../config/environment.js';

const SCRAPE_AUTHORIZATION_PATTERN = /^Bearer ([\x21-\x7e]{32,256})$/;

/** API 与无 HTTP 框架 Worker 共用的指标抓取凭据校验器。 */
@Injectable()
export class MetricsAuthorizationService {
  constructor(private readonly config: ConfigService<AppEnvironment, true>) {}

  verify(authorization: string | undefined): 'valid' | 'invalid' | 'disabled' {
    const expected = this.config.get('METRICS_BEARER_TOKEN', { infer: true });
    if (expected === undefined) return 'disabled';
    const supplied = SCRAPE_AUTHORIZATION_PATTERN.exec(authorization ?? '')?.[1];
    if (supplied === undefined) return 'invalid';
    const suppliedDigest = createHash('sha256').update(supplied).digest();
    const expectedDigest = createHash('sha256').update(expected).digest();
    return timingSafeEqual(suppliedDigest, expectedDigest) ? 'valid' : 'invalid';
  }
}
