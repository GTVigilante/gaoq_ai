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
const RELEASE = /^rc-[0-9]{8}-[0-9]{2}$/u;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/u;
const STEPS = [
  'incident-command-open', 'legacy-write-freeze', 'final-incremental-migration',
  'data-reconciliation', 'identity-switch', 'gateway-switch', 'integration-switch',
  'business-smoke', 'mcp-smoke', 'erp-open', 'legacy-read-only', 'monitoring-handover',
];
const ROLLBACK_COMPONENTS = [
  'data', 'identity', 'dns-gateway', 'dingtalk', 'feishu', 'op', 'esign', 'queues', 'mcp',
];
const CONNECTIONS = [
  'attachment', 'bank', 'dingtalk', 'esign', 'feishu', 'mcp', 'messaging', 'op', 'tax', 'worm',
];
const PRODUCTION_EXECUTION_ACTIONS = [
  'payroll-tax-submission', 'treasury-bank-submission',
];
const SIGNOFF_ROLES = [
  'business_owner', 'change_manager', 'data_owner', 'security_owner', 'sre_owner',
];
const SIGNOFF_SIGNATURE_SUITE = 'gaoq.phase6.cutover.signoff.v1';
const HARNESS_FILES = [
  ['./validate-phase-6-cutover-evidence.mjs', new URL(import.meta.url)],
  ['../../.github/workflows/phase-6-cutover.yml',
    new URL('../../.github/workflows/phase-6-cutover.yml', import.meta.url)],
];
const HARNESS_DIGEST = digest(canonical(Object.fromEntries(await Promise.all(
  HARNESS_FILES.map(async ([name, location]) => [name, await readFile(location, 'utf8')]),
))));

const argumentsList = process.argv.slice(2);
if (argumentsList.length === 1 && argumentsList[0] === '--self-test') {
  runSelfTest();
  process.stdout.write('Phase 6 统一切换证据门禁自测通过。\n');
} else if (argumentsList.length === 1 && argumentsList[0] === '--print-contract') {
  process.stdout.write(`${JSON.stringify({
    formatVersion: 2,
    suite: 'gaoq.phase6.cutover.v2',
    harnessSha256: HARNESS_DIGEST,
    signoffRoles: SIGNOFF_ROLES,
    signatureSuite: SIGNOFF_SIGNATURE_SUITE,
    signatureAlgorithm: 'Ed25519',
    signatureEncoding: 'base64url-unpadded',
    publicKeyEncoding: 'base64-spki-der',
    keyId: 'sha256:<lowercase-hex-of-spki-der>',
    canonicalization: 'RFC8785-compatible-finite-number-subset',
    signerKeysetCanonicalFields: ['role', 'keyId'],
    signerKeysetOrder: 'role-ascending',
    cutoverPayloadFields: [
      'formatVersion', 'suite', 'releaseId', 'source', 'environment', 'phase5Decision',
      'rehearsals', 'rollbackRehearsal', 'window', 'steps', 'connections', 'acceptance',
      'productionExecution', 'legacySystem', 'signoffs', 'signerKeysetHash',
    ],
    cutoverSignoffFields: [
      'role', 'actorHash', 'decision', 'evidenceId', 'evidenceHash', 'acceptedAt',
    ],
    signoffPayloadFields: [
      'suite', 'cutoverPayloadHash', 'role', 'keyId', 'signedAt',
    ],
  }, null, 2)}\n`);
} else {
  const enforceEnvironment = argumentsList[0] === '--enforce-environment';
  const evidencePath = argumentsList[enforceEnvironment ? 1 : 0];
  if (evidencePath === undefined || argumentsList.length !== (enforceEnvironment ? 2 : 1)) {
    fail('PHASE6_CUTOVER_EVIDENCE_PATH_REQUIRED');
  }
  const metadata = await lstat(evidencePath);
  if (
    !metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 ||
    metadata.size > 1_024 * 1_024 || (metadata.mode & 0o022) !== 0
  ) fail('PHASE6_CUTOVER_EVIDENCE_FILE_INVALID');
  const summary = validateEvidence(
    parseDocument(await readFile(evidencePath, 'utf8')),
    enforceEnvironment,
  );
  process.stdout.write(`${JSON.stringify({
    formatVersion: 2,
    suite: 'gaoq.phase6.cutover.verdict',
    releaseId: summary.releaseId,
    outcome: 'CUTOVER_COMPLETED',
    commitSha: summary.commitSha,
    signerKeysetHash: summary.signerKeysetHash,
    cutoverPayloadHash: summary.cutoverPayloadHash,
    evidenceChecksum: digest(canonical(summary)),
  }, null, 2)}\n`);
}

/** 校验统一切换证据；只返回脱敏摘要。 */
function validateEvidence(
  document,
  enforceEnvironment = false,
  now = Date.now(),
  expectedSignerKeysetHash,
) {
  object(document, [
    'formatVersion', 'suite', 'releaseId', 'source', 'environment', 'phase5Decision',
    'rehearsals', 'rollbackRehearsal', 'window', 'steps', 'connections', 'acceptance',
    'productionExecution', 'legacySystem', 'signingAuthorities', 'signoffs',
  ], 'PHASE6_CUTOVER_DOCUMENT_INVALID');
  equal(document.formatVersion, 2, 'PHASE6_CUTOVER_FORMAT_INVALID');
  equal(document.suite, 'gaoq.phase6.cutover.v2', 'PHASE6_CUTOVER_SUITE_INVALID');
  pattern(document.releaseId, ULID, 'PHASE6_CUTOVER_RELEASE_ID_INVALID');
  const source = validateSource(document.source, enforceEnvironment);
  const environment = validateEnvironment(document.environment, enforceEnvironment);
  validatePhase5Decision(document.phase5Decision, source, environment);
  const rehearsals = validateRehearsals(document.rehearsals, source, environment.startedAt);
  const rollback = validateRollback(document.rollbackRehearsal, source, environment.startedAt);
  validateWindow(document.window, environment);
  const steps = validateSteps(document.steps, environment);
  const connectionEvidenceHashes = validateConnections(document.connections);
  const productionExecutionEvidence = validateProductionExecution(
    document.productionExecution, source, environment, steps, connectionEvidenceHashes,
  );
  validateAcceptance(document.acceptance);
  validateLegacySystem(document.legacySystem, steps);
  const authorities = validateSigningAuthorities(document.signingAuthorities);
  const expectedKeyset = expectedSignerKeysetHash ??
    (enforceEnvironment ? process.env.PHASE6_CUTOVER_SIGNER_KEYSET_SHA256 : undefined);
  if (expectedKeyset !== undefined) {
    pattern(expectedKeyset, SHA256, 'PHASE6_CUTOVER_EXPECTED_SIGNER_KEYSET_REQUIRED');
    equal(
      authorities.keysetHash,
      expectedKeyset,
      'PHASE6_CUTOVER_SIGNER_KEYSET_MISMATCH',
    );
  }
  const signoffEvidenceIds = validateSignoffMetadata(
    document.signoffs,
    environment.endedAt,
    now,
  );
  const cutoverPayloadHash = digest(
    cutoverPayload(document, authorities.keysetHash),
  );
  validateSignoffSignatures(
    document.signoffs,
    authorities.byRole,
    cutoverPayloadHash,
    now,
  );
  return Object.freeze({
    releaseId: document.releaseId,
    commitSha: source.commitSha,
    images: source.images,
    environment: document.environment,
    phase5DecisionId: document.phase5Decision.decisionId,
    rehearsalEvidenceIds: rehearsals,
    rollbackEvidenceId: rollback,
    stepEvidenceHashes: steps.map((step) => step.evidenceHash),
    productionExecutionEvidence,
    signoffEvidenceIds,
    signerKeysetHash: authorities.keysetHash,
    cutoverPayloadHash,
  });
}

function validateSource(source, enforceEnvironment) {
  object(source, [
    'commitSha', 'releaseCandidate', 'images', 'deploymentManifestHash', 'harnessSha256',
  ], 'PHASE6_CUTOVER_SOURCE_INVALID');
  pattern(source.commitSha, COMMIT, 'PHASE6_CUTOVER_COMMIT_INVALID');
  pattern(source.releaseCandidate, RELEASE, 'PHASE6_CUTOVER_RC_INVALID');
  object(source.images, ['api', 'worker', 'web', 'website'], 'PHASE6_CUTOVER_IMAGES_INVALID');
  for (const value of Object.values(source.images)) {
    pattern(value, SHA256, 'PHASE6_CUTOVER_IMAGES_INVALID');
  }
  if (new Set(Object.values(source.images)).size !== 4) fail('PHASE6_CUTOVER_IMAGES_INVALID');
  pattern(source.deploymentManifestHash, SHA256, 'PHASE6_CUTOVER_MANIFEST_INVALID');
  equal(source.harnessSha256, HARNESS_DIGEST, 'PHASE6_CUTOVER_HARNESS_INVALID');
  if (enforceEnvironment) {
    const expected = {
      commitSha: process.env.PHASE6_CUTOVER_EXPECTED_COMMIT,
      api: process.env.PHASE6_CUTOVER_EXPECTED_API_IMAGE,
      worker: process.env.PHASE6_CUTOVER_EXPECTED_WORKER_IMAGE,
      web: process.env.PHASE6_CUTOVER_EXPECTED_WEB_IMAGE,
      website: process.env.PHASE6_CUTOVER_EXPECTED_WEBSITE_IMAGE,
      manifest: process.env.PHASE6_CUTOVER_EXPECTED_DEPLOYMENT_MANIFEST,
    };
    pattern(expected.commitSha, COMMIT, 'PHASE6_CUTOVER_EXPECTED_SOURCE_REQUIRED');
    for (const field of ['api', 'worker', 'web', 'website', 'manifest']) {
      pattern(expected[field], SHA256, 'PHASE6_CUTOVER_EXPECTED_SOURCE_REQUIRED');
    }
    equal(source.commitSha, expected.commitSha, 'PHASE6_CUTOVER_COMMIT_MISMATCH');
    for (const image of ['api', 'worker', 'web', 'website']) {
      equal(source.images[image], expected[image], 'PHASE6_CUTOVER_IMAGE_MISMATCH');
    }
    equal(source.deploymentManifestHash, expected.manifest,
      'PHASE6_CUTOVER_MANIFEST_MISMATCH');
  }
  return source;
}

function validateEnvironment(environment, enforceEnvironment) {
  object(environment, [
    'name', 'region', 'timezone', 'production', 'startedAt', 'endedAt',
  ], 'PHASE6_CUTOVER_ENVIRONMENT_INVALID');
  pattern(environment.name, /^[a-z][a-z0-9-]{2,31}$/u, 'PHASE6_CUTOVER_ENVIRONMENT_INVALID');
  if (!/(?:^|-)prod(?:-|$)|production/u.test(environment.name)) {
    fail('PHASE6_CUTOVER_PRODUCTION_REQUIRED');
  }
  pattern(environment.region, /^[a-z0-9-]{2,32}$/u, 'PHASE6_CUTOVER_REGION_INVALID');
  equal(environment.timezone, 'Asia/Shanghai', 'PHASE6_CUTOVER_TIMEZONE_INVALID');
  equal(environment.production, true, 'PHASE6_CUTOVER_PRODUCTION_REQUIRED');
  const startedAt = timestamp(environment.startedAt);
  const endedAt = timestamp(environment.endedAt);
  duration(startedAt, endedAt, 1, 28_800, 'PHASE6_CUTOVER_WINDOW_EXCEEDED');
  if (enforceEnvironment) {
    equal(environment.name, process.env.PHASE6_CUTOVER_EXPECTED_ENVIRONMENT,
      'PHASE6_CUTOVER_ENVIRONMENT_MISMATCH');
    equal(environment.region, process.env.PHASE6_CUTOVER_EXPECTED_REGION,
      'PHASE6_CUTOVER_REGION_MISMATCH');
  }
  return Object.freeze({ startedAt, endedAt });
}

function validatePhase5Decision(decision, source, environment) {
  object(decision, [
    'decisionId', 'outcome', 'subjectCommitSha', 'releaseCandidate', 'evidenceHash',
    'decidedAt', 'validUntil',
  ], 'PHASE6_CUTOVER_PHASE5_DECISION_INVALID');
  pattern(decision.decisionId, ULID, 'PHASE6_CUTOVER_PHASE5_DECISION_INVALID');
  equal(decision.outcome, 'GO', 'PHASE6_CUTOVER_PHASE5_NO_GO');
  equal(decision.subjectCommitSha, source.commitSha, 'PHASE6_CUTOVER_PHASE5_SOURCE_MISMATCH');
  equal(decision.releaseCandidate, source.releaseCandidate,
    'PHASE6_CUTOVER_PHASE5_SOURCE_MISMATCH');
  pattern(decision.evidenceHash, SHA256, 'PHASE6_CUTOVER_PHASE5_DECISION_INVALID');
  const decidedAt = timestamp(decision.decidedAt);
  const validUntil = timestamp(decision.validUntil);
  if (
    decidedAt >= environment.startedAt || validUntil < environment.endedAt ||
    validUntil <= decidedAt
  ) {
    fail('PHASE6_CUTOVER_PHASE5_DECISION_EXPIRED');
  }
}

function validateRehearsals(rehearsals, source, cutoverStartedAt) {
  if (!Array.isArray(rehearsals) || rehearsals.length !== 3) {
    fail('PHASE6_CUTOVER_REHEARSALS_INCOMPLETE');
  }
  const ids = new Set();
  const hashes = new Set();
  let previousEndedAt = 0;
  for (const [index, rehearsal] of rehearsals.entries()) {
    object(rehearsal, [
      'sequence', 'evidenceId', 'evidenceHash', 'subjectCommitSha', 'mode',
      'productionEquivalent', 'startedAt', 'endedAt', 'durationSeconds',
      'recordMismatches', 'permissionMismatches', 'amountDifferenceMinor',
      'missingAttachments', 'checksumMismatches', 'status',
    ], 'PHASE6_CUTOVER_REHEARSAL_INVALID');
    equal(rehearsal.sequence, index + 1, 'PHASE6_CUTOVER_REHEARSAL_ORDER_INVALID');
    pattern(rehearsal.evidenceId, ULID, 'PHASE6_CUTOVER_REHEARSAL_INVALID');
    pattern(rehearsal.evidenceHash, SHA256, 'PHASE6_CUTOVER_REHEARSAL_INVALID');
    equal(rehearsal.subjectCommitSha, source.commitSha,
      'PHASE6_CUTOVER_REHEARSAL_SOURCE_MISMATCH');
    equal(rehearsal.mode, 'full', 'PHASE6_CUTOVER_REHEARSAL_INVALID');
    equal(rehearsal.productionEquivalent, true, 'PHASE6_CUTOVER_REHEARSAL_INVALID');
    equal(rehearsal.status, 'passed', 'PHASE6_CUTOVER_REHEARSAL_FAILED');
    const startedAt = timestamp(rehearsal.startedAt);
    const endedAt = timestamp(rehearsal.endedAt);
    if (startedAt <= previousEndedAt || endedAt >= cutoverStartedAt) {
      fail('PHASE6_CUTOVER_REHEARSAL_ORDER_INVALID');
    }
    const actualDuration = secondsBetween(startedAt, endedAt);
    integer(rehearsal.durationSeconds, 1, 28_800, 'PHASE6_CUTOVER_REHEARSAL_DURATION_INVALID');
    equal(rehearsal.durationSeconds, actualDuration, 'PHASE6_CUTOVER_REHEARSAL_DURATION_INVALID');
    for (const field of [
      'recordMismatches', 'permissionMismatches', 'amountDifferenceMinor',
      'missingAttachments', 'checksumMismatches',
    ]) equal(rehearsal[field], 0, 'PHASE6_CUTOVER_REHEARSAL_DIFFERENCE');
    ids.add(rehearsal.evidenceId);
    hashes.add(rehearsal.evidenceHash);
    previousEndedAt = endedAt;
  }
  if (ids.size !== 3 || hashes.size !== 3) fail('PHASE6_CUTOVER_REHEARSALS_NOT_INDEPENDENT');
  return [...ids];
}

function validateRollback(rollback, source, cutoverStartedAt) {
  object(rollback, [
    'evidenceId', 'evidenceHash', 'subjectCommitSha', 'productionGrade', 'startedAt',
    'endedAt', 'durationSeconds', 'components', 'lostEvents', 'duplicateBusinessEffects',
    'permissionMismatches', 'status',
  ], 'PHASE6_CUTOVER_ROLLBACK_INVALID');
  pattern(rollback.evidenceId, ULID, 'PHASE6_CUTOVER_ROLLBACK_INVALID');
  pattern(rollback.evidenceHash, SHA256, 'PHASE6_CUTOVER_ROLLBACK_INVALID');
  equal(rollback.subjectCommitSha, source.commitSha, 'PHASE6_CUTOVER_ROLLBACK_SOURCE_MISMATCH');
  equal(rollback.productionGrade, true, 'PHASE6_CUTOVER_ROLLBACK_INVALID');
  equal(rollback.status, 'passed', 'PHASE6_CUTOVER_ROLLBACK_FAILED');
  const startedAt = timestamp(rollback.startedAt);
  const endedAt = timestamp(rollback.endedAt);
  if (endedAt >= cutoverStartedAt) fail('PHASE6_CUTOVER_ROLLBACK_ORDER_INVALID');
  const actualDuration = secondsBetween(startedAt, endedAt);
  integer(rollback.durationSeconds, 1, 14_400, 'PHASE6_CUTOVER_ROLLBACK_RTO_EXCEEDED');
  equal(rollback.durationSeconds, actualDuration, 'PHASE6_CUTOVER_ROLLBACK_DURATION_INVALID');
  exactStringSet(rollback.components, ROLLBACK_COMPONENTS, 'PHASE6_CUTOVER_ROLLBACK_SCOPE_INVALID');
  for (const field of ['lostEvents', 'duplicateBusinessEffects', 'permissionMismatches']) {
    equal(rollback[field], 0, 'PHASE6_CUTOVER_ROLLBACK_DIFFERENCE');
  }
  return rollback.evidenceId;
}

function validateWindow(window, environment) {
  object(window, [
    'approvedStartAt', 'approvedEndAt', 'freezeStartedAt', 'productionOpenedAt',
    'rollbackTriggered', 'stopConditionCount',
  ], 'PHASE6_CUTOVER_WINDOW_INVALID');
  const approvedStartAt = timestamp(window.approvedStartAt);
  const approvedEndAt = timestamp(window.approvedEndAt);
  duration(approvedStartAt, approvedEndAt, 1, 28_800, 'PHASE6_CUTOVER_WINDOW_EXCEEDED');
  equal(timestamp(window.freezeStartedAt), environment.startedAt, 'PHASE6_CUTOVER_WINDOW_INVALID');
  equal(timestamp(window.productionOpenedAt), environment.endedAt, 'PHASE6_CUTOVER_WINDOW_INVALID');
  if (environment.startedAt < approvedStartAt || environment.endedAt > approvedEndAt) {
    fail('PHASE6_CUTOVER_OUTSIDE_APPROVED_WINDOW');
  }
  equal(window.rollbackTriggered, false, 'PHASE6_CUTOVER_NOT_COMPLETED');
  equal(window.stopConditionCount, 0, 'PHASE6_CUTOVER_STOP_CONDITION_TRIGGERED');
}

function validateSteps(steps, environment) {
  if (!Array.isArray(steps) || steps.length !== STEPS.length) {
    fail('PHASE6_CUTOVER_STEPS_INCOMPLETE');
  }
  let previousEndedAt = environment.startedAt;
  const evidenceIds = new Set();
  for (const [index, step] of steps.entries()) {
    object(step, [
      'sequence', 'name', 'status', 'startedAt', 'endedAt', 'operatorEvidenceId',
      'reviewerEvidenceId', 'evidenceHash',
    ], 'PHASE6_CUTOVER_STEP_INVALID');
    equal(step.sequence, index + 1, 'PHASE6_CUTOVER_STEP_ORDER_INVALID');
    equal(step.name, STEPS[index], 'PHASE6_CUTOVER_STEP_ORDER_INVALID');
    equal(step.status, 'completed', 'PHASE6_CUTOVER_STEP_INCOMPLETE');
    const startedAt = timestamp(step.startedAt);
    const endedAt = timestamp(step.endedAt);
    if (
      startedAt < previousEndedAt || endedAt < startedAt ||
      startedAt < environment.startedAt || endedAt > environment.endedAt
    ) fail('PHASE6_CUTOVER_STEP_TIME_INVALID');
    pattern(step.operatorEvidenceId, ULID, 'PHASE6_CUTOVER_STEP_REVIEW_INVALID');
    pattern(step.reviewerEvidenceId, ULID, 'PHASE6_CUTOVER_STEP_REVIEW_INVALID');
    if (step.operatorEvidenceId === step.reviewerEvidenceId) {
      fail('PHASE6_CUTOVER_TWO_PERSON_REVIEW_REQUIRED');
    }
    if (evidenceIds.has(step.operatorEvidenceId) || evidenceIds.has(step.reviewerEvidenceId)) {
      fail('PHASE6_CUTOVER_STEP_EVIDENCE_REUSED');
    }
    pattern(step.evidenceHash, SHA256, 'PHASE6_CUTOVER_STEP_INVALID');
    evidenceIds.add(step.operatorEvidenceId);
    evidenceIds.add(step.reviewerEvidenceId);
    previousEndedAt = endedAt;
  }
  return steps;
}

function validateConnections(connections) {
  if (!Array.isArray(connections) || connections.length !== CONNECTIONS.length) {
    fail('PHASE6_CUTOVER_CONNECTIONS_INCOMPLETE');
  }
  const names = [];
  const evidenceHashes = new Set();
  for (const connection of connections) {
    object(connection, [
      'name', 'smokeStatus', 'reconciliationDifferences', 'credentialExposed', 'evidenceHash',
    ], 'PHASE6_CUTOVER_CONNECTION_INVALID');
    equal(connection.smokeStatus, 'passed', 'PHASE6_CUTOVER_CONNECTION_FAILED');
    equal(connection.reconciliationDifferences, 0, 'PHASE6_CUTOVER_CONNECTION_DIFFERENCE');
    equal(connection.credentialExposed, false, 'PHASE6_CUTOVER_CREDENTIAL_EXPOSED');
    pattern(connection.evidenceHash, SHA256, 'PHASE6_CUTOVER_CONNECTION_INVALID');
    names.push(connection.name);
    evidenceHashes.add(connection.evidenceHash);
  }
  exactStringSet(names, CONNECTIONS, 'PHASE6_CUTOVER_CONNECTIONS_INCOMPLETE');
  if (evidenceHashes.size !== CONNECTIONS.length) {
    fail('PHASE6_CUTOVER_CONNECTION_EVIDENCE_REUSED');
  }
  return evidenceHashes;
}

function validateProductionExecution(control, source, environment, steps, connectionHashes) {
  object(control, [
    'evidenceId', 'evidenceHash', 'changeEvidenceId', 'policyId', 'enabledAt',
    'subjectCommitSha', 'deploymentManifestHash', 'maxAuthorizationTtlSeconds',
    'singleUse', 'bindTenant', 'bindResource', 'bindSubjectHash', 'bindExpectedVersion',
    'bindRelease', 'credentialReuseDetected', 'mcpR3ToolCount', 'actions',
  ], 'PHASE6_PRODUCTION_EXECUTION_INVALID');
  pattern(control.evidenceId, ULID, 'PHASE6_PRODUCTION_EXECUTION_INVALID');
  pattern(control.changeEvidenceId, ULID, 'PHASE6_PRODUCTION_EXECUTION_INVALID');
  if (control.evidenceId === control.changeEvidenceId) {
    fail('PHASE6_PRODUCTION_EXECUTION_EVIDENCE_REUSED');
  }
  pattern(control.evidenceHash, SHA256, 'PHASE6_PRODUCTION_EXECUTION_INVALID');
  pattern(control.policyId, /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u,
    'PHASE6_PRODUCTION_EXECUTION_INVALID');
  equal(control.subjectCommitSha, source.commitSha,
    'PHASE6_PRODUCTION_EXECUTION_SOURCE_MISMATCH');
  equal(control.deploymentManifestHash, source.deploymentManifestHash,
    'PHASE6_PRODUCTION_EXECUTION_SOURCE_MISMATCH');
  equal(control.maxAuthorizationTtlSeconds, 900,
    'PHASE6_PRODUCTION_EXECUTION_POLICY_INVALID');
  for (const field of [
    'singleUse', 'bindTenant', 'bindResource', 'bindSubjectHash', 'bindExpectedVersion',
    'bindRelease',
  ]) equal(control[field], true, 'PHASE6_PRODUCTION_EXECUTION_POLICY_INVALID');
  equal(control.credentialReuseDetected, false, 'PHASE6_PRODUCTION_EXECUTION_CREDENTIAL_REUSE');
  equal(control.mcpR3ToolCount, 0, 'PHASE6_PRODUCTION_EXECUTION_MCP_R3_FORBIDDEN');
  const enabledAt = timestamp(control.enabledAt);
  const gatewayStep = steps.find((step) => step.name === 'gateway-switch');
  if (
    gatewayStep === undefined || enabledAt < environment.startedAt ||
    enabledAt > timestamp(gatewayStep.endedAt)
  ) fail('PHASE6_PRODUCTION_EXECUTION_ENABLE_TIME_INVALID');
  if (!Array.isArray(control.actions) ||
    control.actions.length !== PRODUCTION_EXECUTION_ACTIONS.length) {
    fail('PHASE6_PRODUCTION_EXECUTION_ACTIONS_INCOMPLETE');
  }
  const names = [];
  const hashes = new Set([control.evidenceHash]);
  for (const action of control.actions) {
    object(action, [
      'name', 'successfulAuthorizations', 'replayAttempts', 'replaysDenied',
      'bindingMismatchAttempts', 'bindingMismatchesDenied', 'evidenceHash',
    ], 'PHASE6_PRODUCTION_EXECUTION_ACTION_INVALID');
    integer(action.successfulAuthorizations, 1, Number.MAX_SAFE_INTEGER,
      'PHASE6_PRODUCTION_EXECUTION_ACTION_INVALID');
    integer(action.replayAttempts, 1, Number.MAX_SAFE_INTEGER,
      'PHASE6_PRODUCTION_EXECUTION_REPLAY_COVERAGE_INVALID');
    equal(action.replaysDenied, action.replayAttempts,
      'PHASE6_PRODUCTION_EXECUTION_REPLAY_ACCEPTED');
    integer(action.bindingMismatchAttempts, 5, Number.MAX_SAFE_INTEGER,
      'PHASE6_PRODUCTION_EXECUTION_BINDING_COVERAGE_INVALID');
    equal(action.bindingMismatchesDenied, action.bindingMismatchAttempts,
      'PHASE6_PRODUCTION_EXECUTION_BINDING_BYPASS');
    pattern(action.evidenceHash, SHA256, 'PHASE6_PRODUCTION_EXECUTION_ACTION_INVALID');
    names.push(action.name);
    hashes.add(action.evidenceHash);
  }
  exactStringSet(names, PRODUCTION_EXECUTION_ACTIONS,
    'PHASE6_PRODUCTION_EXECUTION_ACTIONS_INCOMPLETE');
  if (
    hashes.size !== PRODUCTION_EXECUTION_ACTIONS.length + 1 ||
    [...hashes].some((hash) => connectionHashes.has(hash))
  ) fail('PHASE6_PRODUCTION_EXECUTION_EVIDENCE_REUSED');
  return Object.freeze({
    evidenceId: control.evidenceId,
    evidenceHash: control.evidenceHash,
    actionEvidenceHashes: control.actions.map((action) => action.evidenceHash),
  });
}

function validateAcceptance(acceptance) {
  object(acceptance, [
    'openSev1', 'openSev2', 'criticalVulnerabilities', 'highVulnerabilities',
    'recordMismatches', 'permissionMismatches', 'amountDifferenceMinor',
    'missingAttachments', 'checksumMismatches', 'crossTenantAttempts',
    'crossTenantDenied', 'mcpR3ToolCount',
  ], 'PHASE6_CUTOVER_ACCEPTANCE_INVALID');
  for (const field of [
    'openSev1', 'openSev2', 'criticalVulnerabilities', 'highVulnerabilities',
    'recordMismatches', 'permissionMismatches', 'amountDifferenceMinor',
    'missingAttachments', 'checksumMismatches', 'mcpR3ToolCount',
  ]) equal(acceptance[field], 0, 'PHASE6_CUTOVER_ACCEPTANCE_FAILED');
  integer(acceptance.crossTenantAttempts, 30, Number.MAX_SAFE_INTEGER,
    'PHASE6_CUTOVER_TENANT_COVERAGE_INVALID');
  equal(acceptance.crossTenantDenied, acceptance.crossTenantAttempts,
    'PHASE6_CUTOVER_TENANT_ESCAPE');
}

function validateLegacySystem(legacy, steps) {
  object(legacy, [
    'writeFrozen', 'readOnly', 'dataPreserved', 'auditPreserved', 'writeProbeRejected',
    'evidenceHash',
  ], 'PHASE6_CUTOVER_LEGACY_INVALID');
  for (const field of [
    'writeFrozen', 'readOnly', 'dataPreserved', 'auditPreserved', 'writeProbeRejected',
  ]) equal(legacy[field], true, 'PHASE6_CUTOVER_LEGACY_INVALID');
  pattern(legacy.evidenceHash, SHA256, 'PHASE6_CUTOVER_LEGACY_INVALID');
  equal(steps.at(-2)?.name, 'legacy-read-only', 'PHASE6_CUTOVER_LEGACY_INVALID');
}

function validateSigningAuthorities(authorities) {
  if (!Array.isArray(authorities) || authorities.length !== SIGNOFF_ROLES.length) {
    fail('PHASE6_CUTOVER_SIGNING_AUTHORITIES_INCOMPLETE');
  }
  const roles = [];
  const keyIds = new Set();
  const byRole = new Map();
  const keyset = [];
  for (const authority of authorities) {
    object(
      authority,
      ['role', 'algorithm', 'keyId', 'publicKeySpkiBase64'],
      'PHASE6_CUTOVER_SIGNING_AUTHORITY_INVALID',
    );
    if (!SIGNOFF_ROLES.includes(authority.role)) {
      fail('PHASE6_CUTOVER_SIGNING_AUTHORITY_INVALID');
    }
    equal(authority.algorithm, 'Ed25519', 'PHASE6_CUTOVER_SIGNING_AUTHORITY_INVALID');
    pattern(authority.keyId, SHA256, 'PHASE6_CUTOVER_SIGNING_AUTHORITY_INVALID');
    const publicKey = publicKeyFromSpkiBase64(authority.publicKeySpkiBase64);
    equal(
      authority.keyId,
      publicKeyHash(publicKey),
      'PHASE6_CUTOVER_SIGNING_AUTHORITY_KEY_MISMATCH',
    );
    roles.push(authority.role);
    keyIds.add(authority.keyId);
    byRole.set(authority.role, Object.freeze({ keyId: authority.keyId, publicKey }));
    keyset.push(Object.freeze({ role: authority.role, keyId: authority.keyId }));
  }
  exactStringSet(roles, SIGNOFF_ROLES, 'PHASE6_CUTOVER_SIGNING_AUTHORITIES_INCOMPLETE');
  if (keyIds.size !== SIGNOFF_ROLES.length || byRole.size !== SIGNOFF_ROLES.length) {
    fail('PHASE6_CUTOVER_SIGNING_AUTHORITIES_NOT_INDEPENDENT');
  }
  return Object.freeze({ byRole, keysetHash: signerKeysetHash(keyset) });
}

function validateSignoffMetadata(signoffs, completedAt, now) {
  if (!Array.isArray(signoffs) || signoffs.length !== SIGNOFF_ROLES.length) {
    fail('PHASE6_CUTOVER_SIGNOFFS_INCOMPLETE');
  }
  const roles = [];
  const actors = new Set();
  const ids = new Set();
  const hashes = new Set();
  for (const signoff of signoffs) {
    object(signoff, [
      'role', 'actorHash', 'decision', 'evidenceId', 'evidenceHash', 'acceptedAt',
      'signedAt', 'algorithm', 'keyId', 'signedPayloadSha256', 'signature',
    ], 'PHASE6_CUTOVER_SIGNOFF_INVALID');
    if (!SIGNOFF_ROLES.includes(signoff.role)) fail('PHASE6_CUTOVER_SIGNOFF_INVALID');
    pattern(signoff.actorHash, SHA256, 'PHASE6_CUTOVER_SIGNOFF_INVALID');
    equal(signoff.decision, 'accepted', 'PHASE6_CUTOVER_SIGNOFF_REJECTED');
    pattern(signoff.evidenceId, ULID, 'PHASE6_CUTOVER_SIGNOFF_INVALID');
    pattern(signoff.evidenceHash, SHA256, 'PHASE6_CUTOVER_SIGNOFF_INVALID');
    const acceptedAt = timestamp(signoff.acceptedAt);
    if (
      acceptedAt < completedAt ||
      acceptedAt - completedAt > 24 * 60 * 60_000 ||
      acceptedAt > now + 5 * 60_000
    ) fail('PHASE6_CUTOVER_SIGNOFF_TIME_INVALID');
    roles.push(signoff.role);
    actors.add(signoff.actorHash);
    ids.add(signoff.evidenceId);
    hashes.add(signoff.evidenceHash);
  }
  exactStringSet(roles, SIGNOFF_ROLES, 'PHASE6_CUTOVER_SIGNOFFS_INCOMPLETE');
  if (
    actors.size !== SIGNOFF_ROLES.length ||
    ids.size !== SIGNOFF_ROLES.length ||
    hashes.size !== SIGNOFF_ROLES.length
  ) fail('PHASE6_CUTOVER_SIGNOFF_EVIDENCE_REUSED');
  return [...ids];
}

function validateSignoffSignatures(signoffs, authorities, cutoverPayloadHash, now) {
  const signatures = new Set();
  for (const signoff of signoffs) {
    equal(signoff.algorithm, 'Ed25519', 'PHASE6_CUTOVER_SIGNOFF_PROOF_INVALID');
    pattern(signoff.keyId, SHA256, 'PHASE6_CUTOVER_SIGNOFF_PROOF_INVALID');
    pattern(
      signoff.signedPayloadSha256,
      SHA256,
      'PHASE6_CUTOVER_SIGNOFF_PROOF_INVALID',
    );
    pattern(signoff.signature, SIGNATURE, 'PHASE6_CUTOVER_SIGNOFF_PROOF_INVALID');
    const acceptedAt = timestamp(signoff.acceptedAt);
    const signedAt = timestamp(signoff.signedAt);
    if (
      signedAt < acceptedAt ||
      signedAt - acceptedAt > 24 * 60 * 60_000 ||
      signedAt > now + 5 * 60_000
    ) fail('PHASE6_CUTOVER_SIGNOFF_SIGNATURE_TIME_INVALID');
    const authority = authorities.get(signoff.role);
    if (authority === undefined) fail('PHASE6_CUTOVER_SIGNOFF_AUTHORITY_INVALID');
    equal(signoff.keyId, authority.keyId, 'PHASE6_CUTOVER_SIGNOFF_KEY_MISMATCH');
    const payload = signoffSignaturePayload(cutoverPayloadHash, signoff);
    equal(
      signoff.signedPayloadSha256,
      digest(payload),
      'PHASE6_CUTOVER_SIGNOFF_PAYLOAD_MISMATCH',
    );
    const signature = decodeSignature(signoff.signature);
    if (!verify(null, Buffer.from(payload, 'utf8'), authority.publicKey, signature)) {
      fail('PHASE6_CUTOVER_SIGNOFF_SIGNATURE_INVALID');
    }
    signatures.add(signoff.signature);
  }
  if (signatures.size !== SIGNOFF_ROLES.length) fail('PHASE6_CUTOVER_SIGNOFFS_INCOMPLETE');
}

function cutoverPayload(document, signerKeysetHashValue) {
  return signatureCanonical({
    formatVersion: document.formatVersion,
    suite: document.suite,
    releaseId: document.releaseId,
    source: document.source,
    environment: document.environment,
    phase5Decision: document.phase5Decision,
    rehearsals: document.rehearsals,
    rollbackRehearsal: document.rollbackRehearsal,
    window: document.window,
    steps: document.steps,
    connections: document.connections,
    acceptance: document.acceptance,
    productionExecution: document.productionExecution,
    legacySystem: document.legacySystem,
    signoffs: document.signoffs.map((signoff) => ({
      role: signoff.role,
      actorHash: signoff.actorHash,
      decision: signoff.decision,
      evidenceId: signoff.evidenceId,
      evidenceHash: signoff.evidenceHash,
      acceptedAt: signoff.acceptedAt,
    })),
    signerKeysetHash: signerKeysetHashValue,
  });
}

function signoffSignaturePayload(cutoverPayloadHash, signoff) {
  return signatureCanonical({
    suite: SIGNOFF_SIGNATURE_SUITE,
    cutoverPayloadHash,
    role: signoff.role,
    keyId: signoff.keyId,
    signedAt: signoff.signedAt,
  });
}

function createFixture() {
  const hash = (character) => `sha256:${character.repeat(64)}`;
  const id = (suffix) => `01J8ZQK7V0A2M4N6P8R0T2W4${suffix.toString(16).toUpperCase().padStart(2, '0')}`;
  const commitSha = 'a'.repeat(40);
  const start = Date.parse('2026-07-19T00:00:00.000Z');
  const end = start + 6 * 60 * 60 * 1_000;
  const privateKeys = new Map();
  const signingAuthorities = SIGNOFF_ROLES.map((role) => {
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
  const evidence = {
    formatVersion: 2,
    suite: 'gaoq.phase6.cutover.v2',
    releaseId: id(1),
    source: {
      commitSha, releaseCandidate: 'rc-20260719-01',
      images: {
        api: hash('a'),
        worker: hash('b'),
        web: hash('c'),
        website: hash('d'),
      },
      deploymentManifestHash: hash('e'), harnessSha256: HARNESS_DIGEST,
    },
    environment: {
      name: 'cn-prod-primary', region: 'cn-shanghai', timezone: 'Asia/Shanghai',
      production: true, startedAt: new Date(start).toISOString(), endedAt: new Date(end).toISOString(),
    },
    phase5Decision: {
      decisionId: id(2), outcome: 'GO', subjectCommitSha: commitSha,
      releaseCandidate: 'rc-20260719-01', evidenceHash: hash('e'),
      decidedAt: new Date(start - 24 * 60 * 60 * 1_000).toISOString(),
      validUntil: new Date(end + 24 * 60 * 60 * 1_000).toISOString(),
    },
    rehearsals: [1, 2, 3].map((sequence) => {
      const rehearsalStart = start - (8 - sequence) * 24 * 60 * 60 * 1_000;
      const rehearsalEnd = rehearsalStart + 7 * 60 * 60 * 1_000;
      return {
        sequence, evidenceId: id(2 + sequence), evidenceHash: hash(String(sequence)),
        subjectCommitSha: commitSha, mode: 'full', productionEquivalent: true,
        startedAt: new Date(rehearsalStart).toISOString(),
        endedAt: new Date(rehearsalEnd).toISOString(), durationSeconds: 25_200,
        recordMismatches: 0, permissionMismatches: 0, amountDifferenceMinor: 0,
        missingAttachments: 0, checksumMismatches: 0, status: 'passed',
      };
    }),
    rollbackRehearsal: {
      evidenceId: id(6), evidenceHash: hash('f'), subjectCommitSha: commitSha,
      productionGrade: true,
      startedAt: new Date(start - 2 * 24 * 60 * 60 * 1_000).toISOString(),
      endedAt: new Date(start - 2 * 24 * 60 * 60 * 1_000 + 3 * 60 * 60 * 1_000).toISOString(),
      durationSeconds: 10_800, components: [...ROLLBACK_COMPONENTS], lostEvents: 0,
      duplicateBusinessEffects: 0, permissionMismatches: 0, status: 'passed',
    },
    window: {
      approvedStartAt: new Date(start).toISOString(),
      approvedEndAt: new Date(start + 8 * 60 * 60 * 1_000).toISOString(),
      freezeStartedAt: new Date(start).toISOString(), productionOpenedAt: new Date(end).toISOString(),
      rollbackTriggered: false, stopConditionCount: 0,
    },
    steps: STEPS.map((name, index) => ({
      sequence: index + 1, name, status: 'completed',
      startedAt: new Date(start + index * 30 * 60 * 1_000).toISOString(),
      endedAt: new Date(start + (index + 1) * 30 * 60 * 1_000).toISOString(),
      operatorEvidenceId: id(10 + index * 2), reviewerEvidenceId: id(11 + index * 2),
      evidenceHash: hash((index % 10).toString()),
    })),
    connections: CONNECTIONS.map((name, index) => ({
      name, smokeStatus: 'passed', reconciliationDifferences: 0,
      credentialExposed: false, evidenceHash: hash((index % 10).toString()),
    })),
    acceptance: {
      openSev1: 0, openSev2: 0, criticalVulnerabilities: 0, highVulnerabilities: 0,
      recordMismatches: 0, permissionMismatches: 0, amountDifferenceMinor: 0,
      missingAttachments: 0, checksumMismatches: 0, crossTenantAttempts: 30,
      crossTenantDenied: 30, mcpR3ToolCount: 0,
    },
    productionExecution: {
      evidenceId: id(60), evidenceHash: hash('a'), changeEvidenceId: id(61),
      policyId: 'phase6-production-execution-v1',
      enabledAt: new Date(start + 2 * 60 * 60 * 1_000).toISOString(),
      subjectCommitSha: commitSha, deploymentManifestHash: hash('e'),
      maxAuthorizationTtlSeconds: 900, singleUse: true, bindTenant: true,
      bindResource: true, bindSubjectHash: true, bindExpectedVersion: true,
      bindRelease: true, credentialReuseDetected: false, mcpR3ToolCount: 0,
      actions: PRODUCTION_EXECUTION_ACTIONS.map((name, index) => ({
        name, successfulAuthorizations: 1, replayAttempts: 1, replaysDenied: 1,
        bindingMismatchAttempts: 5, bindingMismatchesDenied: 5,
        evidenceHash: hash(index === 0 ? 'b' : 'c'),
      })),
    },
    legacySystem: {
      writeFrozen: true, readOnly: true, dataPreserved: true, auditPreserved: true,
      writeProbeRejected: true, evidenceHash: hash('9'),
    },
    signingAuthorities,
    signoffs: SIGNOFF_ROLES.map((role, index) => ({
      role,
      actorHash: hash(String.fromCharCode(97 + index)),
      decision: 'accepted',
      evidenceId: id(40 + index),
      evidenceHash: hash(String.fromCharCode(49 + index)),
      acceptedAt: new Date(end + (index + 1) * 60 * 1_000).toISOString(),
      signedAt: new Date(end + (index + 6) * 60 * 1_000).toISOString(),
      algorithm: 'Ed25519',
      keyId: signingAuthorities[index].keyId,
      signedPayloadSha256: hash('0'),
      signature: 'A'.repeat(86),
    })),
  };
  signFixtureSignoffs(evidence, privateKeys);
  return Object.freeze({ evidence, privateKeys });
}

function runSelfTest() {
  const now = Date.parse('2026-07-20T00:00:00.000Z');
  const { evidence, privateKeys } = createFixture();
  const expectedKeysetHash = signerKeysetHash(evidence.signingAuthorities);
  validateEvidence(evidence, false, now, expectedKeysetHash);
  const cases = [
    [(value) => { value.rehearsals.pop(); }, 'PHASE6_CUTOVER_REHEARSALS_INCOMPLETE'],
    [(value) => { value.rollbackRehearsal.durationSeconds = 14_401; },
      'PHASE6_CUTOVER_ROLLBACK_RTO_EXCEEDED'],
    [(value) => { value.phase5Decision.validUntil = value.environment.startedAt; },
      'PHASE6_CUTOVER_PHASE5_DECISION_EXPIRED'],
    [(value) => { value.steps[2].reviewerEvidenceId = value.steps[2].operatorEvidenceId; },
      'PHASE6_CUTOVER_TWO_PERSON_REVIEW_REQUIRED'],
    [(value) => { value.acceptance.mcpR3ToolCount = 1; }, 'PHASE6_CUTOVER_ACCEPTANCE_FAILED'],
    [(value) => { value.legacySystem.readOnly = false; }, 'PHASE6_CUTOVER_LEGACY_INVALID'],
    [(value) => { value.connections[0].credentialExposed = true; },
      'PHASE6_CUTOVER_CREDENTIAL_EXPOSED'],
    [(value) => { value.productionExecution.actions[0].replaysDenied = 0; },
      'PHASE6_PRODUCTION_EXECUTION_REPLAY_ACCEPTED'],
    [(value) => { value.productionExecution.bindRelease = false; },
      'PHASE6_PRODUCTION_EXECUTION_POLICY_INVALID'],
    [(value) => {
      value.productionExecution.actions[1].evidenceHash =
        value.productionExecution.actions[0].evidenceHash;
    }, 'PHASE6_PRODUCTION_EXECUTION_EVIDENCE_REUSED'],
    [(value) => { value.signoffs[1].actorHash = value.signoffs[0].actorHash; },
      'PHASE6_CUTOVER_SIGNOFF_EVIDENCE_REUSED'],
    [(value) => {
      value.signoffs[0].signature =
        `${value.signoffs[0].signature[0] === 'A' ? 'B' : 'A'}${value.signoffs[0].signature.slice(1)}`;
    }, 'PHASE6_CUTOVER_SIGNOFF_SIGNATURE_INVALID'],
    [(value) => {
      value.signingAuthorities[1].keyId = value.signingAuthorities[0].keyId;
      value.signingAuthorities[1].publicKeySpkiBase64 =
        value.signingAuthorities[0].publicKeySpkiBase64;
    }, 'PHASE6_CUTOVER_SIGNING_AUTHORITIES_NOT_INDEPENDENT'],
    [(value) => {
      const firstKeyId = value.signoffs[0].keyId;
      value.signoffs[0].keyId = value.signoffs[1].keyId;
      value.signoffs[1].keyId = firstKeyId;
    }, 'PHASE6_CUTOVER_SIGNOFF_KEY_MISMATCH'],
    [(value) => { value.signoffs[0].evidenceHash = `sha256:${'f'.repeat(64)}`; },
      'PHASE6_CUTOVER_SIGNOFF_PAYLOAD_MISMATCH'],
  ];
  for (const [mutate, code] of cases) {
    const value = structuredClone(evidence);
    mutate(value);
    expectFailure(() => validateEvidence(value, false, now), code);
  }
  expectFailure(
    () => validateEvidence(evidence, false, now, `sha256:${'f'.repeat(64)}`),
    'PHASE6_CUTOVER_SIGNER_KEYSET_MISMATCH',
  );
  const futureSignature = structuredClone(evidence);
  futureSignature.signoffs[0].signedAt = '2026-07-21T00:10:00.000Z';
  signFixtureSignoffs(futureSignature, privateKeys);
  expectFailure(
    () => validateEvidence(futureSignature, false, now),
    'PHASE6_CUTOVER_SIGNOFF_SIGNATURE_TIME_INVALID',
  );
}

function signFixtureSignoffs(evidence, privateKeys) {
  const keysetHash = signerKeysetHash(evidence.signingAuthorities);
  const payloadHash = digest(cutoverPayload(evidence, keysetHash));
  for (const signoff of evidence.signoffs) {
    const payload = signoffSignaturePayload(payloadHash, signoff);
    signoff.signedPayloadSha256 = digest(payload);
    signoff.signature = sign(
      null,
      Buffer.from(payload, 'utf8'),
      privateKeys.get(signoff.role),
    ).toString('base64url');
  }
}

function publicKeyFromSpkiBase64(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
    fail('PHASE6_CUTOVER_SIGNING_AUTHORITY_INVALID');
  }
  let der;
  try {
    der = Buffer.from(value, 'base64');
  } catch {
    fail('PHASE6_CUTOVER_SIGNING_AUTHORITY_INVALID');
  }
  if (
    der.length < 32 ||
    der.length > 256 ||
    der.toString('base64') !== value
  ) fail('PHASE6_CUTOVER_SIGNING_AUTHORITY_INVALID');
  let publicKey;
  try {
    publicKey = createPublicKey({ key: der, format: 'der', type: 'spki' });
  } catch {
    fail('PHASE6_CUTOVER_SIGNING_AUTHORITY_INVALID');
  }
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    fail('PHASE6_CUTOVER_SIGNING_AUTHORITY_INVALID');
  }
  return publicKey;
}

function publicKeyHash(publicKey) {
  return digest(publicKey.export({ format: 'der', type: 'spki' }));
}

function signerKeysetHash(authorities) {
  return digest(signatureCanonical(
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
    fail('PHASE6_CUTOVER_SIGNOFF_SIGNATURE_INVALID');
  }
  if (signature.length !== 64 || signature.toString('base64url') !== value) {
    fail('PHASE6_CUTOVER_SIGNOFF_SIGNATURE_INVALID');
  }
  return signature;
}

function signatureCanonical(value) {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string'
  ) return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('PHASE6_CUTOVER_NUMBER_INVALID');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => signatureCanonical(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${signatureCanonical(value[key])}`)
      .join(',')}}`;
  }
  return fail('PHASE6_CUTOVER_VALUE_INVALID');
}

function parseDocument(content) {
  try { return JSON.parse(content); } catch { fail('PHASE6_CUTOVER_EVIDENCE_JSON_INVALID'); }
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

function integer(value, minimum, maximum, code) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(code);
}

function equal(actual, expected, code) { if (actual !== expected) fail(code); }

function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    fail('PHASE6_CUTOVER_TIMESTAMP_INVALID');
  }
  const result = Date.parse(value);
  if (!Number.isFinite(result)) fail('PHASE6_CUTOVER_TIMESTAMP_INVALID');
  return result;
}

function duration(startedAt, endedAt, minimumSeconds, maximumSeconds, code) {
  const seconds = secondsBetween(startedAt, endedAt);
  if (seconds < minimumSeconds || seconds > maximumSeconds) fail(code);
}

function secondsBetween(startedAt, endedAt) { return (endedAt - startedAt) / 1_000; }
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
