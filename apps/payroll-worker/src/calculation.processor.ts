import {
  calculatePayrollLine,
  type PayrollLineInput,
  type PayrollLineResult,
} from '@gaoq/payroll-core';

export interface PayrollCalculationJob {
  readonly actor: {
    readonly tenantId: string;
    readonly actorId: string;
    readonly actorType: 'service' | 'system_job';
    readonly scopes: readonly string[];
    readonly traceId: string;
  };
  readonly input: PayrollLineInput;
}

/** 在异步边界重新验证租户、主体和 Scope，禁止队列任务退化为超级权限。 */
export const processPayrollCalculationJob = (
  job: PayrollCalculationJob,
): PayrollLineResult => {
  if (
    job.actor.tenantId !== job.input.tenantId ||
    job.actor.actorId.length === 0 ||
    job.actor.traceId.length === 0 ||
    !job.actor.scopes.includes('erp:payroll:run:calculate')
  ) {
    throw new Error('异步算薪任务的可信身份上下文无效');
  }
  return calculatePayrollLine(job.input);
};
