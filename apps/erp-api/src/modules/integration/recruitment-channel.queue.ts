export const RECRUITMENT_CHANNEL_QUEUE = 'integration-recruitment-channel';
export const RECRUITMENT_CHANNEL_SCAN_JOB = 'scan:recruitment:channel-bindings';
export const RECRUITMENT_CHANNEL_PULL_JOB = 'pull:recruitment:applications';
export const RECRUITMENT_CHANNEL_PROCESS_JOB = 'process:recruitment:application';
export const RECRUITMENT_CHANNEL_RELAY_POSITIONS_JOB = 'relay:recruitment:positions';
export const RECRUITMENT_CHANNEL_DELIVER_POSITIONS_JOB = 'deliver:recruitment:positions';
export const RECRUITMENT_CHANNEL_RELAY_STAGES_JOB = 'relay:recruitment:application-stages';
export const RECRUITMENT_CHANNEL_DELIVER_STAGES_JOB = 'deliver:recruitment:application-stages';

export type RecruitmentChannelScanJobData = Record<string, never>;
export interface RecruitmentChannelPullJobData {
  readonly tenantId: string;
  readonly bindingId: string;
}
export interface RecruitmentChannelProcessJobData {
  readonly tenantId: string;
  readonly inboxId: string;
}

export type RecruitmentChannelJobData =
  | RecruitmentChannelScanJobData
  | Record<string, never>
  | RecruitmentChannelPullJobData
  | RecruitmentChannelProcessJobData;
