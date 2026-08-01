import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';

import type { AppEnvironment } from '../../../config/environment.js';
import {
  validateCareOccasionPolicy,
  type CareOccasionPolicy,
} from '../domain/index.js';

const policySchema = z.object({
  tenantId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  version: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  timeZone: z.string().min(1).max(64),
  dispatchLocalTime: z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/),
  quietHoursStart: z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/),
  quietHoursEnd: z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/),
  leapDayPolicy: z.enum(['feb28', 'mar01']),
  rehireAnniversaryBasis: z.enum(['current_employment', 'original_employment']),
  birthdayTemplateCode: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  anniversaryTemplateCode: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  maxAttempts: z.number().int().min(1).max(12),
}).strict();
const policiesSchema = z.array(policySchema).max(10_000).superRefine((values, context) => {
  if (new Set(values.map((value) => value.tenantId)).size !== values.length) {
    context.addIssue({ code: 'custom', message: '关怀策略租户重复' });
  }
});

/** 关怀时区、静默时段、模板和复聘口径只来自部署控制面。 */
@Injectable()
export class CareOccasionPolicyService {
  constructor(private readonly config: ConfigService<AppEnvironment, true>) {}

  get(tenantId: string): CareOccasionPolicy {
    const raw = this.config.get('CARE_OCCASION_POLICIES_JSON', { infer: true });
    try {
      const parsed = policiesSchema.safeParse(JSON.parse(raw) as unknown);
      const policy = parsed.success
        ? parsed.data.find((value) => value.tenantId === tenantId)
        : undefined;
      if (policy !== undefined) {
        return validateCareOccasionPolicy({
          version: policy.version,
          timeZone: policy.timeZone,
          dispatchLocalTime: policy.dispatchLocalTime,
          quietHoursStart: policy.quietHoursStart,
          quietHoursEnd: policy.quietHoursEnd,
          leapDayPolicy: policy.leapDayPolicy,
          rehireAnniversaryBasis: policy.rehireAnniversaryBasis,
          birthdayTemplateCode: policy.birthdayTemplateCode,
          anniversaryTemplateCode: policy.anniversaryTemplateCode,
          maxAttempts: policy.maxAttempts,
        });
      }
    } catch {
      // 控制面配置错误统一失败关闭，不回显策略内容。
    }
    throw new ServiceUnavailableException({
      code: 'CARE_OCCASION_POLICY_UNAVAILABLE',
      message: '当前租户未配置有效关怀策略',
    });
  }
}
