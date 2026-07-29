import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';

const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const ENVIRONMENT_NAME = /^[a-z][a-z0-9-]{2,31}$/u;
const REGION = /^[a-z0-9-]{2,32}$/u;
const DOMAIN_NAMES = [
  'approval', 'attendance', 'audit', 'migration', 'op', 'org', 'payroll', 'recruitment',
];
const INTEGRATION_PROFILES = Object.freeze({
  attachment: 'request-response',
  bank: 'bidirectional',
  dingtalk: 'bidirectional',
  esign: 'bidirectional',
  feishu: 'bidirectional',
  op: 'bidirectional',
  'professional-payroll': 'bidirectional',
  tax: 'bidirectional',
  worm: 'request-response',
});
const SIGNOFF_ROLES = [
  'business_continuity_owner', 'data_owner', 'integration_owner', 'platform_owner',
  'qa_owner', 'security_owner', 'sre_owner',
];
const HARNESS_FILES = [
  ['./validate-phase-5-resilience-evidence.mjs', new URL(import.meta.url)],
  ['../../.github/workflows/phase-5-resilience.yml',
    new URL('../../.github/workflows/phase-5-resilience.yml', import.meta.url)],
];
const HARNESS_DIGEST = digest(canonical(Object.fromEntries(await Promise.all(
  HARNESS_FILES.map(async ([name, location]) => [name, await readFile(location, 'utf8')]),
))));

const argumentsList = process.argv.slice(2);
if (argumentsList.length === 1 && argumentsList[0] === '--self-test') {
  runSelfTest();
  process.stdout.write('Phase 5 容灾恢复与外部断连证据门禁自测通过。\n');
} else {
  const enforceEnvironment = argumentsList[0] === '--enforce-environment';
  const evidencePath = argumentsList[enforceEnvironment ? 1 : 0];
  const expectedLength = enforceEnvironment ? 2 : 1;
  if (evidencePath === undefined || argumentsList.length !== expectedLength) {
    fail('PHASE5_RESILIENCE_EVIDENCE_PATH_REQUIRED');
  }
  const metadata = await lstat(evidencePath);
  if (
    !metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 ||
    metadata.size > 512 * 1_024 || (metadata.mode & 0o022) !== 0
  ) fail('PHASE5_RESILIENCE_EVIDENCE_FILE_INVALID');
  const document = parseDocument(await readFile(evidencePath, 'utf8'));
  const summary = validateEvidence(document, enforceEnvironment);
  process.stdout.write(`${JSON.stringify({
    formatVersion: 2,
    suite: 'gaoq.phase5.resilience.verdict',
    runId: summary.runId,
    commitSha: summary.commitSha,
    evidenceChecksum: digest(canonical(summary)),
  }, null, 2)}\n`);
}

function validateEvidence(document, enforceEnvironment = false) {
  object(document, [
    'formatVersion', 'suite', 'runId', 'environment', 'source', 'objectives',
    'disasterRecovery', 'consistency', 'integrations', 'safety', 'artifacts', 'signoffs',
  ], 'PHASE5_RESILIENCE_DOCUMENT_INVALID');
  equal(document.formatVersion, 2, 'PHASE5_RESILIENCE_FORMAT_INVALID');
  equal(document.suite, 'gaoq.phase5.resilience.v2', 'PHASE5_RESILIENCE_SUITE_INVALID');
  pattern(document.runId, ULID, 'PHASE5_RESILIENCE_RUN_ID_INVALID');

  const environment = validateEnvironment(document.environment, enforceEnvironment);
  const source = validateSource(document.source, enforceEnvironment);
  const objectives = validateObjectives(document.objectives);
  const recovery = validateRecovery(document.disasterRecovery, environment, objectives);
  const consistency = validateConsistency(document.consistency);
  const integrations = validateIntegrations(
    document.integrations,
    environment,
    objectives,
  );
  validateSafety(document.safety);
  const artifacts = validateArtifacts(document.artifacts);
  const signoffEvidenceIds = validateSignoffs(document.signoffs, environment.endedAt);

  return Object.freeze({
    runId: document.runId,
    commitSha: source.commitSha,
    images: source.images,
    environment: document.environment,
    objectives,
    recovery,
    consistency,
    integrations,
    safety: document.safety,
    artifacts,
    signoffEvidenceIds,
  });
}

function validateEnvironment(environment, enforceEnvironment) {
  object(environment, [
    'name', 'region', 'productionEquivalent', 'productionTraffic', 'isolatedRecovery',
    'syntheticData', 'startedAt', 'endedAt',
  ], 'PHASE5_RESILIENCE_ENV_INVALID');
  pattern(environment.name, ENVIRONMENT_NAME, 'PHASE5_RESILIENCE_ENV_INVALID');
  pattern(environment.region, REGION, 'PHASE5_RESILIENCE_REGION_INVALID');
  if (!/(?:^|-)(?:dr|recovery|resilience|stage|staging|preprod|uat)(?:-|$)/u.test(environment.name)) {
    fail('PHASE5_RESILIENCE_ENV_INVALID');
  }
  if (/(?:^|-)prod(?:-|$)|production/u.test(environment.name)) {
    fail('PHASE5_RESILIENCE_PRODUCTION_FORBIDDEN');
  }
  equal(environment.productionEquivalent, true, 'PHASE5_RESILIENCE_ENV_NOT_EQUIVALENT');
  equal(environment.productionTraffic, false, 'PHASE5_RESILIENCE_PRODUCTION_FORBIDDEN');
  equal(environment.isolatedRecovery, true, 'PHASE5_RESILIENCE_ISOLATION_REQUIRED');
  equal(environment.syntheticData, true, 'PHASE5_RESILIENCE_SYNTHETIC_DATA_REQUIRED');
  const startedAt = timestamp(environment.startedAt);
  const endedAt = timestamp(environment.endedAt);
  duration(startedAt, endedAt, 2 * 60 * 60, 24 * 60 * 60,
    'PHASE5_RESILIENCE_DURATION_INVALID');

  if (enforceEnvironment) {
    const expectedName = process.env.RESILIENCE_EXPECTED_ENVIRONMENT;
    const expectedRegion = process.env.RESILIENCE_EXPECTED_REGION;
    if (
      expectedName === undefined || expectedRegion === undefined ||
      !ENVIRONMENT_NAME.test(expectedName) || !REGION.test(expectedRegion)
    ) fail('PHASE5_RESILIENCE_EXPECTED_ENV_REQUIRED');
    equal(environment.name, expectedName, 'PHASE5_RESILIENCE_ENVIRONMENT_MISMATCH');
    equal(environment.region, expectedRegion, 'PHASE5_RESILIENCE_REGION_MISMATCH');
  }
  return Object.freeze({ startedAt, endedAt });
}

function validateSource(source, enforceEnvironment) {
  object(source, [
    'commitSha', 'images', 'professionalPayrollImage', 'rehearsalPlanVersion',
    'harnessSha256', 'deploymentManifestHash',
  ], 'PHASE5_RESILIENCE_SOURCE_INVALID');
  pattern(source.commitSha, COMMIT, 'PHASE5_RESILIENCE_COMMIT_INVALID');
  object(
    source.images,
    ['api', 'worker', 'web', 'website'],
    'PHASE5_RESILIENCE_IMAGES_INVALID',
  );
  const imageDigests = Object.values(source.images);
  for (const image of imageDigests) pattern(image, SHA256, 'PHASE5_RESILIENCE_IMAGE_INVALID');
  pattern(
    source.professionalPayrollImage,
    SHA256,
    'PHASE5_RESILIENCE_PAYROLL_IMAGE_INVALID',
  );
  if (
    new Set([...imageDigests, source.professionalPayrollImage]).size !== 5
  ) fail('PHASE5_RESILIENCE_IMAGES_NOT_INDEPENDENT');
  equal(
    source.rehearsalPlanVersion,
    'phase-5-resilience-v2',
    'PHASE5_RESILIENCE_PLAN_VERSION_INVALID',
  );
  equal(source.harnessSha256, HARNESS_DIGEST, 'PHASE5_RESILIENCE_HARNESS_INVALID');
  pattern(
    source.deploymentManifestHash,
    SHA256,
    'PHASE5_RESILIENCE_DEPLOYMENT_MANIFEST_INVALID',
  );
  if (enforceEnvironment) validateExpectedSource(source);
  return source;
}

function validateExpectedSource(source) {
  const expected = {
    commitSha: process.env.RESILIENCE_EXPECTED_COMMIT,
    api: process.env.RESILIENCE_EXPECTED_API_IMAGE,
    worker: process.env.RESILIENCE_EXPECTED_WORKER_IMAGE,
    web: process.env.RESILIENCE_EXPECTED_WEB_IMAGE,
    website: process.env.RESILIENCE_EXPECTED_WEBSITE_IMAGE,
    professionalPayroll: process.env.RESILIENCE_EXPECTED_PAYROLL_IMAGE,
    deploymentManifestHash: process.env.RESILIENCE_EXPECTED_DEPLOYMENT_MANIFEST,
  };
  pattern(expected.commitSha, COMMIT, 'PHASE5_RESILIENCE_EXPECTED_SOURCE_REQUIRED');
  for (const field of [
    'api', 'worker', 'web', 'website', 'professionalPayroll', 'deploymentManifestHash',
  ]) {
    pattern(expected[field], SHA256, 'PHASE5_RESILIENCE_EXPECTED_SOURCE_REQUIRED');
  }
  equal(source.commitSha, expected.commitSha, 'PHASE5_RESILIENCE_COMMIT_MISMATCH');
  equal(source.images.api, expected.api, 'PHASE5_RESILIENCE_IMAGE_MISMATCH');
  equal(source.images.worker, expected.worker, 'PHASE5_RESILIENCE_IMAGE_MISMATCH');
  equal(source.images.web, expected.web, 'PHASE5_RESILIENCE_IMAGE_MISMATCH');
  equal(source.images.website, expected.website, 'PHASE5_RESILIENCE_IMAGE_MISMATCH');
  equal(
    source.professionalPayrollImage,
    expected.professionalPayroll,
    'PHASE5_RESILIENCE_PAYROLL_IMAGE_MISMATCH',
  );
  equal(
    source.deploymentManifestHash,
    expected.deploymentManifestHash,
    'PHASE5_RESILIENCE_DEPLOYMENT_MANIFEST_MISMATCH',
  );
}

function validateObjectives(objectives) {
  object(objectives, [
    'rpoTargetSeconds', 'rtoTargetSeconds', 'integrationOutageTargetSeconds',
    'catchUpTargetSeconds',
  ], 'PHASE5_RESILIENCE_OBJECTIVES_INVALID');
  equal(objectives.rpoTargetSeconds, 900, 'PHASE5_RESILIENCE_RPO_TARGET_INVALID');
  equal(objectives.rtoTargetSeconds, 14_400, 'PHASE5_RESILIENCE_RTO_TARGET_INVALID');
  equal(
    objectives.integrationOutageTargetSeconds,
    7_200,
    'PHASE5_RESILIENCE_OUTAGE_TARGET_INVALID',
  );
  integer(
    objectives.catchUpTargetSeconds,
    1,
    3_600,
    'PHASE5_RESILIENCE_CATCHUP_TARGET_INVALID',
  );
  return objectives;
}

function validateRecovery(recovery, environment, objectives) {
  object(recovery, [
    'scenario', 'primaryRegionUnavailable', 'failureDeclaredAt', 'lastRecoverablePointAt',
    'databaseRecoveredAt', 'serviceRecoveredAt', 'actualRpoSeconds', 'actualRtoSeconds',
    'components', 'cutoverRollback',
  ], 'PHASE5_RESILIENCE_RECOVERY_INVALID');
  equal(recovery.scenario, 'isolated-region-loss', 'PHASE5_RESILIENCE_SCENARIO_INVALID');
  equal(recovery.primaryRegionUnavailable, true, 'PHASE5_RESILIENCE_SCENARIO_INVALID');
  const failureDeclaredAt = within(
    recovery.failureDeclaredAt,
    environment,
    'PHASE5_RESILIENCE_RECOVERY_TIME_INVALID',
  );
  const lastRecoverablePointAt = timestamp(recovery.lastRecoverablePointAt);
  const databaseRecoveredAt = within(
    recovery.databaseRecoveredAt,
    environment,
    'PHASE5_RESILIENCE_RECOVERY_TIME_INVALID',
  );
  const serviceRecoveredAt = within(
    recovery.serviceRecoveredAt,
    environment,
    'PHASE5_RESILIENCE_RECOVERY_TIME_INVALID',
  );
  if (
    lastRecoverablePointAt > failureDeclaredAt || databaseRecoveredAt < failureDeclaredAt ||
    serviceRecoveredAt < databaseRecoveredAt
  ) fail('PHASE5_RESILIENCE_RECOVERY_TIME_INVALID');
  const actualRpoSeconds = secondsBetween(lastRecoverablePointAt, failureDeclaredAt);
  const actualRtoSeconds = secondsBetween(failureDeclaredAt, serviceRecoveredAt);
  equal(recovery.actualRpoSeconds, actualRpoSeconds, 'PHASE5_RESILIENCE_RPO_MEASUREMENT_INVALID');
  equal(recovery.actualRtoSeconds, actualRtoSeconds, 'PHASE5_RESILIENCE_RTO_MEASUREMENT_INVALID');
  if (actualRpoSeconds > objectives.rpoTargetSeconds) fail('PHASE5_RESILIENCE_RPO_EXCEEDED');
  if (actualRtoSeconds > objectives.rtoTargetSeconds) fail('PHASE5_RESILIENCE_RTO_EXCEEDED');
  validateRecoveryComponents(recovery.components);
  validateCutoverRollback(recovery.cutoverRollback, environment, objectives.rtoTargetSeconds);
  return Object.freeze({ actualRpoSeconds, actualRtoSeconds });
}

function validateRecoveryComponents(components) {
  object(components, ['mongodb', 'redis', 'objectStorage', 'kms', 'services'],
    'PHASE5_RESILIENCE_COMPONENTS_INVALID');
  object(components.mongodb, [
    'pointInTimeRestore', 'replicaSetHealthy', 'transactionsVerified', 'indexesVerified',
    'restoredCollections', 'failedCollections', 'checksumMismatchCount', 'evidenceHash',
  ], 'PHASE5_RESILIENCE_MONGODB_INVALID');
  for (const field of ['pointInTimeRestore', 'replicaSetHealthy', 'transactionsVerified', 'indexesVerified']) {
    equal(components.mongodb[field], true, 'PHASE5_RESILIENCE_MONGODB_INVALID');
  }
  integer(components.mongodb.restoredCollections, 20, 10_000, 'PHASE5_RESILIENCE_MONGODB_INVALID');
  equal(components.mongodb.failedCollections, 0, 'PHASE5_RESILIENCE_MONGODB_INVALID');
  equal(components.mongodb.checksumMismatchCount, 0, 'PHASE5_RESILIENCE_MONGODB_INVALID');
  pattern(components.mongodb.evidenceHash, SHA256, 'PHASE5_RESILIENCE_MONGODB_INVALID');

  object(components.redis, [
    'treatedAsSourceOfTruth', 'rebuiltFromDurableState', 'cacheWarmupCompleted',
    'bullmqRecovered', 'orphanJobs', 'evidenceHash',
  ], 'PHASE5_RESILIENCE_REDIS_INVALID');
  equal(components.redis.treatedAsSourceOfTruth, false, 'PHASE5_RESILIENCE_REDIS_FACT_FORBIDDEN');
  for (const field of ['rebuiltFromDurableState', 'cacheWarmupCompleted', 'bullmqRecovered']) {
    equal(components.redis[field], true, 'PHASE5_RESILIENCE_REDIS_INVALID');
  }
  equal(components.redis.orphanJobs, 0, 'PHASE5_RESILIENCE_REDIS_INVALID');
  pattern(components.redis.evidenceHash, SHA256, 'PHASE5_RESILIENCE_REDIS_INVALID');

  object(components.objectStorage, [
    'wormImmutabilityVerified', 'retentionPolicyVerified', 'restoredObjectCount',
    'missingObjectCount', 'checksumMismatchCount', 'evidenceHash',
  ], 'PHASE5_RESILIENCE_OBJECT_STORAGE_INVALID');
  equal(
    components.objectStorage.wormImmutabilityVerified,
    true,
    'PHASE5_RESILIENCE_WORM_INVALID',
  );
  equal(
    components.objectStorage.retentionPolicyVerified,
    true,
    'PHASE5_RESILIENCE_WORM_INVALID',
  );
  integer(
    components.objectStorage.restoredObjectCount,
    1,
    Number.MAX_SAFE_INTEGER,
    'PHASE5_RESILIENCE_OBJECT_STORAGE_INVALID',
  );
  equal(components.objectStorage.missingObjectCount, 0, 'PHASE5_RESILIENCE_OBJECT_STORAGE_INVALID');
  equal(
    components.objectStorage.checksumMismatchCount,
    0,
    'PHASE5_RESILIENCE_OBJECT_STORAGE_INVALID',
  );
  pattern(
    components.objectStorage.evidenceHash,
    SHA256,
    'PHASE5_RESILIENCE_OBJECT_STORAGE_INVALID',
  );

  object(components.kms, [
    'keyVersionsVerified', 'decryptionProbesSucceeded', 'decryptionProbesFailed',
    'keyMaterialExported', 'evidenceHash',
  ], 'PHASE5_RESILIENCE_KMS_INVALID');
  integer(components.kms.keyVersionsVerified, 3, 1_000, 'PHASE5_RESILIENCE_KMS_INVALID');
  integer(
    components.kms.decryptionProbesSucceeded,
    20,
    Number.MAX_SAFE_INTEGER,
    'PHASE5_RESILIENCE_KMS_INVALID',
  );
  equal(components.kms.decryptionProbesFailed, 0, 'PHASE5_RESILIENCE_KMS_INVALID');
  equal(components.kms.keyMaterialExported, false, 'PHASE5_RESILIENCE_KEY_EXPORT_FORBIDDEN');
  pattern(components.kms.evidenceHash, SHA256, 'PHASE5_RESILIENCE_KMS_INVALID');

  object(components.services, [
    'apiHealthyReplicas', 'workerHealthyReplicas', 'webHealthyReplicas',
    'websiteHealthyReplicas',
    'smokeTestsPassed', 'smokeTestsFailed', 'evidenceHash',
  ], 'PHASE5_RESILIENCE_SERVICES_INVALID');
  for (const field of [
    'apiHealthyReplicas',
    'workerHealthyReplicas',
    'webHealthyReplicas',
    'websiteHealthyReplicas',
  ]) {
    integer(components.services[field], 2, 1_000, 'PHASE5_RESILIENCE_SERVICES_INVALID');
  }
  integer(
    components.services.smokeTestsPassed,
    20,
    Number.MAX_SAFE_INTEGER,
    'PHASE5_RESILIENCE_SERVICES_INVALID',
  );
  equal(components.services.smokeTestsFailed, 0, 'PHASE5_RESILIENCE_SERVICES_INVALID');
  pattern(components.services.evidenceHash, SHA256, 'PHASE5_RESILIENCE_SERVICES_INVALID');
}

function validateCutoverRollback(rollback, environment, rtoTargetSeconds) {
  object(rollback, [
    'performed', 'startedAt', 'endedAt', 'oldSystemReadWriteRestored',
    'newSystemWritesStopped', 'finalDeltaQuarantined', 'unexplainedDifferences',
    'evidenceHash',
  ], 'PHASE5_RESILIENCE_ROLLBACK_INVALID');
  equal(rollback.performed, true, 'PHASE5_RESILIENCE_ROLLBACK_REQUIRED');
  const startedAt = within(rollback.startedAt, environment, 'PHASE5_RESILIENCE_ROLLBACK_INVALID');
  const endedAt = within(rollback.endedAt, environment, 'PHASE5_RESILIENCE_ROLLBACK_INVALID');
  duration(startedAt, endedAt, 1, rtoTargetSeconds, 'PHASE5_RESILIENCE_ROLLBACK_RTO_EXCEEDED');
  for (const field of [
    'oldSystemReadWriteRestored', 'newSystemWritesStopped', 'finalDeltaQuarantined',
  ]) equal(rollback[field], true, 'PHASE5_RESILIENCE_ROLLBACK_INVALID');
  equal(rollback.unexplainedDifferences, 0, 'PHASE5_RESILIENCE_ROLLBACK_DIFFERENCE');
  pattern(rollback.evidenceHash, SHA256, 'PHASE5_RESILIENCE_ROLLBACK_INVALID');
}

function validateConsistency(consistency) {
  object(consistency, ['domains', 'outbox', 'inbox', 'bullmq', 'audit', 'business'],
    'PHASE5_RESILIENCE_CONSISTENCY_INVALID');
  if (!Array.isArray(consistency.domains) || consistency.domains.length !== DOMAIN_NAMES.length) {
    fail('PHASE5_RESILIENCE_DOMAINS_INCOMPLETE');
  }
  const names = [];
  for (const domain of consistency.domains) {
    object(domain, [
      'domain', 'recordCountBefore', 'recordCountAfter', 'relationCountBefore',
      'relationCountAfter', 'checksumBefore', 'checksumAfter',
    ], 'PHASE5_RESILIENCE_DOMAIN_INVALID');
    names.push(domain.domain);
    integer(domain.recordCountBefore, 1, Number.MAX_SAFE_INTEGER, 'PHASE5_RESILIENCE_DOMAIN_EMPTY');
    equal(domain.recordCountAfter, domain.recordCountBefore, 'PHASE5_RESILIENCE_RECORD_MISMATCH');
    integer(domain.relationCountBefore, 0, Number.MAX_SAFE_INTEGER, 'PHASE5_RESILIENCE_DOMAIN_INVALID');
    equal(domain.relationCountAfter, domain.relationCountBefore, 'PHASE5_RESILIENCE_RELATION_MISMATCH');
    pattern(domain.checksumBefore, SHA256, 'PHASE5_RESILIENCE_DOMAIN_CHECKSUM_INVALID');
    equal(domain.checksumAfter, domain.checksumBefore, 'PHASE5_RESILIENCE_DOMAIN_CHECKSUM_MISMATCH');
  }
  if (canonical(names.sort()) !== canonical(DOMAIN_NAMES)) fail('PHASE5_RESILIENCE_DOMAINS_INCOMPLETE');
  validateOutbox(consistency.outbox);
  validateInbox(consistency.inbox);
  validateBullmq(consistency.bullmq);
  validateAudit(consistency.audit);
  object(consistency.business, [
    'unexplainedRecordDifferences', 'unexplainedAmountDifferenceMinor', 'evidenceHash',
  ], 'PHASE5_RESILIENCE_BUSINESS_RECONCILIATION_INVALID');
  equal(
    consistency.business.unexplainedRecordDifferences,
    0,
    'PHASE5_RESILIENCE_BUSINESS_RECONCILIATION_FAILED',
  );
  equal(
    consistency.business.unexplainedAmountDifferenceMinor,
    0,
    'PHASE5_RESILIENCE_BUSINESS_RECONCILIATION_FAILED',
  );
  pattern(
    consistency.business.evidenceHash,
    SHA256,
    'PHASE5_RESILIENCE_BUSINESS_RECONCILIATION_INVALID',
  );
  return Object.freeze({ domains: names });
}

function validateOutbox(outbox) {
  object(outbox, [
    'pendingBeforeFailure', 'queuedDuringRecovery', 'dispatchedAfterRecovery', 'lostEvents',
    'duplicateBusinessEffects', 'orderingViolations', 'deadLetters', 'remainingPastSlo',
    'evidenceHash',
  ], 'PHASE5_RESILIENCE_OUTBOX_INVALID');
  for (const field of ['pendingBeforeFailure', 'queuedDuringRecovery']) {
    integer(outbox[field], 1, Number.MAX_SAFE_INTEGER, 'PHASE5_RESILIENCE_OUTBOX_COVERAGE');
  }
  equal(
    outbox.dispatchedAfterRecovery,
    outbox.pendingBeforeFailure + outbox.queuedDuringRecovery,
    'PHASE5_RESILIENCE_OUTBOX_LOSS',
  );
  for (const field of [
    'lostEvents', 'duplicateBusinessEffects', 'orderingViolations', 'deadLetters',
    'remainingPastSlo',
  ]) equal(outbox[field], 0, 'PHASE5_RESILIENCE_OUTBOX_RECONCILIATION_FAILED');
  pattern(outbox.evidenceHash, SHA256, 'PHASE5_RESILIENCE_OUTBOX_INVALID');
}

function validateInbox(inbox) {
  object(inbox, [
    'receivedEvents', 'uniqueEvents', 'duplicateDeliveries', 'businessEffectsApplied',
    'lostEvents', 'duplicateBusinessEffects', 'remainingPastSlo', 'evidenceHash',
  ], 'PHASE5_RESILIENCE_INBOX_INVALID');
  integer(inbox.uniqueEvents, 20, Number.MAX_SAFE_INTEGER, 'PHASE5_RESILIENCE_INBOX_COVERAGE');
  integer(inbox.duplicateDeliveries, 1, Number.MAX_SAFE_INTEGER, 'PHASE5_RESILIENCE_INBOX_COVERAGE');
  equal(
    inbox.receivedEvents,
    inbox.uniqueEvents + inbox.duplicateDeliveries,
    'PHASE5_RESILIENCE_INBOX_RECONCILIATION_FAILED',
  );
  equal(
    inbox.businessEffectsApplied,
    inbox.uniqueEvents,
    'PHASE5_RESILIENCE_INBOX_RECONCILIATION_FAILED',
  );
  for (const field of ['lostEvents', 'duplicateBusinessEffects', 'remainingPastSlo']) {
    equal(inbox[field], 0, 'PHASE5_RESILIENCE_INBOX_RECONCILIATION_FAILED');
  }
  pattern(inbox.evidenceHash, SHA256, 'PHASE5_RESILIENCE_INBOX_INVALID');
}

function validateBullmq(bullmq) {
  object(bullmq, [
    'jobsBeforeFailure', 'jobsEnqueuedDuringRecovery', 'jobsCompletedAfterRecovery',
    'jobsFailed', 'jobsOrphaned', 'jobsDuplicated', 'activeJobsAtEvidenceClose', 'evidenceHash',
  ], 'PHASE5_RESILIENCE_BULLMQ_INVALID');
  for (const field of ['jobsBeforeFailure', 'jobsEnqueuedDuringRecovery']) {
    integer(bullmq[field], 1, Number.MAX_SAFE_INTEGER, 'PHASE5_RESILIENCE_BULLMQ_COVERAGE');
  }
  equal(
    bullmq.jobsCompletedAfterRecovery,
    bullmq.jobsBeforeFailure + bullmq.jobsEnqueuedDuringRecovery,
    'PHASE5_RESILIENCE_BULLMQ_RECONCILIATION_FAILED',
  );
  for (const field of ['jobsFailed', 'jobsOrphaned', 'jobsDuplicated', 'activeJobsAtEvidenceClose']) {
    equal(bullmq[field], 0, 'PHASE5_RESILIENCE_BULLMQ_RECONCILIATION_FAILED');
  }
  pattern(bullmq.evidenceHash, SHA256, 'PHASE5_RESILIENCE_BULLMQ_INVALID');
}

function validateAudit(audit) {
  object(audit, [
    'tenantChainsVerified', 'brokenChains', 'wormAnchorsVerified', 'missingWormAnchors',
    'evidenceHash',
  ], 'PHASE5_RESILIENCE_AUDIT_INVALID');
  integer(audit.tenantChainsVerified, 2, Number.MAX_SAFE_INTEGER, 'PHASE5_RESILIENCE_AUDIT_COVERAGE');
  equal(audit.brokenChains, 0, 'PHASE5_RESILIENCE_AUDIT_CHAIN_BROKEN');
  integer(audit.wormAnchorsVerified, 2, Number.MAX_SAFE_INTEGER, 'PHASE5_RESILIENCE_AUDIT_COVERAGE');
  equal(audit.missingWormAnchors, 0, 'PHASE5_RESILIENCE_AUDIT_ANCHOR_MISSING');
  pattern(audit.evidenceHash, SHA256, 'PHASE5_RESILIENCE_AUDIT_INVALID');
}

function validateIntegrations(integrations, environment, objectives) {
  if (!Array.isArray(integrations) || integrations.length !== Object.keys(INTEGRATION_PROFILES).length) {
    fail('PHASE5_RESILIENCE_INTEGRATIONS_INCOMPLETE');
  }
  const providers = [];
  const evidenceHashes = new Set();
  for (const integration of integrations) {
    object(integration, [
      'provider', 'profile', 'outageStartedAt', 'outageEndedAt', 'requestsAttempted',
      'queuedEvents', 'deliveredAfterRecovery', 'lostEvents', 'duplicateBusinessEffects',
      'orderingViolations', 'deadLetters', 'unreconciledEvents', 'catchUpStartedAt',
      'catchUpEndedAt', 'circuitBreakerOpened', 'alertFired', 'automaticCatchUp',
      'manualDataRepair', 'reconciliationHash', 'monitoringHash', 'auditHash',
    ], 'PHASE5_RESILIENCE_INTEGRATION_INVALID');
    if (!Object.hasOwn(INTEGRATION_PROFILES, integration.provider)) {
      fail('PHASE5_RESILIENCE_PROVIDER_INVALID');
    }
    const expectedProfile = INTEGRATION_PROFILES[integration.provider];
    equal(integration.profile, expectedProfile, 'PHASE5_RESILIENCE_PROVIDER_PROFILE_INVALID');
    providers.push(integration.provider);
    const outageStartedAt = within(
      integration.outageStartedAt,
      environment,
      'PHASE5_RESILIENCE_OUTAGE_TIME_INVALID',
    );
    const outageEndedAt = within(
      integration.outageEndedAt,
      environment,
      'PHASE5_RESILIENCE_OUTAGE_TIME_INVALID',
    );
    duration(
      outageStartedAt,
      outageEndedAt,
      objectives.integrationOutageTargetSeconds,
      6 * 60 * 60,
      'PHASE5_RESILIENCE_OUTAGE_DURATION_INSUFFICIENT',
    );
    const catchUpStartedAt = within(
      integration.catchUpStartedAt,
      environment,
      'PHASE5_RESILIENCE_CATCHUP_TIME_INVALID',
    );
    const catchUpEndedAt = within(
      integration.catchUpEndedAt,
      environment,
      'PHASE5_RESILIENCE_CATCHUP_TIME_INVALID',
    );
    if (catchUpStartedAt < outageEndedAt) fail('PHASE5_RESILIENCE_CATCHUP_TIME_INVALID');
    duration(
      catchUpStartedAt,
      catchUpEndedAt,
      1,
      objectives.catchUpTargetSeconds,
      'PHASE5_RESILIENCE_CATCHUP_SLO_EXCEEDED',
    );
    integer(
      integration.requestsAttempted,
      20,
      Number.MAX_SAFE_INTEGER,
      'PHASE5_RESILIENCE_INTEGRATION_COVERAGE',
    );
    integer(
      integration.queuedEvents,
      10,
      Number.MAX_SAFE_INTEGER,
      'PHASE5_RESILIENCE_INTEGRATION_COVERAGE',
    );
    equal(
      integration.deliveredAfterRecovery,
      integration.queuedEvents,
      'PHASE5_RESILIENCE_INTEGRATION_LOSS',
    );
    for (const field of [
      'lostEvents', 'duplicateBusinessEffects', 'orderingViolations', 'deadLetters',
      'unreconciledEvents',
    ]) equal(integration[field], 0, 'PHASE5_RESILIENCE_INTEGRATION_RECONCILIATION_FAILED');
    for (const field of ['circuitBreakerOpened', 'alertFired', 'automaticCatchUp']) {
      equal(integration[field], true, 'PHASE5_RESILIENCE_INTEGRATION_CONTROL_FAILED');
    }
    equal(integration.manualDataRepair, false, 'PHASE5_RESILIENCE_MANUAL_REPAIR_FORBIDDEN');
    for (const field of ['reconciliationHash', 'monitoringHash', 'auditHash']) {
      pattern(integration[field], SHA256, 'PHASE5_RESILIENCE_INTEGRATION_EVIDENCE_INVALID');
      evidenceHashes.add(integration[field]);
    }
  }
  if (
    canonical(providers.sort()) !== canonical(Object.keys(INTEGRATION_PROFILES).sort()) ||
    evidenceHashes.size !== integrations.length * 3
  ) fail('PHASE5_RESILIENCE_INTEGRATIONS_NOT_INDEPENDENT');
  return Object.freeze({ providers, evidenceHashes: [...evidenceHashes] });
}

function validateSafety(safety) {
  object(safety, [
    'productionDataUsed', 'productionTrafficUsed', 'productionEndpointsUsed',
    'realFundsMoved', 'realTaxFiled', 'realContractsSigned', 'realMessagesSent',
    'r3ActionsEnabled', 'secretsInEvidence', 'keyMaterialExported', 'breakGlassUsed',
    'destructiveProductionAction',
  ], 'PHASE5_RESILIENCE_SAFETY_INVALID');
  for (const value of Object.values(safety)) {
    equal(value, false, 'PHASE5_RESILIENCE_UNSAFE_SIDE_EFFECT');
  }
}

function validateArtifacts(artifacts) {
  object(artifacts, [
    'backupManifestHash', 'restoreLogsHash', 'reconciliationReportHash',
    'monitoringReportHash', 'alertReportHash', 'adapterMatrixHash', 'runbookHash',
    'rollbackDecisionHash',
  ], 'PHASE5_RESILIENCE_ARTIFACTS_INVALID');
  const hashes = Object.values(artifacts);
  for (const hash of hashes) pattern(hash, SHA256, 'PHASE5_RESILIENCE_ARTIFACT_INVALID');
  if (new Set(hashes).size !== hashes.length) fail('PHASE5_RESILIENCE_ARTIFACT_REUSED');
  return artifacts;
}

function validateSignoffs(signoffs, endedAt) {
  if (!Array.isArray(signoffs) || signoffs.length !== SIGNOFF_ROLES.length) {
    fail('PHASE5_RESILIENCE_SIGNOFFS_INCOMPLETE');
  }
  const roles = [];
  const evidenceIds = new Set();
  const commentHashes = new Set();
  for (const signoff of signoffs) {
    object(signoff, ['role', 'decision', 'evidenceId', 'commentHash', 'signedAt'],
      'PHASE5_RESILIENCE_SIGNOFF_INVALID');
    equal(signoff.decision, 'approve', 'PHASE5_RESILIENCE_SIGNOFF_REJECTED');
    pattern(signoff.evidenceId, ULID, 'PHASE5_RESILIENCE_SIGNOFF_EVIDENCE_INVALID');
    pattern(signoff.commentHash, SHA256, 'PHASE5_RESILIENCE_SIGNOFF_COMMENT_INVALID');
    if (timestamp(signoff.signedAt) < endedAt) fail('PHASE5_RESILIENCE_SIGNOFF_TIME_INVALID');
    roles.push(signoff.role);
    evidenceIds.add(signoff.evidenceId);
    commentHashes.add(signoff.commentHash);
  }
  if (
    canonical(roles.sort()) !== canonical(SIGNOFF_ROLES) ||
    evidenceIds.size !== SIGNOFF_ROLES.length || commentHashes.size !== SIGNOFF_ROLES.length
  ) fail('PHASE5_RESILIENCE_SIGNOFFS_INCOMPLETE');
  return [...evidenceIds];
}

function runSelfTest() {
  validateEvidence(fixture());

  const environmentBound = fixture();
  process.env.RESILIENCE_EXPECTED_ENVIRONMENT = environmentBound.environment.name;
  process.env.RESILIENCE_EXPECTED_REGION = environmentBound.environment.region;
  process.env.RESILIENCE_EXPECTED_COMMIT = environmentBound.source.commitSha;
  process.env.RESILIENCE_EXPECTED_API_IMAGE = environmentBound.source.images.api;
  process.env.RESILIENCE_EXPECTED_WORKER_IMAGE = environmentBound.source.images.worker;
  process.env.RESILIENCE_EXPECTED_WEB_IMAGE = environmentBound.source.images.web;
  process.env.RESILIENCE_EXPECTED_WEBSITE_IMAGE = environmentBound.source.images.website;
  process.env.RESILIENCE_EXPECTED_PAYROLL_IMAGE =
    environmentBound.source.professionalPayrollImage;
  process.env.RESILIENCE_EXPECTED_DEPLOYMENT_MANIFEST =
    environmentBound.source.deploymentManifestHash;
  validateEvidence(environmentBound, true);
  process.env.RESILIENCE_EXPECTED_COMMIT = 'b'.repeat(40);
  expectFailure(
    () => validateEvidence(environmentBound, true),
    'PHASE5_RESILIENCE_COMMIT_MISMATCH',
  );

  const rpoExceeded = fixture();
  rpoExceeded.disasterRecovery.lastRecoverablePointAt = '2026-07-01T23:54:59.000Z';
  rpoExceeded.disasterRecovery.actualRpoSeconds = 901;
  expectFailure(() => validateEvidence(rpoExceeded), 'PHASE5_RESILIENCE_RPO_EXCEEDED');

  const rtoExceeded = fixture();
  rtoExceeded.disasterRecovery.serviceRecoveredAt = '2026-07-02T04:10:01.000Z';
  rtoExceeded.disasterRecovery.actualRtoSeconds = 14_401;
  expectFailure(() => validateEvidence(rtoExceeded), 'PHASE5_RESILIENCE_RTO_EXCEEDED');

  const shortOutage = fixture();
  shortOutage.integrations[0].outageEndedAt = '2026-07-02T02:14:59.000Z';
  expectFailure(
    () => validateEvidence(shortOutage),
    'PHASE5_RESILIENCE_OUTAGE_DURATION_INSUFFICIENT',
  );

  const duplicateEffect = fixture();
  duplicateEffect.integrations[0].duplicateBusinessEffects = 1;
  expectFailure(
    () => validateEvidence(duplicateEffect),
    'PHASE5_RESILIENCE_INTEGRATION_RECONCILIATION_FAILED',
  );

  const unsafe = fixture();
  unsafe.safety.realFundsMoved = true;
  expectFailure(() => validateEvidence(unsafe), 'PHASE5_RESILIENCE_UNSAFE_SIDE_EFFECT');

  const forgedHarness = fixture();
  forgedHarness.source.harnessSha256 = digest('forged');
  expectFailure(() => validateEvidence(forgedHarness), 'PHASE5_RESILIENCE_HARNESS_INVALID');

  const missingSignoff = fixture();
  missingSignoff.signoffs.pop();
  expectFailure(() => validateEvidence(missingSignoff), 'PHASE5_RESILIENCE_SIGNOFFS_INCOMPLETE');
}

function fixture() {
  const hash = (label) => digest(label);
  const domains = DOMAIN_NAMES.map((domain, index) => ({
    domain,
    recordCountBefore: 100 + index,
    recordCountAfter: 100 + index,
    relationCountBefore: 50 + index,
    relationCountAfter: 50 + index,
    checksumBefore: hash(`domain-${domain}`),
    checksumAfter: hash(`domain-${domain}`),
  }));
  const integrations = Object.entries(INTEGRATION_PROFILES).map(([provider, profile], index) => ({
    provider,
    profile,
    outageStartedAt: '2026-07-02T00:15:00.000Z',
    outageEndedAt: '2026-07-02T02:15:00.000Z',
    requestsAttempted: 40,
    queuedEvents: 20,
    deliveredAfterRecovery: 20,
    lostEvents: 0,
    duplicateBusinessEffects: 0,
    orderingViolations: 0,
    deadLetters: 0,
    unreconciledEvents: 0,
    catchUpStartedAt: '2026-07-02T02:15:00.000Z',
    catchUpEndedAt: '2026-07-02T02:45:00.000Z',
    circuitBreakerOpened: true,
    alertFired: true,
    automaticCatchUp: true,
    manualDataRepair: false,
    reconciliationHash: hash(`integration-${index}-reconciliation`),
    monitoringHash: hash(`integration-${index}-monitoring`),
    auditHash: hash(`integration-${index}-audit`),
  }));
  return {
    formatVersion: 2,
    suite: 'gaoq.phase5.resilience.v2',
    runId: '01J8ZQK7V0A2M4N6P8R0T2W6B1',
    environment: {
      name: 'resilience-stage',
      region: 'cn-test-1',
      productionEquivalent: true,
      productionTraffic: false,
      isolatedRecovery: true,
      syntheticData: true,
      startedAt: '2026-07-02T00:00:00.000Z',
      endedAt: '2026-07-02T05:00:00.000Z',
    },
    source: {
      commitSha: 'a'.repeat(40),
      images: {
        api: hash('api'),
        worker: hash('worker'),
        web: hash('web'),
        website: hash('website'),
      },
      professionalPayrollImage: hash('professional-payroll-image'),
      rehearsalPlanVersion: 'phase-5-resilience-v2',
      harnessSha256: HARNESS_DIGEST,
      deploymentManifestHash: hash('deployment-manifest'),
    },
    objectives: {
      rpoTargetSeconds: 900,
      rtoTargetSeconds: 14_400,
      integrationOutageTargetSeconds: 7_200,
      catchUpTargetSeconds: 3_600,
    },
    disasterRecovery: {
      scenario: 'isolated-region-loss',
      primaryRegionUnavailable: true,
      failureDeclaredAt: '2026-07-02T00:10:00.000Z',
      lastRecoverablePointAt: '2026-07-02T00:00:00.000Z',
      databaseRecoveredAt: '2026-07-02T01:10:00.000Z',
      serviceRecoveredAt: '2026-07-02T02:10:00.000Z',
      actualRpoSeconds: 600,
      actualRtoSeconds: 7_200,
      components: {
        mongodb: {
          pointInTimeRestore: true,
          replicaSetHealthy: true,
          transactionsVerified: true,
          indexesVerified: true,
          restoredCollections: 42,
          failedCollections: 0,
          checksumMismatchCount: 0,
          evidenceHash: hash('mongodb'),
        },
        redis: {
          treatedAsSourceOfTruth: false,
          rebuiltFromDurableState: true,
          cacheWarmupCompleted: true,
          bullmqRecovered: true,
          orphanJobs: 0,
          evidenceHash: hash('redis'),
        },
        objectStorage: {
          wormImmutabilityVerified: true,
          retentionPolicyVerified: true,
          restoredObjectCount: 100,
          missingObjectCount: 0,
          checksumMismatchCount: 0,
          evidenceHash: hash('object-storage'),
        },
        kms: {
          keyVersionsVerified: 6,
          decryptionProbesSucceeded: 40,
          decryptionProbesFailed: 0,
          keyMaterialExported: false,
          evidenceHash: hash('kms'),
        },
        services: {
          apiHealthyReplicas: 2,
          workerHealthyReplicas: 2,
          webHealthyReplicas: 2,
          websiteHealthyReplicas: 2,
          smokeTestsPassed: 40,
          smokeTestsFailed: 0,
          evidenceHash: hash('services'),
        },
      },
      cutoverRollback: {
        performed: true,
        startedAt: '2026-07-02T02:45:00.000Z',
        endedAt: '2026-07-02T03:15:00.000Z',
        oldSystemReadWriteRestored: true,
        newSystemWritesStopped: true,
        finalDeltaQuarantined: true,
        unexplainedDifferences: 0,
        evidenceHash: hash('cutover-rollback'),
      },
    },
    consistency: {
      domains,
      outbox: {
        pendingBeforeFailure: 10,
        queuedDuringRecovery: 40,
        dispatchedAfterRecovery: 50,
        lostEvents: 0,
        duplicateBusinessEffects: 0,
        orderingViolations: 0,
        deadLetters: 0,
        remainingPastSlo: 0,
        evidenceHash: hash('outbox'),
      },
      inbox: {
        receivedEvents: 50,
        uniqueEvents: 40,
        duplicateDeliveries: 10,
        businessEffectsApplied: 40,
        lostEvents: 0,
        duplicateBusinessEffects: 0,
        remainingPastSlo: 0,
        evidenceHash: hash('inbox'),
      },
      bullmq: {
        jobsBeforeFailure: 10,
        jobsEnqueuedDuringRecovery: 40,
        jobsCompletedAfterRecovery: 50,
        jobsFailed: 0,
        jobsOrphaned: 0,
        jobsDuplicated: 0,
        activeJobsAtEvidenceClose: 0,
        evidenceHash: hash('bullmq'),
      },
      audit: {
        tenantChainsVerified: 2,
        brokenChains: 0,
        wormAnchorsVerified: 2,
        missingWormAnchors: 0,
        evidenceHash: hash('audit'),
      },
      business: {
        unexplainedRecordDifferences: 0,
        unexplainedAmountDifferenceMinor: 0,
        evidenceHash: hash('business'),
      },
    },
    integrations,
    safety: {
      productionDataUsed: false,
      productionTrafficUsed: false,
      productionEndpointsUsed: false,
      realFundsMoved: false,
      realTaxFiled: false,
      realContractsSigned: false,
      realMessagesSent: false,
      r3ActionsEnabled: false,
      secretsInEvidence: false,
      keyMaterialExported: false,
      breakGlassUsed: false,
      destructiveProductionAction: false,
    },
    artifacts: Object.fromEntries([
      'backupManifestHash', 'restoreLogsHash', 'reconciliationReportHash',
      'monitoringReportHash', 'alertReportHash', 'adapterMatrixHash', 'runbookHash',
      'rollbackDecisionHash',
    ].map((name) => [name, hash(`artifact-${name}`)])),
    signoffs: SIGNOFF_ROLES.map((role, index) => ({
      role,
      decision: 'approve',
      evidenceId: `01J8ZQK7V0A2M4N6P8R0T2W6C${index + 1}`,
      commentHash: hash(`signoff-${role}`),
      signedAt: `2026-07-02T05:${String(index).padStart(2, '0')}:00.000Z`,
    })),
  };
}

function parseDocument(content) {
  try {
    return JSON.parse(content);
  } catch {
    fail('PHASE5_RESILIENCE_EVIDENCE_JSON_INVALID');
  }
}

function object(value, keys, code) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(code);
  if (canonical(Object.keys(value).sort()) !== canonical([...keys].sort())) fail(code);
}

function integer(value, minimum, maximum, code) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(code);
}

function equal(actual, expected, code) {
  if (actual !== expected) fail(code);
}

function pattern(value, expression, code) {
  if (typeof value !== 'string' || !expression.test(value)) fail(code);
}

function timestamp(value) {
  if (typeof value !== 'string') fail('PHASE5_RESILIENCE_TIMESTAMP_INVALID');
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    fail('PHASE5_RESILIENCE_TIMESTAMP_INVALID');
  }
  return parsed;
}

function within(value, environment, code) {
  const parsed = timestamp(value);
  if (parsed < environment.startedAt || parsed > environment.endedAt) fail(code);
  return parsed;
}

function duration(startedAt, endedAt, minimumSeconds, maximumSeconds, code) {
  const measured = secondsBetween(startedAt, endedAt);
  if (measured < minimumSeconds || measured > maximumSeconds) fail(code);
}

function secondsBetween(startedAt, endedAt) {
  return Math.floor((endedAt - startedAt) / 1_000);
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
