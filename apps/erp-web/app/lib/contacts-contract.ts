export interface DingTalkBindingSnapshot {
  readonly channel: 'dingtalk';
  readonly boundEmployeeIds: readonly string[];
}

export interface ProvisioningInput {
  readonly employeeId: string;
  readonly channel: 'dingtalk';
  readonly contact: {
    readonly mobile: { readonly countryCode: string; readonly subscriberNumber: string };
    readonly email?: string;
  };
}

export interface ProvisioningResult {
  readonly requestId: string;
  readonly status: 'pending' | 'processing' | 'succeeded' | 'manual_review' | 'expired';
  readonly sensitiveExpiresAt: string;
}

const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const COUNTRY_CODE_PATTERN = /^\+[1-9]\d{0,3}$/u;
const SUBSCRIBER_PATTERN = /^[1-9]\d{5,14}$/u;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const RESULT_STATUSES = new Set<ProvisioningResult['status']>([
  'pending', 'processing', 'succeeded', 'manual_review', 'expired',
]);

export function canReadDingTalkBindings(scopes: readonly string[]): boolean {
  return scopes.includes('erp:integration:org_provisioning:read');
}

export function canProvisionDingTalk(scopes: readonly string[]): boolean {
  return scopes.includes('erp:integration:org_provisioning:write');
}

/** 钉钉绑定状态只接受当前员工最小标识集合。 */
export function parseDingTalkBindings(value: unknown): DingTalkBindingSnapshot {
  const record = objectRecord(value, 'DINGTALK_BINDINGS_INVALID');
  if (
    !exactKeys(record, ['channel', 'boundEmployeeIds']) ||
    record.channel !== 'dingtalk' ||
    !Array.isArray(record.boundEmployeeIds) ||
    record.boundEmployeeIds.length > 10_000 ||
    record.boundEmployeeIds.some((item) => typeof item !== 'string' || !ULID_PATTERN.test(item)) ||
    new Set(record.boundEmployeeIds).size !== record.boundEmployeeIds.length
  ) throw new Error('DINGTALK_BINDINGS_INVALID');
  return Object.freeze({
    channel: 'dingtalk',
    boundEmployeeIds: Object.freeze([...(record.boundEmployeeIds as string[])]),
  });
}

/** 将管理员私密开户表单压缩为单个钉钉请求；手机号不会写入浏览器持久化。 */
export function buildDingTalkProvisioningInput(
  employeeId: string,
  value: unknown,
): ProvisioningInput {
  if (!ULID_PATTERN.test(employeeId)) throw new Error('DINGTALK_PROVISIONING_INPUT_INVALID');
  const record = objectRecord(value, 'DINGTALK_PROVISIONING_INPUT_INVALID');
  const countryCode = record.countryCode ?? '+86';
  const email = typeof record.email === 'string' ? record.email.trim().toLowerCase() : '';
  if (
    typeof countryCode !== 'string' || !COUNTRY_CODE_PATTERN.test(countryCode) ||
    typeof record.subscriberNumber !== 'string' || !SUBSCRIBER_PATTERN.test(record.subscriberNumber) ||
    countryCode.length - 1 + record.subscriberNumber.length > 15 ||
    email.length > 254 || (email.length > 0 && !EMAIL_PATTERN.test(email))
  ) throw new Error('DINGTALK_PROVISIONING_INPUT_INVALID');
  return Object.freeze({
    employeeId,
    channel: 'dingtalk',
    contact: Object.freeze({
      mobile: Object.freeze({ countryCode, subscriberNumber: record.subscriberNumber }),
      ...(email.length === 0 ? {} : { email }),
    }),
  });
}

export function parseProvisioningResult(value: unknown): ProvisioningResult {
  const record = objectRecord(value, 'DINGTALK_PROVISIONING_RESULT_INVALID');
  if (
    !exactKeys(record, ['requestId', 'status', 'sensitiveExpiresAt']) ||
    typeof record.requestId !== 'string' || !ULID_PATTERN.test(record.requestId) ||
    typeof record.status !== 'string' ||
    !RESULT_STATUSES.has(record.status as ProvisioningResult['status']) ||
    typeof record.sensitiveExpiresAt !== 'string' ||
    !Number.isFinite(Date.parse(record.sensitiveExpiresAt))
  ) throw new Error('DINGTALK_PROVISIONING_RESULT_INVALID');
  return Object.freeze({
    requestId: record.requestId,
    status: record.status as ProvisioningResult['status'],
    sensitiveExpiresAt: record.sensitiveExpiresAt,
  });
}

function objectRecord(value: unknown, code: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(code);
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(code);
  return value as Readonly<Record<string, unknown>>;
}

function exactKeys(record: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  const keys = Object.keys(record);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}
