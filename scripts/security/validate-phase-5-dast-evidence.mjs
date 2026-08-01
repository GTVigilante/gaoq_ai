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
const SIGNOFF_ROLES = ['appsec_owner', 'platform_owner', 'qa_owner', 'risk_owner'];
const SIGNOFF_SIGNATURE_SUITE = 'gaoq.phase5.dast-asvs.signoff.v1';
const SIGNOFF_WINDOW_MS = 72 * 60 * 60 * 1_000;
const ZAP_IMAGE_DIGEST =
  'sha256:c558ee87358911ab17278c70991e856f57793e115d9cd0f88ca475cf82907a1a';
const ASVS_CATALOG_DIGEST =
  'sha256:6124dba176dc563f66363a11ae0c47f9b86b8a4a84c66a793670bd196ed86cd5';
const HARNESS_FILES = [
  ['./run-phase-5-dast.mjs', new URL('./run-phase-5-dast.mjs', import.meta.url)],
  ['./zap/exact-auth-header.js', new URL('./zap/exact-auth-header.js', import.meta.url)],
  ['./zap/exact-auth-hook.py', new URL('./zap/exact-auth-hook.py', import.meta.url)],
  ['../../.github/workflows/phase-5-dast.yml',
    new URL('../../.github/workflows/phase-5-dast.yml', import.meta.url)],
  ['../../.github/workflows/phase-5-dast-evidence.yml',
    new URL('../../.github/workflows/phase-5-dast-evidence.yml', import.meta.url)],
  ['./validate-phase-5-dast-evidence.mjs', new URL(import.meta.url)],
];
const HARNESS_DIGEST = digest(canonical(Object.fromEntries(await Promise.all(
  HARNESS_FILES.map(async ([name, url]) => [name, await readFile(url, 'utf8')]),
))));

const argumentsList = process.argv.slice(2);
if (argumentsList.length === 1 && argumentsList[0] === '--self-test') {
  runSelfTest();
  process.stdout.write('Phase 5 DAST 与 ASVS 证据门禁自测通过。\n');
} else if (argumentsList.length === 1 && argumentsList[0] === '--print-contract') {
  process.stdout.write(`${JSON.stringify({
    formatVersion: 2,
    suite: 'gaoq.phase5.dast-asvs.contract',
    evidenceSuite: 'gaoq.phase5.dast-asvs.v2',
    verdictSuite: 'gaoq.phase5.dast-asvs.verdict',
    signoffRoles: SIGNOFF_ROLES,
    signatureSuite: SIGNOFF_SIGNATURE_SUITE,
    signatureAlgorithm: 'Ed25519',
    signatureEncoding: 'base64url-unpadded',
    publicKeyEncoding: 'base64-spki-der',
    keyId: 'sha256:<lowercase-hex-of-spki-der>',
    signerKeysetCanonicalFields: ['role', 'keyId'],
    signerKeysetOrder: 'role-ascending',
    maximumSignoffAgeHours: 72,
    zapImageDigest: ZAP_IMAGE_DIGEST,
    asvsCatalogSha256: ASVS_CATALOG_DIGEST,
    harnessSha256: HARNESS_DIGEST,
  }, null, 2)}\n`);
} else {
  const enforceEnvironment = argumentsList[0] === '--enforce-environment';
  const path = argumentsList[enforceEnvironment ? 1 : 0];
  if (path === undefined || argumentsList.length !== (enforceEnvironment ? 2 : 1)) {
    fail('PHASE5_DAST_EVIDENCE_PATH_REQUIRED');
  }
  const metadata = await lstat(path);
  if (
    !metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 ||
    metadata.size > 512 * 1_024 || (metadata.mode & 0o022) !== 0
  ) {
    fail('PHASE5_DAST_EVIDENCE_FILE_INVALID');
  }
  const summary = validateEvidence(
    parseDocument(await readFile(path, 'utf8')),
    enforceEnvironment,
  );
  process.stdout.write(`${JSON.stringify({
    formatVersion: 2,
    suite: 'gaoq.phase5.dast-asvs.verdict',
    runId: summary.runId,
    commitSha: summary.commitSha,
    signerKeysetHash: summary.signerKeysetHash,
    approvalPayloadHash: summary.approvalPayloadHash,
    evidenceChecksum: digest(canonical(summary)),
  }, null, 2)}\n`);
}

function validateEvidence(document, enforceEnvironment = false) {
  object(document, [
    'formatVersion', 'suite', 'runId', 'environment', 'source', 'controls', 'dast',
    'artifacts', 'signingAuthorities', 'signoffs',
  ]);
  equal(document.formatVersion, 2, 'PHASE5_DAST_FORMAT_INVALID');
  equal(document.suite, 'gaoq.phase5.dast-asvs.v2', 'PHASE5_DAST_SUITE_INVALID');
  pattern(document.runId, ULID, 'PHASE5_DAST_RUN_ID_INVALID');
  const authorities = validateSigningAuthorities(document.signingAuthorities);

  object(document.environment, [
    'name', 'region', 'productionEquivalent', 'productionTraffic', 'targetOriginHash',
    'startedAt', 'endedAt',
  ]);
  pattern(document.environment.name, ENVIRONMENT_NAME, 'PHASE5_DAST_ENV_INVALID');
  if (/(?:^|-)prod(?:-|$)|production/u.test(document.environment.name)) {
    fail('PHASE5_DAST_PROD_FORBIDDEN');
  }
  if (!/(?:^|-)(?:dast|preprod|security|stage|staging|uat)(?:-|$)/u
    .test(document.environment.name)) fail('PHASE5_DAST_ENV_INVALID');
  pattern(document.environment.region, REGION, 'PHASE5_DAST_REGION_INVALID');
  equal(document.environment.productionEquivalent, true, 'PHASE5_DAST_ENV_NOT_EQUIVALENT');
  equal(document.environment.productionTraffic, false, 'PHASE5_DAST_PROD_FORBIDDEN');
  pattern(document.environment.targetOriginHash, SHA256, 'PHASE5_DAST_TARGET_HASH_INVALID');
  const startedAt = timestamp(document.environment.startedAt);
  const endedAt = timestamp(document.environment.endedAt);
  if (endedAt - startedAt < 10 * 60 * 1_000) fail('PHASE5_DAST_DURATION_INVALID');
  if (enforceEnvironment) validateExpectedEnvironment(document.environment);

  object(document.source, [
    'commitSha', 'images', 'zapVersion', 'zapImageDigest', 'scanHarnessSha256',
    'asvsVersion', 'asvsCatalogSha256',
  ]);
  pattern(document.source.commitSha, COMMIT, 'PHASE5_DAST_COMMIT_INVALID');
  object(document.source.images, ['api', 'worker', 'web', 'website']);
  for (const image of Object.values(document.source.images)) {
    pattern(image, SHA256, 'PHASE5_DAST_IMAGE_DIGEST_INVALID');
  }
  if (new Set(Object.values(document.source.images)).size !== 4) {
    fail('PHASE5_DAST_IMAGE_DIGEST_INVALID');
  }
  equal(document.source.zapVersion, '2.17.0', 'PHASE5_DAST_ZAP_VERSION_INVALID');
  equal(document.source.zapImageDigest, ZAP_IMAGE_DIGEST, 'PHASE5_DAST_ZAP_DIGEST_INVALID');
  equal(
    document.source.scanHarnessSha256,
    HARNESS_DIGEST,
    'PHASE5_DAST_HARNESS_DIGEST_INVALID',
  );
  equal(document.source.asvsVersion, '5.0.0', 'PHASE5_DAST_ASVS_VERSION_INVALID');
  equal(
    document.source.asvsCatalogSha256,
    ASVS_CATALOG_DIGEST,
    'PHASE5_DAST_ASVS_CATALOG_INVALID',
  );
  if (enforceEnvironment) validateExpectedSource(document.source);
  if (enforceEnvironment) {
    pattern(
      process.env.DAST_EXPECTED_SIGNER_KEYSET_SHA256,
      SHA256,
      'PHASE5_DAST_EXPECTED_SIGNER_KEYSET_REQUIRED',
    );
    equal(
      authorities.keysetHash,
      process.env.DAST_EXPECTED_SIGNER_KEYSET_SHA256,
      'PHASE5_DAST_SIGNER_KEYSET_MISMATCH',
    );
  }

  validateControls(document.controls);
  const scanHashes = validateDast(document.dast);

  object(document.artifacts, [
    'asvsMatrixHash', 'monitoringSnapshotHash', 'auditQueryHash', 'testDataManifestHash',
  ]);
  for (const value of Object.values(document.artifacts)) {
    pattern(value, SHA256, 'PHASE5_DAST_ARTIFACT_INVALID');
  }
  const artifactHashes = new Set(Object.values(document.artifacts));
  if (
    artifactHashes.size !== 4 ||
    [...artifactHashes].some((hash) => scanHashes.has(hash))
  ) fail('PHASE5_DAST_ARTIFACT_REUSED');

  validateSignoffMetadata(document.signoffs, endedAt);
  const approvalPayloadHash = digest(dastApprovalPayload(
    document,
    authorities.keysetHash,
  ));
  const signoffEvidenceIds = validateSignoffSignatures(
    document.signoffs,
    authorities.byRole,
    approvalPayloadHash,
    endedAt,
  );

  return Object.freeze({
    runId: document.runId,
    commitSha: document.source.commitSha,
    images: document.source.images,
    environment: document.environment,
    controls: document.controls,
    dast: document.dast,
    artifacts: document.artifacts,
    signoffEvidenceIds,
    signerKeysetHash: authorities.keysetHash,
    approvalPayloadHash,
  });
}

function validateExpectedEnvironment(environment) {
  const expectedName = process.env.DAST_EXPECTED_ENVIRONMENT;
  const expectedRegion = process.env.DAST_EXPECTED_REGION;
  const expectedTargetOriginHash = process.env.DAST_EXPECTED_TARGET_ORIGIN_SHA256;
  pattern(expectedName, ENVIRONMENT_NAME, 'PHASE5_DAST_EXPECTED_ENVIRONMENT_REQUIRED');
  pattern(expectedRegion, REGION, 'PHASE5_DAST_EXPECTED_ENVIRONMENT_REQUIRED');
  pattern(
    expectedTargetOriginHash,
    SHA256,
    'PHASE5_DAST_EXPECTED_TARGET_ORIGIN_REQUIRED',
  );
  equal(environment.name, expectedName, 'PHASE5_DAST_ENVIRONMENT_MISMATCH');
  equal(environment.region, expectedRegion, 'PHASE5_DAST_REGION_MISMATCH');
  equal(
    environment.targetOriginHash,
    expectedTargetOriginHash,
    'PHASE5_DAST_TARGET_ORIGIN_MISMATCH',
  );
}

function validateExpectedSource(source) {
  const expected = {
    commitSha: process.env.DAST_EXPECTED_COMMIT,
    api: process.env.DAST_EXPECTED_API_IMAGE,
    worker: process.env.DAST_EXPECTED_WORKER_IMAGE,
    web: process.env.DAST_EXPECTED_WEB_IMAGE,
    website: process.env.DAST_EXPECTED_WEBSITE_IMAGE,
  };
  pattern(expected.commitSha, COMMIT, 'PHASE5_DAST_EXPECTED_SOURCE_REQUIRED');
  for (const image of ['api', 'worker', 'web', 'website']) {
    pattern(expected[image], SHA256, 'PHASE5_DAST_EXPECTED_SOURCE_REQUIRED');
  }
  equal(source.commitSha, expected.commitSha, 'PHASE5_DAST_COMMIT_MISMATCH');
  for (const image of ['api', 'worker', 'web', 'website']) {
    equal(source.images[image], expected[image], 'PHASE5_DAST_IMAGE_MISMATCH');
  }
}

function validateSigningAuthorities(authorities) {
  if (!Array.isArray(authorities) || authorities.length !== SIGNOFF_ROLES.length) {
    fail('PHASE5_DAST_SIGNING_AUTHORITIES_INCOMPLETE');
  }
  const roles = [];
  const keyIds = new Set();
  const byRole = new Map();
  const keyset = [];
  for (const authority of authorities) {
    object(authority, ['role', 'algorithm', 'keyId', 'publicKeySpkiBase64']);
    if (!SIGNOFF_ROLES.includes(authority.role)) {
      fail('PHASE5_DAST_SIGNING_AUTHORITY_INVALID');
    }
    equal(authority.algorithm, 'Ed25519', 'PHASE5_DAST_SIGNING_AUTHORITY_INVALID');
    pattern(authority.keyId, SHA256, 'PHASE5_DAST_SIGNING_AUTHORITY_INVALID');
    const publicKey = publicKeyFromSpkiBase64(authority.publicKeySpkiBase64);
    equal(
      authority.keyId,
      publicKeyHash(publicKey),
      'PHASE5_DAST_SIGNING_AUTHORITY_KEY_MISMATCH',
    );
    roles.push(authority.role);
    keyIds.add(authority.keyId);
    byRole.set(authority.role, Object.freeze({ keyId: authority.keyId, publicKey }));
    keyset.push(Object.freeze({ role: authority.role, keyId: authority.keyId }));
  }
  exactStringSet(
    roles,
    SIGNOFF_ROLES,
    'PHASE5_DAST_SIGNING_AUTHORITIES_INCOMPLETE',
  );
  if (keyIds.size !== SIGNOFF_ROLES.length || byRole.size !== SIGNOFF_ROLES.length) {
    fail('PHASE5_DAST_SIGNING_AUTHORITIES_NOT_INDEPENDENT');
  }
  return Object.freeze({ byRole, keysetHash: signerKeysetHash(keyset) });
}

function validateSignoffMetadata(signoffs, endedAt) {
  if (!Array.isArray(signoffs) || signoffs.length !== SIGNOFF_ROLES.length) {
    fail('PHASE5_DAST_SIGNOFFS_INCOMPLETE');
  }
  const roles = [];
  const actorHashes = new Set();
  const evidenceIds = new Set();
  const commentHashes = new Set();
  for (const signoff of signoffs) {
    object(signoff, [
      'role', 'actorHash', 'decision', 'evidenceId', 'commentHash', 'approvedAt',
      'signedAt', 'algorithm', 'keyId', 'signedPayloadSha256', 'signature',
    ]);
    if (!SIGNOFF_ROLES.includes(signoff.role)) fail('PHASE5_DAST_SIGNOFF_INVALID');
    pattern(signoff.actorHash, SHA256, 'PHASE5_DAST_SIGNOFF_ACTOR_INVALID');
    equal(signoff.decision, 'approve', 'PHASE5_DAST_SIGNOFF_REJECTED');
    pattern(signoff.evidenceId, ULID, 'PHASE5_DAST_SIGNOFF_EVIDENCE_INVALID');
    pattern(signoff.commentHash, SHA256, 'PHASE5_DAST_SIGNOFF_COMMENT_INVALID');
    const approvedAt = timestamp(signoff.approvedAt);
    if (approvedAt < endedAt || approvedAt - endedAt > SIGNOFF_WINDOW_MS) {
      fail('PHASE5_DAST_SIGNOFF_TIME_INVALID');
    }
    roles.push(signoff.role);
    actorHashes.add(signoff.actorHash);
    evidenceIds.add(signoff.evidenceId);
    commentHashes.add(signoff.commentHash);
  }
  exactStringSet(roles, SIGNOFF_ROLES, 'PHASE5_DAST_SIGNOFFS_INCOMPLETE');
  if (actorHashes.size !== SIGNOFF_ROLES.length) {
    fail('PHASE5_DAST_SIGNOFF_ACTORS_NOT_INDEPENDENT');
  }
  if (
    evidenceIds.size !== SIGNOFF_ROLES.length ||
    commentHashes.size !== SIGNOFF_ROLES.length
  ) fail('PHASE5_DAST_SIGNOFF_EVIDENCE_REUSED');
}

function validateSignoffSignatures(signoffs, authorities, approvalPayloadHash, endedAt) {
  const signatures = new Set();
  const evidenceIds = [];
  for (const signoff of signoffs) {
    equal(signoff.algorithm, 'Ed25519', 'PHASE5_DAST_SIGNOFF_PROOF_INVALID');
    pattern(signoff.keyId, SHA256, 'PHASE5_DAST_SIGNOFF_PROOF_INVALID');
    pattern(
      signoff.signedPayloadSha256,
      SHA256,
      'PHASE5_DAST_SIGNOFF_PROOF_INVALID',
    );
    pattern(signoff.signature, SIGNATURE, 'PHASE5_DAST_SIGNOFF_PROOF_INVALID');
    const approvedAt = timestamp(signoff.approvedAt);
    const signedAt = timestamp(signoff.signedAt);
    if (signedAt < approvedAt || signedAt - endedAt > SIGNOFF_WINDOW_MS) {
      fail('PHASE5_DAST_SIGNOFF_SIGNATURE_TIME_INVALID');
    }
    const authority = authorities.get(signoff.role);
    if (authority === undefined) fail('PHASE5_DAST_SIGNOFF_AUTHORITY_INVALID');
    equal(signoff.keyId, authority.keyId, 'PHASE5_DAST_SIGNOFF_KEY_MISMATCH');
    const payload = dastSignoffPayload(approvalPayloadHash, signoff);
    equal(
      signoff.signedPayloadSha256,
      digest(payload),
      'PHASE5_DAST_SIGNOFF_PAYLOAD_MISMATCH',
    );
    const signature = decodeSignature(signoff.signature);
    if (!verify(null, Buffer.from(payload, 'utf8'), authority.publicKey, signature)) {
      fail('PHASE5_DAST_SIGNOFF_SIGNATURE_INVALID');
    }
    signatures.add(signoff.signature);
    evidenceIds.push(signoff.evidenceId);
  }
  if (signatures.size !== SIGNOFF_ROLES.length) {
    fail('PHASE5_DAST_SIGNOFF_PROOF_REUSED');
  }
  return evidenceIds;
}

function dastApprovalPayload(document, signerKeysetHashValue) {
  return canonical({
    formatVersion: document.formatVersion,
    suite: document.suite,
    runId: document.runId,
    environment: document.environment,
    source: document.source,
    controls: document.controls,
    dast: document.dast,
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

function dastSignoffPayload(approvalPayloadHash, signoff) {
  return canonical({
    suite: SIGNOFF_SIGNATURE_SUITE,
    approvalPayloadHash,
    role: signoff.role,
    keyId: signoff.keyId,
    signedAt: signoff.signedAt,
  });
}

function validateControls(controls) {
  object(controls, ['catalog', 'level2Baseline', 'highRiskLevel3', 'webRtcExclusion', 'exceptions']);
  object(controls.catalog, ['total', 'level1', 'level2', 'level3']);
  equal(controls.catalog.total, 345, 'PHASE5_DAST_ASVS_COUNT_INVALID');
  equal(controls.catalog.level1, 70, 'PHASE5_DAST_ASVS_COUNT_INVALID');
  equal(controls.catalog.level2, 183, 'PHASE5_DAST_ASVS_COUNT_INVALID');
  equal(controls.catalog.level3, 92, 'PHASE5_DAST_ASVS_COUNT_INVALID');
  object(controls.level2Baseline, [
    'requirementCount', 'passedCount', 'notApplicableCount', 'failedCount',
    'notApplicableEvidenceHash',
  ]);
  equal(controls.level2Baseline.requirementCount, 253, 'PHASE5_DAST_ASVS_L2_INCOMPLETE');
  integer(controls.level2Baseline.passedCount, 223, 253, 'PHASE5_DAST_ASVS_L2_INCOMPLETE');
  integer(controls.level2Baseline.notApplicableCount, 0, 30, 'PHASE5_DAST_ASVS_L2_INCOMPLETE');
  equal(
    controls.level2Baseline.passedCount + controls.level2Baseline.notApplicableCount,
    253,
    'PHASE5_DAST_ASVS_L2_INCOMPLETE',
  );
  equal(controls.level2Baseline.failedCount, 0, 'PHASE5_DAST_ASVS_CONTROL_FAILED');
  pattern(
    controls.level2Baseline.notApplicableEvidenceHash,
    SHA256,
    'PHASE5_DAST_ASVS_NA_EVIDENCE_INVALID',
  );
  object(controls.highRiskLevel3, [
    'profile', 'requirementCount', 'passedCount', 'notApplicableCount', 'failedCount',
  ]);
  equal(controls.highRiskLevel3.profile, 'all-non-webrtc-level3', 'PHASE5_DAST_ASVS_L3_INVALID');
  equal(controls.highRiskLevel3.requirementCount, 87, 'PHASE5_DAST_ASVS_L3_INVALID');
  equal(controls.highRiskLevel3.passedCount, 87, 'PHASE5_DAST_ASVS_L3_INVALID');
  equal(controls.highRiskLevel3.notApplicableCount, 0, 'PHASE5_DAST_ASVS_L3_INVALID');
  equal(controls.highRiskLevel3.failedCount, 0, 'PHASE5_DAST_ASVS_CONTROL_FAILED');
  object(controls.webRtcExclusion, ['requirementCount', 'reasonCode', 'evidenceHash']);
  equal(controls.webRtcExclusion.requirementCount, 5, 'PHASE5_DAST_WEBRTC_EXCLUSION_INVALID');
  equal(controls.webRtcExclusion.reasonCode, 'FEATURE_NOT_PRESENT', 'PHASE5_DAST_WEBRTC_EXCLUSION_INVALID');
  pattern(controls.webRtcExclusion.evidenceHash, SHA256, 'PHASE5_DAST_WEBRTC_EXCLUSION_INVALID');
  if (!Array.isArray(controls.exceptions) || controls.exceptions.length !== 0) {
    fail('PHASE5_DAST_SECURITY_EXCEPTION_FORBIDDEN');
  }
}

function validateDast(dast) {
  object(dast, ['scans', 'authorizationProbes', 'safety']);
  if (!Array.isArray(dast.scans) || dast.scans.length !== 2) fail('PHASE5_DAST_SCANS_INCOMPLETE');
  const modes = [];
  const hashes = new Set();
  for (const scan of dast.scans) {
    object(scan, [
      'mode', 'scannerExitCode', 'activeScanCompleted', 'modernSpiderCompleted',
      'passiveQueueAtEnd', 'scannedUrls', 'requestCount', 'alerts', 'rawJsonHash',
      'rawXmlHash', 'rawHtmlHash',
    ]);
    if (!['authenticated', 'unauthenticated'].includes(scan.mode)) fail('PHASE5_DAST_SCAN_MODE_INVALID');
    modes.push(scan.mode);
    equal(scan.scannerExitCode, 0, 'PHASE5_DAST_SCANNER_FAILED');
    equal(scan.activeScanCompleted, true, 'PHASE5_DAST_ACTIVE_SCAN_INCOMPLETE');
    equal(scan.modernSpiderCompleted, true, 'PHASE5_DAST_SPIDER_INCOMPLETE');
    equal(scan.passiveQueueAtEnd, 0, 'PHASE5_DAST_PASSIVE_SCAN_INCOMPLETE');
    integer(scan.scannedUrls, scan.mode === 'authenticated' ? 20 : 10, 1_000_000,
      'PHASE5_DAST_COVERAGE_INSUFFICIENT');
    integer(scan.requestCount, 1_000, Number.MAX_SAFE_INTEGER, 'PHASE5_DAST_COVERAGE_INSUFFICIENT');
    object(scan.alerts, ['critical', 'high', 'medium', 'low', 'informational']);
    for (const risk of ['critical', 'high', 'medium']) {
      equal(scan.alerts[risk], 0, 'PHASE5_DAST_ALERT_BLOCKING');
    }
    integer(scan.alerts.low, 0, 10_000, 'PHASE5_DAST_ALERT_COUNT_INVALID');
    integer(scan.alerts.informational, 0, 100_000, 'PHASE5_DAST_ALERT_COUNT_INVALID');
    for (const field of ['rawJsonHash', 'rawXmlHash', 'rawHtmlHash']) {
      pattern(scan[field], SHA256, 'PHASE5_DAST_REPORT_HASH_INVALID');
      hashes.add(scan[field]);
    }
  }
  if (canonical(modes.sort()) !== canonical(['authenticated', 'unauthenticated']) || hashes.size !== 6) {
    fail('PHASE5_DAST_SCANS_NOT_INDEPENDENT');
  }
  object(dast.authorizationProbes, [
    'authenticatedRequests', 'authenticationFailures', 'crossTenantDenied', 'idorDenied',
    'scopeDenied', 'mcpR3ToolCount', 'auditEvents',
  ]);
  integer(dast.authorizationProbes.authenticatedRequests, 100, Number.MAX_SAFE_INTEGER,
    'PHASE5_DAST_AUTH_COVERAGE_INSUFFICIENT');
  equal(dast.authorizationProbes.authenticationFailures, 0, 'PHASE5_DAST_AUTH_FAILED');
  integer(dast.authorizationProbes.crossTenantDenied, 10, Number.MAX_SAFE_INTEGER,
    'PHASE5_DAST_AUTHZ_COVERAGE_INSUFFICIENT');
  integer(dast.authorizationProbes.idorDenied, 10, Number.MAX_SAFE_INTEGER,
    'PHASE5_DAST_AUTHZ_COVERAGE_INSUFFICIENT');
  integer(dast.authorizationProbes.scopeDenied, 10, Number.MAX_SAFE_INTEGER,
    'PHASE5_DAST_AUTHZ_COVERAGE_INSUFFICIENT');
  equal(dast.authorizationProbes.mcpR3ToolCount, 0, 'PHASE5_DAST_MCP_R3_EXPOSED');
  integer(dast.authorizationProbes.auditEvents, 30, Number.MAX_SAFE_INTEGER,
    'PHASE5_DAST_AUDIT_COVERAGE_INSUFFICIENT');
  object(dast.safety, [
    'isolatedTenant', 'sandboxConnectors', 'r3ActionsDisabled', 'productionDataUsed',
    'externalSideEffects',
  ]);
  equal(dast.safety.isolatedTenant, true, 'PHASE5_DAST_ISOLATION_REQUIRED');
  equal(dast.safety.sandboxConnectors, true, 'PHASE5_DAST_SANDBOX_REQUIRED');
  equal(dast.safety.r3ActionsDisabled, true, 'PHASE5_DAST_R3_DISABLE_REQUIRED');
  equal(dast.safety.productionDataUsed, false, 'PHASE5_DAST_PRODUCTION_DATA_FORBIDDEN');
  equal(dast.safety.externalSideEffects, false, 'PHASE5_DAST_EXTERNAL_EFFECT_FORBIDDEN');
  return hashes;
}

function runSelfTest() {
  validateEvidence(fixture());
  const bound = fixture();
  withExpectedEnvironment(bound, () => validateEvidence(bound, true));
  const mediumAlert = fixture();
  mediumAlert.dast.scans[0].alerts.medium = 1;
  expectFailure(() => validateEvidence(mediumAlert), 'PHASE5_DAST_ALERT_BLOCKING');
  const incompleteL3 = fixture();
  incompleteL3.controls.highRiskLevel3.passedCount = 86;
  expectFailure(() => validateEvidence(incompleteL3), 'PHASE5_DAST_ASVS_L3_INVALID');
  const unsafe = fixture();
  unsafe.dast.safety.externalSideEffects = true;
  expectFailure(() => validateEvidence(unsafe), 'PHASE5_DAST_EXTERNAL_EFFECT_FORBIDDEN');
  const forgedHarness = fixture();
  forgedHarness.source.scanHarnessSha256 = digest('forged');
  expectFailure(() => validateEvidence(forgedHarness), 'PHASE5_DAST_HARNESS_DIGEST_INVALID');
  const productionNamed = fixture();
  productionNamed.environment.name = 'prod-security';
  expectFailure(() => validateEvidence(productionNamed), 'PHASE5_DAST_PROD_FORBIDDEN');
  withExpectedEnvironment(bound, () => {
    process.env.DAST_EXPECTED_COMMIT = 'b'.repeat(40);
    expectFailure(
      () => validateEvidence(bound, true),
      'PHASE5_DAST_COMMIT_MISMATCH',
    );
    process.env.DAST_EXPECTED_COMMIT = bound.source.commitSha;
    process.env.DAST_EXPECTED_SIGNER_KEYSET_SHA256 = digest('unapproved-keyset');
    expectFailure(
      () => validateEvidence(bound, true),
      'PHASE5_DAST_SIGNER_KEYSET_MISMATCH',
    );
  });
  runSignatureSelfTests();
}

function fixture() {
  return fixtureBundle().document;
}

function fixtureBundle() {
  const privateKeys = new Map();
  const signingAuthorities = SIGNOFF_ROLES.map((role) => {
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
  const document = {
    formatVersion: 2,
    suite: 'gaoq.phase5.dast-asvs.v2',
    runId: '01J8ZQK7V0A2M4N6P8R0T2W6A1',
    environment: {
      name: 'security-stage', region: 'cn-test-1', productionEquivalent: true,
      productionTraffic: false, targetOriginHash: hash('target'),
      startedAt: '2026-07-22T00:00:00.000Z', endedAt: '2026-07-22T01:00:00.000Z',
    },
    source: {
      commitSha: 'a'.repeat(40),
      images: {
        api: hash('api'),
        worker: hash('worker'),
        web: hash('web'),
        website: hash('website'),
      },
      zapVersion: '2.17.0', zapImageDigest: ZAP_IMAGE_DIGEST,
      scanHarnessSha256: HARNESS_DIGEST, asvsVersion: '5.0.0',
      asvsCatalogSha256: ASVS_CATALOG_DIGEST,
    },
    controls: {
      catalog: { total: 345, level1: 70, level2: 183, level3: 92 },
      level2Baseline: {
        requirementCount: 253, passedCount: 246, notApplicableCount: 7, failedCount: 0,
        notApplicableEvidenceHash: hash('na'),
      },
      highRiskLevel3: {
        profile: 'all-non-webrtc-level3', requirementCount: 87, passedCount: 87,
        notApplicableCount: 0, failedCount: 0,
      },
      webRtcExclusion: {
        requirementCount: 5, reasonCode: 'FEATURE_NOT_PRESENT', evidenceHash: hash('webrtc'),
      },
      exceptions: [],
    },
    dast: {
      scans: ['unauthenticated', 'authenticated'].map((mode) => ({
        mode, scannerExitCode: 0, activeScanCompleted: true, modernSpiderCompleted: true,
        passiveQueueAtEnd: 0, scannedUrls: 100, requestCount: 10_000,
        alerts: { critical: 0, high: 0, medium: 0, low: 0, informational: 0 },
        rawJsonHash: hash(`${mode}-json`), rawXmlHash: hash(`${mode}-xml`),
        rawHtmlHash: hash(`${mode}-html`),
      })),
      authorizationProbes: {
        authenticatedRequests: 1_000, authenticationFailures: 0, crossTenantDenied: 20,
        idorDenied: 20, scopeDenied: 20, mcpR3ToolCount: 0, auditEvents: 60,
      },
      safety: {
        isolatedTenant: true, sandboxConnectors: true, r3ActionsDisabled: true,
        productionDataUsed: false, externalSideEffects: false,
      },
    },
    artifacts: {
      asvsMatrixHash: hash('matrix'), monitoringSnapshotHash: hash('monitoring'),
      auditQueryHash: hash('audit'), testDataManifestHash: hash('test-data'),
    },
    signingAuthorities,
    signoffs: SIGNOFF_ROLES.map((role, index) => ({
      role,
      actorHash: hash(`actor-${role}`),
      decision: 'approve',
      evidenceId: `01J8ZQK7V0A2M4N6P8R0T2W6B${index}`,
      commentHash: hash(`comment-${role}`),
      approvedAt: `2026-07-22T0${index + 2}:00:00.000Z`,
      signedAt: `2026-07-22T0${index + 3}:00:00.000Z`,
      algorithm: 'Ed25519',
      keyId: authoritiesByRole.get(role)?.keyId,
      signedPayloadSha256: digest('unsigned'),
      signature: 'A'.repeat(86),
    })),
  };
  signFixture(document, privateKeys);
  return Object.freeze({ document, privateKeys });
}

function signFixture(document, privateKeys) {
  const keysetHash = signerKeysetHash(document.signingAuthorities);
  const approvalPayloadHash = digest(dastApprovalPayload(document, keysetHash));
  for (const signoff of document.signoffs) {
    const payload = dastSignoffPayload(approvalPayloadHash, signoff);
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
  expectFailure(() => validateEvidence(missingSignoff), 'PHASE5_DAST_SIGNOFFS_INCOMPLETE');

  const forgedSignature = fixture();
  forgedSignature.signoffs[0].signature =
    `${forgedSignature.signoffs[0].signature[0] === 'A' ? 'B' : 'A'}${
      forgedSignature.signoffs[0].signature.slice(1)
    }`;
  expectFailure(
    () => validateEvidence(forgedSignature),
    'PHASE5_DAST_SIGNOFF_SIGNATURE_INVALID',
  );

  const tamperedAfterSigning = fixture();
  tamperedAfterSigning.artifacts.auditQueryHash = digest('tampered-audit-query');
  expectFailure(
    () => validateEvidence(tamperedAfterSigning),
    'PHASE5_DAST_SIGNOFF_PAYLOAD_MISMATCH',
  );

  const reusedActorBundle = fixtureBundle();
  reusedActorBundle.document.signoffs[1].actorHash =
    reusedActorBundle.document.signoffs[0].actorHash;
  signFixture(reusedActorBundle.document, reusedActorBundle.privateKeys);
  expectFailure(
    () => validateEvidence(reusedActorBundle.document),
    'PHASE5_DAST_SIGNOFF_ACTORS_NOT_INDEPENDENT',
  );

  const reusedEvidenceBundle = fixtureBundle();
  reusedEvidenceBundle.document.signoffs[1].evidenceId =
    reusedEvidenceBundle.document.signoffs[0].evidenceId;
  signFixture(reusedEvidenceBundle.document, reusedEvidenceBundle.privateKeys);
  expectFailure(
    () => validateEvidence(reusedEvidenceBundle.document),
    'PHASE5_DAST_SIGNOFF_EVIDENCE_REUSED',
  );

  const reusedAuthority = fixture();
  reusedAuthority.signingAuthorities[1].keyId =
    reusedAuthority.signingAuthorities[0].keyId;
  reusedAuthority.signingAuthorities[1].publicKeySpkiBase64 =
    reusedAuthority.signingAuthorities[0].publicKeySpkiBase64;
  expectFailure(
    () => validateEvidence(reusedAuthority),
    'PHASE5_DAST_SIGNING_AUTHORITIES_NOT_INDEPENDENT',
  );

  const swappedRoleKey = fixture();
  const firstKeyId = swappedRoleKey.signoffs[0].keyId;
  swappedRoleKey.signoffs[0].keyId = swappedRoleKey.signoffs[1].keyId;
  swappedRoleKey.signoffs[1].keyId = firstKeyId;
  expectFailure(
    () => validateEvidence(swappedRoleKey),
    'PHASE5_DAST_SIGNOFF_KEY_MISMATCH',
  );

  const lateSignatureBundle = fixtureBundle();
  lateSignatureBundle.document.signoffs[0].signedAt = '2026-07-25T01:00:01.000Z';
  signFixture(lateSignatureBundle.document, lateSignatureBundle.privateKeys);
  expectFailure(
    () => validateEvidence(lateSignatureBundle.document),
    'PHASE5_DAST_SIGNOFF_SIGNATURE_TIME_INVALID',
  );
}

function withExpectedEnvironment(document, operation) {
  const variables = {
    DAST_EXPECTED_ENVIRONMENT: document.environment.name,
    DAST_EXPECTED_REGION: document.environment.region,
    DAST_EXPECTED_TARGET_ORIGIN_SHA256: document.environment.targetOriginHash,
    DAST_EXPECTED_COMMIT: document.source.commitSha,
    DAST_EXPECTED_API_IMAGE: document.source.images.api,
    DAST_EXPECTED_WORKER_IMAGE: document.source.images.worker,
    DAST_EXPECTED_WEB_IMAGE: document.source.images.web,
    DAST_EXPECTED_WEBSITE_IMAGE: document.source.images.website,
    DAST_EXPECTED_SIGNER_KEYSET_SHA256: signerKeysetHash(document.signingAuthorities),
  };
  const previous = Object.fromEntries(
    Object.keys(variables).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, variables);
  try {
    operation();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function publicKeyFromSpkiBase64(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
    fail('PHASE5_DAST_SIGNING_AUTHORITY_INVALID');
  }
  const der = Buffer.from(value, 'base64');
  if (
    der.length < 32 ||
    der.length > 256 ||
    der.toString('base64') !== value
  ) fail('PHASE5_DAST_SIGNING_AUTHORITY_INVALID');
  let publicKey;
  try {
    publicKey = createPublicKey({ key: der, format: 'der', type: 'spki' });
  } catch {
    fail('PHASE5_DAST_SIGNING_AUTHORITY_INVALID');
  }
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    fail('PHASE5_DAST_SIGNING_AUTHORITY_INVALID');
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
  const signature = Buffer.from(value, 'base64url');
  if (signature.length !== 64 || signature.toString('base64url') !== value) {
    fail('PHASE5_DAST_SIGNOFF_SIGNATURE_INVALID');
  }
  return signature;
}

function object(value, keys) {
  if (
    typeof value !== 'object' || value === null || Array.isArray(value) ||
    canonical(Object.keys(value).sort()) !== canonical([...keys].sort())
  ) fail('PHASE5_DAST_SCHEMA_INVALID');
}

function exactStringSet(actual, expected, code) {
  if (
    !Array.isArray(actual) ||
    actual.some((item) => typeof item !== 'string') ||
    new Set(actual).size !== expected.length ||
    canonical([...actual].sort()) !== canonical([...expected].sort())
  ) fail(code);
}

function parseDocument(value) {
  try {
    return JSON.parse(value);
  } catch {
    fail('PHASE5_DAST_EVIDENCE_JSON_INVALID');
  }
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

function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    fail('PHASE5_DAST_TIMESTAMP_INVALID');
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail('PHASE5_DAST_TIMESTAMP_INVALID');
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

function expectFailure(operation, code) {
  try {
    operation();
  } catch (error) {
    if (error instanceof Error && error.message === code) return;
    throw error;
  }
  fail('PHASE5_DAST_SELF_TEST_DID_NOT_FAIL');
}

function fail(code) {
  throw new Error(code);
}
