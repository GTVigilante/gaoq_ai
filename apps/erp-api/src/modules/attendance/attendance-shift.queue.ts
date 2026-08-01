export const ATTENDANCE_SHIFT_QUEUE = 'attendance-shift-evaluation';
export const ATTENDANCE_SHIFT_SCAN_JOB = 'scan:attendance:shift-plans';
export const ATTENDANCE_SHIFT_EVALUATE_JOB = 'evaluate:attendance:shift';

export type AttendanceShiftScanJobData = Record<string, never>;
export interface AttendanceShiftEvaluateJobData {
  readonly tenantId: string;
  readonly shiftPlanId: string;
}
export type AttendanceShiftJobData =
  | AttendanceShiftScanJobData
  | AttendanceShiftEvaluateJobData;
