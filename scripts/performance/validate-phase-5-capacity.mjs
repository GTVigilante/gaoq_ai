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
const SIGNOFF_ROLES = ['performance_owner', 'platform_owner', 'security_owner'];
const SIGNOFF_SIGNATURE_SUITE = 'gaoq.phase5.capacity.signoff.v1';
const SIGNOFF_WINDOW_MS = 72 * 60 * 60 * 1_000;
const K6_BINARY_SHA256 =
  'sha256:2ae87d976f6cdba17185bdd980d8819a3a98e9092c6f0638cd58272ecefc8b90';
const HARNESS_SOURCE = await readFile(
  new URL('../load/phase-5-api-capacity.js', import.meta.url),
  'utf8',
);
const HARNESS_SHA256 = digest(HARNESS_SOURCE);

const argumentsList = process.argv.slice(2);
if (argumentsList.length === 1 && argumentsList[0] === '--self-test') {
  await validateHarnessSource();
  runSelfTest();
  process.stdout.write('Phase 5 性能容量证据门禁自测通过。\n');
} else if (argumentsList.length === 1 && argumentsList[0] === '--print-contract') {
  process.stdout.write(`${JSON.stringify({
    formatVersion: 2,
    suite: 'gaoq.phase5.capacity.contract',
    evidenceSuite: 'gaoq.phase5.capacity.v2',
    comparisonSuite: 'gaoq.phase5.capacity.comparison',
    signoffRoles: SIGNOFF_ROLES,
    signatureSuite: SIGNOFF_SIGNATURE_SUITE,
    signatureAlgorithm: 'Ed25519',
    signatureEncoding: 'base64url-unpadded',
    publicKeyEncoding: 'base64-spki-der',
    keyId: 'sha256:<lowercase-hex-of-spki-der>',
    signerKeysetCanonicalFields: ['role', 'keyId'],
    signerKeysetOrder: 'role-ascending',
    maximumSignoffAgeHours: 72,
    requiredIndependentRuns: 3,
    k6Version: '2.0.0',
    k6BinarySha256: K6_BINARY_SHA256,
    harnessSha256: HARNESS_SHA256,
  }, null, 2)}\n`);
} else {
  const enforceEnvironment = argumentsList[0] === '--enforce-environment';
  const paths = argumentsList.slice(enforceEnvironment ? 1 : 0);
  if (paths.length !== 3) fail('PHASE5_PERFORMANCE_THREE_RUNS_REQUIRED');
  const documents = await Promise.all(paths.map(async (path) => {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 ||
      metadata.size > 256 * 1_024 || (metadata.mode & 0o022) !== 0) {
      fail('PHASE5_PERFORMANCE_EVIDENCE_FILE_INVALID');
    }
    return parseDocument(await readFile(path, 'utf8'));
  }));
  const summaries = documents.map((document) => validateEvidence(document, enforceEnvironment));
  validateComparable(summaries);
  process.stdout.write(`${JSON.stringify({
    formatVersion: 2,
    suite: 'gaoq.phase5.capacity.comparison',
    runIds: summaries.map((summary) => summary.runId),
    commitSha: summaries[0].commitSha,
    signerKeysetHash: summaries[0].signerKeysetHash,
    approvalPayloadHashes: summaries.map((summary) => summary.approvalPayloadHash),
    comparisonChecksum: digest(canonical(summaries)),
  }, null, 2)}\n`);
}

async function validateHarnessSource() {
  const workflow = await readFile(
    new URL('../../.github/workflows/phase-5-security.yml', import.meta.url),
    'utf8',
  );
  for (const marker of [
    "executor: 'ramping-vus'",
    "{ duration: '20m', target: 1_000 }",
    "business_errors: ['rate<=0.001']",
    "core_api_duration: ['p(95)<500', 'p(99)<1000']",
    "dashboard_duration: ['p(95)<=2000', 'p(99)<=5000']",
    'document.length < 1_000',
    "if (inspectOnly) fail('PERFORMANCE_INSPECT_MODE_CANNOT_RUN')",
    "const corePaths = ['/api/org/chart', '/api/approvals/instances/inbox']",
    'value.length > 264',
  ]) {
    if (!HARNESS_SOURCE.includes(marker)) fail('PHASE5_PERFORMANCE_HARNESS_INCOMPLETE');
  }
  if (/http\.(?:post|put|patch|del)\(/u.test(HARNESS_SOURCE)) {
    fail('PHASE5_PERFORMANCE_WRITE_REQUEST_FORBIDDEN');
  }
  if (HARNESS_SOURCE.includes('new URL(')) fail('PHASE5_PERFORMANCE_K6_API_INCOMPATIBLE');
  for (const marker of [
    'performance-contract:',
    'grafana/k6/releases/download/v2.0.0/k6-v2.0.0-linux-amd64.tar.gz',
    '2ae87d976f6cdba17185bdd980d8819a3a98e9092c6f0638cd58272ecefc8b90',
    '--env PERFORMANCE_INSPECT_ONLY=true',
    '--env PERFORMANCE_BASE_URL=https://erp.example.invalid',
    '--env PERFORMANCE_AS_OF=2026-07-01',
    '--env PERFORMANCE_API_RESULT_PATH=/tmp/phase-5-k6-inspect.json',
    'node scripts/performance/validate-phase-5-capacity.mjs --self-test',
  ]) {
    if (!workflow.includes(marker)) fail('PHASE5_PERFORMANCE_CI_GATE_INCOMPLETE');
  }
  if (workflow.includes('--include-system-env-vars')) {
    fail('PHASE5_PERFORMANCE_CI_ENV_EXPOSURE_FORBIDDEN');
  }
}

function validateEvidence(document, enforceEnvironment = false) {
  object(document, [
    'formatVersion', 'suite', 'runId', 'environment', 'source', 'images', 'dataset',
    'api', 'payroll', 'infrastructure', 'artifacts', 'signingAuthorities', 'signoffs',
  ]);
  equal(document.formatVersion, 2, 'PHASE5_PERFORMANCE_FORMAT_INVALID');
  equal(document.suite, 'gaoq.phase5.capacity.v2', 'PHASE5_PERFORMANCE_SUITE_INVALID');
  pattern(document.runId, ULID, 'PHASE5_PERFORMANCE_RUN_ID_INVALID');
  const authorities = validateSigningAuthorities(document.signingAuthorities);

  object(document.environment, [
    'name', 'region', 'productionEquivalent', 'productionTraffic', 'startedAt', 'endedAt',
  ]);
  pattern(document.environment.name, ENVIRONMENT_NAME, 'PHASE5_PERFORMANCE_ENV_INVALID');
  if (/(?:^|-)prod(?:-|$)|production/u.test(document.environment.name)) {
    fail('PHASE5_PERFORMANCE_PROD_FORBIDDEN');
  }
  if (!/(?:^|-)(?:capacity|load|performance|stage|staging|preprod|uat)(?:-|$)/u
    .test(document.environment.name)) fail('PHASE5_PERFORMANCE_ENV_INVALID');
  pattern(document.environment.region, REGION, 'PHASE5_PERFORMANCE_REGION_INVALID');
  equal(document.environment.productionEquivalent, true, 'PHASE5_PERFORMANCE_ENV_NOT_EQUIVALENT');
  equal(document.environment.productionTraffic, false, 'PHASE5_PERFORMANCE_PROD_TRAFFIC_FORBIDDEN');
  const startedAt = timestamp(document.environment.startedAt);
  const endedAt = timestamp(document.environment.endedAt);
  if (endedAt <= startedAt) fail('PHASE5_PERFORMANCE_TIME_INVALID');

  object(document.source, [
    'commitSha', 'k6Version', 'k6BinarySha256', 'harnessSha256', 'deploymentManifestHash',
  ]);
  pattern(document.source.commitSha, COMMIT, 'PHASE5_PERFORMANCE_COMMIT_INVALID');
  equal(document.source.k6Version, '2.0.0', 'PHASE5_PERFORMANCE_K6_VERSION_INVALID');
  equal(document.source.k6BinarySha256, K6_BINARY_SHA256, 'PHASE5_PERFORMANCE_K6_DIGEST_INVALID');
  equal(document.source.harnessSha256, HARNESS_SHA256, 'PHASE5_PERFORMANCE_HARNESS_DIGEST_INVALID');
  pattern(
    document.source.deploymentManifestHash,
    SHA256,
    'PHASE5_PERFORMANCE_DEPLOYMENT_MANIFEST_INVALID',
  );

  object(document.images, ['api', 'worker', 'web', 'website']);
  for (const value of Object.values(document.images)) {
    pattern(value, SHA256, 'PHASE5_PERFORMANCE_IMAGE_DIGEST_INVALID');
  }
  if (new Set(Object.values(document.images)).size !== 4) {
    fail('PHASE5_PERFORMANCE_IMAGES_NOT_INDEPENDENT');
  }
  if (enforceEnvironment) validateExpectedEnvironment(document);
  if (enforceEnvironment) {
    pattern(
      process.env.PERFORMANCE_EXPECTED_SIGNER_KEYSET_SHA256,
      SHA256,
      'PHASE5_PERFORMANCE_EXPECTED_SIGNER_KEYSET_REQUIRED',
    );
    equal(
      authorities.keysetHash,
      process.env.PERFORMANCE_EXPECTED_SIGNER_KEYSET_SHA256,
      'PHASE5_PERFORMANCE_SIGNER_KEYSET_MISMATCH',
    );
  }
  object(document.dataset, ['fingerprint', 'employeeCount']);
  pattern(document.dataset.fingerprint, SHA256, 'PHASE5_PERFORMANCE_DATASET_INVALID');
  equal(document.dataset.employeeCount, 1_000, 'PHASE5_PERFORMANCE_DATASET_SIZE_INVALID');

  object(document.api, [
    'maxVus', 'durationSeconds', 'requestCount', 'errorRate', 'coreP95Ms', 'coreP99Ms',
    'dashboardP95Ms', 'dashboardP99Ms', 'thresholdsPassed',
  ]);
  equal(document.api.maxVus, 1_000, 'PHASE5_PERFORMANCE_VUS_INVALID');
  equal(document.api.durationSeconds, 1_800, 'PHASE5_PERFORMANCE_DURATION_INVALID');
  integer(document.api.requestCount, 1_000, Number.MAX_SAFE_INTEGER, 'PHASE5_PERFORMANCE_REQUESTS_INVALID');
  if (document.api.requestCount < document.api.maxVus * document.api.durationSeconds / 3) {
    fail('PHASE5_PERFORMANCE_REQUEST_VOLUME_INVALID');
  }
  if (endedAt - startedAt < document.api.durationSeconds * 1_000) {
    fail('PHASE5_PERFORMANCE_TIME_INVALID');
  }
  number(document.api.errorRate, 0, 0.001, 'PHASE5_PERFORMANCE_ERROR_RATE_FAILED');
  lessThan(document.api.coreP95Ms, 500, 'PHASE5_PERFORMANCE_CORE_P95_FAILED');
  lessThan(document.api.coreP99Ms, 1_000, 'PHASE5_PERFORMANCE_CORE_P99_FAILED');
  number(document.api.dashboardP95Ms, 0, 2_000, 'PHASE5_PERFORMANCE_DASHBOARD_P95_FAILED');
  number(document.api.dashboardP99Ms, 0, 5_000, 'PHASE5_PERFORMANCE_DASHBOARD_P99_FAILED');
  equal(document.api.thresholdsPassed, true, 'PHASE5_PERFORMANCE_K6_THRESHOLDS_FAILED');

  object(document.payroll, [
    'employeeCount', 'durationMs', 'status', 'errorCount', 'resultHash', 'evidenceHash',
    'externalSideEffects',
  ]);
  equal(document.payroll.employeeCount, 1_000, 'PHASE5_PERFORMANCE_PAYROLL_SIZE_INVALID');
  integer(document.payroll.durationMs, 1, 299_999, 'PHASE5_PERFORMANCE_PAYROLL_DURATION_FAILED');
  equal(document.payroll.status, 'completed', 'PHASE5_PERFORMANCE_PAYROLL_STATUS_FAILED');
  equal(document.payroll.errorCount, 0, 'PHASE5_PERFORMANCE_PAYROLL_ERRORS_FAILED');
  pattern(document.payroll.resultHash, SHA256, 'PHASE5_PERFORMANCE_PAYROLL_RESULT_INVALID');
  pattern(document.payroll.evidenceHash, SHA256, 'PHASE5_PERFORMANCE_PAYROLL_EVIDENCE_INVALID');
  equal(document.payroll.externalSideEffects, false, 'PHASE5_PERFORMANCE_EXTERNAL_EFFECT_FORBIDDEN');

  object(document.infrastructure, [
    'mongoReplicaSetMembers', 'redisTopology', 'apiReplicas', 'workerReplicas',
  ]);
  integer(document.infrastructure.mongoReplicaSetMembers, 3, 20, 'PHASE5_PERFORMANCE_MONGO_HA_REQUIRED');
  if (!['sentinel', 'cluster'].includes(document.infrastructure.redisTopology)) {
    fail('PHASE5_PERFORMANCE_REDIS_HA_REQUIRED');
  }
  integer(document.infrastructure.apiReplicas, 3, 100, 'PHASE5_PERFORMANCE_API_REPLICAS_INVALID');
  integer(document.infrastructure.workerReplicas, 2, 100, 'PHASE5_PERFORMANCE_WORKER_REPLICAS_INVALID');

  object(document.artifacts, ['rawLoadResultHash', 'monitoringSnapshotHash', 'logQueryHash']);
  for (const value of Object.values(document.artifacts)) {
    pattern(value, SHA256, 'PHASE5_PERFORMANCE_ARTIFACT_INVALID');
  }
  const artifactHashes = new Set([
    ...Object.values(document.artifacts),
    document.dataset.fingerprint,
    document.payroll.resultHash,
    document.payroll.evidenceHash,
  ]);
  if (
    artifactHashes.size !== 6
  ) fail('PHASE5_PERFORMANCE_ARTIFACT_REUSED');

  validateSignoffMetadata(document.signoffs, endedAt);
  const approvalPayloadHash = digest(capacityApprovalPayload(
    document,
    authorities.keysetHash,
  ));
  const signoffSummary = validateSignoffSignatures(
    document.signoffs,
    authorities.byRole,
    approvalPayloadHash,
    endedAt,
  );

  return Object.freeze({
    runId: document.runId,
    commitSha: document.source.commitSha,
    k6BinarySha256: document.source.k6BinarySha256,
    harnessSha256: document.source.harnessSha256,
    deploymentManifestHash: document.source.deploymentManifestHash,
    images: document.images,
    dataset: document.dataset,
    environmentName: document.environment.name,
    region: document.environment.region,
    infrastructure: document.infrastructure,
    api: document.api,
    payroll: document.payroll,
    artifacts: document.artifacts,
    signoffEvidenceIds: signoffSummary.evidenceIds,
    signoffCommentHashes: signoffSummary.commentHashes,
    signoffSignatures: signoffSummary.signatures,
    signoffActors: signoffSummary.actors,
    signerKeysetHash: authorities.keysetHash,
    approvalPayloadHash,
  });
}

function validateSigningAuthorities(authorities) {
  if (!Array.isArray(authorities) || authorities.length !== SIGNOFF_ROLES.length) {
    fail('PHASE5_PERFORMANCE_SIGNING_AUTHORITIES_INCOMPLETE');
  }
  const roles = [];
  const keyIds = new Set();
  const byRole = new Map();
  const keyset = [];
  for (const authority of authorities) {
    object(authority, ['role', 'algorithm', 'keyId', 'publicKeySpkiBase64']);
    if (!SIGNOFF_ROLES.includes(authority.role)) {
      fail('PHASE5_PERFORMANCE_SIGNING_AUTHORITY_INVALID');
    }
    equal(authority.algorithm, 'Ed25519', 'PHASE5_PERFORMANCE_SIGNING_AUTHORITY_INVALID');
    pattern(authority.keyId, SHA256, 'PHASE5_PERFORMANCE_SIGNING_AUTHORITY_INVALID');
    const publicKey = publicKeyFromSpkiBase64(authority.publicKeySpkiBase64);
    equal(
      authority.keyId,
      publicKeyHash(publicKey),
      'PHASE5_PERFORMANCE_SIGNING_AUTHORITY_KEY_MISMATCH',
    );
    roles.push(authority.role);
    keyIds.add(authority.keyId);
    byRole.set(authority.role, Object.freeze({ keyId: authority.keyId, publicKey }));
    keyset.push(Object.freeze({ role: authority.role, keyId: authority.keyId }));
  }
  exactStringSet(
    roles,
    SIGNOFF_ROLES,
    'PHASE5_PERFORMANCE_SIGNING_AUTHORITIES_INCOMPLETE',
  );
  if (keyIds.size !== SIGNOFF_ROLES.length || byRole.size !== SIGNOFF_ROLES.length) {
    fail('PHASE5_PERFORMANCE_SIGNING_AUTHORITIES_NOT_INDEPENDENT');
  }
  return Object.freeze({ byRole, keysetHash: signerKeysetHash(keyset) });
}

function validateSignoffMetadata(signoffs, endedAt) {
  if (!Array.isArray(signoffs) || signoffs.length !== SIGNOFF_ROLES.length) {
    fail('PHASE5_PERFORMANCE_SIGNOFFS_INCOMPLETE');
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
    if (!SIGNOFF_ROLES.includes(signoff.role)) {
      fail('PHASE5_PERFORMANCE_SIGNOFF_INVALID');
    }
    pattern(signoff.actorHash, SHA256, 'PHASE5_PERFORMANCE_SIGNOFF_ACTOR_INVALID');
    equal(signoff.decision, 'approve', 'PHASE5_PERFORMANCE_SIGNOFF_REJECTED');
    pattern(signoff.evidenceId, ULID, 'PHASE5_PERFORMANCE_SIGNOFF_EVIDENCE_INVALID');
    pattern(signoff.commentHash, SHA256, 'PHASE5_PERFORMANCE_SIGNOFF_COMMENT_INVALID');
    const approvedAt = timestamp(signoff.approvedAt);
    if (approvedAt < endedAt || approvedAt - endedAt > SIGNOFF_WINDOW_MS) {
      fail('PHASE5_PERFORMANCE_SIGNOFF_TIME_INVALID');
    }
    roles.push(signoff.role);
    actorHashes.add(signoff.actorHash);
    evidenceIds.add(signoff.evidenceId);
    commentHashes.add(signoff.commentHash);
  }
  exactStringSet(roles, SIGNOFF_ROLES, 'PHASE5_PERFORMANCE_SIGNOFF_ROLES_INVALID');
  if (actorHashes.size !== SIGNOFF_ROLES.length) {
    fail('PHASE5_PERFORMANCE_SIGNOFF_ACTORS_NOT_INDEPENDENT');
  }
  if (
    evidenceIds.size !== SIGNOFF_ROLES.length ||
    commentHashes.size !== SIGNOFF_ROLES.length
  ) fail('PHASE5_PERFORMANCE_SIGNOFF_EVIDENCE_REUSED');
}

function validateSignoffSignatures(signoffs, authorities, approvalPayloadHash, endedAt) {
  const signatures = new Set();
  const evidenceIds = [];
  const commentHashes = [];
  const actors = {};
  for (const signoff of signoffs) {
    equal(signoff.algorithm, 'Ed25519', 'PHASE5_PERFORMANCE_SIGNOFF_PROOF_INVALID');
    pattern(signoff.keyId, SHA256, 'PHASE5_PERFORMANCE_SIGNOFF_PROOF_INVALID');
    pattern(
      signoff.signedPayloadSha256,
      SHA256,
      'PHASE5_PERFORMANCE_SIGNOFF_PROOF_INVALID',
    );
    pattern(signoff.signature, SIGNATURE, 'PHASE5_PERFORMANCE_SIGNOFF_PROOF_INVALID');
    const approvedAt = timestamp(signoff.approvedAt);
    const signedAt = timestamp(signoff.signedAt);
    if (signedAt < approvedAt || signedAt - endedAt > SIGNOFF_WINDOW_MS) {
      fail('PHASE5_PERFORMANCE_SIGNOFF_SIGNATURE_TIME_INVALID');
    }
    const authority = authorities.get(signoff.role);
    if (authority === undefined) fail('PHASE5_PERFORMANCE_SIGNOFF_AUTHORITY_INVALID');
    equal(signoff.keyId, authority.keyId, 'PHASE5_PERFORMANCE_SIGNOFF_KEY_MISMATCH');
    const payload = capacitySignoffPayload(approvalPayloadHash, signoff);
    equal(
      signoff.signedPayloadSha256,
      digest(payload),
      'PHASE5_PERFORMANCE_SIGNOFF_PAYLOAD_MISMATCH',
    );
    const signature = decodeSignature(signoff.signature);
    if (!verify(null, Buffer.from(payload, 'utf8'), authority.publicKey, signature)) {
      fail('PHASE5_PERFORMANCE_SIGNOFF_SIGNATURE_INVALID');
    }
    signatures.add(signoff.signature);
    evidenceIds.push(signoff.evidenceId);
    commentHashes.push(signoff.commentHash);
    actors[signoff.role] = signoff.actorHash;
  }
  if (signatures.size !== SIGNOFF_ROLES.length) {
    fail('PHASE5_PERFORMANCE_SIGNOFF_PROOF_REUSED');
  }
  return Object.freeze({
    evidenceIds,
    commentHashes,
    signatures: [...signatures],
    actors: Object.freeze(actors),
  });
}

function capacityApprovalPayload(document, signerKeysetHashValue) {
  return canonical({
    formatVersion: document.formatVersion,
    suite: document.suite,
    runId: document.runId,
    environment: document.environment,
    source: document.source,
    images: document.images,
    dataset: document.dataset,
    api: document.api,
    payroll: document.payroll,
    infrastructure: document.infrastructure,
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

function capacitySignoffPayload(approvalPayloadHash, signoff) {
  return canonical({
    suite: SIGNOFF_SIGNATURE_SUITE,
    approvalPayloadHash,
    role: signoff.role,
    keyId: signoff.keyId,
    signedAt: signoff.signedAt,
  });
}

function validateComparable(summaries) {
  const runIds = new Set(summaries.map((summary) => summary.runId));
  const rawArtifacts = new Set(summaries.map((summary) => summary.artifacts.rawLoadResultHash));
  const monitoringArtifacts = new Set(
    summaries.map((summary) => summary.artifacts.monitoringSnapshotHash),
  );
  const logArtifacts = new Set(summaries.map((summary) => summary.artifacts.logQueryHash));
  const payrollEvidence = new Set(summaries.map((summary) => summary.payroll.evidenceHash));
  const signoffEvidenceIds = new Set(summaries.flatMap((summary) => summary.signoffEvidenceIds));
  const signoffCommentHashes = new Set(
    summaries.flatMap((summary) => summary.signoffCommentHashes),
  );
  const signoffSignatures = new Set(
    summaries.flatMap((summary) => summary.signoffSignatures),
  );
  const approvalPayloadHashes = new Set(
    summaries.map((summary) => summary.approvalPayloadHash),
  );
  if (
    runIds.size !== 3 || rawArtifacts.size !== 3 || monitoringArtifacts.size !== 3 ||
    logArtifacts.size !== 3 || payrollEvidence.size !== 3 || signoffEvidenceIds.size !== 9 ||
    signoffCommentHashes.size !== 9 || signoffSignatures.size !== 9 ||
    approvalPayloadHashes.size !== 3
  ) {
    fail('PHASE5_PERFORMANCE_RUNS_NOT_INDEPENDENT');
  }
  const comparable = summaries.map((summary) => canonical({
    commitSha: summary.commitSha,
    k6BinarySha256: summary.k6BinarySha256,
    harnessSha256: summary.harnessSha256,
    deploymentManifestHash: summary.deploymentManifestHash,
    images: summary.images,
    dataset: summary.dataset,
    environmentName: summary.environmentName,
    region: summary.region,
    infrastructure: summary.infrastructure,
    payrollResultHash: summary.payroll.resultHash,
    signoffActors: summary.signoffActors,
    signerKeysetHash: summary.signerKeysetHash,
  }));
  if (new Set(comparable).size !== 1) fail('PHASE5_PERFORMANCE_RUNS_NOT_COMPARABLE');
}

function runSelfTest() {
  const runs = fixtureSet().map((document) => validateEvidence(document));
  validateComparable(runs);
  const slow = fixture(1);
  slow.api.coreP95Ms = 500;
  expectFailure(() => validateEvidence(slow), 'PHASE5_PERFORMANCE_CORE_P95_FAILED');
  const unsafe = fixture(1);
  unsafe.payroll.externalSideEffects = true;
  expectFailure(() => validateEvidence(unsafe), 'PHASE5_PERFORMANCE_EXTERNAL_EFFECT_FORBIDDEN');
  const forgedHarness = fixture(1);
  forgedHarness.source.harnessSha256 = digest('forged-harness');
  expectFailure(
    () => validateEvidence(forgedHarness),
    'PHASE5_PERFORMANCE_HARNESS_DIGEST_INVALID',
  );
  const reusedMonitoringKeys = createSigningKeyMaterial();
  const reusedMonitoringBundles = [1, 2, 3].map(
    (sequence) => fixtureBundle(sequence, reusedMonitoringKeys),
  );
  const reusedMonitoring = reusedMonitoringBundles.map((bundle) => bundle.document);
  reusedMonitoring[1].artifacts.monitoringSnapshotHash =
    reusedMonitoring[0].artifacts.monitoringSnapshotHash;
  signFixture(reusedMonitoring[1], reusedMonitoringKeys.privateKeys);
  expectFailure(
    () => validateComparable(reusedMonitoring.map((run) => validateEvidence(run))),
    'PHASE5_PERFORMANCE_RUNS_NOT_INDEPENDENT',
  );
  const productionNamed = fixture(1);
  productionNamed.environment.name = 'prod-capacity';
  expectFailure(
    () => validateEvidence(productionNamed),
    'PHASE5_PERFORMANCE_PROD_FORBIDDEN',
  );
  const bound = fixture(1);
  withExpectedEnvironment(bound, () => {
    validateEvidence(bound, true);
    bound.source.commitSha = 'b'.repeat(40);
    expectFailure(
      () => validateEvidence(bound, true),
      'PHASE5_PERFORMANCE_COMMIT_MISMATCH',
    );
    bound.source.commitSha = 'a'.repeat(40);
    process.env.PERFORMANCE_EXPECTED_SIGNER_KEYSET_SHA256 = digest('unapproved-keyset');
    expectFailure(
      () => validateEvidence(bound, true),
      'PHASE5_PERFORMANCE_SIGNER_KEYSET_MISMATCH',
    );
  });
  runSignatureSelfTests();
}

function fixture(sequence) {
  return fixtureBundle(sequence).document;
}

function fixtureSet() {
  const keyMaterial = createSigningKeyMaterial();
  return [1, 2, 3].map((sequence) => fixtureBundle(sequence, keyMaterial).document);
}

function createSigningKeyMaterial() {
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
  return Object.freeze({ privateKeys, signingAuthorities });
}

function fixtureBundle(sequence, keyMaterial = createSigningKeyMaterial()) {
  const hash = (label) => digest(`${label}-${sequence}`);
  const authoritiesByRole = new Map(
    keyMaterial.signingAuthorities.map((authority) => [authority.role, authority]),
  );
  const document = {
    formatVersion: 2,
    suite: 'gaoq.phase5.capacity.v2',
    runId: `01J8ZQK7V0A2M4N6P8R0T2W4Y${sequence}`,
    environment: {
      name: 'capacity-stage', region: 'cn-test-1', productionEquivalent: true,
      productionTraffic: false, startedAt: `2026-07-2${sequence}T00:00:00.000Z`,
      endedAt: `2026-07-2${sequence}T00:40:00.000Z`,
    },
    source: {
      commitSha: 'a'.repeat(40), k6Version: '2.0.0', k6BinarySha256: K6_BINARY_SHA256,
      harnessSha256: HARNESS_SHA256, deploymentManifestHash: digest('deployment-manifest'),
    },
    images: {
      api: digest('api'),
      worker: digest('worker'),
      web: digest('web'),
      website: digest('website'),
    },
    dataset: { fingerprint: digest('dataset'), employeeCount: 1_000 },
    api: {
      maxVus: 1_000, durationSeconds: 1_800, requestCount: 1_000_000, errorRate: 0.0001,
      coreP95Ms: 300, coreP99Ms: 700, dashboardP95Ms: 1_500, dashboardP99Ms: 4_000,
      thresholdsPassed: true,
    },
    payroll: {
      employeeCount: 1_000, durationMs: 240_000, status: 'completed', errorCount: 0,
      resultHash: digest('payroll-result'), evidenceHash: hash('payroll-evidence'),
      externalSideEffects: false,
    },
    infrastructure: {
      mongoReplicaSetMembers: 3, redisTopology: 'sentinel', apiReplicas: 3, workerReplicas: 2,
    },
    artifacts: {
      rawLoadResultHash: hash('raw-load'), monitoringSnapshotHash: hash('monitoring'),
      logQueryHash: hash('logs'),
    },
    signingAuthorities: keyMaterial.signingAuthorities.map((authority) => ({ ...authority })),
    signoffs: SIGNOFF_ROLES.map((role, index) => ({
      role,
      actorHash: digest(`actor-${role}`),
      decision: 'approve',
      evidenceId: `01J8ZQK7V0A2M4N6P8R0T2W5${sequence}${index}`,
      commentHash: hash(`comment-${role}`),
      approvedAt: `2026-07-2${sequence}T0${index + 1}:00:00.000Z`,
      signedAt: `2026-07-2${sequence}T0${index + 1}:10:00.000Z`,
      algorithm: 'Ed25519',
      keyId: authoritiesByRole.get(role)?.keyId,
      signedPayloadSha256: digest('unsigned'),
      signature: 'A'.repeat(86),
    })),
  };
  signFixture(document, keyMaterial.privateKeys);
  return Object.freeze({ document, privateKeys: keyMaterial.privateKeys });
}

function signFixture(document, privateKeys) {
  const keysetHash = signerKeysetHash(document.signingAuthorities);
  const approvalPayloadHash = digest(capacityApprovalPayload(document, keysetHash));
  for (const signoff of document.signoffs) {
    const payload = capacitySignoffPayload(approvalPayloadHash, signoff);
    signoff.signedPayloadSha256 = digest(payload);
    signoff.signature = sign(
      null,
      Buffer.from(payload, 'utf8'),
      privateKeys.get(signoff.role),
    ).toString('base64url');
  }
}

function runSignatureSelfTests() {
  const missingSignoff = fixture(1);
  missingSignoff.signoffs.pop();
  expectFailure(
    () => validateEvidence(missingSignoff),
    'PHASE5_PERFORMANCE_SIGNOFFS_INCOMPLETE',
  );

  const forgedSignature = fixture(1);
  forgedSignature.signoffs[0].signature =
    `${forgedSignature.signoffs[0].signature[0] === 'A' ? 'B' : 'A'}${
      forgedSignature.signoffs[0].signature.slice(1)
    }`;
  expectFailure(
    () => validateEvidence(forgedSignature),
    'PHASE5_PERFORMANCE_SIGNOFF_SIGNATURE_INVALID',
  );

  const tamperedAfterSigning = fixture(1);
  tamperedAfterSigning.api.coreP95Ms = 301;
  expectFailure(
    () => validateEvidence(tamperedAfterSigning),
    'PHASE5_PERFORMANCE_SIGNOFF_PAYLOAD_MISMATCH',
  );

  const reusedActorBundle = fixtureBundle(1);
  reusedActorBundle.document.signoffs[1].actorHash =
    reusedActorBundle.document.signoffs[0].actorHash;
  signFixture(reusedActorBundle.document, reusedActorBundle.privateKeys);
  expectFailure(
    () => validateEvidence(reusedActorBundle.document),
    'PHASE5_PERFORMANCE_SIGNOFF_ACTORS_NOT_INDEPENDENT',
  );

  const reusedEvidenceBundle = fixtureBundle(1);
  reusedEvidenceBundle.document.signoffs[1].evidenceId =
    reusedEvidenceBundle.document.signoffs[0].evidenceId;
  signFixture(reusedEvidenceBundle.document, reusedEvidenceBundle.privateKeys);
  expectFailure(
    () => validateEvidence(reusedEvidenceBundle.document),
    'PHASE5_PERFORMANCE_SIGNOFF_EVIDENCE_REUSED',
  );

  const reusedCommentBundle = fixtureBundle(1);
  reusedCommentBundle.document.signoffs[1].commentHash =
    reusedCommentBundle.document.signoffs[0].commentHash;
  signFixture(reusedCommentBundle.document, reusedCommentBundle.privateKeys);
  expectFailure(
    () => validateEvidence(reusedCommentBundle.document),
    'PHASE5_PERFORMANCE_SIGNOFF_EVIDENCE_REUSED',
  );

  const reusedAuthority = fixture(1);
  reusedAuthority.signingAuthorities[1].keyId =
    reusedAuthority.signingAuthorities[0].keyId;
  reusedAuthority.signingAuthorities[1].publicKeySpkiBase64 =
    reusedAuthority.signingAuthorities[0].publicKeySpkiBase64;
  expectFailure(
    () => validateEvidence(reusedAuthority),
    'PHASE5_PERFORMANCE_SIGNING_AUTHORITIES_NOT_INDEPENDENT',
  );

  const swappedRoleKey = fixture(1);
  const firstKeyId = swappedRoleKey.signoffs[0].keyId;
  swappedRoleKey.signoffs[0].keyId = swappedRoleKey.signoffs[1].keyId;
  swappedRoleKey.signoffs[1].keyId = firstKeyId;
  expectFailure(
    () => validateEvidence(swappedRoleKey),
    'PHASE5_PERFORMANCE_SIGNOFF_KEY_MISMATCH',
  );

  const lateSignatureBundle = fixtureBundle(1);
  lateSignatureBundle.document.signoffs[0].signedAt = '2026-07-24T00:40:01.000Z';
  signFixture(lateSignatureBundle.document, lateSignatureBundle.privateKeys);
  expectFailure(
    () => validateEvidence(lateSignatureBundle.document),
    'PHASE5_PERFORMANCE_SIGNOFF_SIGNATURE_TIME_INVALID',
  );

  const signerDrift = fixtureSet();
  signerDrift[1] = fixture(2);
  expectFailure(
    () => validateComparable(signerDrift.map((document) => validateEvidence(document))),
    'PHASE5_PERFORMANCE_RUNS_NOT_COMPARABLE',
  );

  const actorDriftKeys = createSigningKeyMaterial();
  const actorDriftBundles = [1, 2, 3].map(
    (sequence) => fixtureBundle(sequence, actorDriftKeys),
  );
  actorDriftBundles[1].document.signoffs[0].actorHash = digest('replacement-actor');
  signFixture(actorDriftBundles[1].document, actorDriftKeys.privateKeys);
  expectFailure(
    () => validateComparable(
      actorDriftBundles.map((bundle) => validateEvidence(bundle.document)),
    ),
    'PHASE5_PERFORMANCE_RUNS_NOT_COMPARABLE',
  );
}

function validateExpectedEnvironment(document) {
  const expected = {
    environment: process.env.PERFORMANCE_EXPECTED_ENVIRONMENT,
    region: process.env.PERFORMANCE_EXPECTED_REGION,
    commitSha: process.env.PERFORMANCE_EXPECTED_COMMIT,
    api: process.env.PERFORMANCE_EXPECTED_API_IMAGE,
    worker: process.env.PERFORMANCE_EXPECTED_WORKER_IMAGE,
    web: process.env.PERFORMANCE_EXPECTED_WEB_IMAGE,
    website: process.env.PERFORMANCE_EXPECTED_WEBSITE_IMAGE,
    deploymentManifestHash: process.env.PERFORMANCE_EXPECTED_DEPLOYMENT_MANIFEST,
    signerKeysetHash: process.env.PERFORMANCE_EXPECTED_SIGNER_KEYSET_SHA256,
  };
  pattern(expected.environment, ENVIRONMENT_NAME, 'PHASE5_PERFORMANCE_EXPECTED_ENV_REQUIRED');
  pattern(expected.region, REGION, 'PHASE5_PERFORMANCE_EXPECTED_ENV_REQUIRED');
  pattern(expected.commitSha, COMMIT, 'PHASE5_PERFORMANCE_EXPECTED_SOURCE_REQUIRED');
  for (const field of ['api', 'worker', 'web', 'website', 'deploymentManifestHash']) {
    pattern(expected[field], SHA256, 'PHASE5_PERFORMANCE_EXPECTED_SOURCE_REQUIRED');
  }
  pattern(
    expected.signerKeysetHash,
    SHA256,
    'PHASE5_PERFORMANCE_EXPECTED_SIGNER_KEYSET_REQUIRED',
  );
  equal(
    document.environment.name,
    expected.environment,
    'PHASE5_PERFORMANCE_ENVIRONMENT_MISMATCH',
  );
  equal(document.environment.region, expected.region, 'PHASE5_PERFORMANCE_REGION_MISMATCH');
  equal(document.source.commitSha, expected.commitSha, 'PHASE5_PERFORMANCE_COMMIT_MISMATCH');
  equal(document.images.api, expected.api, 'PHASE5_PERFORMANCE_IMAGE_MISMATCH');
  equal(document.images.worker, expected.worker, 'PHASE5_PERFORMANCE_IMAGE_MISMATCH');
  equal(document.images.web, expected.web, 'PHASE5_PERFORMANCE_IMAGE_MISMATCH');
  equal(document.images.website, expected.website, 'PHASE5_PERFORMANCE_IMAGE_MISMATCH');
  equal(
    document.source.deploymentManifestHash,
    expected.deploymentManifestHash,
    'PHASE5_PERFORMANCE_DEPLOYMENT_MANIFEST_MISMATCH',
  );
}

function withExpectedEnvironment(document, action) {
  const values = {
    PERFORMANCE_EXPECTED_ENVIRONMENT: document.environment.name,
    PERFORMANCE_EXPECTED_REGION: document.environment.region,
    PERFORMANCE_EXPECTED_COMMIT: document.source.commitSha,
    PERFORMANCE_EXPECTED_API_IMAGE: document.images.api,
    PERFORMANCE_EXPECTED_WORKER_IMAGE: document.images.worker,
    PERFORMANCE_EXPECTED_WEB_IMAGE: document.images.web,
    PERFORMANCE_EXPECTED_WEBSITE_IMAGE: document.images.website,
    PERFORMANCE_EXPECTED_DEPLOYMENT_MANIFEST: document.source.deploymentManifestHash,
    PERFORMANCE_EXPECTED_SIGNER_KEYSET_SHA256:
      signerKeysetHash(document.signingAuthorities),
  };
  const previous = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
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

function object(value, keys) {
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
    canonical(Object.keys(value).sort()) !== canonical([...keys].sort())) {
    fail('PHASE5_PERFORMANCE_SCHEMA_INVALID');
  }
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
    fail('PHASE5_PERFORMANCE_EVIDENCE_JSON_INVALID');
  }
}

function publicKeyFromSpkiBase64(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
    fail('PHASE5_PERFORMANCE_SIGNING_AUTHORITY_INVALID');
  }
  const der = Buffer.from(value, 'base64');
  if (
    der.length < 32 ||
    der.length > 256 ||
    der.toString('base64') !== value
  ) fail('PHASE5_PERFORMANCE_SIGNING_AUTHORITY_INVALID');
  let publicKey;
  try {
    publicKey = createPublicKey({ key: der, format: 'der', type: 'spki' });
  } catch {
    fail('PHASE5_PERFORMANCE_SIGNING_AUTHORITY_INVALID');
  }
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    fail('PHASE5_PERFORMANCE_SIGNING_AUTHORITY_INVALID');
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
    fail('PHASE5_PERFORMANCE_SIGNOFF_SIGNATURE_INVALID');
  }
  return signature;
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

function number(value, minimum, maximum, code) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) fail(code);
}

function lessThan(value, maximum, code) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value >= maximum) fail(code);
}

function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    fail('PHASE5_PERFORMANCE_TIMESTAMP_INVALID');
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail('PHASE5_PERFORMANCE_TIMESTAMP_INVALID');
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
  fail('PHASE5_PERFORMANCE_SELF_TEST_DID_NOT_FAIL');
}

function fail(code) {
  throw new Error(code);
}
