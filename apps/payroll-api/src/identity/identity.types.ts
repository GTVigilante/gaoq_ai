import type { PayrollIdentityContext } from '@gaoq/platform-contracts';
import type { Request } from 'express';

/** 已通过 GaoQ JWKS 验签并绑定算薪资源的请求。 */
export interface AuthenticatedPayrollRequest extends Request {
  payrollIdentity?: PayrollIdentityContext;
}
