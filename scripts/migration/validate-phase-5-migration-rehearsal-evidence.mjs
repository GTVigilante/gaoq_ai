import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';

const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const HASH = /^[A-Za-z0-9_-]{43}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const ENVIRONMENT_NAME = /^[a-z][a-z0-9-]{2,31}$/u;
const REGION = /^[a-z0-9-]{2,32}$/u;
const ROUND_COUNT = 3;
const FAULT_EXERCISES = [
  'attachment_gateway_outage', 'duplicate_input', 'interruption_resume',
];
const SIGNOFF_ROLES = [
  'architecture_owner', 'business_owner', 'data_owner', 'security_owner',
];
const CONTRACT_LOCATION = new URL(
  '../../apps/erp-api/src/modules/data-migration/data-migration-contract.ts',
  import.meta.url,
);
const WORKFLOW_LOCATION = new URL(
  '../../.github/workflows/phase-5-migration-rehearsal.yml',
  import.meta.url,
);
const CONTRACT_SOURCE = await readFile(CONTRACT_LOCATION, 'utf8');
const SCOPES = parseScopes(CONTRACT_SOURCE);
const HARNESS_DIGEST = digest(canonical({
  './validate-phase-5-migration-rehearsal-evidence.mjs': await readFile(
    new URL(import.meta.url),
    'utf8',
  ),
  '../../.github/workflows/phase-5-migration-rehearsal.yml': await readFile(
    WORKFLOW_LOCATION,
    'utf8',
  ),
  '../../apps/erp-api/src/modules/data-migration/data-migration-contract.ts': CONTRACT_SOURCE,
}));

const argumentsList = process.argv.slice(2);
if (argumentsList.length === 1 && argumentsList[0] === '--self-test') {
  runSelfTest();
  process.stdout.write('Phase 5 全量迁移三次演练聚合证据门禁自测通过。\n');
} else if (argumentsList.length === 1 && argumentsList[0] === '--print-contract') {
  process.stdout.write(`${JSON.stringify({
    formatVersion: 1,
    suite: 'gaoq.phase5.migration-rehearsal.contract',
    scopeCount: SCOPES.length,
    scopes: SCOPES,
    rehearsalCount: ROUND_COUNT,
    expectedRunCount: SCOPES.length * ROUND_COUNT,
    harnessSha256: HARNESS_DIGEST,
  }, null, 2)}\n`);
} else {
  const enforceEnvironment = argumentsList[0] === '--enforce-environment';
  const evidencePath = argumentsList[enforceEnvironment ? 1 : 0];
  if (evidencePath === undefined || argumentsList.length !== (enforceEnvironment ? 2 : 1)) {
    fail('PHASE5_MIGRATION_REHEARSAL_EVIDENCE_PATH_REQUIRED');
  }
  const metadata = await lstat(evidencePath);
  if (
    !metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 ||
    metadata.size > 1_024 * 1_024 || (metadata.mode & 0o022) !== 0
  ) fail('PHASE5_MIGRATION_REHEARSAL_EVIDENCE_FILE_INVALID');
  const summary = validateEvidence(
    parseDocument(await readFile(evidencePath, 'utf8')),
    enforceEnvironment,
  );
  process.stdout.write(`${JSON.stringify({
    formatVersion: 1,
    suite: 'gaoq.phase5.migration-rehearsal.verdict',
    evidenceId: summary.evidenceId,
    outcome: 'PASSED',
    commitSha: summary.commitSha,
    scopeCount: summary.scopeCount,
    runCount: summary.runCount,
    comparisonChecksum: digest(canonical(summary)),
  }, null, 2)}\n`);
}

/** 校验全部 Scope 的三次全量演练聚合证据，只返回脱敏控制摘要。 */
function validateEvidence(document, enforceEnvironment = false) {
  object(document, [
    'formatVersion', 'suite', 'evidenceId', 'environment', 'source', 'sourceSystems',
    'rounds', 'scopes', 'faultExercises', 'safety', 'signoffs',
  ], 'PHASE5_MIGRATION_REHEARSAL_DOCUMENT_INVALID');
  equal(document.formatVersion, 1, 'PHASE5_MIGRATION_REHEARSAL_FORMAT_INVALID');
  equal(
    document.suite,
    'gaoq.phase5.migration-rehearsal.v1',
    'PHASE5_MIGRATION_REHEARSAL_SUITE_INVALID',
  );
  pattern(document.evidenceId, ULID, 'PHASE5_MIGRATION_REHEARSAL_EVIDENCE_ID_INVALID');
  const environment = validateEnvironment(document.environment, enforceEnvironment);
  const source = validateSource(document.source, enforceEnvironment);
  const sourceSystems = validateSourceSystems(document.sourceSystems);
  const rounds = validateRounds(document.rounds, environment);
  const scopes = validateScopes(document.scopes, sourceSystems);
  validateFaultExercises(document.faultExercises, environment);
  validateSafety(document.safety);
  const signoffEvidenceIds = validateSignoffs(document.signoffs, environment.endedAt);
  return Object.freeze({
    evidenceId: document.evidenceId,
    commitSha: source.commitSha,
    images: source.images,
    deploymentManifestHash: source.deploymentManifestHash,
    sourceSnapshotHash: source.sourceSnapshotHash,
    packageManifestHash: source.packageManifestHash,
    environment: document.environment,
    sourceSystems,
    scopeCount: scopes.length,
    runCount: scopes.length * ROUND_COUNT,
    roundEvidenceIds: rounds.map((round) => round.evidenceId),
    roundBundleHashes: rounds.map((round) => round.bundleHash),
    scopeComparisons: scopes.map((scope) => ({
      scope: scope.scope,
      comparisonChecksum: scope.comparisonChecksum,
      runIds: scope.runs.map((run) => run.runId),
      artifactChecksums: scope.runs.map((run) => run.artifactChecksum),
    })),
    signoffEvidenceIds,
  });
}

function validateEnvironment(environment, enforceEnvironment) {
  object(environment, [
    'name', 'region', 'productionEquivalent', 'productionTraffic', 'syntheticData',
    'startedAt', 'endedAt',
  ], 'PHASE5_MIGRATION_REHEARSAL_ENVIRONMENT_INVALID');
  pattern(environment.name, ENVIRONMENT_NAME, 'PHASE5_MIGRATION_REHEARSAL_ENVIRONMENT_INVALID');
  if (/(?:^|-)prod(?:-|$)|production/u.test(environment.name)) {
    fail('PHASE5_MIGRATION_REHEARSAL_PRODUCTION_FORBIDDEN');
  }
  if (!/(?:^|-)(?:migration|rehearsal|stage|staging|preprod|uat)(?:-|$)/u
    .test(environment.name)) fail('PHASE5_MIGRATION_REHEARSAL_ENVIRONMENT_INVALID');
  pattern(environment.region, REGION, 'PHASE5_MIGRATION_REHEARSAL_REGION_INVALID');
  equal(
    environment.productionEquivalent,
    true,
    'PHASE5_MIGRATION_REHEARSAL_ENVIRONMENT_NOT_EQUIVALENT',
  );
  equal(
    environment.productionTraffic,
    false,
    'PHASE5_MIGRATION_REHEARSAL_PRODUCTION_FORBIDDEN',
  );
  equal(environment.syntheticData, true, 'PHASE5_MIGRATION_REHEARSAL_SYNTHETIC_DATA_REQUIRED');
  const startedAt = timestamp(environment.startedAt);
  const endedAt = timestamp(environment.endedAt);
  duration(
    startedAt,
    endedAt,
    1,
    30 * 24 * 60 * 60,
    'PHASE5_MIGRATION_REHEARSAL_ENVIRONMENT_TIME_INVALID',
  );
  if (enforceEnvironment) {
    const expectedName = process.env.MIGRATION_REHEARSAL_EXPECTED_ENVIRONMENT;
    const expectedRegion = process.env.MIGRATION_REHEARSAL_EXPECTED_REGION;
    pattern(
      expectedName,
      ENVIRONMENT_NAME,
      'PHASE5_MIGRATION_REHEARSAL_EXPECTED_ENVIRONMENT_REQUIRED',
    );
    pattern(expectedRegion, REGION, 'PHASE5_MIGRATION_REHEARSAL_EXPECTED_ENVIRONMENT_REQUIRED');
    equal(
      environment.name,
      expectedName,
      'PHASE5_MIGRATION_REHEARSAL_ENVIRONMENT_MISMATCH',
    );
    equal(
      environment.region,
      expectedRegion,
      'PHASE5_MIGRATION_REHEARSAL_REGION_MISMATCH',
    );
  }
  return Object.freeze({ startedAt, endedAt });
}

function validateSource(source, enforceEnvironment) {
  object(source, [
    'commitSha', 'images', 'deploymentManifestHash', 'sourceSnapshotHash',
    'packageManifestHash', 'harnessSha256',
  ], 'PHASE5_MIGRATION_REHEARSAL_SOURCE_INVALID');
  pattern(source.commitSha, COMMIT, 'PHASE5_MIGRATION_REHEARSAL_COMMIT_INVALID');
  object(source.images, ['api', 'worker', 'web'], 'PHASE5_MIGRATION_REHEARSAL_IMAGES_INVALID');
  for (const value of Object.values(source.images)) {
    pattern(value, SHA256, 'PHASE5_MIGRATION_REHEARSAL_IMAGES_INVALID');
  }
  if (new Set(Object.values(source.images)).size !== 3) {
    fail('PHASE5_MIGRATION_REHEARSAL_IMAGES_INVALID');
  }
  for (const field of [
    'deploymentManifestHash', 'sourceSnapshotHash', 'packageManifestHash',
  ]) pattern(source[field], SHA256, 'PHASE5_MIGRATION_REHEARSAL_SOURCE_INVALID');
  equal(
    source.harnessSha256,
    HARNESS_DIGEST,
    'PHASE5_MIGRATION_REHEARSAL_HARNESS_INVALID',
  );
  if (enforceEnvironment) validateExpectedSource(source);
  return source;
}

function validateExpectedSource(source) {
  const expected = {
    commitSha: process.env.MIGRATION_REHEARSAL_EXPECTED_COMMIT,
    api: process.env.MIGRATION_REHEARSAL_EXPECTED_API_IMAGE,
    worker: process.env.MIGRATION_REHEARSAL_EXPECTED_WORKER_IMAGE,
    web: process.env.MIGRATION_REHEARSAL_EXPECTED_WEB_IMAGE,
    deploymentManifestHash: process.env.MIGRATION_REHEARSAL_EXPECTED_DEPLOYMENT_MANIFEST,
    sourceSnapshotHash: process.env.MIGRATION_REHEARSAL_EXPECTED_SOURCE_SNAPSHOT,
    packageManifestHash: process.env.MIGRATION_REHEARSAL_EXPECTED_PACKAGE_MANIFEST,
  };
  pattern(
    expected.commitSha,
    COMMIT,
    'PHASE5_MIGRATION_REHEARSAL_EXPECTED_SOURCE_REQUIRED',
  );
  for (const field of [
    'api', 'worker', 'web', 'deploymentManifestHash', 'sourceSnapshotHash',
    'packageManifestHash',
  ]) pattern(expected[field], SHA256, 'PHASE5_MIGRATION_REHEARSAL_EXPECTED_SOURCE_REQUIRED');
  equal(source.commitSha, expected.commitSha, 'PHASE5_MIGRATION_REHEARSAL_COMMIT_MISMATCH');
  for (const image of ['api', 'worker', 'web']) {
    equal(source.images[image], expected[image], 'PHASE5_MIGRATION_REHEARSAL_IMAGE_MISMATCH');
  }
  equal(
    source.deploymentManifestHash,
    expected.deploymentManifestHash,
    'PHASE5_MIGRATION_REHEARSAL_DEPLOYMENT_MANIFEST_MISMATCH',
  );
  equal(
    source.sourceSnapshotHash,
    expected.sourceSnapshotHash,
    'PHASE5_MIGRATION_REHEARSAL_SOURCE_SNAPSHOT_MISMATCH',
  );
  equal(
    source.packageManifestHash,
    expected.packageManifestHash,
    'PHASE5_MIGRATION_REHEARSAL_PACKAGE_MANIFEST_MISMATCH',
  );
}

function validateSourceSystems(sourceSystems) {
  if (!Array.isArray(sourceSystems) || sourceSystems.length < 1 || sourceSystems.length > 16) {
    fail('PHASE5_MIGRATION_REHEARSAL_SOURCE_SYSTEMS_INVALID');
  }
  for (const value of sourceSystems) {
    pattern(value, ID, 'PHASE5_MIGRATION_REHEARSAL_SOURCE_SYSTEMS_INVALID');
  }
  if (new Set(sourceSystems).size !== sourceSystems.length ||
    canonical(sourceSystems) !== canonical([...sourceSystems].sort())) {
    fail('PHASE5_MIGRATION_REHEARSAL_SOURCE_SYSTEMS_INVALID');
  }
  return sourceSystems;
}

function validateRounds(rounds, environment) {
  if (!Array.isArray(rounds) || rounds.length !== ROUND_COUNT) {
    fail('PHASE5_MIGRATION_REHEARSAL_ROUNDS_INCOMPLETE');
  }
  const evidenceIds = new Set();
  const bundleHashes = new Set();
  let previousEndedAt = environment.startedAt - 1;
  for (const [index, round] of rounds.entries()) {
    object(round, [
      'sequence', 'evidenceId', 'startedAt', 'endedAt', 'durationSeconds',
      'bundleHash', 'status',
    ], 'PHASE5_MIGRATION_REHEARSAL_ROUND_INVALID');
    equal(round.sequence, index + 1, 'PHASE5_MIGRATION_REHEARSAL_ROUND_ORDER_INVALID');
    pattern(round.evidenceId, ULID, 'PHASE5_MIGRATION_REHEARSAL_ROUND_INVALID');
    pattern(round.bundleHash, SHA256, 'PHASE5_MIGRATION_REHEARSAL_ROUND_INVALID');
    equal(round.status, 'passed', 'PHASE5_MIGRATION_REHEARSAL_ROUND_FAILED');
    const startedAt = timestamp(round.startedAt);
    const endedAt = timestamp(round.endedAt);
    if (
      startedAt <= previousEndedAt || startedAt < environment.startedAt ||
      endedAt > environment.endedAt
    ) fail('PHASE5_MIGRATION_REHEARSAL_ROUND_ORDER_INVALID');
    const actualDuration = secondsBetween(startedAt, endedAt);
    integer(round.durationSeconds, 1, 28_800, 'PHASE5_MIGRATION_REHEARSAL_WINDOW_EXCEEDED');
    equal(
      round.durationSeconds,
      actualDuration,
      'PHASE5_MIGRATION_REHEARSAL_ROUND_DURATION_INVALID',
    );
    evidenceIds.add(round.evidenceId);
    bundleHashes.add(round.bundleHash);
    previousEndedAt = endedAt;
  }
  if (evidenceIds.size !== ROUND_COUNT || bundleHashes.size !== ROUND_COUNT) {
    fail('PHASE5_MIGRATION_REHEARSAL_ROUNDS_NOT_INDEPENDENT');
  }
  return rounds;
}

function validateScopes(scopes, sourceSystems) {
  if (!Array.isArray(scopes) || scopes.length !== SCOPES.length) {
    fail('PHASE5_MIGRATION_REHEARSAL_SCOPES_INCOMPLETE');
  }
  const runIds = new Set();
  const artifactChecksums = new Set();
  const comparisonChecksums = new Set();
  for (const [index, scope] of scopes.entries()) {
    object(scope, [
      'sequence', 'scope', 'sourceSystem', 'rehearsalCount', 'expectedSourceCount',
      'sourceChecksum', 'targetChecksum', 'associationCount', 'attachmentCount',
      'comparisonChecksum', 'runs',
    ], 'PHASE5_MIGRATION_REHEARSAL_SCOPE_INVALID');
    equal(scope.sequence, index + 1, 'PHASE5_MIGRATION_REHEARSAL_SCOPE_ORDER_INVALID');
    equal(scope.scope, SCOPES[index], 'PHASE5_MIGRATION_REHEARSAL_SCOPE_ORDER_INVALID');
    if (!sourceSystems.includes(scope.sourceSystem)) {
      fail('PHASE5_MIGRATION_REHEARSAL_SOURCE_SYSTEM_INVALID');
    }
    equal(scope.rehearsalCount, ROUND_COUNT, 'PHASE5_MIGRATION_REHEARSAL_COUNT_INVALID');
    integer(
      scope.expectedSourceCount,
      0,
      10_000_000,
      'PHASE5_MIGRATION_REHEARSAL_SOURCE_COUNT_INVALID',
    );
    pattern(scope.sourceChecksum, HASH, 'PHASE5_MIGRATION_REHEARSAL_CHECKSUM_INVALID');
    pattern(scope.targetChecksum, HASH, 'PHASE5_MIGRATION_REHEARSAL_CHECKSUM_INVALID');
    integer(scope.associationCount, 0, 100_000_000,
      'PHASE5_MIGRATION_REHEARSAL_ASSOCIATION_COUNT_INVALID');
    integer(scope.attachmentCount, 0, 100_000_000,
      'PHASE5_MIGRATION_REHEARSAL_ATTACHMENT_COUNT_INVALID');
    pattern(scope.comparisonChecksum, HASH, 'PHASE5_MIGRATION_REHEARSAL_CHECKSUM_INVALID');
    if (!Array.isArray(scope.runs) || scope.runs.length !== ROUND_COUNT) {
      fail('PHASE5_MIGRATION_REHEARSAL_SCOPE_RUNS_INCOMPLETE');
    }
    for (const [runIndex, run] of scope.runs.entries()) {
      object(run, ['roundSequence', 'runId', 'artifactChecksum'],
        'PHASE5_MIGRATION_REHEARSAL_SCOPE_RUN_INVALID');
      equal(
        run.roundSequence,
        runIndex + 1,
        'PHASE5_MIGRATION_REHEARSAL_SCOPE_RUN_ORDER_INVALID',
      );
      pattern(run.runId, ULID, 'PHASE5_MIGRATION_REHEARSAL_SCOPE_RUN_INVALID');
      pattern(
        run.artifactChecksum,
        HASH,
        'PHASE5_MIGRATION_REHEARSAL_SCOPE_RUN_INVALID',
      );
      runIds.add(run.runId);
      artifactChecksums.add(run.artifactChecksum);
    }
    equal(
      scope.comparisonChecksum,
      hashUrl(canonical(migrationComparisonBody(scope))),
      'PHASE5_MIGRATION_REHEARSAL_COMPARISON_CHECKSUM_MISMATCH',
    );
    comparisonChecksums.add(scope.comparisonChecksum);
  }
  const expectedRuns = SCOPES.length * ROUND_COUNT;
  if (
    runIds.size !== expectedRuns || artifactChecksums.size !== expectedRuns ||
    comparisonChecksums.size !== SCOPES.length
  ) fail('PHASE5_MIGRATION_REHEARSAL_SCOPE_EVIDENCE_REUSED');
  return scopes;
}

function validateFaultExercises(exercises, environment) {
  if (!Array.isArray(exercises) || exercises.length !== FAULT_EXERCISES.length) {
    fail('PHASE5_MIGRATION_REHEARSAL_FAULT_EXERCISES_INCOMPLETE');
  }
  const evidenceIds = new Set();
  for (const [index, exercise] of exercises.entries()) {
    object(exercise, [
      'type', 'evidenceId', 'executedAt', 'status', 'lostRecords',
      'duplicateBusinessEffects', 'unresolvedDifferences',
    ], 'PHASE5_MIGRATION_REHEARSAL_FAULT_EXERCISE_INVALID');
    equal(exercise.type, FAULT_EXERCISES[index],
      'PHASE5_MIGRATION_REHEARSAL_FAULT_EXERCISE_ORDER_INVALID');
    pattern(exercise.evidenceId, ULID,
      'PHASE5_MIGRATION_REHEARSAL_FAULT_EXERCISE_INVALID');
    const executedAt = timestamp(exercise.executedAt);
    if (executedAt < environment.startedAt || executedAt > environment.endedAt) {
      fail('PHASE5_MIGRATION_REHEARSAL_FAULT_EXERCISE_TIME_INVALID');
    }
    equal(exercise.status, 'passed', 'PHASE5_MIGRATION_REHEARSAL_FAULT_EXERCISE_FAILED');
    for (const field of [
      'lostRecords', 'duplicateBusinessEffects', 'unresolvedDifferences',
    ]) equal(exercise[field], 0, 'PHASE5_MIGRATION_REHEARSAL_FAULT_EXERCISE_FAILED');
    evidenceIds.add(exercise.evidenceId);
  }
  if (evidenceIds.size !== FAULT_EXERCISES.length) {
    fail('PHASE5_MIGRATION_REHEARSAL_FAULT_EVIDENCE_REUSED');
  }
}

function validateSafety(safety) {
  object(safety, [
    'criticalDifferenceCount', 'highDifferenceCount', 'auditFailureCount',
    'recordMismatchCount', 'permissionMismatchCount', 'amountDifferenceMinor',
    'missingAttachmentCount', 'checksumMismatchCount', 'productionSideEffects',
  ], 'PHASE5_MIGRATION_REHEARSAL_SAFETY_INVALID');
  for (const field of [
    'criticalDifferenceCount', 'highDifferenceCount', 'auditFailureCount',
    'recordMismatchCount', 'permissionMismatchCount', 'amountDifferenceMinor',
    'missingAttachmentCount', 'checksumMismatchCount',
  ]) equal(safety[field], 0, 'PHASE5_MIGRATION_REHEARSAL_SAFETY_FAILED');
  equal(
    safety.productionSideEffects,
    false,
    'PHASE5_MIGRATION_REHEARSAL_PRODUCTION_SIDE_EFFECT_FORBIDDEN',
  );
}

function validateSignoffs(signoffs, endedAt) {
  if (!Array.isArray(signoffs) || signoffs.length !== SIGNOFF_ROLES.length) {
    fail('PHASE5_MIGRATION_REHEARSAL_SIGNOFFS_INCOMPLETE');
  }
  const roles = [];
  const evidenceIds = new Set();
  for (const signoff of signoffs) {
    object(signoff, ['role', 'evidenceId', 'signedAt'],
      'PHASE5_MIGRATION_REHEARSAL_SIGNOFF_INVALID');
    pattern(signoff.evidenceId, ULID, 'PHASE5_MIGRATION_REHEARSAL_SIGNOFF_INVALID');
    if (timestamp(signoff.signedAt) < endedAt) {
      fail('PHASE5_MIGRATION_REHEARSAL_SIGNOFF_TIME_INVALID');
    }
    roles.push(signoff.role);
    evidenceIds.add(signoff.evidenceId);
  }
  if (
    canonical(roles.sort()) !== canonical([...SIGNOFF_ROLES].sort()) ||
    evidenceIds.size !== SIGNOFF_ROLES.length
  ) fail('PHASE5_MIGRATION_REHEARSAL_SIGNOFFS_INCOMPLETE');
  return [...evidenceIds];
}

function runSelfTest() {
  const valid = fixture();
  validateEvidence(valid);
  const missingScope = fixture();
  missingScope.scopes.pop();
  expectFailure(
    () => validateEvidence(missingScope),
    'PHASE5_MIGRATION_REHEARSAL_SCOPES_INCOMPLETE',
  );
  const reusedRun = fixture();
  reusedRun.scopes[1].runs[0].runId = reusedRun.scopes[0].runs[0].runId;
  reusedRun.scopes[1].comparisonChecksum = hashUrl(canonical(
    migrationComparisonBody(reusedRun.scopes[1]),
  ));
  expectFailure(
    () => validateEvidence(reusedRun),
    'PHASE5_MIGRATION_REHEARSAL_SCOPE_EVIDENCE_REUSED',
  );
  const tamperedComparison = fixture();
  tamperedComparison.scopes[0].targetChecksum = hashUrl('tampered-target');
  expectFailure(
    () => validateEvidence(tamperedComparison),
    'PHASE5_MIGRATION_REHEARSAL_COMPARISON_CHECKSUM_MISMATCH',
  );
  const unsafe = fixture();
  unsafe.safety.productionSideEffects = true;
  expectFailure(
    () => validateEvidence(unsafe),
    'PHASE5_MIGRATION_REHEARSAL_PRODUCTION_SIDE_EFFECT_FORBIDDEN',
  );
  withExpectedEnvironment(valid, () => {
    validateEvidence(fixture(), true);
    const mismatch = fixture();
    mismatch.source.sourceSnapshotHash = digest('different-source-snapshot');
    expectFailure(
      () => validateEvidence(mismatch, true),
      'PHASE5_MIGRATION_REHEARSAL_SOURCE_SNAPSHOT_MISMATCH',
    );
  });
}

function fixture() {
  const environment = {
    name: 'migration-rehearsal', region: 'cn-test-1', productionEquivalent: true,
    productionTraffic: false, syntheticData: true,
    startedAt: '2026-07-01T00:00:00.000Z', endedAt: '2026-07-04T00:00:00.000Z',
  };
  return {
    formatVersion: 1,
    suite: 'gaoq.phase5.migration-rehearsal.v1',
    evidenceId: ulid(1),
    environment,
    source: {
      commitSha: 'a'.repeat(40),
      images: { api: digest('api'), worker: digest('worker'), web: digest('web') },
      deploymentManifestHash: digest('deployment-manifest'),
      sourceSnapshotHash: digest('source-snapshot'),
      packageManifestHash: digest('package-manifest'),
      harnessSha256: HARNESS_DIGEST,
    },
    sourceSystems: ['legacy-erp'],
    rounds: [1, 2, 3].map((sequence) => ({
      sequence,
      evidenceId: ulid(10 + sequence),
      startedAt: `2026-07-0${sequence}T01:00:00.000Z`,
      endedAt: `2026-07-0${sequence}T07:00:00.000Z`,
      durationSeconds: 21_600,
      bundleHash: digest(`round-bundle-${sequence}`),
      status: 'passed',
    })),
    scopes: SCOPES.map(scopeFixture),
    faultExercises: FAULT_EXERCISES.map((type, index) => ({
      type,
      evidenceId: ulid(300 + index),
      executedAt: `2026-07-0${index + 1}T03:00:00.000Z`,
      status: 'passed',
      lostRecords: 0,
      duplicateBusinessEffects: 0,
      unresolvedDifferences: 0,
    })),
    safety: {
      criticalDifferenceCount: 0,
      highDifferenceCount: 0,
      auditFailureCount: 0,
      recordMismatchCount: 0,
      permissionMismatchCount: 0,
      amountDifferenceMinor: 0,
      missingAttachmentCount: 0,
      checksumMismatchCount: 0,
      productionSideEffects: false,
    },
    signoffs: SIGNOFF_ROLES.map((role, index) => ({
      role,
      evidenceId: ulid(400 + index),
      signedAt: '2026-07-04T01:00:00.000Z',
    })),
  };
}

function scopeFixture(scope, scopeIndex) {
  const runs = [1, 2, 3].map((roundSequence) => ({
    roundSequence,
    runId: ulid(100 + scopeIndex * 3 + roundSequence),
    artifactChecksum: hashUrl(`artifact-${scope}-${roundSequence}`),
  }));
  const values = {
    rehearsalCount: 3,
    sourceSystem: 'legacy-erp',
    scope,
    expectedSourceCount: 1,
    sourceChecksum: hashUrl(`source-${scope}`),
    targetChecksum: hashUrl(`target-${scope}`),
    associationCount: 1,
    attachmentCount: 1,
  };
  const result = {
    sequence: scopeIndex + 1,
    ...values,
    comparisonChecksum: '',
    runs,
  };
  result.comparisonChecksum = hashUrl(canonical(migrationComparisonBody(result)));
  return result;
}

function migrationComparisonBody(scope) {
  return {
    qualified: true,
    rehearsalCount: scope.rehearsalCount,
    sourceSystem: scope.sourceSystem,
    scope: scope.scope,
    expectedSourceCount: scope.expectedSourceCount,
    sourceChecksum: scope.sourceChecksum,
    targetChecksum: scope.targetChecksum,
    associationCount: scope.associationCount,
    attachmentCount: scope.attachmentCount,
    runs: scope.runs.map((run) => ({
      runId: run.runId,
      artifactChecksum: run.artifactChecksum,
    })),
  };
}

function withExpectedEnvironment(document, action) {
  const values = {
    MIGRATION_REHEARSAL_EXPECTED_ENVIRONMENT: document.environment.name,
    MIGRATION_REHEARSAL_EXPECTED_REGION: document.environment.region,
    MIGRATION_REHEARSAL_EXPECTED_COMMIT: document.source.commitSha,
    MIGRATION_REHEARSAL_EXPECTED_API_IMAGE: document.source.images.api,
    MIGRATION_REHEARSAL_EXPECTED_WORKER_IMAGE: document.source.images.worker,
    MIGRATION_REHEARSAL_EXPECTED_WEB_IMAGE: document.source.images.web,
    MIGRATION_REHEARSAL_EXPECTED_DEPLOYMENT_MANIFEST:
      document.source.deploymentManifestHash,
    MIGRATION_REHEARSAL_EXPECTED_SOURCE_SNAPSHOT: document.source.sourceSnapshotHash,
    MIGRATION_REHEARSAL_EXPECTED_PACKAGE_MANIFEST: document.source.packageManifestHash,
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

function parseScopes(source) {
  const startMarker = 'export const DATA_MIGRATION_SCOPE_ENTITIES = Object.freeze({';
  const endMarker = '} as const);';
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) fail('PHASE5_MIGRATION_REHEARSAL_SCOPE_CONTRACT_INVALID');
  const block = source.slice(start + startMarker.length, end);
  const scopes = [...block.matchAll(/^ {2}([a-z][a-z0-9_]+): Object\.freeze\(/gmu)]
    .map((match) => match[1]);
  if (scopes.length < 1 || new Set(scopes).size !== scopes.length) {
    fail('PHASE5_MIGRATION_REHEARSAL_SCOPE_CONTRACT_INVALID');
  }
  return Object.freeze(scopes);
}

function parseDocument(text) {
  try {
    return JSON.parse(text);
  } catch {
    fail('PHASE5_MIGRATION_REHEARSAL_JSON_INVALID');
  }
}

function object(value, keys, code) {
  if (
    typeof value !== 'object' || value === null || Array.isArray(value) ||
    canonical(Object.keys(value).sort()) !== canonical([...keys].sort())
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
  ) fail('PHASE5_MIGRATION_REHEARSAL_TIMESTAMP_INVALID');
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail('PHASE5_MIGRATION_REHEARSAL_TIMESTAMP_INVALID');
  return parsed;
}

function duration(startedAt, endedAt, minimumSeconds, maximumSeconds, code) {
  const seconds = secondsBetween(startedAt, endedAt);
  if (seconds < minimumSeconds || seconds > maximumSeconds) fail(code);
}

function secondsBetween(startedAt, endedAt) {
  const milliseconds = endedAt - startedAt;
  if (milliseconds <= 0 || milliseconds % 1_000 !== 0) {
    fail('PHASE5_MIGRATION_REHEARSAL_TIME_INVALID');
  }
  return milliseconds / 1_000;
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

function hashUrl(value) {
  return createHash('sha256').update(value).digest('base64url');
}

function ulid(index) {
  return `01J8ZQK7V0A2M4N6P8R0T2W${String(index).padStart(3, '0')}`;
}

function expectFailure(operation, code) {
  try {
    operation();
  } catch (error) {
    if (error instanceof Error && error.message === code) return;
    throw error;
  }
  fail('PHASE5_MIGRATION_REHEARSAL_SELF_TEST_DID_NOT_FAIL');
}

function fail(code) {
  throw new Error(code);
}
