import { z } from 'zod';

const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const MONTH_DAY_PATTERN = /^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/;
const EXTERNAL_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const PUBLIC_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SLUG_PATTERN = /^(?:[a-z0-9]+(?:-[a-z0-9]+)*)$/;
const FILE_NAME_PATTERN = /^[^/\\\0]{1,180}$/;
const CANONICAL_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** 校验 UTC 毫秒精度规范时间，拒绝日期自动溢出。 */
function isCanonicalInstant(value: string): boolean {
  const timestamp = new Date(value);
  return !Number.isNaN(timestamp.getTime()) && timestamp.toISOString() === value;
}

/** 校验闰年口径下的规范月日，不接受日期自动溢出。 */
function isCanonicalMonthDay(value: string): boolean {
  const date = new Date(`2000-${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(5, 10) === value
  );
}

export const strictEmptyRequestSchema = z.object({}).strict();
export const attestPersonBirthdayRequestSchema = z.object({
  monthDay: z.string().regex(MONTH_DAY_PATTERN).refine(isCanonicalMonthDay),
  identityEvidenceId: z.string().regex(ULID_PATTERN),
  birthdayEvidenceId: z.string().regex(ULID_PATTERN),
}).strict();
export const retryReasonSchema = z.object({
  reason: z.string(),
}).strict();
const marketingBlockSchema = z.object({
  type: z.enum([
    'hero',
    'service_grid',
    'case_list',
    'metrics',
    'process',
    'rich_text',
    'faq',
    'logo_wall',
    'cta',
  ]),
  data: z.record(z.string(), z.unknown()),
}).strict();
const marketingSeoSchema = z.object({
  title: z.string().max(500).optional(),
  description: z.string().max(500).optional(),
  canonicalPath: z.string().max(500).optional(),
  imageRef: z.string().max(500).optional(),
  robots: z.string().max(500).optional(),
}).strict();
export const marketingContentRequestSchema = z.object({
  siteId: z.string().regex(PUBLIC_ID_PATTERN),
  type: z.enum([
    'page',
    'service',
    'case',
    'article',
    'team',
    'testimonial',
    'faq',
    'navigation',
    'footer',
    'site_config',
  ]),
  locale: z.enum(['zh-CN', 'en']),
  slug: z.string().regex(SLUG_PATTERN),
  title: z.string().min(1).max(160),
  summary: z.string().max(500).optional(),
  blocks: z.array(marketingBlockSchema).max(40),
  seo: marketingSeoSchema.optional(),
}).strict();

export const authorizationCodeTokenRequestSchema = z.object({
  grant_type: z.literal('authorization_code'),
  client_id: z.string().min(1).max(128),
  code: z.string().min(1).max(256),
  redirect_uri: z.string().min(1).max(2_048),
  resource: z.string().min(1).max(2_048),
  code_verifier: z.string().min(43).max(128),
}).strict();

export const clientCredentialsTokenRequestSchema = z.object({
  grant_type: z.literal('client_credentials'),
  resource: z.string().min(1).max(2_048),
  scope: z.string().min(1).max(12_900).optional(),
  client_id: z.string().min(1).max(128).optional(),
  client_assertion_type: z.string().min(1).max(128).optional(),
  client_assertion: z.string().min(1).max(8_192).optional(),
}).strict();

export const eSignIssuanceRequestSchema = z.object({
  offerId: z.string().regex(ULID_PATTERN),
  providerFileId: z.string().regex(EXTERNAL_ID_PATTERN),
  expiresAt: z.string(),
  signaturePosition: z.object({
    page: z.number().int(),
    x: z.number().finite(),
    y: z.number().finite(),
  }).strict(),
}).strict();

export const eSignIssuanceResolutionRequestSchema = z.object({
  decision: z.enum(['retry', 'attach_external_flow']),
  reason: z.enum([
    'credentials_fixed',
    'offer_state_fixed',
    'provider_recovered',
    'approved_exception',
  ]),
  providerConfirmedNotCommitted: z.boolean(),
  providerConfirmedMatchesRequest: z.boolean(),
  externalFlowId: z.string().regex(EXTERNAL_ID_PATTERN).optional(),
}).strict();

export const recruitmentCalendarResolutionRequestSchema = z.object({
  externalCalendarId: z.string(),
  decision: z.string(),
  reason: z.string(),
  externalEventId: z.string().optional(),
}).strict();

export const marketingContentScheduleRequestSchema = z.object({
  scheduledAt: z.string(),
}).strict();
export const marketingContentRollbackRequestSchema = z.object({
  revision: z.number().int().min(1),
}).strict();
export const marketingLeadStatusRequestSchema = z.object({
  status: z.enum(['new', 'contacted', 'qualified', 'unqualified', 'converted', 'closed']),
}).strict();
export const marketingLeadAssigneeRequestSchema = z.object({
  assigneeId: z.string().regex(PUBLIC_ID_PATTERN),
}).strict();
export const marketingLeadNoteRequestSchema = z.object({
  body: z.string().min(1).max(2_000),
}).strict();
export const marketingMediaUploadRequestSchema = z.object({
  siteId: z.string().regex(PUBLIC_ID_PATTERN),
  fileName: z.string().regex(FILE_NAME_PATTERN),
  mimeType: z.enum([
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/avif',
    'application/pdf',
  ]),
  sizeBytes: z.number().int().min(1).max(20_971_520),
  altText: z.object({
    'zh-CN': z.string().max(500).optional(),
    en: z.string().max(500).optional(),
  }).strict(),
  copyrightSource: z.string().max(500),
}).strict();
export const marketingAiDraftRequestSchema = z.object({
  action: z.enum(['translate', 'rewrite', 'outline', 'seo', 'alt_text']),
  targetLocale: z.enum(['zh-CN', 'en']),
  instruction: z.string().max(1_000),
}).strict();
export const marketingAiReviewRequestSchema = z.object({
  decision: z.enum(['accepted', 'rejected']),
}).strict();
export const marketingLeadInputRequestSchema = z.object({
  audience: z.enum(['creator', 'brand']),
  name: z.string().trim().min(1).max(100),
  contact: z.string().trim().min(5).max(254),
  requestSummary: z.string().trim().min(10).max(2_000),
  privacyAccepted: z.literal(true),
  website: z.literal(''),
  utmSource: z.unknown().optional(),
  utmCampaign: z.unknown().optional(),
}).strict();
export const marketingPublicLeadRequestSchema = marketingLeadInputRequestSchema.extend({
  captchaToken: z.string().min(16).max(4_096),
}).strict();

export const talentTouchpointCreateRequestSchema = z.object({
  kind: z.enum([
    'candidate_outreach',
    'interview_support',
    'offer_support',
    'onboarding_support',
    'employee_care',
    'offboarding_support',
    'alumni_engagement',
    'rehire_contact',
  ]),
  channel: z.enum(['email', 'phone', 'wechat', 'meeting', 'portal', 'internal']),
  direction: z.enum(['inbound', 'outbound', 'internal']),
  outcome: z.enum([
    'contacted',
    'no_response',
    'follow_up_required',
    'resolved',
    'declined',
    'joined',
    'departed',
    'consent_withdrawn',
  ]),
  occurredAt: z.string().regex(CANONICAL_INSTANT_PATTERN).refine(isCanonicalInstant),
  nextActionAt: z.string().regex(CANONICAL_INSTANT_PATTERN).refine(isCanonicalInstant).optional(),
  note: z.string().max(1_000).optional(),
}).strict();
export const talentTouchpointCloseRequestSchema = z.object({
  status: z.enum(['completed', 'cancelled']),
}).strict();

export type RestRequestContract = Readonly<{
  name: string;
  contentType: string;
  schema: z.ZodType;
  required?: boolean;
  runtimeSource: string;
}>;

export const restRequestContracts: Readonly<Record<string, RestRequestContract>> = Object.freeze({
  'ApprovalNotificationOperationsController.retry': {
    name: 'ApprovalNotificationRetryRequest',
    contentType: 'application/json',
    schema: retryReasonSchema,
    runtimeSource:
      'apps/erp-api/src/modules/approval/approval-notification-operations.controller.ts#retryRequestSchema',
  },
  'OAuthController.token': {
    name: 'OAuthTokenRequest',
    contentType: 'application/x-www-form-urlencoded',
    schema: z.discriminatedUnion('grant_type', [
      authorizationCodeTokenRequestSchema,
      clientCredentialsTokenRequestSchema,
    ]),
    runtimeSource:
      'apps/erp-api/src/modules/identity/oauth.controller.ts#authorizationCodeTokenRequestSchema|clientCredentialsTokenRequestSchema',
  },
  'ESignIssuanceController.request': {
    name: 'ESignIssuanceRequest',
    contentType: 'application/json',
    schema: eSignIssuanceRequestSchema,
    runtimeSource:
      'apps/erp-api/src/modules/integration/esign-issuance.controller.ts#parseRequest',
  },
  'ESignIssuanceController.resolve': {
    name: 'ESignIssuanceResolutionRequest',
    contentType: 'application/json',
    schema: eSignIssuanceResolutionRequestSchema,
    runtimeSource:
      'apps/erp-api/src/modules/integration/esign-issuance.controller.ts#parseResolution',
  },
  'IntegrationController.retry': {
    name: 'OrgDeliveryRetryRequest',
    contentType: 'application/json',
    schema: retryReasonSchema,
    runtimeSource:
      'apps/erp-api/src/modules/integration/integration.controller.ts#retryRequestSchema',
  },
  'RecruitmentCalendarOperationsController.resolve': {
    name: 'RecruitmentCalendarResolutionRequest',
    contentType: 'application/json',
    schema: recruitmentCalendarResolutionRequestSchema,
    runtimeSource:
      'apps/erp-api/src/modules/integration/recruitment-calendar-operations.controller.ts#resolutionRequestSchema',
  },
  'MarketingCmsController.create': {
    name: 'MarketingContentCreateRequest',
    contentType: 'application/json',
    schema: marketingContentRequestSchema,
    runtimeSource:
      'apps/erp-api/src/modules/marketing-cms/marketing-cms.types.ts#parseContentInput',
  },
  'MarketingCmsController.update': {
    name: 'MarketingContentUpdateRequest',
    contentType: 'application/json',
    schema: marketingContentRequestSchema,
    runtimeSource:
      'apps/erp-api/src/modules/marketing-cms/marketing-cms.types.ts#parseContentInput',
  },
  'MarketingCmsController.schedule': {
    name: 'MarketingContentScheduleRequest',
    contentType: 'application/json',
    schema: marketingContentScheduleRequestSchema,
    runtimeSource:
      'apps/erp-api/src/contracts/rest-request-contracts.ts#marketingContentScheduleRequestSchema',
  },
  'MarketingCmsController.rollback': {
    name: 'MarketingContentRollbackRequest',
    contentType: 'application/json',
    schema: marketingContentRollbackRequestSchema,
    runtimeSource:
      'apps/erp-api/src/contracts/rest-request-contracts.ts#marketingContentRollbackRequestSchema',
  },
  'MarketingCmsController.updateLead': {
    name: 'MarketingLeadStatusRequest',
    contentType: 'application/json',
    schema: marketingLeadStatusRequestSchema,
    runtimeSource:
      'apps/erp-api/src/contracts/rest-request-contracts.ts#marketingLeadStatusRequestSchema',
  },
  'MarketingCmsController.assignLead': {
    name: 'MarketingLeadAssigneeRequest',
    contentType: 'application/json',
    schema: marketingLeadAssigneeRequestSchema,
    runtimeSource:
      'apps/erp-api/src/contracts/rest-request-contracts.ts#marketingLeadAssigneeRequestSchema',
  },
  'MarketingCmsController.addLeadNote': {
    name: 'MarketingLeadNoteRequest',
    contentType: 'application/json',
    schema: marketingLeadNoteRequestSchema,
    runtimeSource:
      'apps/erp-api/src/contracts/rest-request-contracts.ts#marketingLeadNoteRequestSchema',
  },
  'MarketingCmsController.createMedia': {
    name: 'MarketingMediaUploadRequest',
    contentType: 'application/json',
    schema: marketingMediaUploadRequestSchema,
    runtimeSource:
      'apps/erp-api/src/modules/marketing-cms/marketing-cms.service.ts#parseMediaInput',
  },
  'MarketingCmsController.aiDraft': {
    name: 'MarketingAiDraftRequest',
    contentType: 'application/json',
    schema: marketingAiDraftRequestSchema,
    runtimeSource:
      'apps/erp-api/src/modules/marketing-cms/marketing-cms.service.ts#parseAiInput',
  },
  'MarketingCmsController.reviewAiDraft': {
    name: 'MarketingAiReviewRequest',
    contentType: 'application/json',
    schema: marketingAiReviewRequestSchema,
    runtimeSource:
      'apps/erp-api/src/contracts/rest-request-contracts.ts#marketingAiReviewRequestSchema',
  },
  'MarketingPublicController.submitLead': {
    name: 'MarketingPublicLeadRequest',
    contentType: 'application/json',
    schema: marketingPublicLeadRequestSchema,
    runtimeSource:
      'apps/erp-api/src/contracts/rest-request-contracts.ts#marketingPublicLeadRequestSchema|apps/erp-api/src/modules/marketing-cms/marketing-cms.service.ts#parseLead',
  },
  'OrgPersonBirthdayController.attest': {
    name: 'AttestPersonBirthdayRequest',
    contentType: 'application/json',
    schema: attestPersonBirthdayRequestSchema,
    runtimeSource:
      'apps/erp-api/src/modules/org/application/org-person-birthday.dto.ts#attestPersonBirthdayRequestSchema',
  },
  'RecruitmentInterviewController.cancel': {
    name: 'RecruitmentInterviewCancelRequest',
    contentType: 'application/json',
    schema: strictEmptyRequestSchema,
    required: false,
    runtimeSource:
      'apps/erp-api/src/modules/recruitment/recruitment-interview.controller.ts#requireEmptyBody',
  },
  'RecruitmentInterviewController.complete': {
    name: 'RecruitmentInterviewCompleteRequest',
    contentType: 'application/json',
    schema: strictEmptyRequestSchema,
    required: false,
    runtimeSource:
      'apps/erp-api/src/modules/recruitment/recruitment-interview.controller.ts#requireEmptyBody',
  },
  'RecruitmentOfferController.requestSend': {
    name: 'RecruitmentOfferSendRequest',
    contentType: 'application/json',
    schema: strictEmptyRequestSchema,
    required: false,
    runtimeSource:
      'apps/erp-api/src/modules/recruitment/recruitment-offer.controller.ts#requireEmptyBody',
  },
  'RecruitmentOfferController.submit': {
    name: 'RecruitmentOfferSubmitRequest',
    contentType: 'application/json',
    schema: strictEmptyRequestSchema,
    required: false,
    runtimeSource:
      'apps/erp-api/src/modules/recruitment/recruitment-offer.controller.ts#requireEmptyBody',
  },
  'RecruitmentOfferController.syncApproval': {
    name: 'RecruitmentOfferSyncApprovalRequest',
    contentType: 'application/json',
    schema: strictEmptyRequestSchema,
    required: false,
    runtimeSource:
      'apps/erp-api/src/modules/recruitment/recruitment-offer.controller.ts#requireEmptyBody',
  },
  'RecruitmentManagementController.submitRequisition': {
    name: 'RecruitmentRequisitionSubmitRequest',
    contentType: 'application/json',
    schema: strictEmptyRequestSchema,
    required: false,
    runtimeSource:
      'apps/erp-api/src/modules/recruitment/recruitment-management.controller.ts#requireEmptyBody',
  },
  'RecruitmentManagementController.syncApproval': {
    name: 'RecruitmentRequisitionSyncApprovalRequest',
    contentType: 'application/json',
    schema: strictEmptyRequestSchema,
    required: false,
    runtimeSource:
      'apps/erp-api/src/modules/recruitment/recruitment-management.controller.ts#requireEmptyBody',
  },
  'TalentLifecycleController.createTouchpoint': {
    name: 'TalentTouchpointCreateRequest',
    contentType: 'application/json',
    schema: talentTouchpointCreateRequestSchema,
    runtimeSource:
      'apps/erp-api/src/modules/talent-lifecycle/talent-lifecycle.controller.ts#createTouchpointSchema',
  },
  'TalentLifecycleController.closeTouchpoint': {
    name: 'TalentTouchpointCloseRequest',
    contentType: 'application/json',
    schema: talentTouchpointCloseRequestSchema,
    runtimeSource:
      'apps/erp-api/src/modules/talent-lifecycle/talent-lifecycle.controller.ts#closeTouchpointSchema',
  },
});

/** 对 Zod 明确允许任意值的空 Schema 加注，不让开放字段伪装成遗漏。 */
function annotateIntentionalUnknown(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(annotateIntentionalUnknown);
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  const entries = Object.entries(value);
  if (entries.length === 0) {
    return { 'x-intentionally-untyped': true };
  }
  return Object.fromEntries(
    entries.map(([key, item]) => [key, annotateIntentionalUnknown(item)]),
  );
}

/** 输出供 OpenAPI 生成器消费的确定性 JSON Schema，不包含运行期对象引用。 */
export function openApiRequestContracts(): Readonly<
  Record<string, Readonly<{
    name: string;
    contentType: string;
    schema: Readonly<Record<string, unknown>>;
    required?: boolean;
    runtimeSource: string;
  }>>
> {
  return Object.freeze(Object.fromEntries(
    Object.entries(restRequestContracts)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([operationId, contract]) => {
        const schema = z.toJSONSchema(contract.schema);
        delete schema.$schema;
        const annotatedSchema = annotateIntentionalUnknown(schema) as Readonly<
          Record<string, unknown>
        >;
        return [
          operationId,
          Object.freeze({
            name: contract.name,
            contentType: contract.contentType,
            schema: Object.freeze(annotatedSchema),
            ...(contract.required === undefined ? {} : { required: contract.required }),
            runtimeSource: contract.runtimeSource,
          }),
        ];
      }),
  ));
}
