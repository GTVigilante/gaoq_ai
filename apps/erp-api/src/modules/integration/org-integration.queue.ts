/** BullMQ 组织集成队列名称。 */
export const ORG_INTEGRATION_QUEUE = 'org-integration';

export const ORG_INTEGRATION_JOB_NAMES = [
  'relay',
  'relay:calendar',
  'deliver:dingtalk',
  'deliver:feishu',
  'provision',
  'reconcile',
] as const;

export type OrgIntegrationJobName = (typeof ORG_INTEGRATION_JOB_NAMES)[number];
