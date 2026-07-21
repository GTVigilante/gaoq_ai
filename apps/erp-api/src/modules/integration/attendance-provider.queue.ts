export const ATTENDANCE_PROVIDER_QUEUE = 'integration-attendance-provider';
export const ATTENDANCE_PROVIDER_SCAN_JOB = 'scan:attendance:provider-states';
export const ATTENDANCE_PROVIDER_PULL_JOB = 'pull:attendance:facts';
export const ATTENDANCE_PROVIDER_PROCESS_JOB = 'process:attendance:fact';

export type AttendanceProviderScanJobData = Record<string, never>;
export interface AttendanceProviderPullJobData {
  readonly tenantId: string;
  readonly stateId: string;
}
export interface AttendanceProviderProcessJobData {
  readonly tenantId: string;
  readonly inboxId: string;
}
export type AttendanceProviderJobData =
  | AttendanceProviderScanJobData
  | AttendanceProviderPullJobData
  | AttendanceProviderProcessJobData;
