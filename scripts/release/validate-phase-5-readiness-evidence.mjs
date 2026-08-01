import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';

const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/u;
const ENVIRONMENT_NAME = /^[a-z][a-z0-9-]{2,31}$/u;
const REGION = /^[a-z0-9-]{2,32}$/u;
const DOMAINS = [
  'approval', 'attendance', 'audit', 'migration', 'op', 'org', 'payroll', 'recruitment',
];
const GATE_SUITES = Object.freeze({
  authorization: 'gaoq.phase5.authorization.verdict',
  'business-uat': 'gaoq.phase5.business-uat.verdict',
  'engineering-quality': 'gaoq.phase5.engineering-quality.verdict',
  operations: 'gaoq.phase5.operations.verdict',
  'privacy-compliance': 'gaoq.phase5.privacy-compliance.verdict',
  'production-images': 'gaoq.phase5.production-images.verdict',
  'supply-chain': 'gaoq.phase5.supply-chain.verdict',
});
const SIGNOFF_ROLES = Object.freeze({
  authorization: ['qa_owner', 'security_owner'],
  'business-uat': ['finance_owner', 'hr_owner', 'product_owner', 'qa_owner'],
  'engineering-quality': ['engineering_owner', 'qa_owner'],
  operations: ['change_manager', 'security_owner', 'sre_owner', 'support_owner'],
  'privacy-compliance': ['legal_owner', 'privacy_owner', 'security_owner'],
  'production-images': ['platform_owner', 'security_owner', 'sre_owner'],
  'supply-chain': ['architecture_owner', 'legal_owner', 'security_owner'],
});
const SIGNER_ROLES = Object.freeze(
  [...new Set(Object.values(SIGNOFF_ROLES).flat())].sort(),
);
const SIGNOFF_SIGNATURE_SUITE = 'gaoq.phase5.readiness.signoff.v1';
const GATE_SECTION_FIELDS = Object.freeze({
  authorization: 'authorization',
  'business-uat': 'businessUat',
  'engineering-quality': 'engineeringQuality',
  operations: 'operations',
  'privacy-compliance': 'privacyCompliance',
  'production-images': 'productionImages',
  'supply-chain': 'supplyChain',
});
const WORKFLOW_LOCATION = new URL(
  '../../.github/workflows/phase-5-readiness.yml',
  import.meta.url,
);
const HARNESS_DIGEST = digest(canonical({
  './validate-phase-5-readiness-evidence.mjs': await readFile(new URL(import.meta.url), 'utf8'),
  '../../.github/workflows/phase-5-readiness.yml': await readFile(WORKFLOW_LOCATION, 'utf8'),
}));

const argumentsList = process.argv.slice(2);
if (argumentsList.length === 1 && argumentsList[0] === '--self-test') {
  runSelfTest();
  process.stdout.write('Phase 5 七类发布就绪证据门禁自测通过。\n');
} else if (argumentsList.length === 1 && argumentsList[0] === '--print-contract') {
  process.stdout.write(`${JSON.stringify({
    formatVersion: 2,
    suite: 'gaoq.phase5.readiness.contract',
    gates: Object.entries(GATE_SUITES).map(([name, suite]) => ({ name, suite })),
    signerRoles: SIGNER_ROLES,
    signatureSuite: SIGNOFF_SIGNATURE_SUITE,
    signatureAlgorithm: 'Ed25519',
    signatureEncoding: 'base64url-unpadded',
    signerKeysetHash: 'sha256(canonical(sorted[{role,keyId}]))',
    gatePayloadFields: [
      'formatVersion', 'suite', 'evidenceId', 'gateName', 'environment', 'source',
      'section', 'signerKeysetHash',
    ],
    signoffPayloadFields: [
      'suite', 'gateName', 'gatePayloadHash', 'role', 'keyId', 'signedAt',
    ],
    harnessSha256: HARNESS_DIGEST,
  }, null, 2)}\n`);
} else {
  const enforceEnvironment = argumentsList[0] === '--enforce-environment';
  const evidencePath = argumentsList[enforceEnvironment ? 1 : 0];
  if (evidencePath === undefined || argumentsList.length !== (enforceEnvironment ? 2 : 1)) {
    fail('PHASE5_READINESS_EVIDENCE_PATH_REQUIRED');
  }
  const metadata = await lstat(evidencePath);
  if (
    !metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 ||
    metadata.size > 1_024 * 1_024 || (metadata.mode & 0o022) !== 0
  ) fail('PHASE5_READINESS_EVIDENCE_FILE_INVALID');
  const result = validateEvidence(
    parseDocument(await readFile(evidencePath, 'utf8')),
    enforceEnvironment,
  );
  process.stdout.write(`${JSON.stringify({
    formatVersion: 2,
    suite: 'gaoq.phase5.readiness.verdict-bundle',
    evidenceId: result.evidenceId,
    commitSha: result.commitSha,
    signerKeysetHash: result.signerKeysetHash,
    verdicts: result.verdicts,
    bundleChecksum: digest(canonical(result)),
  }, null, 2)}\n`);
}

/** 校验七类原始就绪证据并输出 Go/No-Go 可直接消费的独立 verdict。 */
function validateEvidence(document, enforceEnvironment = false) {
  object(document, [
    'formatVersion', 'suite', 'evidenceId', 'environment', 'source',
    'engineeringQuality', 'supplyChain', 'productionImages', 'authorization',
    'businessUat', 'privacyCompliance', 'operations', 'signingAuthorities',
  ], 'PHASE5_READINESS_DOCUMENT_INVALID');
  equal(document.formatVersion, 2, 'PHASE5_READINESS_FORMAT_INVALID');
  equal(document.suite, 'gaoq.phase5.readiness.v2', 'PHASE5_READINESS_SUITE_INVALID');
  pattern(document.evidenceId, ULID, 'PHASE5_READINESS_EVIDENCE_ID_INVALID');
  const environment = validateEnvironment(document.environment, enforceEnvironment);
  const source = validateSource(document.source, enforceEnvironment);
  const authorities = validateSigningAuthorities(document.signingAuthorities);
  if (enforceEnvironment) {
    pattern(
      process.env.READINESS_EXPECTED_SIGNER_KEYSET_SHA256,
      SHA256,
      'PHASE5_READINESS_EXPECTED_SIGNER_KEYSET_REQUIRED',
    );
    equal(
      authorities.keysetHash,
      process.env.READINESS_EXPECTED_SIGNER_KEYSET_SHA256,
      'PHASE5_READINESS_SIGNER_KEYSET_MISMATCH',
    );
  }
  const sections = [
    ['engineering-quality', document.engineeringQuality, validateEngineeringQuality],
    ['supply-chain', document.supplyChain, validateSupplyChain],
    ['production-images', document.productionImages,
      (value) => validateProductionImages(value, source.images)],
    ['authorization', document.authorization, validateAuthorization],
    ['business-uat', document.businessUat, validateBusinessUat],
    ['privacy-compliance', document.privacyCompliance, validatePrivacyCompliance],
    ['operations', document.operations, validateOperations],
  ];
  const rawEvidenceHashes = [];
  const allSignoffs = [];
  const verdicts = sections.map(([name, section, validator]) => {
    const control = validateControlMetadata(section.control, name, environment.evaluatedAt);
    rawEvidenceHashes.push(control.rawEvidenceHash);
    validator(section);
    const gatePayloadHash = digest(readinessGatePayload(
      document,
      name,
      section,
      authorities.keysetHash,
    ));
    validateSignoffSignatures(
      control.signoffs,
      authorities.byRole,
      name,
      gatePayloadHash,
      environment.evaluatedAt,
    );
    allSignoffs.push(...control.signoffs);
    return Object.freeze({
      name,
      suite: GATE_SUITES[name],
      subjectCommitSha: source.commitSha,
      status: 'passed',
      evidenceId: control.evidenceId,
      evidenceHash: digest(canonical({
        name,
        subjectCommitSha: source.commitSha,
        environment: document.environment,
        source: {
          images: source.images,
          deploymentManifestHash: source.deploymentManifestHash,
        },
        signerKeysetHash: authorities.keysetHash,
        gatePayloadHash,
        section,
      })),
      completedAt: control.completedAt,
      expiresAt: control.expiresAt,
    });
  });
  if (
    new Set(verdicts.map((item) => item.evidenceId)).size !== verdicts.length ||
    new Set(verdicts.map((item) => item.evidenceHash)).size !== verdicts.length ||
    new Set(rawEvidenceHashes).size !== verdicts.length
  ) fail('PHASE5_READINESS_GATE_EVIDENCE_REUSED');
  validateSignoffSeparation(allSignoffs);
  return Object.freeze({
    evidenceId: document.evidenceId,
    commitSha: source.commitSha,
    images: source.images,
    deploymentManifestHash: source.deploymentManifestHash,
    environment: document.environment,
    signerKeysetHash: authorities.keysetHash,
    verdicts,
  });
}

function validateEnvironment(environment, enforceEnvironment) {
  object(environment, [
    'name', 'region', 'productionEquivalent', 'productionTraffic', 'productionData',
    'evaluatedAt',
  ], 'PHASE5_READINESS_ENVIRONMENT_INVALID');
  pattern(environment.name, ENVIRONMENT_NAME, 'PHASE5_READINESS_ENVIRONMENT_INVALID');
  pattern(environment.region, REGION, 'PHASE5_READINESS_REGION_INVALID');
  if (/(?:^|-)prod(?:-|$)|production/u.test(environment.name)) {
    fail('PHASE5_READINESS_PRODUCTION_FORBIDDEN');
  }
  if (!/(?:^|-)(?:release|stage|staging|preprod|uat)(?:-|$)/u.test(environment.name)) {
    fail('PHASE5_READINESS_ENVIRONMENT_INVALID');
  }
  equal(environment.productionEquivalent, true, 'PHASE5_READINESS_ENVIRONMENT_NOT_EQUIVALENT');
  equal(environment.productionTraffic, false, 'PHASE5_READINESS_PRODUCTION_FORBIDDEN');
  equal(environment.productionData, false, 'PHASE5_READINESS_PRODUCTION_DATA_FORBIDDEN');
  const evaluatedAt = timestamp(environment.evaluatedAt);
  if (enforceEnvironment) {
    pattern(
      process.env.READINESS_EXPECTED_ENVIRONMENT,
      ENVIRONMENT_NAME,
      'PHASE5_READINESS_EXPECTED_ENVIRONMENT_REQUIRED',
    );
    pattern(
      process.env.READINESS_EXPECTED_REGION,
      REGION,
      'PHASE5_READINESS_EXPECTED_ENVIRONMENT_REQUIRED',
    );
    equal(
      environment.name,
      process.env.READINESS_EXPECTED_ENVIRONMENT,
      'PHASE5_READINESS_ENVIRONMENT_MISMATCH',
    );
    equal(
      environment.region,
      process.env.READINESS_EXPECTED_REGION,
      'PHASE5_READINESS_REGION_MISMATCH',
    );
  }
  return Object.freeze({ evaluatedAt });
}

function validateSource(source, enforceEnvironment) {
  object(source, [
    'commitSha', 'images', 'deploymentManifestHash', 'harnessSha256',
  ], 'PHASE5_READINESS_SOURCE_INVALID');
  pattern(source.commitSha, COMMIT, 'PHASE5_READINESS_COMMIT_INVALID');
  object(source.images, ['api', 'worker', 'web', 'website'], 'PHASE5_READINESS_IMAGES_INVALID');
  for (const value of Object.values(source.images)) {
    pattern(value, SHA256, 'PHASE5_READINESS_IMAGES_INVALID');
  }
  if (new Set(Object.values(source.images)).size !== 4) {
    fail('PHASE5_READINESS_IMAGES_INVALID');
  }
  pattern(
    source.deploymentManifestHash,
    SHA256,
    'PHASE5_READINESS_DEPLOYMENT_MANIFEST_INVALID',
  );
  equal(source.harnessSha256, HARNESS_DIGEST, 'PHASE5_READINESS_HARNESS_INVALID');
  if (enforceEnvironment) {
    const expected = {
      commitSha: process.env.READINESS_EXPECTED_COMMIT,
      api: process.env.READINESS_EXPECTED_API_IMAGE,
      worker: process.env.READINESS_EXPECTED_WORKER_IMAGE,
      web: process.env.READINESS_EXPECTED_WEB_IMAGE,
      website: process.env.READINESS_EXPECTED_WEBSITE_IMAGE,
      manifest: process.env.READINESS_EXPECTED_DEPLOYMENT_MANIFEST,
    };
    pattern(expected.commitSha, COMMIT, 'PHASE5_READINESS_EXPECTED_SOURCE_REQUIRED');
    for (const field of ['api', 'worker', 'web', 'website', 'manifest']) {
      pattern(expected[field], SHA256, 'PHASE5_READINESS_EXPECTED_SOURCE_REQUIRED');
    }
    equal(source.commitSha, expected.commitSha, 'PHASE5_READINESS_COMMIT_MISMATCH');
    for (const image of ['api', 'worker', 'web', 'website']) {
      equal(source.images[image], expected[image], 'PHASE5_READINESS_IMAGE_MISMATCH');
    }
    equal(
      source.deploymentManifestHash,
      expected.manifest,
      'PHASE5_READINESS_DEPLOYMENT_MANIFEST_MISMATCH',
    );
  }
  return source;
}

function validateControlMetadata(control, gateName, evaluatedAt) {
  object(control, [
    'evidenceId', 'rawEvidenceHash', 'completedAt', 'expiresAt', 'signoffs',
  ], 'PHASE5_READINESS_CONTROL_INVALID');
  pattern(control.evidenceId, ULID, 'PHASE5_READINESS_CONTROL_INVALID');
  pattern(control.rawEvidenceHash, SHA256, 'PHASE5_READINESS_CONTROL_INVALID');
  const completedAt = timestamp(control.completedAt);
  const expiresAt = timestamp(control.expiresAt);
  if (
    completedAt > evaluatedAt || evaluatedAt - completedAt > 30 * 24 * 60 * 60 * 1_000 ||
    expiresAt <= evaluatedAt || expiresAt - completedAt > 90 * 24 * 60 * 60 * 1_000
  ) fail('PHASE5_READINESS_CONTROL_STALE');
  validateSignoffMetadata(control.signoffs, SIGNOFF_ROLES[gateName], completedAt, evaluatedAt);
  return control;
}

function validateEngineeringQuality(section) {
  object(section, [
    'control', 'lintPassed', 'typecheckPassed', 'unitPassed', 'integrationPassed',
    'contractPassed', 'e2ePassed', 'buildPassed', 'testFiles', 'testCases',
    'openSev1', 'openSev2', 'blockingFlakyTests',
  ], 'PHASE5_READINESS_ENGINEERING_INVALID');
  for (const field of [
    'lintPassed', 'typecheckPassed', 'unitPassed', 'integrationPassed', 'contractPassed',
    'e2ePassed', 'buildPassed',
  ]) equal(section[field], true, 'PHASE5_READINESS_ENGINEERING_FAILED');
  integer(section.testFiles, 1, Number.MAX_SAFE_INTEGER, 'PHASE5_READINESS_ENGINEERING_FAILED');
  integer(section.testCases, 1, Number.MAX_SAFE_INTEGER, 'PHASE5_READINESS_ENGINEERING_FAILED');
  for (const field of ['openSev1', 'openSev2', 'blockingFlakyTests']) {
    equal(section[field], 0, 'PHASE5_READINESS_ENGINEERING_FAILED');
  }
}

function validateSupplyChain(section) {
  object(section, [
    'control', 'sastPassed', 'scaPassed', 'secretScanPassed', 'licensePassed',
    'dependencyAuditPassed', 'criticalVulnerabilities', 'highVulnerabilities',
    'unexpiredSecurityExceptions', 'sbomHashes',
  ], 'PHASE5_READINESS_SUPPLY_CHAIN_INVALID');
  for (const field of [
    'sastPassed', 'scaPassed', 'secretScanPassed', 'licensePassed', 'dependencyAuditPassed',
  ]) equal(section[field], true, 'PHASE5_READINESS_SUPPLY_CHAIN_FAILED');
  for (const field of [
    'criticalVulnerabilities', 'highVulnerabilities', 'unexpiredSecurityExceptions',
  ]) equal(section[field], 0, 'PHASE5_READINESS_SUPPLY_CHAIN_FAILED');
  object(
    section.sbomHashes,
    ['api', 'worker', 'web', 'website'],
    'PHASE5_READINESS_SBOM_INVALID',
  );
  for (const value of Object.values(section.sbomHashes)) {
    pattern(value, SHA256, 'PHASE5_READINESS_SBOM_INVALID');
  }
  if (new Set(Object.values(section.sbomHashes)).size !== 4) {
    fail('PHASE5_READINESS_SBOM_INVALID');
  }
}

function validateProductionImages(section, expectedImages) {
  object(section, [
    'control', 'images', 'admissionPolicyEnforced',
  ], 'PHASE5_READINESS_PRODUCTION_IMAGES_INVALID');
  object(
    section.images,
    ['api', 'worker', 'web', 'website'],
    'PHASE5_READINESS_PRODUCTION_IMAGES_INVALID',
  );
  for (const name of ['api', 'worker', 'web', 'website']) {
    const image = section.images[name];
    object(image, [
      'digest', 'signatureVerified', 'slsaProvenanceVerified', 'sbomHash', 'nonRoot',
      'readOnlyRootFilesystem', 'healthcheckPassed', 'rollbackSmokePassed',
    ], 'PHASE5_READINESS_PRODUCTION_IMAGE_INVALID');
    equal(image.digest, expectedImages[name], 'PHASE5_READINESS_PRODUCTION_IMAGE_MISMATCH');
    pattern(image.sbomHash, SHA256, 'PHASE5_READINESS_PRODUCTION_IMAGE_INVALID');
    for (const field of [
      'signatureVerified', 'slsaProvenanceVerified', 'nonRoot', 'readOnlyRootFilesystem',
      'healthcheckPassed', 'rollbackSmokePassed',
    ]) equal(image[field], true, 'PHASE5_READINESS_PRODUCTION_IMAGE_FAILED');
  }
  equal(
    section.admissionPolicyEnforced,
    true,
    'PHASE5_READINESS_ADMISSION_POLICY_REQUIRED',
  );
}

function validateAuthorization(section) {
  object(section, [
    'control', 'matrixCases', 'passedCases', 'crossTenantAttempts', 'crossTenantDenied',
    'fieldScopeFailures', 'dataScopeFailures', 'mcpR3ToolCount', 'matrixEvidenceHash',
    'crossTenantEvidenceHash',
  ], 'PHASE5_READINESS_AUTHORIZATION_INVALID');
  integer(section.matrixCases, 200, Number.MAX_SAFE_INTEGER,
    'PHASE5_READINESS_AUTHORIZATION_COVERAGE');
  equal(section.passedCases, section.matrixCases, 'PHASE5_READINESS_AUTHORIZATION_FAILED');
  integer(section.crossTenantAttempts, 50, Number.MAX_SAFE_INTEGER,
    'PHASE5_READINESS_AUTHORIZATION_COVERAGE');
  equal(
    section.crossTenantDenied,
    section.crossTenantAttempts,
    'PHASE5_READINESS_TENANT_ESCAPE',
  );
  for (const field of ['fieldScopeFailures', 'dataScopeFailures', 'mcpR3ToolCount']) {
    equal(section[field], 0, 'PHASE5_READINESS_AUTHORIZATION_FAILED');
  }
  pattern(section.matrixEvidenceHash, SHA256, 'PHASE5_READINESS_AUTHORIZATION_INVALID');
  pattern(section.crossTenantEvidenceHash, SHA256, 'PHASE5_READINESS_AUTHORIZATION_INVALID');
}

function validateBusinessUat(section) {
  object(section, [
    'control', 'approvalShadowDays', 'payrollShadowCycles', 'domains',
    'unexplainedRecordDifferences', 'unexplainedAmountDifferenceMinor',
  ], 'PHASE5_READINESS_BUSINESS_UAT_INVALID');
  integer(section.approvalShadowDays, 28, 365, 'PHASE5_READINESS_APPROVAL_SHADOW_INCOMPLETE');
  integer(section.payrollShadowCycles, 2, 24, 'PHASE5_READINESS_PAYROLL_SHADOW_INCOMPLETE');
  if (!Array.isArray(section.domains) || section.domains.length !== DOMAINS.length) {
    fail('PHASE5_READINESS_UAT_INCOMPLETE');
  }
  const domains = [];
  const evidenceIds = new Set();
  for (const domain of section.domains) {
    object(domain, ['name', 'status', 'evidenceId', 'evidenceHash'],
      'PHASE5_READINESS_UAT_INVALID');
    equal(domain.status, 'passed', 'PHASE5_READINESS_UAT_FAILED');
    pattern(domain.evidenceId, ULID, 'PHASE5_READINESS_UAT_INVALID');
    pattern(domain.evidenceHash, SHA256, 'PHASE5_READINESS_UAT_INVALID');
    domains.push(domain.name);
    evidenceIds.add(domain.evidenceId);
  }
  if (
    canonical(domains.sort()) !== canonical(DOMAINS) || evidenceIds.size !== DOMAINS.length
  ) fail('PHASE5_READINESS_UAT_INCOMPLETE');
  equal(section.unexplainedRecordDifferences, 0, 'PHASE5_READINESS_UAT_DIFFERENCE');
  equal(section.unexplainedAmountDifferenceMinor, 0, 'PHASE5_READINESS_UAT_DIFFERENCE');
}

function validatePrivacyCompliance(section) {
  object(section, [
    'control', 'dataInventoryApproved', 'privacyImpactAssessmentApproved',
    'retentionDeletionVerified', 'consentWithdrawalVerified', 'legalBasisApproved',
    'unresolvedPrivacyFindings', 'unapprovedCrossBorderTransfers',
    'dataInventoryHash', 'privacyImpactAssessmentHash',
  ], 'PHASE5_READINESS_PRIVACY_INVALID');
  for (const field of [
    'dataInventoryApproved', 'privacyImpactAssessmentApproved', 'retentionDeletionVerified',
    'consentWithdrawalVerified', 'legalBasisApproved',
  ]) equal(section[field], true, 'PHASE5_READINESS_PRIVACY_FAILED');
  for (const field of ['unresolvedPrivacyFindings', 'unapprovedCrossBorderTransfers']) {
    equal(section[field], 0, 'PHASE5_READINESS_PRIVACY_FAILED');
  }
  pattern(section.dataInventoryHash, SHA256, 'PHASE5_READINESS_PRIVACY_INVALID');
  pattern(section.privacyImpactAssessmentHash, SHA256, 'PHASE5_READINESS_PRIVACY_INVALID');
}

function validateOperations(section) {
  object(section, [
    'control', 'monitoringDashboardsApproved', 'alertRoutesTested',
    'onCallRosterConfirmed', 'runbooksApproved', 'backupPolicyActive',
    'rollbackRehearsed', 'changeFreezeApproved', 'hypercareDays',
    'incidentCommanderAssigned', 'supportHandoffComplete', 'wormEvidenceHash',
  ], 'PHASE5_READINESS_OPERATIONS_INVALID');
  for (const field of [
    'monitoringDashboardsApproved', 'alertRoutesTested', 'onCallRosterConfirmed',
    'runbooksApproved', 'backupPolicyActive', 'rollbackRehearsed', 'changeFreezeApproved',
    'incidentCommanderAssigned', 'supportHandoffComplete',
  ]) equal(section[field], true, 'PHASE5_READINESS_OPERATIONS_FAILED');
  equal(section.hypercareDays, 28, 'PHASE5_READINESS_HYPERCARE_INVALID');
  pattern(section.wormEvidenceHash, SHA256, 'PHASE5_READINESS_OPERATIONS_INVALID');
}

function validateSigningAuthorities(authorities) {
  if (!Array.isArray(authorities) || authorities.length !== SIGNER_ROLES.length) {
    fail('PHASE5_READINESS_SIGNING_AUTHORITIES_INCOMPLETE');
  }
  const roles = [];
  const keyIds = new Set();
  const byRole = new Map();
  const keyset = [];
  for (const authority of authorities) {
    object(
      authority,
      ['role', 'algorithm', 'keyId', 'publicKeySpkiBase64'],
      'PHASE5_READINESS_SIGNING_AUTHORITY_INVALID',
    );
    if (!SIGNER_ROLES.includes(authority.role)) {
      fail('PHASE5_READINESS_SIGNING_AUTHORITY_INVALID');
    }
    equal(authority.algorithm, 'Ed25519', 'PHASE5_READINESS_SIGNING_AUTHORITY_INVALID');
    pattern(authority.keyId, SHA256, 'PHASE5_READINESS_SIGNING_AUTHORITY_INVALID');
    const publicKey = publicKeyFromSpkiBase64(authority.publicKeySpkiBase64);
    equal(
      authority.keyId,
      publicKeyHash(publicKey),
      'PHASE5_READINESS_SIGNING_AUTHORITY_KEY_MISMATCH',
    );
    roles.push(authority.role);
    keyIds.add(authority.keyId);
    byRole.set(authority.role, Object.freeze({ keyId: authority.keyId, publicKey }));
    keyset.push(Object.freeze({ role: authority.role, keyId: authority.keyId }));
  }
  exactStringSet(
    roles,
    SIGNER_ROLES,
    'PHASE5_READINESS_SIGNING_AUTHORITIES_INCOMPLETE',
  );
  if (keyIds.size !== SIGNER_ROLES.length || byRole.size !== SIGNER_ROLES.length) {
    fail('PHASE5_READINESS_SIGNING_AUTHORITIES_NOT_INDEPENDENT');
  }
  return Object.freeze({ byRole, keysetHash: signerKeysetHash(keyset) });
}

function validateSignoffMetadata(signoffs, expectedRoles, completedAt, evaluatedAt) {
  if (!Array.isArray(signoffs) || signoffs.length !== expectedRoles.length) {
    fail('PHASE5_READINESS_SIGNOFFS_INCOMPLETE');
  }
  const roles = [];
  for (const signoff of signoffs) {
    object(signoff, [
      'role', 'actorHash', 'decision', 'evidenceId', 'evidenceHash', 'approvedAt', 'signedAt',
      'algorithm', 'keyId', 'signedPayloadSha256', 'signature',
    ], 'PHASE5_READINESS_SIGNOFF_INVALID');
    if (!expectedRoles.includes(signoff.role)) fail('PHASE5_READINESS_SIGNOFF_INVALID');
    pattern(signoff.actorHash, SHA256, 'PHASE5_READINESS_SIGNOFF_INVALID');
    equal(signoff.decision, 'approved', 'PHASE5_READINESS_SIGNOFF_REJECTED');
    pattern(signoff.evidenceId, ULID, 'PHASE5_READINESS_SIGNOFF_INVALID');
    pattern(signoff.evidenceHash, SHA256, 'PHASE5_READINESS_SIGNOFF_INVALID');
    const approvedAt = timestamp(signoff.approvedAt);
    if (approvedAt < completedAt || approvedAt > evaluatedAt) {
      fail('PHASE5_READINESS_SIGNOFF_TIME_INVALID');
    }
    roles.push(signoff.role);
  }
  exactStringSet(roles, expectedRoles, 'PHASE5_READINESS_SIGNOFFS_INCOMPLETE');
}

function validateSignoffSignatures(
  signoffs,
  signingAuthorities,
  gateName,
  gatePayloadHash,
  evaluatedAt,
) {
  const signatures = new Set();
  for (const signoff of signoffs) {
    equal(signoff.algorithm, 'Ed25519', 'PHASE5_READINESS_SIGNOFF_PROOF_INVALID');
    pattern(signoff.keyId, SHA256, 'PHASE5_READINESS_SIGNOFF_PROOF_INVALID');
    pattern(
      signoff.signedPayloadSha256,
      SHA256,
      'PHASE5_READINESS_SIGNOFF_PROOF_INVALID',
    );
    pattern(signoff.signature, SIGNATURE, 'PHASE5_READINESS_SIGNOFF_PROOF_INVALID');
    const approvedAt = timestamp(signoff.approvedAt);
    const signedAt = timestamp(signoff.signedAt);
    if (
      signedAt < approvedAt ||
      signedAt - approvedAt > 24 * 60 * 60 * 1_000 ||
      signedAt > evaluatedAt
    ) fail('PHASE5_READINESS_SIGNOFF_SIGNATURE_TIME_INVALID');
    const authority = signingAuthorities.get(signoff.role);
    if (authority === undefined) fail('PHASE5_READINESS_SIGNOFF_AUTHORITY_INVALID');
    equal(signoff.keyId, authority.keyId, 'PHASE5_READINESS_SIGNOFF_KEY_MISMATCH');
    const payload = readinessSignoffPayload(gateName, gatePayloadHash, signoff);
    equal(
      signoff.signedPayloadSha256,
      digest(payload),
      'PHASE5_READINESS_SIGNOFF_PAYLOAD_MISMATCH',
    );
    const signature = decodeSignature(signoff.signature);
    if (!verify(null, Buffer.from(payload, 'utf8'), authority.publicKey, signature)) {
      fail('PHASE5_READINESS_SIGNOFF_SIGNATURE_INVALID');
    }
    signatures.add(signoff.signature);
  }
  if (signatures.size !== signoffs.length) fail('PHASE5_READINESS_SIGNOFF_PROOF_REUSED');
}

function validateSignoffSeparation(signoffs) {
  const roleActors = new Map();
  const actorRoles = new Map();
  const evidenceIds = new Set();
  const evidenceHashes = new Set();
  const signatures = new Set();
  for (const signoff of signoffs) {
    const existingActor = roleActors.get(signoff.role);
    if (existingActor !== undefined && existingActor !== signoff.actorHash) {
      fail('PHASE5_READINESS_SIGNOFF_ACTOR_INCONSISTENT');
    }
    const existingRole = actorRoles.get(signoff.actorHash);
    if (existingRole !== undefined && existingRole !== signoff.role) {
      fail('PHASE5_READINESS_SIGNOFF_ACTORS_NOT_INDEPENDENT');
    }
    roleActors.set(signoff.role, signoff.actorHash);
    actorRoles.set(signoff.actorHash, signoff.role);
    evidenceIds.add(signoff.evidenceId);
    evidenceHashes.add(signoff.evidenceHash);
    signatures.add(signoff.signature);
  }
  if (
    roleActors.size !== SIGNER_ROLES.length ||
    actorRoles.size !== SIGNER_ROLES.length ||
    evidenceIds.size !== signoffs.length ||
    evidenceHashes.size !== signoffs.length ||
    signatures.size !== signoffs.length
  ) fail('PHASE5_READINESS_SIGNOFF_EVIDENCE_REUSED');
}

function readinessGatePayload(document, gateName, section, signerKeysetHashValue) {
  return canonical({
    formatVersion: document.formatVersion,
    suite: document.suite,
    evidenceId: document.evidenceId,
    gateName,
    environment: document.environment,
    source: document.source,
    section: {
      ...section,
      control: {
        evidenceId: section.control.evidenceId,
        rawEvidenceHash: section.control.rawEvidenceHash,
        completedAt: section.control.completedAt,
        expiresAt: section.control.expiresAt,
        signoffs: section.control.signoffs.map((signoff) => ({
          role: signoff.role,
          actorHash: signoff.actorHash,
          decision: signoff.decision,
          evidenceId: signoff.evidenceId,
          evidenceHash: signoff.evidenceHash,
          approvedAt: signoff.approvedAt,
        })),
      },
    },
    signerKeysetHash: signerKeysetHashValue,
  });
}

function readinessSignoffPayload(gateName, gatePayloadHash, signoff) {
  return canonical({
    suite: SIGNOFF_SIGNATURE_SUITE,
    gateName,
    gatePayloadHash,
    role: signoff.role,
    keyId: signoff.keyId,
    signedAt: signoff.signedAt,
  });
}

function runSelfTest() {
  const valid = fixture();
  validateEvidence(valid);

  const tenantEscape = fixture();
  tenantEscape.authorization.crossTenantDenied -= 1;
  expectFailure(() => validateEvidence(tenantEscape), 'PHASE5_READINESS_TENANT_ESCAPE');

  const unsignedUat = fixture();
  unsignedUat.businessUat.control.signoffs.pop();
  expectFailure(() => validateEvidence(unsignedUat), 'PHASE5_READINESS_SIGNOFFS_INCOMPLETE');

  const forgedSignature = fixture();
  forgedSignature.authorization.control.signoffs[0].signature =
    `${forgedSignature.authorization.control.signoffs[0].signature[0] === 'A' ? 'B' : 'A'}${
      forgedSignature.authorization.control.signoffs[0].signature.slice(1)
    }`;
  expectFailure(
    () => validateEvidence(forgedSignature),
    'PHASE5_READINESS_SIGNOFF_SIGNATURE_INVALID',
  );

  const gateTamperedAfterSigning = fixture();
  gateTamperedAfterSigning.engineeringQuality.testCases += 1;
  expectFailure(
    () => validateEvidence(gateTamperedAfterSigning),
    'PHASE5_READINESS_SIGNOFF_PAYLOAD_MISMATCH',
  );

  const privacyFinding = fixture();
  privacyFinding.privacyCompliance.unresolvedPrivacyFindings = 1;
  expectFailure(() => validateEvidence(privacyFinding), 'PHASE5_READINESS_PRIVACY_FAILED');

  const reusedSignoffBundle = fixtureBundle();
  reusedSignoffBundle.document.operations.control.signoffs[0].evidenceId =
    reusedSignoffBundle.document.privacyCompliance.control.signoffs[0].evidenceId;
  signFixture(reusedSignoffBundle.document, reusedSignoffBundle.privateKeys);
  expectFailure(
    () => validateEvidence(reusedSignoffBundle.document),
    'PHASE5_READINESS_SIGNOFF_EVIDENCE_REUSED',
  );

  const reusedActorBundle = fixtureBundle();
  reusedActorBundle.document.operations.control.signoffs[0].actorHash =
    reusedActorBundle.document.privacyCompliance.control.signoffs[0].actorHash;
  signFixture(reusedActorBundle.document, reusedActorBundle.privateKeys);
  expectFailure(
    () => validateEvidence(reusedActorBundle.document),
    'PHASE5_READINESS_SIGNOFF_ACTORS_NOT_INDEPENDENT',
  );

  const inconsistentActorBundle = fixtureBundle();
  const qaSignoff = inconsistentActorBundle.document.authorization.control.signoffs
    .find((item) => item.role === 'qa_owner');
  if (qaSignoff === undefined) fail('PHASE5_READINESS_SELF_TEST_INVALID');
  qaSignoff.actorHash = digest('different-qa-owner');
  signFixture(inconsistentActorBundle.document, inconsistentActorBundle.privateKeys);
  expectFailure(
    () => validateEvidence(inconsistentActorBundle.document),
    'PHASE5_READINESS_SIGNOFF_ACTOR_INCONSISTENT',
  );

  const reusedAuthority = fixture();
  reusedAuthority.signingAuthorities[1].keyId = reusedAuthority.signingAuthorities[0].keyId;
  reusedAuthority.signingAuthorities[1].publicKeySpkiBase64 =
    reusedAuthority.signingAuthorities[0].publicKeySpkiBase64;
  expectFailure(
    () => validateEvidence(reusedAuthority),
    'PHASE5_READINESS_SIGNING_AUTHORITIES_NOT_INDEPENDENT',
  );

  const swappedRoleKey = fixture();
  const firstKeyId = swappedRoleKey.operations.control.signoffs[0].keyId;
  swappedRoleKey.operations.control.signoffs[0].keyId =
    swappedRoleKey.operations.control.signoffs[1].keyId;
  swappedRoleKey.operations.control.signoffs[1].keyId = firstKeyId;
  expectFailure(
    () => validateEvidence(swappedRoleKey),
    'PHASE5_READINESS_SIGNOFF_KEY_MISMATCH',
  );

  const futureSignatureBundle = fixtureBundle();
  futureSignatureBundle.document.authorization.control.signoffs[0].signedAt =
    '2026-07-24T00:00:00.000Z';
  signFixture(futureSignatureBundle.document, futureSignatureBundle.privateKeys);
  expectFailure(
    () => validateEvidence(futureSignatureBundle.document),
    'PHASE5_READINESS_SIGNOFF_SIGNATURE_TIME_INVALID',
  );

  const unsignedImage = fixture();
  unsignedImage.productionImages.images.api.signatureVerified = false;
  expectFailure(
    () => validateEvidence(unsignedImage),
    'PHASE5_READINESS_PRODUCTION_IMAGE_FAILED',
  );

  const bound = fixture();
  withExpectedEnvironment(bound, () => {
    validateEvidence(bound, true);
    const mismatch = structuredClone(bound);
    mismatch.source.commitSha = 'b'.repeat(40);
    expectFailure(() => validateEvidence(mismatch, true), 'PHASE5_READINESS_COMMIT_MISMATCH');
    process.env.READINESS_EXPECTED_SIGNER_KEYSET_SHA256 = digest('unapproved-keyset');
    expectFailure(
      () => validateEvidence(bound, true),
      'PHASE5_READINESS_SIGNER_KEYSET_MISMATCH',
    );
  });
}

function fixture() {
  return fixtureBundle().document;
}

function fixtureBundle() {
  const images = {
    api: digest('api'),
    worker: digest('worker'),
    web: digest('web'),
    website: digest('website'),
  };
  let nextId = 10;
  const evidenceId = () => ulid(nextId++);
  const privateKeys = new Map();
  const signingAuthorities = SIGNER_ROLES.map((role) => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const keyId = publicKeyHash(publicKey);
    privateKeys.set(role, privateKey);
    return {
      role,
      algorithm: 'Ed25519',
      keyId,
      publicKeySpkiBase64: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    };
  });
  const authoritiesByRole = new Map(
    signingAuthorities.map((authority) => [authority.role, authority]),
  );
  const control = (gate) => ({
    evidenceId: evidenceId(),
    rawEvidenceHash: digest(`raw-${gate}`),
    completedAt: '2026-07-22T00:00:00.000Z',
    expiresAt: '2026-08-21T00:00:00.000Z',
    signoffs: SIGNOFF_ROLES[gate].map((role) => ({
      role,
      actorHash: digest(`actor-${role}`),
      decision: 'approved',
      evidenceId: evidenceId(),
      evidenceHash: digest(`signoff-${gate}-${role}`),
      approvedAt: '2026-07-22T01:00:00.000Z',
      signedAt: '2026-07-22T01:05:00.000Z',
      algorithm: 'Ed25519',
      keyId: authoritiesByRole.get(role)?.keyId,
      signedPayloadSha256: digest('unsigned'),
      signature: 'A'.repeat(86),
    })),
  });
  const document = {
    formatVersion: 2,
    suite: 'gaoq.phase5.readiness.v2',
    evidenceId: evidenceId(),
    environment: {
      name: 'release-uat', region: 'cn-test-1', productionEquivalent: true,
      productionTraffic: false, productionData: false,
      evaluatedAt: '2026-07-23T00:00:00.000Z',
    },
    source: {
      commitSha: 'a'.repeat(40), images,
      deploymentManifestHash: digest('deployment-manifest'), harnessSha256: HARNESS_DIGEST,
    },
    engineeringQuality: {
      control: control('engineering-quality'),
      lintPassed: true, typecheckPassed: true, unitPassed: true, integrationPassed: true,
      contractPassed: true, e2ePassed: true, buildPassed: true,
      testFiles: 255, testCases: 1_206, openSev1: 0, openSev2: 0, blockingFlakyTests: 0,
    },
    supplyChain: {
      control: control('supply-chain'),
      sastPassed: true, scaPassed: true, secretScanPassed: true, licensePassed: true,
      dependencyAuditPassed: true, criticalVulnerabilities: 0, highVulnerabilities: 0,
      unexpiredSecurityExceptions: 0,
      sbomHashes: {
        api: digest('sbom-api'),
        worker: digest('sbom-worker'),
        web: digest('sbom-web'),
        website: digest('sbom-website'),
      },
    },
    productionImages: {
      control: control('production-images'),
      images: Object.fromEntries(Object.entries(images).map(([name, imageDigest]) => [name, {
        digest: imageDigest, signatureVerified: true, slsaProvenanceVerified: true,
        sbomHash: digest(`image-sbom-${name}`), nonRoot: true, readOnlyRootFilesystem: true,
        healthcheckPassed: true, rollbackSmokePassed: true,
      }])),
      admissionPolicyEnforced: true,
    },
    authorization: {
      control: control('authorization'),
      matrixCases: 240, passedCases: 240, crossTenantAttempts: 60, crossTenantDenied: 60,
      fieldScopeFailures: 0, dataScopeFailures: 0, mcpR3ToolCount: 0,
      matrixEvidenceHash: digest('authorization-matrix'),
      crossTenantEvidenceHash: digest('cross-tenant'),
    },
    businessUat: {
      control: control('business-uat'), approvalShadowDays: 28, payrollShadowCycles: 2,
      domains: DOMAINS.map((name) => ({
        name, status: 'passed', evidenceId: evidenceId(), evidenceHash: digest(`uat-${name}`),
      })),
      unexplainedRecordDifferences: 0, unexplainedAmountDifferenceMinor: 0,
    },
    privacyCompliance: {
      control: control('privacy-compliance'),
      dataInventoryApproved: true, privacyImpactAssessmentApproved: true,
      retentionDeletionVerified: true, consentWithdrawalVerified: true,
      legalBasisApproved: true, unresolvedPrivacyFindings: 0,
      unapprovedCrossBorderTransfers: 0, dataInventoryHash: digest('data-inventory'),
      privacyImpactAssessmentHash: digest('pia'),
    },
    operations: {
      control: control('operations'),
      monitoringDashboardsApproved: true, alertRoutesTested: true,
      onCallRosterConfirmed: true, runbooksApproved: true, backupPolicyActive: true,
      rollbackRehearsed: true, changeFreezeApproved: true, hypercareDays: 28,
      incidentCommanderAssigned: true, supportHandoffComplete: true,
      wormEvidenceHash: digest('operations-worm'),
    },
    signingAuthorities,
  };
  signFixture(document, privateKeys);
  return Object.freeze({ document, privateKeys });
}

function signFixture(document, privateKeys) {
  const keysetHash = signerKeysetHash(document.signingAuthorities);
  for (const gateName of Object.keys(GATE_SUITES)) {
    const sectionField = GATE_SECTION_FIELDS[gateName];
    const section = document[sectionField];
    const gatePayloadHash = digest(readinessGatePayload(
      document,
      gateName,
      section,
      keysetHash,
    ));
    for (const signoff of section.control.signoffs) {
      const payload = readinessSignoffPayload(gateName, gatePayloadHash, signoff);
      signoff.signedPayloadSha256 = digest(payload);
      signoff.signature = sign(
        null,
        Buffer.from(payload, 'utf8'),
        privateKeys.get(signoff.role),
      ).toString('base64url');
    }
  }
}

function withExpectedEnvironment(document, action) {
  const values = {
    READINESS_EXPECTED_ENVIRONMENT: document.environment.name,
    READINESS_EXPECTED_REGION: document.environment.region,
    READINESS_EXPECTED_COMMIT: document.source.commitSha,
    READINESS_EXPECTED_API_IMAGE: document.source.images.api,
    READINESS_EXPECTED_WORKER_IMAGE: document.source.images.worker,
    READINESS_EXPECTED_WEB_IMAGE: document.source.images.web,
    READINESS_EXPECTED_WEBSITE_IMAGE: document.source.images.website,
    READINESS_EXPECTED_DEPLOYMENT_MANIFEST: document.source.deploymentManifestHash,
    READINESS_EXPECTED_SIGNER_KEYSET_SHA256:
      signerKeysetHash(document.signingAuthorities),
  };
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try {
    action();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function publicKeyFromSpkiBase64(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
    fail('PHASE5_READINESS_SIGNING_AUTHORITY_INVALID');
  }
  let der;
  try {
    der = Buffer.from(value, 'base64');
  } catch {
    fail('PHASE5_READINESS_SIGNING_AUTHORITY_INVALID');
  }
  if (
    der.length < 32 ||
    der.length > 256 ||
    der.toString('base64') !== value
  ) fail('PHASE5_READINESS_SIGNING_AUTHORITY_INVALID');
  let publicKey;
  try {
    publicKey = createPublicKey({ key: der, format: 'der', type: 'spki' });
  } catch {
    fail('PHASE5_READINESS_SIGNING_AUTHORITY_INVALID');
  }
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    fail('PHASE5_READINESS_SIGNING_AUTHORITY_INVALID');
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
    fail('PHASE5_READINESS_SIGNOFF_SIGNATURE_INVALID');
  }
  if (signature.length !== 64 || signature.toString('base64url') !== value) {
    fail('PHASE5_READINESS_SIGNOFF_SIGNATURE_INVALID');
  }
  return signature;
}

function parseDocument(text) {
  try {
    return JSON.parse(text);
  } catch {
    fail('PHASE5_READINESS_JSON_INVALID');
  }
}

function object(value, keys, code) {
  if (
    typeof value !== 'object' || value === null || Array.isArray(value) ||
    canonical(Object.keys(value).sort()) !== canonical([...keys].sort())
  ) fail(code);
}

function exactStringSet(actual, expected, code) {
  if (
    !Array.isArray(actual) ||
    actual.some((item) => typeof item !== 'string') ||
    new Set(actual).size !== expected.length ||
    canonical([...actual].sort()) !== canonical([...expected].sort())
  ) fail(code);
}

function pattern(value, expression, code) {
  if (typeof value !== 'string' || !expression.test(value)) fail(code);
}

function equal(actual, expected, code) {
  if (actual !== expected) fail(code);
}

function integer(value, minimum, maximum, code) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(code);
}

function timestamp(value) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
  ) fail('PHASE5_READINESS_TIMESTAMP_INVALID');
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail('PHASE5_READINESS_TIMESTAMP_INVALID');
  return parsed;
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

function ulid(index) {
  return `01J8ZQK7V0A2M4N6P8R0T3R${String(index).padStart(3, '0')}`;
}

function expectFailure(operation, code) {
  try {
    operation();
  } catch (error) {
    if (error instanceof Error && error.message === code) return;
    throw error;
  }
  fail('PHASE5_READINESS_SELF_TEST_DID_NOT_FAIL');
}

function fail(code) {
  throw new Error(code);
}
