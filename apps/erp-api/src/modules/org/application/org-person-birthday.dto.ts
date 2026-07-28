import { z } from 'zod';

const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const MONTH_DAY_PATTERN = /^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/;

/** 校验闰年口径下的规范月日，不接受 02-30、04-31 等自动溢出日期。 */
function isCanonicalMonthDay(value: string): boolean {
  const date = new Date(`2000-${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(5, 10) === value
  );
}

/** 生日证明请求契约；未知字段必须失败关闭。 */
export const attestPersonBirthdayRequestSchema = z.object({
  monthDay: z.string().regex(MONTH_DAY_PATTERN).refine(isCanonicalMonthDay),
  identityEvidenceId: z.string().regex(ULID_PATTERN),
  birthdayEvidenceId: z.string().regex(ULID_PATTERN),
}).strict();

export type AttestPersonBirthdayDto = Readonly<
  z.infer<typeof attestPersonBirthdayRequestSchema>
>;
