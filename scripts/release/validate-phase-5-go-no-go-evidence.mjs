import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';

const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const ENVIRONMENT_NAME = /^[a-z][a-z0-9-]{2,31}$/u;
const REGION = /^[a-z0-9-]{2,32}$/u;
const GATE_NAMES = [
  'authorization', 'business-uat', 'dast-asvs', 'engineering-quality', 'integration-mcp',
  'migration', 'operations', 'performance', 'privacy-compliance', 'production-images',
  'resilience', 'supply-chain',
];
const GATE_SUITES = Object.freeze({
  authorization: 'gaoq.phase5.authorization.verdict',
  'business-uat': 'gaoq.phase5.business-uat.verdict',
  'dast-asvs': 'gaoq.phase5.dast-asvs.verdict',
  'engineering-quality': 'gaoq.phase5.engineering-quality.verdict',
  'integration-mcp': 'gaoq.phase5.integration-mcp.verdict',
  migration: 'gaoq.phase5.migration-rehearsal.verdict',
  operations: 'gaoq.phase5.operations.verdict',
  performance: 'gaoq.phase5.capacity.comparison',
  'privacy-compliance': 'gaoq.phase5.privacy-compliance.verdict',
  'production-images': 'gaoq.phase5.production-images.verdict',
  resilience: 'gaoq.phase5.resilience.verdict',
  'supply-chain': 'gaoq.phase5.supply-chain.verdict',
});
const INTEGRATION_NAMES = [
  'attachment', 'bank', 'dingtalk', 'esign', 'feishu', 'mcp', 'messaging', 'op', 'tax', 'worm',
];
const DOMAIN_NAMES = [
  'approval', 'attendance', 'audit', 'migration', 'op', 'org', 'payroll', 'recruitment',
];
const MCP_CLIENT_PROFILES = [
  'interactive-user-agent', 'machine-service-agent', 'read-only-audit-agent',
];
const SIGNOFF_ROLES = [
  'architecture_owner', 'data_owner', 'finance_owner', 'hr_owner', 'legal_owner',
  'product_owner', 'project_sponsor', 'qa_owner', 'security_owner', 'sre_owner',
];
const HARNESS_FILES = [
  ['./validate-phase-5-go-no-go-evidence.mjs', new URL(import.meta.url)],
  ['../../.github/workflows/phase-5-go-no-go.yml',
    new URL('../../.github/workflows/phase-5-go-no-go.yml', import.meta.url)],
];
const HARNESS_DIGEST = digest(canonical(Object.fromEntries(await Promise.all(
  HARNESS_FILES.map(async ([name, location]) => [name, await readFile(location, 'utf8')]),
))));

const argumentsList = process.argv.slice(2);
if (argumentsList.length === 1 && argumentsList[0] === '--self-test') {
  runSelfTest();
  process.stdout.write('Phase 5 跨职能 Go-No-Go 证据门禁自测通过。\n');
} else {
  const enforceEnvironment = argumentsList[0] === '--enforce-environment';
  const evidencePath = argumentsList[enforceEnvironment ? 1 : 0];
  if (evidencePath === undefined || argumentsList.length !== (enforceEnvironment ? 2 : 1)) {
    fail('PHASE5_GO_NO_GO_EVIDENCE_PATH_REQUIRED');
  }
  const metadata = await lstat(evidencePath);
  if (
    !metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 ||
    metadata.size > 512 * 1_024 || (metadata.mode & 0o022) !== 0
  ) fail('PHASE5_GO_NO_GO_EVIDENCE_FILE_INVALID');
  const summary = validateEvidence(parseDocument(await readFile(evidencePath, 'utf8')),
    enforceEnvironment);
  process.stdout.write(`${JSON.stringify({
    formatVersion: 1,
    suite: 'gaoq.phase5.go-no-go.verdict',
    decisionId: summary.decisionId,
    outcome: 'GO',
    commitSha: summary.commitSha,
    evidenceChecksum: digest(canonical(summary)),
  }, null, 2)}\n`);
}

function validateEvidence(document, enforceEnvironment = false, now = Date.now()) {
  object(document, [
    'formatVersion', 'suite', 'decisionId', 'environment', 'source', 'gates', 'acceptance',
    'integrations', 'mcp', 'operations', 'signoffs', 'decision',
  ], 'PHASE5_GO_NO_GO_DOCUMENT_INVALID');
  equal(document.formatVersion, 1, 'PHASE5_GO_NO_GO_FORMAT_INVALID');
  equal(document.suite, 'gaoq.phase5.go-no-go.v1', 'PHASE5_GO_NO_GO_SUITE_INVALID');
  pattern(document.decisionId, ULID, 'PHASE5_GO_NO_GO_DECISION_ID_INVALID');
  const environment = validateEnvironment(document.environment, enforceEnvironment, now);
  const source = validateSource(document.source, enforceEnvironment);
  const gates = validateGates(document.gates, environment.evaluatedAt, source.commitSha);
  const acceptance = validateAcceptance(document.acceptance);
  const integrations = validateIntegrations(document.integrations);
  const mcp = validateMcp(document.mcp);
  const operations = validateOperations(document.operations);
  const decision = validateDecision(
    document.decision,
    environment.evaluatedAt,
    gates.minimumExpiresAt,
    now,
  );
  const signoffEvidenceIds = validateSignoffs(
    document.signoffs,
    environment.evaluatedAt,
    decision.decidedAt,
  );
  return Object.freeze({
    decisionId: document.decisionId,
    commitSha: source.commitSha,
    images: source.images,
    environment: document.environment,
    gates,
    acceptance,
    integrations,
    mcp,
    operations,
    decision: document.decision,
    signoffEvidenceIds,
  });
}

function validateEnvironment(environment, enforceEnvironment, now) {
  object(environment, [
    'name', 'region', 'productionEquivalent', 'productionTraffic', 'productionData',
    'evaluatedAt',
  ], 'PHASE5_GO_NO_GO_ENV_INVALID');
  pattern(environment.name, ENVIRONMENT_NAME, 'PHASE5_GO_NO_GO_ENV_INVALID');
  pattern(environment.region, REGION, 'PHASE5_GO_NO_GO_REGION_INVALID');
  if (!/(?:^|-)(?:release|stage|staging|preprod|uat)(?:-|$)/u.test(environment.name)) {
    fail('PHASE5_GO_NO_GO_ENV_INVALID');
  }
  if (/(?:^|-)prod(?:-|$)|production/u.test(environment.name)) {
    fail('PHASE5_GO_NO_GO_PRODUCTION_FORBIDDEN');
  }
  equal(environment.productionEquivalent, true, 'PHASE5_GO_NO_GO_ENV_NOT_EQUIVALENT');
  equal(environment.productionTraffic, false, 'PHASE5_GO_NO_GO_PRODUCTION_FORBIDDEN');
  equal(environment.productionData, false, 'PHASE5_GO_NO_GO_PRODUCTION_DATA_FORBIDDEN');
  const evaluatedAt = timestamp(environment.evaluatedAt);
  if (evaluatedAt > now + 5 * 60 * 1_000 || now - evaluatedAt > 24 * 60 * 60 * 1_000) {
    fail('PHASE5_GO_NO_GO_EVALUATION_STALE');
  }
  if (enforceEnvironment) {
    const expectedName = process.env.GO_NO_GO_EXPECTED_ENVIRONMENT;
    const expectedRegion = process.env.GO_NO_GO_EXPECTED_REGION;
    if (
      expectedName === undefined || expectedRegion === undefined ||
      !ENVIRONMENT_NAME.test(expectedName) || !REGION.test(expectedRegion)
    ) fail('PHASE5_GO_NO_GO_EXPECTED_ENV_REQUIRED');
    equal(environment.name, expectedName, 'PHASE5_GO_NO_GO_ENVIRONMENT_MISMATCH');
    equal(environment.region, expectedRegion, 'PHASE5_GO_NO_GO_REGION_MISMATCH');
  }
  return Object.freeze({ evaluatedAt });
}

function validateSource(source, enforceEnvironment) {
  object(source, [
    'commitSha', 'releaseCandidate', 'images', 'deploymentManifestHash', 'harnessSha256',
  ], 'PHASE5_GO_NO_GO_SOURCE_INVALID');
  pattern(source.commitSha, COMMIT, 'PHASE5_GO_NO_GO_COMMIT_INVALID');
  pattern(source.releaseCandidate, /^rc-[0-9]{8}-[0-9]{2}$/u, 'PHASE5_GO_NO_GO_RC_INVALID');
  object(source.images, ['api', 'worker', 'web', 'website'], 'PHASE5_GO_NO_GO_IMAGES_INVALID');
  const images = Object.values(source.images);
  for (const image of images) pattern(image, SHA256, 'PHASE5_GO_NO_GO_IMAGE_INVALID');
  if (new Set(images).size !== 4) fail('PHASE5_GO_NO_GO_IMAGES_NOT_INDEPENDENT');
  pattern(source.deploymentManifestHash, SHA256, 'PHASE5_GO_NO_GO_MANIFEST_INVALID');
  equal(source.harnessSha256, HARNESS_DIGEST, 'PHASE5_GO_NO_GO_HARNESS_INVALID');
  if (enforceEnvironment) validateExpectedSource(source);
  return source;
}

function validateExpectedSource(source) {
  const expected = {
    commitSha: process.env.GO_NO_GO_EXPECTED_COMMIT,
    api: process.env.GO_NO_GO_EXPECTED_API_IMAGE,
    worker: process.env.GO_NO_GO_EXPECTED_WORKER_IMAGE,
    web: process.env.GO_NO_GO_EXPECTED_WEB_IMAGE,
    website: process.env.GO_NO_GO_EXPECTED_WEBSITE_IMAGE,
    manifest: process.env.GO_NO_GO_EXPECTED_DEPLOYMENT_MANIFEST,
  };
  pattern(expected.commitSha, COMMIT, 'PHASE5_GO_NO_GO_EXPECTED_SOURCE_REQUIRED');
  for (const field of ['api', 'worker', 'web', 'website', 'manifest']) {
    pattern(expected[field], SHA256, 'PHASE5_GO_NO_GO_EXPECTED_SOURCE_REQUIRED');
  }
  equal(source.commitSha, expected.commitSha, 'PHASE5_GO_NO_GO_COMMIT_MISMATCH');
  for (const image of ['api', 'worker', 'web', 'website']) {
    equal(source.images[image], expected[image], 'PHASE5_GO_NO_GO_IMAGE_MISMATCH');
  }
  equal(source.deploymentManifestHash, expected.manifest, 'PHASE5_GO_NO_GO_MANIFEST_MISMATCH');
}

function validateGates(gates, evaluatedAt, subjectCommitSha) {
  if (!Array.isArray(gates) || gates.length !== GATE_NAMES.length) {
    fail('PHASE5_GO_NO_GO_GATES_INCOMPLETE');
  }
  const names = [];
  const evidenceIds = new Set();
  const evidenceHashes = new Set();
  for (const gate of gates) {
    object(gate, [
      'name', 'suite', 'subjectCommitSha', 'status', 'evidenceId', 'evidenceHash',
      'completedAt', 'expiresAt',
    ], 'PHASE5_GO_NO_GO_GATE_INVALID');
    if (!Object.hasOwn(GATE_SUITES, gate.name)) fail('PHASE5_GO_NO_GO_GATE_INVALID');
    equal(gate.suite, GATE_SUITES[gate.name], 'PHASE5_GO_NO_GO_GATE_SUITE_INVALID');
    equal(gate.subjectCommitSha, subjectCommitSha, 'PHASE5_GO_NO_GO_GATE_COMMIT_MISMATCH');
    equal(gate.status, 'passed', 'PHASE5_GO_NO_GO_GATE_FAILED');
    pattern(gate.evidenceId, ULID, 'PHASE5_GO_NO_GO_GATE_EVIDENCE_INVALID');
    pattern(gate.evidenceHash, SHA256, 'PHASE5_GO_NO_GO_GATE_EVIDENCE_INVALID');
    const completedAt = timestamp(gate.completedAt);
    const expiresAt = timestamp(gate.expiresAt);
    if (
      completedAt > evaluatedAt || evaluatedAt - completedAt > 30 * 24 * 60 * 60 * 1_000 ||
      expiresAt <= evaluatedAt || expiresAt - completedAt > 90 * 24 * 60 * 60 * 1_000
    ) fail('PHASE5_GO_NO_GO_GATE_STALE');
    names.push(gate.name);
    evidenceIds.add(gate.evidenceId);
    evidenceHashes.add(gate.evidenceHash);
  }
  if (
    canonical(names.sort()) !== canonical(GATE_NAMES) ||
    evidenceIds.size !== GATE_NAMES.length || evidenceHashes.size !== GATE_NAMES.length
  ) fail('PHASE5_GO_NO_GO_GATES_INCOMPLETE');
  return Object.freeze({
    names,
    evidenceIds: [...evidenceIds],
    evidenceHashes: [...evidenceHashes],
    minimumExpiresAt: Math.min(...gates.map((gate) => timestamp(gate.expiresAt))),
  });
}

function validateAcceptance(acceptance) {
  object(acceptance, [
    'defects', 'performance', 'migration', 'resilience', 'authorization', 'business',
    'compliance',
  ], 'PHASE5_GO_NO_GO_ACCEPTANCE_INVALID');
  validateDefects(acceptance.defects);
  validatePerformance(acceptance.performance);
  validateMigration(acceptance.migration);
  validateResilience(acceptance.resilience);
  validateAuthorization(acceptance.authorization);
  validateBusiness(acceptance.business);
  validateCompliance(acceptance.compliance);
  return acceptance;
}

function validateDefects(defects) {
  object(defects, [
    'openSev1', 'openSev2', 'criticalVulnerabilities', 'highVulnerabilities',
    'unexpiredSecurityExceptions',
  ], 'PHASE5_GO_NO_GO_DEFECTS_INVALID');
  for (const value of Object.values(defects)) equal(value, 0, 'PHASE5_GO_NO_GO_BLOCKER_OPEN');
}

function validatePerformance(performance) {
  object(performance, [
    'independentRuns', 'concurrentUsers', 'maximumApiP95Milliseconds',
    'maximumErrorRate', 'payrollEmployees', 'maximumPayrollDurationSeconds',
  ], 'PHASE5_GO_NO_GO_PERFORMANCE_INVALID');
  equal(performance.independentRuns, 3, 'PHASE5_GO_NO_GO_PERFORMANCE_INVALID');
  equal(performance.concurrentUsers, 1_000, 'PHASE5_GO_NO_GO_PERFORMANCE_INVALID');
  numberRange(performance.maximumApiP95Milliseconds, 0, 499.999,
    'PHASE5_GO_NO_GO_API_P95_EXCEEDED');
  numberRange(performance.maximumErrorRate, 0, 0.01, 'PHASE5_GO_NO_GO_ERROR_RATE_EXCEEDED');
  equal(performance.payrollEmployees, 1_000, 'PHASE5_GO_NO_GO_PAYROLL_CAPACITY_INVALID');
  numberRange(performance.maximumPayrollDurationSeconds, 0, 299.999,
    'PHASE5_GO_NO_GO_PAYROLL_DURATION_EXCEEDED');
}

function validateMigration(migration) {
  object(migration, [
    'fullRehearsals', 'recordMismatches', 'relationMismatches', 'amountDifferenceMinor',
    'missingAttachments', 'checksumMismatches',
  ], 'PHASE5_GO_NO_GO_MIGRATION_INVALID');
  equal(migration.fullRehearsals, 3, 'PHASE5_GO_NO_GO_MIGRATION_INVALID');
  for (const field of [
    'recordMismatches', 'relationMismatches', 'amountDifferenceMinor', 'missingAttachments',
    'checksumMismatches',
  ]) equal(migration[field], 0, 'PHASE5_GO_NO_GO_MIGRATION_DIFFERENCE');
}

function validateResilience(resilience) {
  object(resilience, [
    'actualRpoSeconds', 'actualRtoSeconds', 'adaptersRehearsed',
    'minimumOutageSeconds', 'maximumCatchUpSeconds', 'lostEvents',
    'duplicateBusinessEffects', 'unreconciledEvents',
  ], 'PHASE5_GO_NO_GO_RESILIENCE_INVALID');
  integer(resilience.actualRpoSeconds, 0, 900, 'PHASE5_GO_NO_GO_RPO_EXCEEDED');
  integer(resilience.actualRtoSeconds, 1, 14_400, 'PHASE5_GO_NO_GO_RTO_EXCEEDED');
  equal(resilience.adaptersRehearsed, 8, 'PHASE5_GO_NO_GO_ADAPTER_REHEARSAL_INCOMPLETE');
  integer(resilience.minimumOutageSeconds, 7_200, 21_600,
    'PHASE5_GO_NO_GO_OUTAGE_INSUFFICIENT');
  integer(resilience.maximumCatchUpSeconds, 1, 3_600, 'PHASE5_GO_NO_GO_CATCHUP_EXCEEDED');
  for (const field of ['lostEvents', 'duplicateBusinessEffects', 'unreconciledEvents']) {
    equal(resilience[field], 0, 'PHASE5_GO_NO_GO_RESILIENCE_DIFFERENCE');
  }
}

function validateAuthorization(authorization) {
  object(authorization, [
    'matrixCases', 'passedCases', 'crossTenantAttempts', 'crossTenantDenied',
    'fieldScopeFailures', 'dataScopeFailures', 'mcpR3ToolCount',
  ], 'PHASE5_GO_NO_GO_AUTHORIZATION_INVALID');
  integer(authorization.matrixCases, 200, Number.MAX_SAFE_INTEGER,
    'PHASE5_GO_NO_GO_AUTHORIZATION_COVERAGE');
  equal(authorization.passedCases, authorization.matrixCases,
    'PHASE5_GO_NO_GO_AUTHORIZATION_FAILED');
  integer(authorization.crossTenantAttempts, 50, Number.MAX_SAFE_INTEGER,
    'PHASE5_GO_NO_GO_TENANT_COVERAGE');
  equal(authorization.crossTenantDenied, authorization.crossTenantAttempts,
    'PHASE5_GO_NO_GO_TENANT_ESCAPE');
  for (const field of ['fieldScopeFailures', 'dataScopeFailures', 'mcpR3ToolCount']) {
    equal(authorization[field], 0, 'PHASE5_GO_NO_GO_AUTHORIZATION_FAILED');
  }
}

function validateBusiness(business) {
  object(business, [
    'approvalShadowDays', 'payrollShadowCycles', 'uatDomains',
    'unexplainedRecordDifferences', 'unexplainedAmountDifferenceMinor',
  ], 'PHASE5_GO_NO_GO_BUSINESS_INVALID');
  integer(business.approvalShadowDays, 28, 365, 'PHASE5_GO_NO_GO_APPROVAL_SHADOW_INCOMPLETE');
  integer(business.payrollShadowCycles, 2, 24, 'PHASE5_GO_NO_GO_PAYROLL_SHADOW_INCOMPLETE');
  if (!Array.isArray(business.uatDomains) || business.uatDomains.length !== DOMAIN_NAMES.length) {
    fail('PHASE5_GO_NO_GO_UAT_INCOMPLETE');
  }
  const domains = [];
  for (const uat of business.uatDomains) {
    object(uat, ['domain', 'status', 'evidenceHash'], 'PHASE5_GO_NO_GO_UAT_INVALID');
    equal(uat.status, 'passed', 'PHASE5_GO_NO_GO_UAT_FAILED');
    pattern(uat.evidenceHash, SHA256, 'PHASE5_GO_NO_GO_UAT_INVALID');
    domains.push(uat.domain);
  }
  if (canonical(domains.sort()) !== canonical(DOMAIN_NAMES)) fail('PHASE5_GO_NO_GO_UAT_INCOMPLETE');
  equal(business.unexplainedRecordDifferences, 0, 'PHASE5_GO_NO_GO_BUSINESS_DIFFERENCE');
  equal(business.unexplainedAmountDifferenceMinor, 0, 'PHASE5_GO_NO_GO_BUSINESS_DIFFERENCE');
}

function validateCompliance(compliance) {
  object(compliance, [
    'dataInventoryApproved', 'privacyImpactAssessmentApproved',
    'retentionDeletionVerified', 'consentWithdrawalVerified', 'legalBasisApproved',
    'unresolvedPrivacyFindings', 'unapprovedCrossBorderTransfers', 'evidenceHash',
  ], 'PHASE5_GO_NO_GO_COMPLIANCE_INVALID');
  for (const field of [
    'dataInventoryApproved', 'privacyImpactAssessmentApproved',
    'retentionDeletionVerified', 'consentWithdrawalVerified', 'legalBasisApproved',
  ]) equal(compliance[field], true, 'PHASE5_GO_NO_GO_COMPLIANCE_INCOMPLETE');
  equal(compliance.unresolvedPrivacyFindings, 0, 'PHASE5_GO_NO_GO_PRIVACY_FINDING_OPEN');
  equal(compliance.unapprovedCrossBorderTransfers, 0, 'PHASE5_GO_NO_GO_CROSS_BORDER_UNAPPROVED');
  pattern(compliance.evidenceHash, SHA256, 'PHASE5_GO_NO_GO_COMPLIANCE_INVALID');
}

function validateIntegrations(integrations) {
  if (!Array.isArray(integrations) || integrations.length !== INTEGRATION_NAMES.length) {
    fail('PHASE5_GO_NO_GO_INTEGRATIONS_INCOMPLETE');
  }
  const names = [];
  const hashes = new Set();
  for (const integration of integrations) {
    object(integration, [
      'name', 'status', 'sandboxContractPassed', 'credentialPreflightPassed',
      'productionSideEffectExecuted', 'contractHash', 'rehearsalHash', 'reconciliationHash',
    ], 'PHASE5_GO_NO_GO_INTEGRATION_INVALID');
    equal(integration.status, 'passed', 'PHASE5_GO_NO_GO_INTEGRATION_FAILED');
    equal(integration.sandboxContractPassed, true, 'PHASE5_GO_NO_GO_INTEGRATION_FAILED');
    equal(integration.credentialPreflightPassed, true, 'PHASE5_GO_NO_GO_CREDENTIAL_PREFLIGHT_FAILED');
    equal(integration.productionSideEffectExecuted, false, 'PHASE5_GO_NO_GO_PRODUCTION_SIDE_EFFECT');
    names.push(integration.name);
    for (const field of ['contractHash', 'rehearsalHash', 'reconciliationHash']) {
      pattern(integration[field], SHA256, 'PHASE5_GO_NO_GO_INTEGRATION_EVIDENCE_INVALID');
      hashes.add(integration[field]);
    }
  }
  if (
    canonical(names.sort()) !== canonical(INTEGRATION_NAMES) ||
    hashes.size !== INTEGRATION_NAMES.length * 3
  ) fail('PHASE5_GO_NO_GO_INTEGRATIONS_INCOMPLETE');
  return Object.freeze({ names, evidenceHashes: [...hashes] });
}

function validateMcp(mcp) {
  object(mcp, [
    'protocolVersion', 'transport', 'oauthProfile', 'catalogHash', 'toolCount',
    'resourceCount', 'promptCount', 'r0ToolCount', 'r1ToolCount', 'r2ToolCount',
    'r3ToolCount', 'toolsWithoutInputSchema', 'toolsWithoutOutputSchema',
    'toolsWithoutRiskLevel', 'directDatabaseAccessCount', 'upstreamTokenExposureCount',
    'clientProfiles', 'crossTenantAttempts', 'crossTenantDenied', 'auditEvents',
  ], 'PHASE5_GO_NO_GO_MCP_INVALID');
  equal(mcp.protocolVersion, '2025-11-25', 'PHASE5_GO_NO_GO_MCP_PROTOCOL_INVALID');
  equal(mcp.transport, 'streamable-http', 'PHASE5_GO_NO_GO_MCP_TRANSPORT_INVALID');
  equal(mcp.oauthProfile, 'oauth-2.1', 'PHASE5_GO_NO_GO_MCP_OAUTH_INVALID');
  pattern(mcp.catalogHash, SHA256, 'PHASE5_GO_NO_GO_MCP_CATALOG_INVALID');
  integer(mcp.toolCount, 1, 10_000, 'PHASE5_GO_NO_GO_MCP_CATALOG_INVALID');
  for (const field of ['resourceCount', 'promptCount', 'r0ToolCount', 'r1ToolCount', 'r2ToolCount']) {
    integer(mcp[field], 0, 10_000, 'PHASE5_GO_NO_GO_MCP_CATALOG_INVALID');
  }
  equal(mcp.r0ToolCount + mcp.r1ToolCount + mcp.r2ToolCount, mcp.toolCount,
    'PHASE5_GO_NO_GO_MCP_CATALOG_INVALID');
  for (const field of [
    'r3ToolCount', 'toolsWithoutInputSchema', 'toolsWithoutOutputSchema',
    'toolsWithoutRiskLevel', 'directDatabaseAccessCount', 'upstreamTokenExposureCount',
  ]) equal(mcp[field], 0, 'PHASE5_GO_NO_GO_MCP_SECURITY_FAILED');
  if (!Array.isArray(mcp.clientProfiles) ||
      canonical([...mcp.clientProfiles].sort()) !== canonical(MCP_CLIENT_PROFILES)) {
    fail('PHASE5_GO_NO_GO_MCP_CLIENT_MATRIX_INCOMPLETE');
  }
  integer(mcp.crossTenantAttempts, 30, Number.MAX_SAFE_INTEGER,
    'PHASE5_GO_NO_GO_MCP_TENANT_COVERAGE');
  equal(mcp.crossTenantDenied, mcp.crossTenantAttempts, 'PHASE5_GO_NO_GO_MCP_TENANT_ESCAPE');
  integer(mcp.auditEvents, mcp.toolCount, Number.MAX_SAFE_INTEGER,
    'PHASE5_GO_NO_GO_MCP_AUDIT_INCOMPLETE');
  return mcp;
}

function validateOperations(operations) {
  object(operations, [
    'monitoringDashboardsApproved', 'alertRoutesTested', 'onCallRosterConfirmed',
    'runbooksApproved', 'backupPolicyActive', 'rollbackRehearsed', 'changeFreezeApproved',
    'hypercareDays', 'incidentCommanderAssigned', 'supportHandoffComplete',
    'imageSignaturesVerified', 'slsaProvenanceVerified', 'admissionPolicyEnforced',
    'wormEvidenceHash',
  ], 'PHASE5_GO_NO_GO_OPERATIONS_INVALID');
  for (const field of [
    'monitoringDashboardsApproved', 'alertRoutesTested', 'onCallRosterConfirmed',
    'runbooksApproved', 'backupPolicyActive', 'rollbackRehearsed', 'changeFreezeApproved',
    'incidentCommanderAssigned', 'supportHandoffComplete', 'imageSignaturesVerified',
    'slsaProvenanceVerified', 'admissionPolicyEnforced',
  ]) equal(operations[field], true, 'PHASE5_GO_NO_GO_OPERATIONS_INCOMPLETE');
  equal(operations.hypercareDays, 28, 'PHASE5_GO_NO_GO_HYPERCARE_INVALID');
  pattern(operations.wormEvidenceHash, SHA256, 'PHASE5_GO_NO_GO_WORM_EVIDENCE_INVALID');
  return operations;
}

function validateDecision(decision, evaluatedAt, minimumGateExpiresAt, now) {
  object(decision, [
    'outcome', 'decidedAt', 'timezone', 'changeWindowStartAt', 'changeWindowEndAt',
    'goNoGoExpiresAt', 'exceptions',
  ], 'PHASE5_GO_NO_GO_DECISION_INVALID');
  equal(decision.outcome, 'GO', 'PHASE5_GO_NO_GO_NOT_APPROVED');
  equal(decision.timezone, 'Asia/Shanghai', 'PHASE5_GO_NO_GO_TIMEZONE_INVALID');
  if (!Array.isArray(decision.exceptions) || decision.exceptions.length !== 0) {
    fail('PHASE5_GO_NO_GO_EXCEPTION_FORBIDDEN');
  }
  const decidedAt = timestamp(decision.decidedAt);
  const startAt = timestamp(decision.changeWindowStartAt);
  const endAt = timestamp(decision.changeWindowEndAt);
  const expiresAt = timestamp(decision.goNoGoExpiresAt);
  if (
    decidedAt < evaluatedAt || startAt < decidedAt || expiresAt < endAt ||
    endAt > minimumGateExpiresAt || expiresAt > minimumGateExpiresAt ||
    decidedAt > now + 5 * 60 * 1_000 || now - decidedAt > 24 * 60 * 60 * 1_000
  ) {
    fail('PHASE5_GO_NO_GO_DECISION_TIME_INVALID');
  }
  duration(startAt, endAt, 8 * 60 * 60, 8 * 60 * 60, 'PHASE5_GO_NO_GO_WINDOW_INVALID');
  if (expiresAt - decidedAt > 7 * 24 * 60 * 60 * 1_000) fail('PHASE5_GO_NO_GO_DECISION_STALE');
  const shanghaiDay = new Date(startAt + 8 * 60 * 60 * 1_000).getUTCDay();
  if (shanghaiDay !== 6 && shanghaiDay !== 0) fail('PHASE5_GO_NO_GO_WEEKEND_REQUIRED');
  return Object.freeze({ decidedAt });
}

function validateSignoffs(signoffs, evaluatedAt, decidedAt) {
  if (!Array.isArray(signoffs) || signoffs.length !== SIGNOFF_ROLES.length) {
    fail('PHASE5_GO_NO_GO_SIGNOFFS_INCOMPLETE');
  }
  const roles = [];
  const evidenceIds = new Set();
  const commentHashes = new Set();
  for (const signoff of signoffs) {
    object(signoff, ['role', 'decision', 'evidenceId', 'commentHash', 'signedAt'],
      'PHASE5_GO_NO_GO_SIGNOFF_INVALID');
    equal(signoff.decision, 'GO', 'PHASE5_GO_NO_GO_SIGNOFF_REJECTED');
    pattern(signoff.evidenceId, ULID, 'PHASE5_GO_NO_GO_SIGNOFF_EVIDENCE_INVALID');
    pattern(signoff.commentHash, SHA256, 'PHASE5_GO_NO_GO_SIGNOFF_COMMENT_INVALID');
    const signedAt = timestamp(signoff.signedAt);
    if (signedAt < evaluatedAt || signedAt > decidedAt) fail('PHASE5_GO_NO_GO_SIGNOFF_TIME_INVALID');
    roles.push(signoff.role);
    evidenceIds.add(signoff.evidenceId);
    commentHashes.add(signoff.commentHash);
  }
  if (
    canonical(roles.sort()) !== canonical(SIGNOFF_ROLES) ||
    evidenceIds.size !== SIGNOFF_ROLES.length || commentHashes.size !== SIGNOFF_ROLES.length
  ) fail('PHASE5_GO_NO_GO_SIGNOFFS_INCOMPLETE');
  return [...evidenceIds];
}

function runSelfTest() {
  const selfTestNow = Date.parse('2026-07-24T00:00:00.000Z');
  const validate = (document, enforceEnvironment = false) =>
    validateEvidence(document, enforceEnvironment, selfTestNow);
  validate(fixture());
  const bound = fixture();
  bindExpectedEnvironment(bound);
  validate(bound, true);

  const staleGate = fixture();
  staleGate.gates[0].completedAt = '2026-06-01T00:00:00.000Z';
  expectFailure(() => validate(staleGate), 'PHASE5_GO_NO_GO_GATE_STALE');

  const wrongGateCommit = fixture();
  wrongGateCommit.gates[0].subjectCommitSha = 'b'.repeat(40);
  expectFailure(() => validate(wrongGateCommit), 'PHASE5_GO_NO_GO_GATE_COMMIT_MISMATCH');

  const p95Exceeded = fixture();
  p95Exceeded.acceptance.performance.maximumApiP95Milliseconds = 500;
  expectFailure(() => validate(p95Exceeded), 'PHASE5_GO_NO_GO_API_P95_EXCEEDED');

  const missingIntegration = fixture();
  missingIntegration.integrations.pop();
  expectFailure(() => validate(missingIntegration), 'PHASE5_GO_NO_GO_INTEGRATIONS_INCOMPLETE');

  const r3Exposed = fixture();
  r3Exposed.mcp.r3ToolCount = 1;
  expectFailure(() => validate(r3Exposed), 'PHASE5_GO_NO_GO_MCP_SECURITY_FAILED');

  const unsignedImage = fixture();
  unsignedImage.operations.imageSignaturesVerified = false;
  expectFailure(() => validate(unsignedImage), 'PHASE5_GO_NO_GO_OPERATIONS_INCOMPLETE');

  const privacyIncomplete = fixture();
  privacyIncomplete.acceptance.compliance.privacyImpactAssessmentApproved = false;
  expectFailure(() => validate(privacyIncomplete), 'PHASE5_GO_NO_GO_COMPLIANCE_INCOMPLETE');

  const exception = fixture();
  exception.decision.exceptions.push('temporary-waiver');
  expectFailure(() => validate(exception), 'PHASE5_GO_NO_GO_EXCEPTION_FORBIDDEN');

  const missingSignoff = fixture();
  missingSignoff.signoffs.pop();
  expectFailure(() => validate(missingSignoff), 'PHASE5_GO_NO_GO_SIGNOFFS_INCOMPLETE');

  process.env.GO_NO_GO_EXPECTED_COMMIT = 'b'.repeat(40);
  expectFailure(() => validate(bound, true), 'PHASE5_GO_NO_GO_COMMIT_MISMATCH');
}

function bindExpectedEnvironment(document) {
  process.env.GO_NO_GO_EXPECTED_ENVIRONMENT = document.environment.name;
  process.env.GO_NO_GO_EXPECTED_REGION = document.environment.region;
  process.env.GO_NO_GO_EXPECTED_COMMIT = document.source.commitSha;
  process.env.GO_NO_GO_EXPECTED_API_IMAGE = document.source.images.api;
  process.env.GO_NO_GO_EXPECTED_WORKER_IMAGE = document.source.images.worker;
  process.env.GO_NO_GO_EXPECTED_WEB_IMAGE = document.source.images.web;
  process.env.GO_NO_GO_EXPECTED_WEBSITE_IMAGE = document.source.images.website;
  process.env.GO_NO_GO_EXPECTED_DEPLOYMENT_MANIFEST = document.source.deploymentManifestHash;
}

function fixture() {
  const hash = (label) => digest(label);
  return {
    formatVersion: 1,
    suite: 'gaoq.phase5.go-no-go.v1',
    decisionId: '01J8ZQK7V0A2M4N6P8R0T2W6D1',
    environment: {
      name: 'release-uat', region: 'cn-test-1', productionEquivalent: true,
      productionTraffic: false, productionData: false, evaluatedAt: '2026-07-23T00:00:00.000Z',
    },
    source: {
      commitSha: 'a'.repeat(40), releaseCandidate: 'rc-20260723-01',
      images: {
        api: hash('api'),
        worker: hash('worker'),
        web: hash('web'),
        website: hash('website'),
      },
      deploymentManifestHash: hash('deployment-manifest'), harnessSha256: HARNESS_DIGEST,
    },
    gates: GATE_NAMES.map((name, index) => ({
      name, suite: GATE_SUITES[name], subjectCommitSha: 'a'.repeat(40), status: 'passed',
      evidenceId: `01J8ZQK7V0A2M4N6P8R0T2W7${String(index).padStart(2, '0')}`,
      evidenceHash: hash(`gate-${name}`), completedAt: '2026-07-22T00:00:00.000Z',
      expiresAt: '2026-08-21T00:00:00.000Z',
    })),
    acceptance: {
      defects: {
        openSev1: 0, openSev2: 0, criticalVulnerabilities: 0, highVulnerabilities: 0,
        unexpiredSecurityExceptions: 0,
      },
      performance: {
        independentRuns: 3, concurrentUsers: 1_000, maximumApiP95Milliseconds: 320,
        maximumErrorRate: 0.001, payrollEmployees: 1_000, maximumPayrollDurationSeconds: 180,
      },
      migration: {
        fullRehearsals: 3, recordMismatches: 0, relationMismatches: 0,
        amountDifferenceMinor: 0, missingAttachments: 0, checksumMismatches: 0,
      },
      resilience: {
        actualRpoSeconds: 600, actualRtoSeconds: 7_200, adaptersRehearsed: 8,
        minimumOutageSeconds: 7_200, maximumCatchUpSeconds: 1_800, lostEvents: 0,
        duplicateBusinessEffects: 0, unreconciledEvents: 0,
      },
      authorization: {
        matrixCases: 240, passedCases: 240, crossTenantAttempts: 60, crossTenantDenied: 60,
        fieldScopeFailures: 0, dataScopeFailures: 0, mcpR3ToolCount: 0,
      },
      business: {
        approvalShadowDays: 28, payrollShadowCycles: 2,
        uatDomains: DOMAIN_NAMES.map((domain) => ({
          domain, status: 'passed', evidenceHash: hash(`uat-${domain}`),
        })),
        unexplainedRecordDifferences: 0, unexplainedAmountDifferenceMinor: 0,
      },
      compliance: {
        dataInventoryApproved: true, privacyImpactAssessmentApproved: true,
        retentionDeletionVerified: true, consentWithdrawalVerified: true,
        legalBasisApproved: true, unresolvedPrivacyFindings: 0,
        unapprovedCrossBorderTransfers: 0, evidenceHash: hash('compliance'),
      },
    },
    integrations: INTEGRATION_NAMES.map((name, index) => ({
      name, status: 'passed', sandboxContractPassed: true, credentialPreflightPassed: true,
      productionSideEffectExecuted: false, contractHash: hash(`integration-${index}-contract`),
      rehearsalHash: hash(`integration-${index}-rehearsal`),
      reconciliationHash: hash(`integration-${index}-reconciliation`),
    })),
    mcp: {
      protocolVersion: '2025-11-25', transport: 'streamable-http', oauthProfile: 'oauth-2.1',
      catalogHash: hash('mcp-catalog'), toolCount: 30, resourceCount: 3, promptCount: 2,
      r0ToolCount: 20, r1ToolCount: 6, r2ToolCount: 4, r3ToolCount: 0,
      toolsWithoutInputSchema: 0, toolsWithoutOutputSchema: 0, toolsWithoutRiskLevel: 0,
      directDatabaseAccessCount: 0, upstreamTokenExposureCount: 0,
      clientProfiles: [...MCP_CLIENT_PROFILES], crossTenantAttempts: 30, crossTenantDenied: 30,
      auditEvents: 60,
    },
    operations: {
      monitoringDashboardsApproved: true, alertRoutesTested: true, onCallRosterConfirmed: true,
      runbooksApproved: true, backupPolicyActive: true, rollbackRehearsed: true,
      changeFreezeApproved: true, hypercareDays: 28, incidentCommanderAssigned: true,
      supportHandoffComplete: true, imageSignaturesVerified: true,
      slsaProvenanceVerified: true, admissionPolicyEnforced: true,
      wormEvidenceHash: hash('operations-worm'),
    },
    signoffs: SIGNOFF_ROLES.map((role, index) => ({
      role, decision: 'GO', evidenceId: `01J8ZQK7V0A2M4N6P8R0T2W8${String(index).padStart(2, '0')}`,
      commentHash: hash(`signoff-${role}`),
      signedAt: `2026-07-23T00:${String(5 + index).padStart(2, '0')}:00.000Z`,
    })),
    decision: {
      outcome: 'GO', decidedAt: '2026-07-23T00:20:00.000Z', timezone: 'Asia/Shanghai',
      changeWindowStartAt: '2026-07-25T00:00:00.000Z',
      changeWindowEndAt: '2026-07-25T08:00:00.000Z',
      goNoGoExpiresAt: '2026-07-30T00:20:00.000Z', exceptions: [],
    },
  };
}

function parseDocument(content) {
  try {
    return JSON.parse(content);
  } catch {
    fail('PHASE5_GO_NO_GO_EVIDENCE_JSON_INVALID');
  }
}

function object(value, keys, code) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(code);
  if (canonical(Object.keys(value).sort()) !== canonical([...keys].sort())) fail(code);
}

function equal(actual, expected, code) {
  if (actual !== expected) fail(code);
}

function pattern(value, expression, code) {
  if (typeof value !== 'string' || !expression.test(value)) fail(code);
}

function integer(value, minimum, maximum, code) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(code);
}

function numberRange(value, minimum, maximum, code) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    fail(code);
  }
}

function timestamp(value) {
  if (typeof value !== 'string') fail('PHASE5_GO_NO_GO_TIMESTAMP_INVALID');
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    fail('PHASE5_GO_NO_GO_TIMESTAMP_INVALID');
  }
  return parsed;
}

function duration(startAt, endAt, minimumSeconds, maximumSeconds, code) {
  const seconds = Math.floor((endAt - startAt) / 1_000);
  if (seconds < minimumSeconds || seconds > maximumSeconds) fail(code);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function expectFailure(callback, expectedCode) {
  try {
    callback();
  } catch (error) {
    if (error instanceof Error && error.message === expectedCode) return;
    throw error;
  }
  fail(`SELF_TEST_DID_NOT_FAIL:${expectedCode}`);
}

function fail(code) {
  throw new Error(code);
}
