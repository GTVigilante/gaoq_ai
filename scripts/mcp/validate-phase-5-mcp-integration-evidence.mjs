import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { catalog } from './validate-phase-5-mcp-catalog.mjs';

const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/u;
const CLIENTS = Object.freeze({
  'interactive-user-agent': 'authorization-code-pkce',
  'machine-service-agent': 'client-credentials',
  'read-only-audit-agent': 'authorization-code-pkce',
});
const INTEGRATIONS = [
  'attachment', 'bank', 'dingtalk', 'esign', 'feishu', 'op',
  'professional-payroll', 'tax', 'worm',
];
const PROFESSIONAL_PAYROLL_TOOLS = Object.freeze([
  'payroll_payslip_get_self',
  'payroll_period_get',
  'payroll_reconciliation_get',
  'payroll_tax_filing_get',
]);
const PROFESSIONAL_PAYROLL_RESOURCES = Object.freeze([
  'payroll://payslips/self/{period}',
  'payroll://periods/{period}',
]);
const PROFESSIONAL_PAYROLL_PROMPTS = Object.freeze([
  'payroll_payslip_explain_self',
  'payroll_period_status_guide',
]);
const SIGNOFFS = ['integration_owner', 'mcp_owner', 'qa_owner', 'security_owner'];
const SIGNOFF_SIGNATURE_SUITE = 'gaoq.phase5.integration-mcp.signoff.v1';
const SIGNOFF_WINDOW_MS = 24 * 60 * 60 * 1_000;

if (process.argv[2] === '--self-test') {
  validate(fixture());
  const bound = fixture();
  process.env.MCP_INTEGRATION_EXPECTED_ENVIRONMENT = bound.environment.name;
  process.env.MCP_INTEGRATION_EXPECTED_COMMIT = bound.source.commitSha;
  process.env.MCP_INTEGRATION_EXPECTED_API_IMAGE = bound.source.images.api;
  process.env.MCP_INTEGRATION_EXPECTED_WORKER_IMAGE = bound.source.images.worker;
  process.env.MCP_INTEGRATION_EXPECTED_WEB_IMAGE = bound.source.images.web;
  process.env.MCP_INTEGRATION_EXPECTED_WEBSITE_IMAGE = bound.source.images.website;
  process.env.MCP_INTEGRATION_EXPECTED_PAYROLL_RESOURCE =
    bound.professionalPayroll.resource;
  process.env.MCP_INTEGRATION_EXPECTED_PAYROLL_AUTHORIZATION_SERVER =
    bound.professionalPayroll.authorizationServer;
  process.env.MCP_INTEGRATION_EXPECTED_PAYROLL_IMAGE =
    bound.professionalPayroll.imageDigest;
  process.env.MCP_INTEGRATION_EXPECTED_PAYROLL_CONTRACT_HASH =
    bound.professionalPayroll.eventContractHash;
  process.env.MCP_INTEGRATION_EXPECTED_PAYROLL_CATALOG_HASH =
    bound.professionalPayroll.catalogHash;
  process.env.MCP_INTEGRATION_EXPECTED_SIGNER_KEYSET_SHA256 =
    signerKeysetHash(bound.signingAuthorities);
  validate(bound, true);
  process.env.MCP_INTEGRATION_EXPECTED_SIGNER_KEYSET_SHA256 =
    digest('unapproved-keyset');
  expectFailure(
    () => validate(bound, true),
    'PHASE5_MCP_INTEGRATION_SIGNER_KEYSET_MISMATCH',
  );
  process.env.MCP_INTEGRATION_EXPECTED_SIGNER_KEYSET_SHA256 =
    signerKeysetHash(bound.signingAuthorities);
  const stale = fixture(); stale.source.catalogHash = digest('old');
  expectFailure(() => validate(stale), 'PHASE5_MCP_INTEGRATION_CATALOG_MISMATCH');
  const leaked = fixture(); leaked.integrations[0].upstreamTokenExposures = 1;
  expectFailure(() => validate(leaked), 'PHASE5_MCP_INTEGRATION_SECURITY_FAILED');
  const escaped = fixture(); escaped.authorization.crossTenantDenied = 29;
  expectFailure(() => validate(escaped), 'PHASE5_MCP_INTEGRATION_TENANT_ESCAPE');
  const missingPayrollTool = fixture();
  missingPayrollTool.professionalPayroll.requiredTools.pop();
  expectFailure(
    () => validate(missingPayrollTool),
    'PHASE5_MCP_INTEGRATION_PAYROLL_CATALOG_INVALID',
  );
  const payrollAudienceEscape = fixture();
  payrollAudienceEscape.professionalPayroll.crossResourceTokenDenied = 29;
  expectFailure(
    () => validate(payrollAudienceEscape),
    'PHASE5_MCP_INTEGRATION_PAYROLL_AUDIENCE_ESCAPE',
  );
  const stalePayrollContract = fixture();
  stalePayrollContract.professionalPayroll.eventContractHash = digest('stale-payroll-contract');
  process.env.MCP_INTEGRATION_EXPECTED_PAYROLL_CONTRACT_HASH =
    bound.professionalPayroll.eventContractHash;
  expectFailure(
    () => validate(stalePayrollContract, true),
    'PHASE5_MCP_INTEGRATION_PAYROLL_CONTRACT_MISMATCH',
  );
  process.env.MCP_INTEGRATION_EXPECTED_COMMIT = 'b'.repeat(40);
  expectFailure(() => validate(bound, true), 'PHASE5_MCP_INTEGRATION_COMMIT_MISMATCH');
  runSignatureSelfTests();
  process.stdout.write('Phase 5 MCP 客户端与跨系统联调证据门禁自测通过。\n');
} else if (process.argv.length === 3 && process.argv[2] === '--print-contract') {
  process.stdout.write(`${JSON.stringify({
    formatVersion: 3,
    suite: 'gaoq.phase5.integration-mcp.contract',
    evidenceSuite: 'gaoq.phase5.integration-mcp.v3',
    verdictSuite: 'gaoq.phase5.integration-mcp.verdict',
    protocolVersion: '2025-11-25',
    clientProfiles: Object.keys(CLIENTS),
    integrationNames: INTEGRATIONS,
    signoffRoles: SIGNOFFS,
    signatureSuite: SIGNOFF_SIGNATURE_SUITE,
    signatureAlgorithm: 'Ed25519',
    signatureEncoding: 'base64url-unpadded',
    publicKeyEncoding: 'base64-spki-der',
    keyId: 'sha256:<lowercase-hex-of-spki-der>',
    signerKeysetCanonicalFields: ['role', 'keyId'],
    signerKeysetOrder: 'role-ascending',
    maximumSignoffAgeHours: 24,
    approvalPayloadFields: [
      'formatVersion', 'suite', 'runId', 'source', 'environment', 'clients',
      'integrations', 'professionalPayroll', 'authorization', 'safety', 'artifacts',
      'signerKeysetHash', 'signoffs',
    ],
  }, null, 2)}\n`);
} else {
  const enforce = process.argv[2] === '--enforce-environment';
  const path = process.argv[enforce ? 3 : 2];
  if (path === undefined || process.argv.length !== (enforce ? 4 : 3)) {
    fail('PHASE5_MCP_INTEGRATION_PATH_REQUIRED');
  }
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > 512 * 1_024 ||
      (stat.mode & 0o022) !== 0) fail('PHASE5_MCP_INTEGRATION_FILE_INVALID');
  const result = validate(JSON.parse(await readFile(path, 'utf8')), enforce);
  process.stdout.write(`${JSON.stringify({
    formatVersion: 3, suite: 'gaoq.phase5.integration-mcp.verdict', runId: result.runId,
    commitSha: result.commitSha, catalogHash: catalog.catalogHash,
    professionalPayrollCatalogHash: result.professionalPayroll.catalogHash,
    professionalPayrollEventContractHash: result.professionalPayroll.eventContractHash,
    signerKeysetHash: result.signerKeysetHash,
    approvalPayloadHash: result.approvalPayloadHash,
    evidenceChecksum: digest(canonical(result)),
  }, null, 2)}\n`);
}

function validate(document, enforce = false) {
  exact(document, ['formatVersion', 'suite', 'runId', 'source', 'environment', 'clients',
    'integrations', 'professionalPayroll', 'authorization', 'safety', 'artifacts',
    'signingAuthorities', 'signoffs']);
  equal(document.formatVersion, 3, 'PHASE5_MCP_INTEGRATION_FORMAT_INVALID');
  equal(document.suite, 'gaoq.phase5.integration-mcp.v3', 'PHASE5_MCP_INTEGRATION_SUITE_INVALID');
  pattern(document.runId, ULID, 'PHASE5_MCP_INTEGRATION_RUN_ID_INVALID');
  const authorities = validateSigningAuthorities(document.signingAuthorities);
  exact(document.source, ['commitSha', 'images', 'protocolVersion', 'catalogHash']);
  pattern(document.source.commitSha, COMMIT, 'PHASE5_MCP_INTEGRATION_COMMIT_INVALID');
  exact(document.source.images, ['api', 'worker', 'web', 'website']);
  for (const hash of Object.values(document.source.images)) pattern(hash, SHA256,
    'PHASE5_MCP_INTEGRATION_IMAGE_INVALID');
  equal(document.source.protocolVersion, '2025-11-25', 'PHASE5_MCP_INTEGRATION_PROTOCOL_INVALID');
  equal(document.source.catalogHash, catalog.catalogHash, 'PHASE5_MCP_INTEGRATION_CATALOG_MISMATCH');
  exact(document.environment, ['name', 'productionEquivalent', 'productionTraffic',
    'productionData', 'startedAt', 'endedAt']);
  equal(document.environment.productionEquivalent, true, 'PHASE5_MCP_INTEGRATION_ENV_INVALID');
  equal(document.environment.productionTraffic, false, 'PHASE5_MCP_INTEGRATION_PROD_FORBIDDEN');
  equal(document.environment.productionData, false, 'PHASE5_MCP_INTEGRATION_PROD_FORBIDDEN');
  if (!/(?:stage|staging|preprod|uat)/u.test(document.environment.name)) {
    fail('PHASE5_MCP_INTEGRATION_ENV_INVALID');
  }
  if (enforce) validateExpected(document, authorities.keysetHash);
  const started = time(document.environment.startedAt);
  const ended = time(document.environment.endedAt);
  if (ended - started < 30 * 60 * 1_000) fail('PHASE5_MCP_INTEGRATION_DURATION_INVALID');
  validateClients(document.clients);
  validateIntegrations(document.integrations);
  const professionalPayroll = validateProfessionalPayroll(document.professionalPayroll);
  validateAuthorization(document.authorization);
  exact(document.safety, ['productionEndpointsUsed', 'productionSideEffects', 'r3ActionsEnabled',
    'secretsInEvidence', 'directDatabaseAccess', 'upstreamTokensReturned']);
  for (const value of Object.values(document.safety)) equal(value, false,
    'PHASE5_MCP_INTEGRATION_UNSAFE');
  exact(document.artifacts, ['protocolTranscriptsHash', 'oauthMatrixHash', 'catalogArtifactHash',
    'auditQueryHash', 'sandboxMatrixHash']);
  const artifactHashes = Object.values(document.artifacts);
  for (const hash of artifactHashes) pattern(hash, SHA256, 'PHASE5_MCP_INTEGRATION_ARTIFACT_INVALID');
  if (new Set(artifactHashes).size !== artifactHashes.length) fail('PHASE5_MCP_INTEGRATION_ARTIFACT_REUSED');
  validateSignoffMetadata(document.signoffs, ended);
  const approvalPayloadHash = digest(mcpIntegrationApprovalPayload(
    document,
    authorities.keysetHash,
  ));
  const signoffEvidenceIds = validateSignoffSignatures(
    document.signoffs,
    authorities.byRole,
    approvalPayloadHash,
    ended,
  );
  return Object.freeze({ runId: document.runId, commitSha: document.source.commitSha,
    source: document.source, environment: document.environment, clients: document.clients,
    integrations: document.integrations, authorization: document.authorization,
    professionalPayroll, artifacts: document.artifacts, signoffEvidenceIds,
    signerKeysetHash: authorities.keysetHash, approvalPayloadHash });
}

function validateExpected(document, signerKeysetHashValue) {
  const expected = {
    environment: process.env.MCP_INTEGRATION_EXPECTED_ENVIRONMENT,
    commit: process.env.MCP_INTEGRATION_EXPECTED_COMMIT,
    api: process.env.MCP_INTEGRATION_EXPECTED_API_IMAGE,
    worker: process.env.MCP_INTEGRATION_EXPECTED_WORKER_IMAGE,
    web: process.env.MCP_INTEGRATION_EXPECTED_WEB_IMAGE,
    website: process.env.MCP_INTEGRATION_EXPECTED_WEBSITE_IMAGE,
    payrollResource: process.env.MCP_INTEGRATION_EXPECTED_PAYROLL_RESOURCE,
    payrollAuthorizationServer:
      process.env.MCP_INTEGRATION_EXPECTED_PAYROLL_AUTHORIZATION_SERVER,
    payrollImage: process.env.MCP_INTEGRATION_EXPECTED_PAYROLL_IMAGE,
    payrollContractHash: process.env.MCP_INTEGRATION_EXPECTED_PAYROLL_CONTRACT_HASH,
    payrollCatalogHash: process.env.MCP_INTEGRATION_EXPECTED_PAYROLL_CATALOG_HASH,
    signerKeysetHash: process.env.MCP_INTEGRATION_EXPECTED_SIGNER_KEYSET_SHA256,
  };
  if (expected.environment === undefined || !/^[a-z][a-z0-9-]{2,31}$/u.test(expected.environment)) {
    fail('PHASE5_MCP_INTEGRATION_EXPECTED_SOURCE_REQUIRED');
  }
  pattern(expected.commit, COMMIT, 'PHASE5_MCP_INTEGRATION_EXPECTED_SOURCE_REQUIRED');
  for (const field of ['api', 'worker', 'web', 'website']) {
    pattern(expected[field], SHA256, 'PHASE5_MCP_INTEGRATION_EXPECTED_SOURCE_REQUIRED');
  }
  httpsOrigin(
    expected.payrollResource,
    'PHASE5_MCP_INTEGRATION_EXPECTED_PAYROLL_SOURCE_REQUIRED',
  );
  httpsOrigin(
    expected.payrollAuthorizationServer,
    'PHASE5_MCP_INTEGRATION_EXPECTED_PAYROLL_SOURCE_REQUIRED',
  );
  pattern(
    expected.payrollImage,
    SHA256,
    'PHASE5_MCP_INTEGRATION_EXPECTED_PAYROLL_SOURCE_REQUIRED',
  );
  pattern(
    expected.payrollContractHash,
    SHA256,
    'PHASE5_MCP_INTEGRATION_EXPECTED_PAYROLL_SOURCE_REQUIRED',
  );
  pattern(
    expected.payrollCatalogHash,
    SHA256,
    'PHASE5_MCP_INTEGRATION_EXPECTED_PAYROLL_SOURCE_REQUIRED',
  );
  pattern(
    expected.signerKeysetHash,
    SHA256,
    'PHASE5_MCP_INTEGRATION_EXPECTED_SIGNER_KEYSET_REQUIRED',
  );
  equal(document.environment.name, expected.environment, 'PHASE5_MCP_INTEGRATION_ENV_MISMATCH');
  equal(document.source.commitSha, expected.commit, 'PHASE5_MCP_INTEGRATION_COMMIT_MISMATCH');
  for (const image of ['api', 'worker', 'web', 'website']) {
    equal(document.source.images[image], expected[image], 'PHASE5_MCP_INTEGRATION_IMAGE_MISMATCH');
  }
  equal(
    document.professionalPayroll.resource,
    expected.payrollResource,
    'PHASE5_MCP_INTEGRATION_PAYROLL_RESOURCE_MISMATCH',
  );
  equal(
    document.professionalPayroll.authorizationServer,
    expected.payrollAuthorizationServer,
    'PHASE5_MCP_INTEGRATION_PAYROLL_AUTHORIZATION_SERVER_MISMATCH',
  );
  equal(
    document.professionalPayroll.imageDigest,
    expected.payrollImage,
    'PHASE5_MCP_INTEGRATION_PAYROLL_IMAGE_MISMATCH',
  );
  equal(
    document.professionalPayroll.eventContractHash,
    expected.payrollContractHash,
    'PHASE5_MCP_INTEGRATION_PAYROLL_CONTRACT_MISMATCH',
  );
  equal(
    document.professionalPayroll.catalogHash,
    expected.payrollCatalogHash,
    'PHASE5_MCP_INTEGRATION_PAYROLL_CATALOG_MISMATCH',
  );
  equal(
    signerKeysetHashValue,
    expected.signerKeysetHash,
    'PHASE5_MCP_INTEGRATION_SIGNER_KEYSET_MISMATCH',
  );
}

function validateClients(clients) {
  if (!Array.isArray(clients) || clients.length !== 3) fail('PHASE5_MCP_INTEGRATION_CLIENTS_INCOMPLETE');
  const profiles = [];
  for (const client of clients) {
    exact(client, ['profile', 'authFlow', 'initialized', 'protocolVersion', 'catalogHash',
      'toolCount', 'resourceCount', 'resourceTemplateCount', 'promptCount', 'toolCalls',
      'structuredOutputFailures', 'schemaFailures', 'errorContractFailures',
      'timeoutCancellationFailures', 'idempotencyFailures', 'auditEvents', 'evidenceHash']);
    if (!Object.hasOwn(CLIENTS, client.profile)) fail('PHASE5_MCP_INTEGRATION_CLIENT_INVALID');
    profiles.push(client.profile);
    equal(client.authFlow, CLIENTS[client.profile], 'PHASE5_MCP_INTEGRATION_AUTH_FLOW_INVALID');
    equal(client.initialized, true, 'PHASE5_MCP_INTEGRATION_INITIALIZE_FAILED');
    equal(client.protocolVersion, '2025-11-25', 'PHASE5_MCP_INTEGRATION_PROTOCOL_INVALID');
    equal(client.catalogHash, catalog.catalogHash, 'PHASE5_MCP_INTEGRATION_CATALOG_MISMATCH');
    equal(client.toolCount, 50, 'PHASE5_MCP_INTEGRATION_CATALOG_MISMATCH');
    integer(client.resourceCount, 4, 10_000, 'PHASE5_MCP_INTEGRATION_COVERAGE');
    integer(client.resourceTemplateCount, 27, 10_000, 'PHASE5_MCP_INTEGRATION_COVERAGE');
    integer(client.promptCount, 25, 10_000, 'PHASE5_MCP_INTEGRATION_COVERAGE');
    integer(client.toolCalls, 10, Number.MAX_SAFE_INTEGER, 'PHASE5_MCP_INTEGRATION_COVERAGE');
    for (const field of ['structuredOutputFailures', 'schemaFailures', 'errorContractFailures',
      'timeoutCancellationFailures', 'idempotencyFailures']) equal(client[field], 0,
      'PHASE5_MCP_INTEGRATION_CLIENT_FAILED');
    integer(client.auditEvents, client.toolCalls, Number.MAX_SAFE_INTEGER,
      'PHASE5_MCP_INTEGRATION_AUDIT_INCOMPLETE');
    pattern(client.evidenceHash, SHA256, 'PHASE5_MCP_INTEGRATION_CLIENT_EVIDENCE_INVALID');
  }
  if (canonical(profiles.sort()) !== canonical(Object.keys(CLIENTS).sort())) {
    fail('PHASE5_MCP_INTEGRATION_CLIENTS_INCOMPLETE');
  }
}

function validateIntegrations(integrations) {
  if (!Array.isArray(integrations) || integrations.length !== INTEGRATIONS.length) {
    fail('PHASE5_MCP_INTEGRATION_SYSTEMS_INCOMPLETE');
  }
  const names = []; const hashes = new Set();
  for (const item of integrations) {
    exact(item, ['name', 'sandbox', 'requests', 'successfulResponses', 'lostEvents',
      'duplicateBusinessEffects', 'unreconciledEvents', 'tenantMismatches',
      'upstreamTokenExposures', 'productionSideEffects', 'evidenceHash']);
    names.push(item.name); equal(item.sandbox, true, 'PHASE5_MCP_INTEGRATION_SANDBOX_REQUIRED');
    integer(item.requests, 10, Number.MAX_SAFE_INTEGER, 'PHASE5_MCP_INTEGRATION_COVERAGE');
    equal(item.successfulResponses, item.requests, 'PHASE5_MCP_INTEGRATION_SYSTEM_FAILED');
    for (const field of ['lostEvents', 'duplicateBusinessEffects', 'unreconciledEvents',
      'tenantMismatches', 'upstreamTokenExposures', 'productionSideEffects']) equal(item[field], 0,
      'PHASE5_MCP_INTEGRATION_SECURITY_FAILED');
    pattern(item.evidenceHash, SHA256, 'PHASE5_MCP_INTEGRATION_SYSTEM_EVIDENCE_INVALID');
    hashes.add(item.evidenceHash);
  }
  if (
    canonical(names.sort()) !== canonical([...INTEGRATIONS].sort()) ||
    hashes.size !== INTEGRATIONS.length
  ) {
    fail('PHASE5_MCP_INTEGRATION_SYSTEMS_INCOMPLETE');
  }
}

function validateProfessionalPayroll(value) {
  exact(value, [
    'resource', 'mcpEndpoint', 'authorizationServer', 'imageDigest',
    'platformContractVersion', 'eventContractHash', 'protocolVersion', 'transport',
    'oauthProfile', 'catalogHash', 'requiredTools', 'requiredResourceTemplates',
    'requiredPrompts', 'toolCount', 'resourceTemplateCount', 'promptCount',
    'initializedClientProfiles', 'payslipSelfCalls', 'eventTypesValidated',
    'eventReplayAttempts', 'eventReplayAccepted', 'legacyEventTypesRejected',
    'unknownFieldsRejected', 'crossResourceTokenAttempts', 'crossResourceTokenDenied',
    'wrongTenantAttempts', 'wrongTenantDenied', 'r3ToolCount',
    'toolsWithoutInputSchema', 'toolsWithoutOutputSchema', 'toolsWithoutRiskLevel',
    'directDatabaseAccessCount', 'upstreamTokenExposureCount', 'artifacts',
  ]);
  const resource = httpsOrigin(
    value.resource,
    'PHASE5_MCP_INTEGRATION_PAYROLL_RESOURCE_INVALID',
  );
  const authorizationServer = httpsOrigin(
    value.authorizationServer,
    'PHASE5_MCP_INTEGRATION_PAYROLL_AUTHORIZATION_SERVER_INVALID',
  );
  if (authorizationServer === resource) {
    fail('PHASE5_MCP_INTEGRATION_PAYROLL_TRUST_DOMAINS_NOT_SEPARATE');
  }
  equal(
    value.mcpEndpoint,
    `${resource}/mcp`,
    'PHASE5_MCP_INTEGRATION_PAYROLL_ENDPOINT_INVALID',
  );
  pattern(value.imageDigest, SHA256, 'PHASE5_MCP_INTEGRATION_PAYROLL_IMAGE_INVALID');
  equal(
    value.platformContractVersion,
    '1.0.0',
    'PHASE5_MCP_INTEGRATION_PAYROLL_CONTRACT_VERSION_INVALID',
  );
  pattern(
    value.eventContractHash,
    SHA256,
    'PHASE5_MCP_INTEGRATION_PAYROLL_CONTRACT_INVALID',
  );
  equal(
    value.protocolVersion,
    '2025-11-25',
    'PHASE5_MCP_INTEGRATION_PAYROLL_PROTOCOL_INVALID',
  );
  equal(
    value.transport,
    'streamable-http',
    'PHASE5_MCP_INTEGRATION_PAYROLL_TRANSPORT_INVALID',
  );
  equal(
    value.oauthProfile,
    'oauth-2.1-resource-server',
    'PHASE5_MCP_INTEGRATION_PAYROLL_OAUTH_INVALID',
  );
  pattern(value.catalogHash, SHA256, 'PHASE5_MCP_INTEGRATION_PAYROLL_CATALOG_INVALID');
  exactStringArray(
    value.requiredTools,
    PROFESSIONAL_PAYROLL_TOOLS,
    'PHASE5_MCP_INTEGRATION_PAYROLL_CATALOG_INVALID',
  );
  exactStringArray(
    value.requiredResourceTemplates,
    PROFESSIONAL_PAYROLL_RESOURCES,
    'PHASE5_MCP_INTEGRATION_PAYROLL_CATALOG_INVALID',
  );
  exactStringArray(
    value.requiredPrompts,
    PROFESSIONAL_PAYROLL_PROMPTS,
    'PHASE5_MCP_INTEGRATION_PAYROLL_CATALOG_INVALID',
  );
  integer(
    value.toolCount,
    PROFESSIONAL_PAYROLL_TOOLS.length,
    10_000,
    'PHASE5_MCP_INTEGRATION_PAYROLL_CATALOG_INVALID',
  );
  integer(
    value.resourceTemplateCount,
    PROFESSIONAL_PAYROLL_RESOURCES.length,
    10_000,
    'PHASE5_MCP_INTEGRATION_PAYROLL_CATALOG_INVALID',
  );
  integer(
    value.promptCount,
    PROFESSIONAL_PAYROLL_PROMPTS.length,
    10_000,
    'PHASE5_MCP_INTEGRATION_PAYROLL_CATALOG_INVALID',
  );
  exactStringArray(
    value.initializedClientProfiles,
    Object.keys(CLIENTS),
    'PHASE5_MCP_INTEGRATION_PAYROLL_CLIENTS_INCOMPLETE',
  );
  integer(
    value.payslipSelfCalls,
    10,
    Number.MAX_SAFE_INTEGER,
    'PHASE5_MCP_INTEGRATION_PAYROLL_COVERAGE',
  );
  equal(value.eventTypesValidated, 7, 'PHASE5_MCP_INTEGRATION_PAYROLL_EVENT_COVERAGE');
  integer(
    value.eventReplayAttempts,
    70,
    Number.MAX_SAFE_INTEGER,
    'PHASE5_MCP_INTEGRATION_PAYROLL_EVENT_COVERAGE',
  );
  equal(
    value.eventReplayAccepted,
    value.eventReplayAttempts,
    'PHASE5_MCP_INTEGRATION_PAYROLL_EVENT_REPLAY_FAILED',
  );
  integer(
    value.legacyEventTypesRejected,
    7,
    Number.MAX_SAFE_INTEGER,
    'PHASE5_MCP_INTEGRATION_PAYROLL_EVENT_COVERAGE',
  );
  integer(
    value.unknownFieldsRejected,
    7,
    Number.MAX_SAFE_INTEGER,
    'PHASE5_MCP_INTEGRATION_PAYROLL_EVENT_COVERAGE',
  );
  integer(
    value.crossResourceTokenAttempts,
    30,
    Number.MAX_SAFE_INTEGER,
    'PHASE5_MCP_INTEGRATION_PAYROLL_COVERAGE',
  );
  equal(
    value.crossResourceTokenDenied,
    value.crossResourceTokenAttempts,
    'PHASE5_MCP_INTEGRATION_PAYROLL_AUDIENCE_ESCAPE',
  );
  integer(
    value.wrongTenantAttempts,
    30,
    Number.MAX_SAFE_INTEGER,
    'PHASE5_MCP_INTEGRATION_PAYROLL_COVERAGE',
  );
  equal(
    value.wrongTenantDenied,
    value.wrongTenantAttempts,
    'PHASE5_MCP_INTEGRATION_PAYROLL_TENANT_ESCAPE',
  );
  for (const field of [
    'r3ToolCount', 'toolsWithoutInputSchema', 'toolsWithoutOutputSchema',
    'toolsWithoutRiskLevel', 'directDatabaseAccessCount', 'upstreamTokenExposureCount',
  ]) {
    equal(value[field], 0, 'PHASE5_MCP_INTEGRATION_PAYROLL_SECURITY_FAILED');
  }
  exact(value.artifacts, [
    'oauthMetadataHash', 'mcpCatalogArtifactHash', 'eventReplayHash', 'auditQueryHash',
  ]);
  const artifactHashes = Object.values(value.artifacts);
  for (const hash of artifactHashes) {
    pattern(hash, SHA256, 'PHASE5_MCP_INTEGRATION_PAYROLL_ARTIFACT_INVALID');
  }
  if (new Set(artifactHashes).size !== artifactHashes.length) {
    fail('PHASE5_MCP_INTEGRATION_PAYROLL_ARTIFACT_REUSED');
  }
  return Object.freeze({
    resource,
    authorizationServer,
    imageDigest: value.imageDigest,
    eventContractHash: value.eventContractHash,
    catalogHash: value.catalogHash,
    artifacts: value.artifacts,
  });
}

function validateAuthorization(value) {
  exact(value, ['crossTenantAttempts', 'crossTenantDenied', 'invalidScopeAttempts',
    'invalidScopeDenied', 'expiredConfirmationAttempts', 'expiredConfirmationDenied',
    'r3ToolsListed', 'auditEvents']);
  integer(value.crossTenantAttempts, 30, Number.MAX_SAFE_INTEGER, 'PHASE5_MCP_INTEGRATION_COVERAGE');
  equal(value.crossTenantDenied, value.crossTenantAttempts, 'PHASE5_MCP_INTEGRATION_TENANT_ESCAPE');
  integer(value.invalidScopeAttempts, 30, Number.MAX_SAFE_INTEGER, 'PHASE5_MCP_INTEGRATION_COVERAGE');
  equal(value.invalidScopeDenied, value.invalidScopeAttempts, 'PHASE5_MCP_INTEGRATION_SCOPE_ESCAPE');
  integer(value.expiredConfirmationAttempts, 10, Number.MAX_SAFE_INTEGER,
    'PHASE5_MCP_INTEGRATION_COVERAGE');
  equal(value.expiredConfirmationDenied, value.expiredConfirmationAttempts,
    'PHASE5_MCP_INTEGRATION_CONFIRMATION_REPLAY');
  equal(value.r3ToolsListed, 0, 'PHASE5_MCP_INTEGRATION_R3_EXPOSED');
  integer(value.auditEvents, 70, Number.MAX_SAFE_INTEGER, 'PHASE5_MCP_INTEGRATION_AUDIT_INCOMPLETE');
}

function validateSigningAuthorities(authorities) {
  if (!Array.isArray(authorities) || authorities.length !== SIGNOFFS.length) {
    fail('PHASE5_MCP_INTEGRATION_SIGNING_AUTHORITIES_INCOMPLETE');
  }
  const roles = [];
  const keyIds = new Set();
  const byRole = new Map();
  const keyset = [];
  for (const authority of authorities) {
    exact(authority, ['role', 'algorithm', 'keyId', 'publicKeySpkiBase64']);
    if (!SIGNOFFS.includes(authority.role)) {
      fail('PHASE5_MCP_INTEGRATION_SIGNING_AUTHORITY_INVALID');
    }
    equal(
      authority.algorithm,
      'Ed25519',
      'PHASE5_MCP_INTEGRATION_SIGNING_AUTHORITY_INVALID',
    );
    pattern(
      authority.keyId,
      SHA256,
      'PHASE5_MCP_INTEGRATION_SIGNING_AUTHORITY_INVALID',
    );
    const publicKey = publicKeyFromSpkiBase64(authority.publicKeySpkiBase64);
    equal(
      authority.keyId,
      publicKeyHash(publicKey),
      'PHASE5_MCP_INTEGRATION_SIGNING_AUTHORITY_KEY_MISMATCH',
    );
    roles.push(authority.role);
    keyIds.add(authority.keyId);
    byRole.set(authority.role, Object.freeze({ keyId: authority.keyId, publicKey }));
    keyset.push(Object.freeze({ role: authority.role, keyId: authority.keyId }));
  }
  exactStringSet(
    roles,
    SIGNOFFS,
    'PHASE5_MCP_INTEGRATION_SIGNING_AUTHORITIES_INCOMPLETE',
  );
  if (keyIds.size !== SIGNOFFS.length || byRole.size !== SIGNOFFS.length) {
    fail('PHASE5_MCP_INTEGRATION_SIGNING_AUTHORITIES_NOT_INDEPENDENT');
  }
  return Object.freeze({ byRole, keysetHash: signerKeysetHash(keyset) });
}

function validateSignoffMetadata(signoffs, ended) {
  if (!Array.isArray(signoffs) || signoffs.length !== SIGNOFFS.length) {
    fail('PHASE5_MCP_INTEGRATION_SIGNOFFS_INCOMPLETE');
  }
  const roles = [];
  const actorHashes = new Set();
  const ids = new Set();
  const commentHashes = new Set();
  for (const item of signoffs) {
    exact(item, [
      'role', 'actorHash', 'decision', 'evidenceId', 'commentHash', 'approvedAt',
      'signedAt', 'algorithm', 'keyId', 'signedPayloadSha256', 'signature',
    ]);
    if (!SIGNOFFS.includes(item.role)) {
      fail('PHASE5_MCP_INTEGRATION_SIGNOFF_INVALID');
    }
    pattern(item.actorHash, SHA256, 'PHASE5_MCP_INTEGRATION_SIGNOFF_ACTOR_INVALID');
    equal(item.decision, 'approve', 'PHASE5_MCP_INTEGRATION_SIGNOFF_REJECTED');
    pattern(item.evidenceId, ULID, 'PHASE5_MCP_INTEGRATION_SIGNOFF_INVALID');
    pattern(item.commentHash, SHA256, 'PHASE5_MCP_INTEGRATION_SIGNOFF_COMMENT_INVALID');
    const approvedAt = time(item.approvedAt);
    if (approvedAt < ended || approvedAt - ended > SIGNOFF_WINDOW_MS) {
      fail('PHASE5_MCP_INTEGRATION_SIGNOFF_TIME_INVALID');
    }
    roles.push(item.role);
    actorHashes.add(item.actorHash);
    ids.add(item.evidenceId);
    commentHashes.add(item.commentHash);
  }
  exactStringSet(roles, SIGNOFFS, 'PHASE5_MCP_INTEGRATION_SIGNOFFS_INCOMPLETE');
  if (actorHashes.size !== SIGNOFFS.length) {
    fail('PHASE5_MCP_INTEGRATION_SIGNOFF_ACTORS_NOT_INDEPENDENT');
  }
  if (ids.size !== SIGNOFFS.length || commentHashes.size !== SIGNOFFS.length) {
    fail('PHASE5_MCP_INTEGRATION_SIGNOFF_EVIDENCE_REUSED');
  }
}

function validateSignoffSignatures(signoffs, authorities, approvalPayloadHash, ended) {
  const signatures = new Set();
  const evidenceIds = [];
  for (const signoff of signoffs) {
    equal(signoff.algorithm, 'Ed25519', 'PHASE5_MCP_INTEGRATION_SIGNOFF_PROOF_INVALID');
    pattern(signoff.keyId, SHA256, 'PHASE5_MCP_INTEGRATION_SIGNOFF_PROOF_INVALID');
    pattern(
      signoff.signedPayloadSha256,
      SHA256,
      'PHASE5_MCP_INTEGRATION_SIGNOFF_PROOF_INVALID',
    );
    pattern(
      signoff.signature,
      SIGNATURE,
      'PHASE5_MCP_INTEGRATION_SIGNOFF_PROOF_INVALID',
    );
    const approvedAt = time(signoff.approvedAt);
    const signedAt = time(signoff.signedAt);
    if (signedAt < approvedAt || signedAt - ended > SIGNOFF_WINDOW_MS) {
      fail('PHASE5_MCP_INTEGRATION_SIGNOFF_SIGNATURE_TIME_INVALID');
    }
    const authority = authorities.get(signoff.role);
    if (authority === undefined) {
      fail('PHASE5_MCP_INTEGRATION_SIGNOFF_AUTHORITY_INVALID');
    }
    equal(
      signoff.keyId,
      authority.keyId,
      'PHASE5_MCP_INTEGRATION_SIGNOFF_KEY_MISMATCH',
    );
    const payload = mcpIntegrationSignoffPayload(approvalPayloadHash, signoff);
    equal(
      signoff.signedPayloadSha256,
      digest(payload),
      'PHASE5_MCP_INTEGRATION_SIGNOFF_PAYLOAD_MISMATCH',
    );
    const signature = decodeSignature(signoff.signature);
    if (!verify(null, Buffer.from(payload, 'utf8'), authority.publicKey, signature)) {
      fail('PHASE5_MCP_INTEGRATION_SIGNOFF_SIGNATURE_INVALID');
    }
    signatures.add(signoff.signature);
    evidenceIds.push(signoff.evidenceId);
  }
  if (signatures.size !== SIGNOFFS.length) {
    fail('PHASE5_MCP_INTEGRATION_SIGNOFF_PROOF_REUSED');
  }
  return evidenceIds;
}

function mcpIntegrationApprovalPayload(document, signerKeysetHashValue) {
  return canonical({
    formatVersion: document.formatVersion,
    suite: document.suite,
    runId: document.runId,
    source: document.source,
    environment: document.environment,
    clients: document.clients,
    integrations: document.integrations,
    professionalPayroll: document.professionalPayroll,
    authorization: document.authorization,
    safety: document.safety,
    artifacts: document.artifacts,
    signerKeysetHash: signerKeysetHashValue,
    signoffs: document.signoffs.map((signoff) => ({
      role: signoff.role,
      actorHash: signoff.actorHash,
      decision: signoff.decision,
      evidenceId: signoff.evidenceId,
      commentHash: signoff.commentHash,
      approvedAt: signoff.approvedAt,
    })),
  });
}

function mcpIntegrationSignoffPayload(approvalPayloadHash, signoff) {
  return canonical({
    suite: SIGNOFF_SIGNATURE_SUITE,
    approvalPayloadHash,
    role: signoff.role,
    keyId: signoff.keyId,
    signedAt: signoff.signedAt,
  });
}

function fixture() {
  return fixtureBundle().document;
}

function fixtureBundle() {
  const privateKeys = new Map();
  const signingAuthorities = SIGNOFFS.map((role) => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const keyId = publicKeyHash(publicKey);
    privateKeys.set(role, privateKey);
    return {
      role,
      algorithm: 'Ed25519',
      keyId,
      publicKeySpkiBase64: publicKey.export({
        format: 'der',
        type: 'spki',
      }).toString('base64'),
    };
  });
  const authoritiesByRole = new Map(
    signingAuthorities.map((authority) => [authority.role, authority]),
  );
  const hash = (label) => digest(label);
  const document = { formatVersion: 3, suite: 'gaoq.phase5.integration-mcp.v3',
    runId: '01J8ZQK7V0A2M4N6P8R0T2W6E1', source: { commitSha: 'a'.repeat(40),
      images: {
        api: hash('api'),
        worker: hash('worker'),
        web: hash('web'),
        website: hash('website'),
      },
      protocolVersion: '2025-11-25', catalogHash: catalog.catalogHash },
    environment: { name: 'mcp-uat', productionEquivalent: true, productionTraffic: false,
      productionData: false, startedAt: '2026-07-22T00:00:00.000Z',
      endedAt: '2026-07-22T01:00:00.000Z' },
    clients: Object.entries(CLIENTS).map(([profile, authFlow], index) => ({ profile, authFlow,
      initialized: true, protocolVersion: '2025-11-25', catalogHash: catalog.catalogHash,
      toolCount: 50, resourceCount: 4, resourceTemplateCount: 27, promptCount: 25,
      toolCalls: 20, structuredOutputFailures: 0, schemaFailures: 0,
      errorContractFailures: 0, timeoutCancellationFailures: 0, idempotencyFailures: 0,
      auditEvents: 20, evidenceHash: hash(`client-${index}`) })),
    integrations: INTEGRATIONS.map((name) => ({ name, sandbox: true, requests: 10,
      successfulResponses: 10, lostEvents: 0, duplicateBusinessEffects: 0,
      unreconciledEvents: 0, tenantMismatches: 0, upstreamTokenExposures: 0,
      productionSideEffects: 0, evidenceHash: hash(`integration-${name}`) })),
    professionalPayroll: {
      resource: 'https://payroll.example.invalid',
      mcpEndpoint: 'https://payroll.example.invalid/mcp',
      authorizationServer: 'https://identity.example.invalid',
      imageDigest: hash('professional-payroll-image'),
      platformContractVersion: '1.0.0',
      eventContractHash: hash('professional-payroll-event-contract'),
      protocolVersion: '2025-11-25',
      transport: 'streamable-http',
      oauthProfile: 'oauth-2.1-resource-server',
      catalogHash: hash('professional-payroll-catalog'),
      requiredTools: [...PROFESSIONAL_PAYROLL_TOOLS],
      requiredResourceTemplates: [...PROFESSIONAL_PAYROLL_RESOURCES],
      requiredPrompts: [...PROFESSIONAL_PAYROLL_PROMPTS],
      toolCount: 4,
      resourceTemplateCount: 2,
      promptCount: 2,
      initializedClientProfiles: Object.keys(CLIENTS),
      payslipSelfCalls: 10,
      eventTypesValidated: 7,
      eventReplayAttempts: 70,
      eventReplayAccepted: 70,
      legacyEventTypesRejected: 7,
      unknownFieldsRejected: 7,
      crossResourceTokenAttempts: 30,
      crossResourceTokenDenied: 30,
      wrongTenantAttempts: 30,
      wrongTenantDenied: 30,
      r3ToolCount: 0,
      toolsWithoutInputSchema: 0,
      toolsWithoutOutputSchema: 0,
      toolsWithoutRiskLevel: 0,
      directDatabaseAccessCount: 0,
      upstreamTokenExposureCount: 0,
      artifacts: {
        oauthMetadataHash: hash('professional-payroll-oauth'),
        mcpCatalogArtifactHash: hash('professional-payroll-mcp-catalog'),
        eventReplayHash: hash('professional-payroll-event-replay'),
        auditQueryHash: hash('professional-payroll-audit'),
      },
    },
    authorization: { crossTenantAttempts: 30, crossTenantDenied: 30, invalidScopeAttempts: 30,
      invalidScopeDenied: 30, expiredConfirmationAttempts: 10, expiredConfirmationDenied: 10,
      r3ToolsListed: 0, auditEvents: 70 },
    safety: { productionEndpointsUsed: false, productionSideEffects: false,
      r3ActionsEnabled: false, secretsInEvidence: false, directDatabaseAccess: false,
      upstreamTokensReturned: false },
    artifacts: Object.fromEntries(['protocolTranscriptsHash', 'oauthMatrixHash',
      'catalogArtifactHash', 'auditQueryHash', 'sandboxMatrixHash'].map((key) => [key, hash(key)])),
    signingAuthorities,
    signoffs: SIGNOFFS.map((role, index) => ({
      role,
      actorHash: hash(`actor-${role}`),
      decision: 'approve',
      evidenceId: `01J8ZQK7V0A2M4N6P8R0T2W9${index}A`,
      commentHash: hash(`comment-${role}`),
      approvedAt: `2026-07-22T0${index + 2}:00:00.000Z`,
      signedAt: `2026-07-22T0${index + 3}:00:00.000Z`,
      algorithm: 'Ed25519',
      keyId: authoritiesByRole.get(role)?.keyId,
      signedPayloadSha256: digest('unsigned'),
      signature: 'A'.repeat(86),
    })) };
  signFixture(document, privateKeys);
  return Object.freeze({ document, privateKeys });
}

function signFixture(document, privateKeys) {
  const keysetHash = signerKeysetHash(document.signingAuthorities);
  const approvalPayloadHash = digest(mcpIntegrationApprovalPayload(document, keysetHash));
  for (const signoff of document.signoffs) {
    const payload = mcpIntegrationSignoffPayload(approvalPayloadHash, signoff);
    signoff.signedPayloadSha256 = digest(payload);
    signoff.signature = sign(
      null,
      Buffer.from(payload, 'utf8'),
      privateKeys.get(signoff.role),
    ).toString('base64url');
  }
}

function runSignatureSelfTests() {
  const missingSignoff = fixture();
  missingSignoff.signoffs.pop();
  expectFailure(
    () => validate(missingSignoff),
    'PHASE5_MCP_INTEGRATION_SIGNOFFS_INCOMPLETE',
  );

  const forgedSignature = fixture();
  forgedSignature.signoffs[0].signature =
    `${forgedSignature.signoffs[0].signature[0] === 'A' ? 'B' : 'A'}${
      forgedSignature.signoffs[0].signature.slice(1)
    }`;
  expectFailure(
    () => validate(forgedSignature),
    'PHASE5_MCP_INTEGRATION_SIGNOFF_SIGNATURE_INVALID',
  );

  const tamperedAfterSigning = fixture();
  tamperedAfterSigning.artifacts.protocolTranscriptsHash =
    digest('tampered-protocol-transcripts');
  expectFailure(
    () => validate(tamperedAfterSigning),
    'PHASE5_MCP_INTEGRATION_SIGNOFF_PAYLOAD_MISMATCH',
  );

  const reusedActorBundle = fixtureBundle();
  reusedActorBundle.document.signoffs[1].actorHash =
    reusedActorBundle.document.signoffs[0].actorHash;
  signFixture(reusedActorBundle.document, reusedActorBundle.privateKeys);
  expectFailure(
    () => validate(reusedActorBundle.document),
    'PHASE5_MCP_INTEGRATION_SIGNOFF_ACTORS_NOT_INDEPENDENT',
  );

  const reusedEvidenceBundle = fixtureBundle();
  reusedEvidenceBundle.document.signoffs[1].evidenceId =
    reusedEvidenceBundle.document.signoffs[0].evidenceId;
  signFixture(reusedEvidenceBundle.document, reusedEvidenceBundle.privateKeys);
  expectFailure(
    () => validate(reusedEvidenceBundle.document),
    'PHASE5_MCP_INTEGRATION_SIGNOFF_EVIDENCE_REUSED',
  );

  const reusedAuthority = fixture();
  reusedAuthority.signingAuthorities[1].keyId =
    reusedAuthority.signingAuthorities[0].keyId;
  reusedAuthority.signingAuthorities[1].publicKeySpkiBase64 =
    reusedAuthority.signingAuthorities[0].publicKeySpkiBase64;
  expectFailure(
    () => validate(reusedAuthority),
    'PHASE5_MCP_INTEGRATION_SIGNING_AUTHORITIES_NOT_INDEPENDENT',
  );

  const swappedRoleKey = fixture();
  const firstKeyId = swappedRoleKey.signoffs[0].keyId;
  swappedRoleKey.signoffs[0].keyId = swappedRoleKey.signoffs[1].keyId;
  swappedRoleKey.signoffs[1].keyId = firstKeyId;
  expectFailure(
    () => validate(swappedRoleKey),
    'PHASE5_MCP_INTEGRATION_SIGNOFF_KEY_MISMATCH',
  );

  const lateSignatureBundle = fixtureBundle();
  lateSignatureBundle.document.signoffs[0].signedAt = '2026-07-23T01:00:01.000Z';
  signFixture(lateSignatureBundle.document, lateSignatureBundle.privateKeys);
  expectFailure(
    () => validate(lateSignatureBundle.document),
    'PHASE5_MCP_INTEGRATION_SIGNOFF_SIGNATURE_TIME_INVALID',
  );
}

function publicKeyFromSpkiBase64(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
    fail('PHASE5_MCP_INTEGRATION_SIGNING_AUTHORITY_INVALID');
  }
  let der;
  try {
    der = Buffer.from(value, 'base64');
  } catch {
    fail('PHASE5_MCP_INTEGRATION_SIGNING_AUTHORITY_INVALID');
  }
  if (
    der.length < 32 ||
    der.length > 256 ||
    der.toString('base64') !== value
  ) fail('PHASE5_MCP_INTEGRATION_SIGNING_AUTHORITY_INVALID');
  let publicKey;
  try {
    publicKey = createPublicKey({ key: der, format: 'der', type: 'spki' });
  } catch {
    fail('PHASE5_MCP_INTEGRATION_SIGNING_AUTHORITY_INVALID');
  }
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    fail('PHASE5_MCP_INTEGRATION_SIGNING_AUTHORITY_INVALID');
  }
  return publicKey;
}

function publicKeyHash(publicKey) {
  return digest(publicKey.export({ format: 'der', type: 'spki' }));
}

function signerKeysetHash(authorities) {
  return digest(canonical(
    authorities
      .map(({ role, keyId }) => ({ role, keyId }))
      .sort((left, right) => left.role.localeCompare(right.role)),
  ));
}

function decodeSignature(value) {
  let signature;
  try {
    signature = Buffer.from(value, 'base64url');
  } catch {
    fail('PHASE5_MCP_INTEGRATION_SIGNOFF_SIGNATURE_INVALID');
  }
  if (signature.length !== 64 || signature.toString('base64url') !== value) {
    fail('PHASE5_MCP_INTEGRATION_SIGNOFF_SIGNATURE_INVALID');
  }
  return signature;
}

function exact(value, keys) { if (typeof value !== 'object' || value === null || Array.isArray(value) ||
  canonical(Object.keys(value).sort()) !== canonical([...keys].sort())) fail('PHASE5_MCP_INTEGRATION_SCHEMA_INVALID'); }
function equal(actual, expected, code) { if (actual !== expected) fail(code); }
function pattern(value, regex, code) { if (typeof value !== 'string' || !regex.test(value)) fail(code); }
function integer(value, min, max, code) { if (!Number.isSafeInteger(value) || value < min || value > max) fail(code); }
function exactStringSet(actual, expected, code) {
  if (
    !Array.isArray(actual) ||
    actual.some((item) => typeof item !== 'string') ||
    new Set(actual).size !== expected.length ||
    canonical([...actual].sort()) !== canonical([...expected].sort())
  ) fail(code);
}
function exactStringArray(value, expected, code) {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== 'string') ||
    canonical([...value].sort()) !== canonical([...expected].sort())
  ) fail(code);
}
function httpsOrigin(value, code) {
  if (typeof value !== 'string' || value.length > 256) fail(code);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(code);
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.port !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.origin !== value
  ) fail(code);
  return parsed.origin;
}
function time(value) { const parsed = Date.parse(value); if (typeof value !== 'string' || !Number.isFinite(parsed) ||
  new Date(parsed).toISOString() !== value) fail('PHASE5_MCP_INTEGRATION_TIME_INVALID'); return parsed; }
function canonical(value) { if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`; return JSON.stringify(value); }
function digest(value) { return `sha256:${createHash('sha256').update(value).digest('hex')}`; }
function expectFailure(callback, code) { try { callback(); } catch (error) {
  if (error instanceof Error && error.message === code) return; throw error; } fail(`SELF_TEST_DID_NOT_FAIL:${code}`); }
function fail(code) { throw new Error(code); }
