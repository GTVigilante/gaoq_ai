import type {
  DepartmentProjection,
  EmployeeProjection,
  EmploymentProjection,
} from './payroll-events.js';

/** 主数据快照游标分页响应。 */
export interface PayrollMasterDataSnapshotPage {
  readonly contractVersion: '1.0.0';
  readonly snapshotId: string;
  readonly generatedAt: string;
  readonly nextCursor: string | null;
  readonly departments: readonly DepartmentProjection[];
  readonly employees: readonly EmployeeProjection[];
  readonly employments: readonly EmploymentProjection[];
  readonly snapshotDigest: string;
}
