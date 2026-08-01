import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  parseCareAlumniCleanupTargets,
  type CareAlumniCleanupTarget,
} from '../../../config/care-alumni-cleanup-targets.js';
import type { AppEnvironment } from '../../../config/environment.js';

/** 只从已校验的服务端 Secret 读取登记下游，禁止请求或队列指定端点。 */
@Injectable()
export class CareAlumniCleanupTargetRegistry {
  private readonly configured: readonly CareAlumniCleanupTarget[];
  private readonly byCode: ReadonlyMap<string, CareAlumniCleanupTarget>;

  constructor(config: ConfigService<AppEnvironment, true>) {
    this.configured = parseCareAlumniCleanupTargets(
      config.get('CARE_ALUMNI_CLEANUP_TARGETS_JSON', { infer: true }),
    );
    this.byCode = new Map(this.configured.map((target) =>
      [target.targetCode, target] as const));
  }

  targets(): readonly CareAlumniCleanupTarget[] {
    return this.configured;
  }

  require(targetCode: string): CareAlumniCleanupTarget {
    if (!/^[a-z][a-z0-9_-]{1,31}$/u.test(targetCode)) {
      throw new Error('CARE_ALUMNI_CLEANUP_TARGET_CODE_INVALID');
    }
    const target = this.byCode.get(targetCode);
    if (target === undefined) throw new Error('CARE_ALUMNI_CLEANUP_TARGET_NOT_REGISTERED');
    return target;
  }
}
