import { describe, expect, it } from 'vitest';

import { attestPersonBirthdayRequestSchema } from './org-person-birthday.dto.js';

const VALID = {
  monthDay: '02-29',
  identityEvidenceId: '01J8ZQK7V0A2M4N6P8R0T2W4B2',
  birthdayEvidenceId: '01J8ZQK7V0A2M4N6P8R0T2W4C3',
};

describe('生日证明请求契约', () => {
  it.each(['01-01', '02-29', '04-30', '12-31'])('接受规范日期 %s', (monthDay) => {
    expect(attestPersonBirthdayRequestSchema.safeParse({
      ...VALID,
      monthDay,
    }).success).toBe(true);
  });

  it.each(['00-01', '01-00', '02-30', '04-31', '11-31', '13-01', '2-29'])(
    '拒绝非法日期 %s',
    (monthDay) => {
      expect(attestPersonBirthdayRequestSchema.safeParse({
        ...VALID,
        monthDay,
      }).success).toBe(false);
    },
  );

  it('拒绝未知字段和非严格 ULID', () => {
    expect(attestPersonBirthdayRequestSchema.safeParse({
      ...VALID,
      tenantId: 'tenant-001',
    }).success).toBe(false);
    expect(attestPersonBirthdayRequestSchema.safeParse({
      ...VALID,
      identityEvidenceId: VALID.identityEvidenceId.toLowerCase(),
    }).success).toBe(false);
  });
});
