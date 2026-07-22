import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';

const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const SIGNOFF_ROLES = ['appsec_owner', 'platform_owner', 'qa_owner', 'risk_owner'];
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
];
const HARNESS_DIGEST = digest(canonical(Object.fromEntries(await Promise.all(
  HARNESS_FILES.map(async ([name, url]) => [name, await readFile(url, 'utf8')]),
))));

if (process.argv[2] === '--self-test') {
  runSelfTest();
  process.stdout.write('Phase 5 DAST 与 ASVS 证据门禁自测通过。\n');
} else {
  const path = process.argv[2];
  if (path === undefined || process.argv.length !== 3) fail('PHASE5_DAST_EVIDENCE_PATH_REQUIRED');
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size < 2 || metadata.size > 512 * 1_024) {
    fail('PHASE5_DAST_EVIDENCE_FILE_INVALID');
  }
  const summary = validateEvidence(JSON.parse(await readFile(path, 'utf8')));
  process.stdout.write(`${JSON.stringify({
    formatVersion: 1,
    suite: 'gaoq.phase5.dast-asvs.verdict',
    runId: summary.runId,
    commitSha: summary.commitSha,
    evidenceChecksum: digest(canonical(summary)),
  }, null, 2)}\n`);
}

function validateEvidence(document) {
  object(document, [
    'formatVersion', 'suite', 'runId', 'environment', 'source', 'controls', 'dast',
    'artifacts', 'signoffs',
  ]);
  equal(document.formatVersion, 1, 'PHASE5_DAST_FORMAT_INVALID');
  equal(document.suite, 'gaoq.phase5.dast-asvs.v1', 'PHASE5_DAST_SUITE_INVALID');
  pattern(document.runId, ULID, 'PHASE5_DAST_RUN_ID_INVALID');

  object(document.environment, [
    'name', 'region', 'productionEquivalent', 'productionTraffic', 'targetOriginHash',
    'startedAt', 'endedAt',
  ]);
  pattern(document.environment.name, /^[a-z][a-z0-9-]{2,31}$/u, 'PHASE5_DAST_ENV_INVALID');
  if (['prod', 'production'].includes(document.environment.name)) fail('PHASE5_DAST_PROD_FORBIDDEN');
  pattern(document.environment.region, /^[a-z0-9-]{2,32}$/u, 'PHASE5_DAST_REGION_INVALID');
  equal(document.environment.productionEquivalent, true, 'PHASE5_DAST_ENV_NOT_EQUIVALENT');
  equal(document.environment.productionTraffic, false, 'PHASE5_DAST_PROD_FORBIDDEN');
  pattern(document.environment.targetOriginHash, SHA256, 'PHASE5_DAST_TARGET_HASH_INVALID');
  const startedAt = timestamp(document.environment.startedAt);
  const endedAt = timestamp(document.environment.endedAt);
  if (endedAt - startedAt < 10 * 60 * 1_000) fail('PHASE5_DAST_DURATION_INVALID');

  object(document.source, [
    'commitSha', 'images', 'zapVersion', 'zapImageDigest', 'scanHarnessSha256',
    'asvsVersion', 'asvsCatalogSha256',
  ]);
  pattern(document.source.commitSha, COMMIT, 'PHASE5_DAST_COMMIT_INVALID');
  object(document.source.images, ['api', 'worker', 'web']);
  for (const image of Object.values(document.source.images)) {
    pattern(image, SHA256, 'PHASE5_DAST_IMAGE_DIGEST_INVALID');
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

  if (!Array.isArray(document.signoffs) || document.signoffs.length !== 4) {
    fail('PHASE5_DAST_SIGNOFFS_INCOMPLETE');
  }
  const roles = [];
  const evidenceIds = new Set();
  for (const signoff of document.signoffs) {
    object(signoff, ['role', 'evidenceId', 'signedAt']);
    pattern(signoff.evidenceId, ULID, 'PHASE5_DAST_SIGNOFF_EVIDENCE_INVALID');
    if (timestamp(signoff.signedAt) < endedAt) fail('PHASE5_DAST_SIGNOFF_TIME_INVALID');
    roles.push(signoff.role);
    evidenceIds.add(signoff.evidenceId);
  }
  if (
    canonical(roles.sort()) !== canonical([...SIGNOFF_ROLES].sort()) ||
    evidenceIds.size !== 4
  ) fail('PHASE5_DAST_SIGNOFFS_INCOMPLETE');

  return Object.freeze({
    runId: document.runId,
    commitSha: document.source.commitSha,
    images: document.source.images,
    environment: document.environment,
    controls: document.controls,
    dast: document.dast,
    artifacts: document.artifacts,
    signoffEvidenceIds: [...evidenceIds],
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
}

function fixture() {
  const hash = (label) => digest(label);
  return {
    formatVersion: 1,
    suite: 'gaoq.phase5.dast-asvs.v1',
    runId: '01J8ZQK7V0A2M4N6P8R0T2W6A1',
    environment: {
      name: 'security-stage', region: 'cn-test-1', productionEquivalent: true,
      productionTraffic: false, targetOriginHash: hash('target'),
      startedAt: '2026-07-22T00:00:00.000Z', endedAt: '2026-07-22T01:00:00.000Z',
    },
    source: {
      commitSha: 'a'.repeat(40), images: { api: hash('api'), worker: hash('worker'), web: hash('web') },
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
    signoffs: SIGNOFF_ROLES.map((role, index) => ({
      role, evidenceId: `01J8ZQK7V0A2M4N6P8R0T2W6B${index}`,
      signedAt: '2026-07-22T02:00:00.000Z',
    })),
  };
}

function object(value, keys) {
  if (
    typeof value !== 'object' || value === null || Array.isArray(value) ||
    canonical(Object.keys(value).sort()) !== canonical([...keys].sort())
  ) fail('PHASE5_DAST_SCHEMA_INVALID');
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
