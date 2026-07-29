import type { z } from 'zod';

import { attestPersonBirthdayRequestSchema } from '../../../contracts/rest-request-contracts.js';

export { attestPersonBirthdayRequestSchema };

/** 生日证明请求契约；未知字段必须失败关闭。 */
export type AttestPersonBirthdayDto = Readonly<
  z.infer<typeof attestPersonBirthdayRequestSchema>
>;
