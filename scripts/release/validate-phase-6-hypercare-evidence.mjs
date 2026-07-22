import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';

const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const RELEASE = /^rc-[0-9]{8}-[0-9]{2}$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const RECONCILIATION_DOMAINS = [
  'approval', 'esign', 'external-callbacks', 'mcp', 'org', 'payroll', 'queues',
];
const ARCHIVE_SIGNOFF_ROLES = ['data_owner', 'finance_owner', 'legal_owner'];
const HARNESS_FILES = [
  ['./validate-phase-6-hypercare-evidence.mjs', new URL(import.meta.url)],
  ['../../.github/workflows/phase-6-hypercare.yml',
    new URL('../../.github/workflows/phase-6-hypercare.yml', import.meta.url)],
];
const HARNESS_DIGEST = digest(canonical(Object.fromEntries(await Promise.all(
  HARNESS_FILES.map(async ([name, location]) => [name, await readFile(location, 'utf8')]),
))));

const argumentsList = process.argv.slice(2);
if (argumentsList.length === 1 && argumentsList[0] === '--self-test') {
  runSelfTest();
  process.stdout.write('Phase 6 Hypercare 与旧系统归档证据门禁自测通过。\n');
} else {
  const enforceEnvironment = argumentsList[0] === '--enforce-environment';
  const evidencePath = argumentsList[enforceEnvironment ? 1 : 0];
  if (evidencePath === undefined || argumentsList.length !== (enforceEnvironment ? 2 : 1)) {
    fail('PHASE6_HYPERCARE_EVIDENCE_PATH_REQUIRED');
  }
  const metadata = await lstat(evidencePath);
  if (
    !metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 ||
    metadata.size > 1_024 * 1_024 || (metadata.mode & 0o022) !== 0
  ) fail('PHASE6_HYPERCARE_EVIDENCE_FILE_INVALID');
  const summary = validateEvidence(
    parseDocument(await readFile(evidencePath, 'utf8')),
    enforceEnvironment,
  );
  process.stdout.write(`${JSON.stringify({
    formatVersion: 1,
    suite: 'gaoq.phase6.hypercare-archive.verdict',
    releaseId: summary.releaseId,
    outcome: 'ARCHIVE_APPROVED',
    commitSha: summary.commitSha,
    evidenceChecksum: digest(canonical(summary)),
  }, null, 2)}\n`);
}

/** 校验连续 28 天稳定期和只读归档证据。 */
function validateEvidence(document, enforceEnvironment = false) {
  object(document, [
    'formatVersion', 'suite', 'releaseId', 'source', 'production', 'cutover', 'period',
    'days', 'aggregate', 'legacySystem', 'archiveSignoffs', 'archive',
  ], 'PHASE6_HYPERCARE_DOCUMENT_INVALID');
  equal(document.formatVersion, 1, 'PHASE6_HYPERCARE_FORMAT_INVALID');
  equal(document.suite, 'gaoq.phase6.hypercare-archive.v1',
    'PHASE6_HYPERCARE_SUITE_INVALID');
  pattern(document.releaseId, ULID, 'PHASE6_HYPERCARE_RELEASE_ID_INVALID');
  const source = validateSource(document.source, enforceEnvironment);
  validateProduction(document.production, enforceEnvironment);
  const cutoverCompletedAt = validateCutover(document.cutover, source, document.releaseId);
  const period = validatePeriod(document.period, cutoverCompletedAt);
  const dailyHashes = validateDays(document.days, period);
  validateAggregate(document.aggregate, document.days);
  validateLegacySystem(document.legacySystem, document.days);
  const signoffs = validateSignoffs(document.archiveSignoffs, period.completedAt);
  validateArchive(document.archive, signoffs.maximumSignedAt);
  return Object.freeze({
    releaseId: document.releaseId,
    commitSha: source.commitSha,
    cutoverEvidenceHash: document.cutover.evidenceHash,
    period: document.period,
    dailyEvidenceHashes: dailyHashes,
    archiveSignoffEvidenceIds: signoffs.evidenceIds,
    archiveEvidenceHash: document.archive.evidenceHash,
  });
}

function validateSource(source, enforceEnvironment) {
  object(source, ['commitSha', 'releaseCandidate', 'harnessSha256'],
    'PHASE6_HYPERCARE_SOURCE_INVALID');
  pattern(source.commitSha, COMMIT, 'PHASE6_HYPERCARE_COMMIT_INVALID');
  pattern(source.releaseCandidate, RELEASE, 'PHASE6_HYPERCARE_RC_INVALID');
  equal(source.harnessSha256, HARNESS_DIGEST, 'PHASE6_HYPERCARE_HARNESS_INVALID');
  if (enforceEnvironment) {
    equal(source.commitSha, process.env.PHASE6_HYPERCARE_EXPECTED_COMMIT,
      'PHASE6_HYPERCARE_COMMIT_MISMATCH');
    equal(source.releaseCandidate, process.env.PHASE6_HYPERCARE_EXPECTED_RELEASE,
      'PHASE6_HYPERCARE_RELEASE_MISMATCH');
  }
  return source;
}

function validateProduction(production, enforceEnvironment) {
  object(production, ['environment', 'region', 'timezone', 'production'],
    'PHASE6_HYPERCARE_PRODUCTION_INVALID');
  pattern(production.environment, /^[a-z][a-z0-9-]{2,31}$/u,
    'PHASE6_HYPERCARE_PRODUCTION_INVALID');
  if (!/(?:^|-)prod(?:-|$)|production/u.test(production.environment)) {
    fail('PHASE6_HYPERCARE_PRODUCTION_INVALID');
  }
  pattern(production.region, /^[a-z0-9-]{2,32}$/u, 'PHASE6_HYPERCARE_REGION_INVALID');
  equal(production.timezone, 'Asia/Shanghai', 'PHASE6_HYPERCARE_TIMEZONE_INVALID');
  equal(production.production, true, 'PHASE6_HYPERCARE_PRODUCTION_INVALID');
  if (enforceEnvironment) {
    equal(production.environment, process.env.PHASE6_HYPERCARE_EXPECTED_ENVIRONMENT,
      'PHASE6_HYPERCARE_ENVIRONMENT_MISMATCH');
    equal(production.region, process.env.PHASE6_HYPERCARE_EXPECTED_REGION,
      'PHASE6_HYPERCARE_REGION_MISMATCH');
  }
}

function validateCutover(cutover, source, releaseId) {
  object(cutover, [
    'releaseId', 'outcome', 'subjectCommitSha', 'releaseCandidate', 'evidenceHash',
    'completedAt',
  ], 'PHASE6_HYPERCARE_CUTOVER_INVALID');
  pattern(cutover.releaseId, ULID, 'PHASE6_HYPERCARE_CUTOVER_INVALID');
  equal(cutover.releaseId, releaseId, 'PHASE6_HYPERCARE_CUTOVER_MISMATCH');
  equal(cutover.outcome, 'CUTOVER_COMPLETED', 'PHASE6_HYPERCARE_CUTOVER_INVALID');
  equal(cutover.subjectCommitSha, source.commitSha, 'PHASE6_HYPERCARE_CUTOVER_MISMATCH');
  equal(cutover.releaseCandidate, source.releaseCandidate, 'PHASE6_HYPERCARE_CUTOVER_MISMATCH');
  pattern(cutover.evidenceHash, SHA256, 'PHASE6_HYPERCARE_CUTOVER_INVALID');
  const expectedHash = process.env.PHASE6_HYPERCARE_EXPECTED_CUTOVER_EVIDENCE;
  if (expectedHash !== undefined) {
    pattern(expectedHash, SHA256, 'PHASE6_HYPERCARE_EXPECTED_CUTOVER_REQUIRED');
    equal(cutover.evidenceHash, expectedHash, 'PHASE6_HYPERCARE_CUTOVER_MISMATCH');
  }
  return timestamp(cutover.completedAt);
}

function validatePeriod(period, cutoverCompletedAt) {
  object(period, ['startDate', 'endDate', 'calendarDays', 'completedAt'],
    'PHASE6_HYPERCARE_PERIOD_INVALID');
  const start = calendarDate(period.startDate);
  const end = calendarDate(period.endDate);
  equal(period.calendarDays, 28, 'PHASE6_HYPERCARE_PERIOD_INVALID');
  equal(daysBetween(start, end), 27, 'PHASE6_HYPERCARE_PERIOD_INVALID');
  if (start <= cutoverCompletedAt) fail('PHASE6_HYPERCARE_PERIOD_INVALID');
  const completedAt = timestamp(period.completedAt);
  if (completedAt < end + 24 * 60 * 60 * 1_000) fail('PHASE6_HYPERCARE_PERIOD_INCOMPLETE');
  return Object.freeze({ start, end, completedAt });
}

function validateDays(days, period) {
  if (!Array.isArray(days) || days.length !== 28) fail('PHASE6_HYPERCARE_DAYS_INCOMPLETE');
  const hashes = new Set();
  for (const [index, day] of days.entries()) {
    object(day, [
      'sequence', 'date', 'status', 'slo', 'incidents', 'safety', 'reconciliations',
      'resolvedDifferences', 'unresolvedDifferences', 'evidenceHash', 'closedAt',
    ], 'PHASE6_HYPERCARE_DAY_INVALID');
    equal(day.sequence, index + 1, 'PHASE6_HYPERCARE_DAY_ORDER_INVALID');
    const expectedDate = period.start + index * 24 * 60 * 60 * 1_000;
    equal(calendarDate(day.date), expectedDate, 'PHASE6_HYPERCARE_DAY_ORDER_INVALID');
    equal(day.status, 'passed', 'PHASE6_HYPERCARE_DAY_FAILED');
    validateSlo(day.slo);
    validateIncidents(day.incidents);
    validateSafety(day.safety);
    validateReconciliations(day.reconciliations);
    integer(day.resolvedDifferences, 0, Number.MAX_SAFE_INTEGER,
      'PHASE6_HYPERCARE_DIFFERENCE_INVALID');
    equal(day.unresolvedDifferences, 0, 'PHASE6_HYPERCARE_DIFFERENCE_OPEN');
    pattern(day.evidenceHash, SHA256, 'PHASE6_HYPERCARE_DAY_INVALID');
    if (hashes.has(day.evidenceHash)) fail('PHASE6_HYPERCARE_DAILY_EVIDENCE_REUSED');
    hashes.add(day.evidenceHash);
    const closedAt = timestamp(day.closedAt);
    if (
      closedAt < expectedDate + 24 * 60 * 60 * 1_000 ||
      closedAt > expectedDate + 48 * 60 * 60 * 1_000 || closedAt > period.completedAt
    ) {
      fail('PHASE6_HYPERCARE_DAY_CLOSE_TIME_INVALID');
    }
  }
  return [...hashes];
}

function validateSlo(slo) {
  object(slo, [
    'apiAvailability', 'maximumApiP95Milliseconds', 'failedJobs', 'queueLagSeconds',
    'databaseHealthy', 'cacheRebuildable', 'sloBreaches',
  ], 'PHASE6_HYPERCARE_SLO_INVALID');
  numberRange(slo.apiAvailability, 0.999, 1, 'PHASE6_HYPERCARE_SLO_BREACH');
  numberRange(slo.maximumApiP95Milliseconds, 0, 499.999, 'PHASE6_HYPERCARE_SLO_BREACH');
  equal(slo.failedJobs, 0, 'PHASE6_HYPERCARE_SLO_BREACH');
  integer(slo.queueLagSeconds, 0, 300, 'PHASE6_HYPERCARE_SLO_BREACH');
  equal(slo.databaseHealthy, true, 'PHASE6_HYPERCARE_SLO_BREACH');
  equal(slo.cacheRebuildable, true, 'PHASE6_HYPERCARE_SLO_BREACH');
  equal(slo.sloBreaches, 0, 'PHASE6_HYPERCARE_SLO_BREACH');
}

function validateIncidents(incidents) {
  object(incidents, ['sev1', 'sev2', 'openSev3', 'unreviewedIncidents'],
    'PHASE6_HYPERCARE_INCIDENT_INVALID');
  for (const field of ['sev1', 'sev2', 'openSev3', 'unreviewedIncidents']) {
    equal(incidents[field], 0, 'PHASE6_HYPERCARE_INCIDENT_OPEN');
  }
}

function validateSafety(safety) {
  object(safety, [
    'crossTenantAttempts', 'crossTenantDenied', 'lostEvents', 'duplicateBusinessEffects',
    'unexplainedAmountDifferenceMinor', 'legacyWriteAttempts', 'legacyWriteRejected',
  ], 'PHASE6_HYPERCARE_SAFETY_INVALID');
  integer(safety.crossTenantAttempts, 1, Number.MAX_SAFE_INTEGER,
    'PHASE6_HYPERCARE_TENANT_COVERAGE_INVALID');
  equal(safety.crossTenantDenied, safety.crossTenantAttempts, 'PHASE6_HYPERCARE_TENANT_ESCAPE');
  equal(safety.lostEvents, 0, 'PHASE6_HYPERCARE_SAFETY_FAILED');
  equal(safety.duplicateBusinessEffects, 0, 'PHASE6_HYPERCARE_SAFETY_FAILED');
  equal(safety.unexplainedAmountDifferenceMinor, 0, 'PHASE6_HYPERCARE_AMOUNT_DIFFERENCE');
  integer(safety.legacyWriteAttempts, 1, Number.MAX_SAFE_INTEGER,
    'PHASE6_HYPERCARE_LEGACY_PROBE_MISSING');
  equal(safety.legacyWriteRejected, safety.legacyWriteAttempts,
    'PHASE6_HYPERCARE_LEGACY_WRITE_ACCEPTED');
}

function validateReconciliations(reconciliations) {
  if (!Array.isArray(reconciliations) || reconciliations.length !== RECONCILIATION_DOMAINS.length) {
    fail('PHASE6_HYPERCARE_RECONCILIATION_INCOMPLETE');
  }
  const domains = [];
  for (const reconciliation of reconciliations) {
    object(reconciliation, [
      'domain', 'status', 'sourceCount', 'targetCount', 'unresolvedDifferences',
      'evidenceHash',
    ], 'PHASE6_HYPERCARE_RECONCILIATION_INVALID');
    equal(reconciliation.status, 'passed', 'PHASE6_HYPERCARE_RECONCILIATION_FAILED');
    integer(reconciliation.sourceCount, 0, Number.MAX_SAFE_INTEGER,
      'PHASE6_HYPERCARE_RECONCILIATION_INVALID');
    equal(reconciliation.targetCount, reconciliation.sourceCount,
      'PHASE6_HYPERCARE_RECONCILIATION_DIFFERENCE');
    equal(reconciliation.unresolvedDifferences, 0,
      'PHASE6_HYPERCARE_RECONCILIATION_DIFFERENCE');
    pattern(reconciliation.evidenceHash, SHA256, 'PHASE6_HYPERCARE_RECONCILIATION_INVALID');
    domains.push(reconciliation.domain);
  }
  exactStringSet(domains, RECONCILIATION_DOMAINS, 'PHASE6_HYPERCARE_RECONCILIATION_INCOMPLETE');
}

function validateAggregate(aggregate, days) {
  object(aggregate, [
    'daysPassed', 'sloBreaches', 'sev1', 'sev2', 'unresolvedDifferences',
    'unexplainedAmountDifferenceMinor', 'legacyWriteAccepted',
  ], 'PHASE6_HYPERCARE_AGGREGATE_INVALID');
  equal(aggregate.daysPassed, days.filter((day) => day.status === 'passed').length,
    'PHASE6_HYPERCARE_AGGREGATE_INVALID');
  equal(aggregate.daysPassed, 28, 'PHASE6_HYPERCARE_AGGREGATE_INVALID');
  for (const field of [
    'sloBreaches', 'sev1', 'sev2', 'unresolvedDifferences',
    'unexplainedAmountDifferenceMinor', 'legacyWriteAccepted',
  ]) equal(aggregate[field], 0, 'PHASE6_HYPERCARE_AGGREGATE_FAILED');
}

function validateLegacySystem(legacy, days) {
  object(legacy, [
    'readOnlyThroughout', 'accessAuditRetained', 'encrypted', 'recordCount',
    'objectCount', 'dataChecksum', 'auditChecksum', 'retentionPolicyId',
    'deletionPerformed', 'evidenceHash',
  ], 'PHASE6_HYPERCARE_LEGACY_INVALID');
  for (const field of ['readOnlyThroughout', 'accessAuditRetained', 'encrypted']) {
    equal(legacy[field], true, 'PHASE6_HYPERCARE_LEGACY_INVALID');
  }
  integer(legacy.recordCount, 1, Number.MAX_SAFE_INTEGER, 'PHASE6_HYPERCARE_LEGACY_INVALID');
  integer(legacy.objectCount, 0, Number.MAX_SAFE_INTEGER, 'PHASE6_HYPERCARE_LEGACY_INVALID');
  pattern(legacy.dataChecksum, SHA256, 'PHASE6_HYPERCARE_LEGACY_INVALID');
  pattern(legacy.auditChecksum, SHA256, 'PHASE6_HYPERCARE_LEGACY_INVALID');
  pattern(legacy.retentionPolicyId, /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u,
    'PHASE6_HYPERCARE_LEGACY_INVALID');
  equal(legacy.deletionPerformed, false, 'PHASE6_HYPERCARE_DELETION_FORBIDDEN');
  pattern(legacy.evidenceHash, SHA256, 'PHASE6_HYPERCARE_LEGACY_INVALID');
  if (days.some((day) => day.safety.legacyWriteRejected !== day.safety.legacyWriteAttempts)) {
    fail('PHASE6_HYPERCARE_LEGACY_WRITE_ACCEPTED');
  }
}

function validateSignoffs(signoffs, completedAt) {
  if (!Array.isArray(signoffs) || signoffs.length !== ARCHIVE_SIGNOFF_ROLES.length) {
    fail('PHASE6_HYPERCARE_ARCHIVE_SIGNOFFS_INCOMPLETE');
  }
  const roles = [];
  const evidenceIds = new Set();
  let maximumSignedAt = completedAt;
  for (const signoff of signoffs) {
    object(signoff, ['role', 'decision', 'evidenceId', 'evidenceHash', 'signedAt'],
      'PHASE6_HYPERCARE_ARCHIVE_SIGNOFF_INVALID');
    equal(signoff.decision, 'approved', 'PHASE6_HYPERCARE_ARCHIVE_REJECTED');
    pattern(signoff.evidenceId, ULID, 'PHASE6_HYPERCARE_ARCHIVE_SIGNOFF_INVALID');
    pattern(signoff.evidenceHash, SHA256, 'PHASE6_HYPERCARE_ARCHIVE_SIGNOFF_INVALID');
    const signedAt = timestamp(signoff.signedAt);
    if (signedAt < completedAt) fail('PHASE6_HYPERCARE_ARCHIVE_SIGNOFF_TOO_EARLY');
    maximumSignedAt = Math.max(maximumSignedAt, signedAt);
    roles.push(signoff.role);
    evidenceIds.add(signoff.evidenceId);
  }
  exactStringSet(roles, ARCHIVE_SIGNOFF_ROLES,
    'PHASE6_HYPERCARE_ARCHIVE_SIGNOFFS_INCOMPLETE');
  if (evidenceIds.size !== ARCHIVE_SIGNOFF_ROLES.length) {
    fail('PHASE6_HYPERCARE_ARCHIVE_SIGNOFF_EVIDENCE_REUSED');
  }
  return Object.freeze({ evidenceIds: [...evidenceIds], maximumSignedAt });
}

function validateArchive(archive, maximumSignedAt) {
  object(archive, [
    'status', 'mode', 'archivedAt', 'immutable', 'writeProbeRejected', 'deletionAuthorized',
    'evidenceHash',
  ], 'PHASE6_HYPERCARE_ARCHIVE_INVALID');
  equal(archive.status, 'archived', 'PHASE6_HYPERCARE_ARCHIVE_INVALID');
  equal(archive.mode, 'read-only', 'PHASE6_HYPERCARE_ARCHIVE_INVALID');
  if (timestamp(archive.archivedAt) < maximumSignedAt) fail('PHASE6_HYPERCARE_ARCHIVE_TOO_EARLY');
  equal(archive.immutable, true, 'PHASE6_HYPERCARE_ARCHIVE_INVALID');
  equal(archive.writeProbeRejected, true, 'PHASE6_HYPERCARE_ARCHIVE_INVALID');
  equal(archive.deletionAuthorized, false, 'PHASE6_HYPERCARE_DELETION_FORBIDDEN');
  pattern(archive.evidenceHash, SHA256, 'PHASE6_HYPERCARE_ARCHIVE_INVALID');
}

function fixture() {
  const hash = (index) => {
    const value = index.toString(16).padStart(64, '0').slice(-64);
    return `sha256:${value}`;
  };
  const id = (suffix) => `01J8ZQK7V0A2M4N6P8R0T2W4${suffix.toString(16).toUpperCase().padStart(2, '0')}`;
  const start = Date.UTC(2026, 6, 20);
  const end = start + 27 * 24 * 60 * 60 * 1_000;
  const completedAt = end + 24 * 60 * 60 * 1_000;
  const commitSha = 'a'.repeat(40);
  return {
    formatVersion: 1,
    suite: 'gaoq.phase6.hypercare-archive.v1',
    releaseId: id(1),
    source: {
      commitSha, releaseCandidate: 'rc-20260719-01', harnessSha256: HARNESS_DIGEST,
    },
    production: {
      environment: 'cn-prod-primary', region: 'cn-shanghai', timezone: 'Asia/Shanghai',
      production: true,
    },
    cutover: {
      releaseId: id(1), outcome: 'CUTOVER_COMPLETED', subjectCommitSha: commitSha,
      releaseCandidate: 'rc-20260719-01', evidenceHash: hash(1),
      completedAt: '2026-07-19T06:00:00.000Z',
    },
    period: {
      startDate: '2026-07-20', endDate: '2026-08-16', calendarDays: 28,
      completedAt: new Date(completedAt).toISOString(),
    },
    days: Array.from({ length: 28 }, (_, index) => {
      const date = new Date(start + index * 24 * 60 * 60 * 1_000).toISOString().slice(0, 10);
      return {
        sequence: index + 1, date, status: 'passed',
        slo: {
          apiAvailability: 0.9999, maximumApiP95Milliseconds: 320, failedJobs: 0,
          queueLagSeconds: 30, databaseHealthy: true, cacheRebuildable: true, sloBreaches: 0,
        },
        incidents: { sev1: 0, sev2: 0, openSev3: 0, unreviewedIncidents: 0 },
        safety: {
          crossTenantAttempts: 2, crossTenantDenied: 2, lostEvents: 0,
          duplicateBusinessEffects: 0, unexplainedAmountDifferenceMinor: 0,
          legacyWriteAttempts: 1, legacyWriteRejected: 1,
        },
        reconciliations: RECONCILIATION_DOMAINS.map((domain, domainIndex) => ({
          domain, status: 'passed', sourceCount: 100, targetCount: 100,
          unresolvedDifferences: 0, evidenceHash: hash(1_000 + index * 10 + domainIndex),
        })),
        resolvedDifferences: index === 4 ? 1 : 0, unresolvedDifferences: 0,
        evidenceHash: hash(100 + index),
        closedAt: new Date(start + (index + 1) * 24 * 60 * 60 * 1_000).toISOString(),
      };
    }),
    aggregate: {
      daysPassed: 28, sloBreaches: 0, sev1: 0, sev2: 0, unresolvedDifferences: 0,
      unexplainedAmountDifferenceMinor: 0, legacyWriteAccepted: 0,
    },
    legacySystem: {
      readOnlyThroughout: true, accessAuditRetained: true, encrypted: true,
      recordCount: 10_000, objectCount: 500, dataChecksum: hash(2), auditChecksum: hash(3),
      retentionPolicyId: 'retention-cn-erp-10y', deletionPerformed: false, evidenceHash: hash(4),
    },
    archiveSignoffs: ARCHIVE_SIGNOFF_ROLES.map((role, index) => ({
      role, decision: 'approved', evidenceId: id(10 + index), evidenceHash: hash(10 + index),
      signedAt: new Date(completedAt + (index + 1) * 60 * 1_000).toISOString(),
    })),
    archive: {
      status: 'archived', mode: 'read-only',
      archivedAt: new Date(completedAt + 10 * 60 * 1_000).toISOString(),
      immutable: true, writeProbeRejected: true, deletionAuthorized: false, evidenceHash: hash(20),
    },
  };
}

function runSelfTest() {
  validateEvidence(fixture());
  const cases = [
    [(value) => { value.days.pop(); }, 'PHASE6_HYPERCARE_DAYS_INCOMPLETE'],
    [(value) => { value.days[3].date = value.days[2].date; },
      'PHASE6_HYPERCARE_DAY_ORDER_INVALID'],
    [(value) => { value.cutover.releaseId = '01J8ZQK7V0A2M4N6P8R0T2W402'; },
      'PHASE6_HYPERCARE_CUTOVER_MISMATCH'],
    [(value) => { value.days[0].closedAt = value.period.completedAt; },
      'PHASE6_HYPERCARE_DAY_CLOSE_TIME_INVALID'],
    [(value) => { value.days[5].slo.sloBreaches = 1; }, 'PHASE6_HYPERCARE_SLO_BREACH'],
    [(value) => { value.days[7].safety.crossTenantDenied = 1; },
      'PHASE6_HYPERCARE_TENANT_ESCAPE'],
    [(value) => { value.days[9].unresolvedDifferences = 1; },
      'PHASE6_HYPERCARE_DIFFERENCE_OPEN'],
    [(value) => { value.legacySystem.deletionPerformed = true; },
      'PHASE6_HYPERCARE_DELETION_FORBIDDEN'],
    [(value) => { value.archiveSignoffs.pop(); },
      'PHASE6_HYPERCARE_ARCHIVE_SIGNOFFS_INCOMPLETE'],
  ];
  for (const [mutate, code] of cases) {
    const value = structuredClone(fixture());
    mutate(value);
    expectFailure(() => validateEvidence(value), code);
  }
}

function parseDocument(content) {
  try { return JSON.parse(content); } catch { fail('PHASE6_HYPERCARE_EVIDENCE_JSON_INVALID'); }
}

function object(value, keys, code) {
  if (
    typeof value !== 'object' || value === null || Array.isArray(value) ||
    canonical(Object.keys(value).sort()) !== canonical([...keys].sort())
  ) fail(code);
}

function exactStringSet(actual, expected, code) {
  if (
    !Array.isArray(actual) || actual.some((item) => typeof item !== 'string') ||
    new Set(actual).size !== expected.length ||
    canonical([...actual].sort()) !== canonical([...expected].sort())
  ) fail(code);
}

function pattern(value, expression, code) {
  if (typeof value !== 'string' || !expression.test(value)) fail(code);
}

function equal(actual, expected, code) { if (actual !== expected) fail(code); }

function integer(value, minimum, maximum, code) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(code);
}

function numberRange(value, minimum, maximum, code) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    fail(code);
  }
}

function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    fail('PHASE6_HYPERCARE_TIMESTAMP_INVALID');
  }
  const result = Date.parse(value);
  if (!Number.isFinite(result)) fail('PHASE6_HYPERCARE_TIMESTAMP_INVALID');
  return result;
}

function calendarDate(value) {
  pattern(value, DATE, 'PHASE6_HYPERCARE_DATE_INVALID');
  const result = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(result) || new Date(result).toISOString().slice(0, 10) !== value) {
    fail('PHASE6_HYPERCARE_DATE_INVALID');
  }
  return result;
}

function daysBetween(start, end) { return (end - start) / (24 * 60 * 60 * 1_000); }
function canonical(value) { return JSON.stringify(value); }
function digest(value) { return `sha256:${createHash('sha256').update(value).digest('hex')}`; }
function fail(code) { throw new Error(code); }

function expectFailure(action, code) {
  try { action(); } catch (error) {
    if (error instanceof Error && error.message === code) return;
    throw error;
  }
  throw new Error(`SELF_TEST_EXPECTED_FAILURE:${code}`);
}
