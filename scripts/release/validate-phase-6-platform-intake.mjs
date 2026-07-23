import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';

const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const DNS_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/u;
const GROUP = /^[A-Za-z0-9][A-Za-z0-9:._/@-]{2,127}$/u;
const REGION = /^[a-z0-9-]{2,32}$/u;
const SERVICE_NAMES = [
  'egress-gateway', 'ingress-gateway', 'kms', 'mongodb', 'observability',
  'redis', 'registry', 'secret-manager', 'worm-storage',
];
const APPROVAL_ROLES = [
  'change_owner', 'compliance_owner', 'data_owner', 'platform_owner', 'security_owner',
  'sre_owner',
];
const FORBIDDEN_KEYS = new Set([
  'accessKey', 'apiKey', 'clientSecret', 'connectionString', 'credential', 'password',
  'privateKey', 'secret', 'secretValue', 'token',
]);
const VALIDATOR_SHA256 = digest(await readFile(new URL(import.meta.url)));

const argumentsList = process.argv.slice(2);
if (argumentsList.length === 1 && argumentsList[0] === '--self-test') {
  runSelfTest();
  process.stdout.write('Phase 6 生产平台准入证据门禁自测通过。\n');
} else if (argumentsList.length === 1 && argumentsList[0] === '--print-contract') {
  process.stdout.write(`${JSON.stringify({
    formatVersion: 1,
    suite: 'gaoq.phase6.production-platform-intake.v1',
    validatorSha256: VALIDATOR_SHA256,
    serviceNames: SERVICE_NAMES,
    approvalRoles: APPROVAL_ROLES,
  }, null, 2)}\n`);
} else {
  const enforceEnvironment = argumentsList[0] === '--enforce-environment';
  const evidencePath = argumentsList[enforceEnvironment ? 1 : 0];
  if (evidencePath === undefined || argumentsList.length !== (enforceEnvironment ? 2 : 1)) {
    fail('PHASE6_PLATFORM_INTAKE_PATH_REQUIRED');
  }
  const metadata = await lstat(evidencePath);
  if (
    !metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 ||
    metadata.size > 512 * 1_024 || (metadata.mode & 0o022) !== 0
  ) fail('PHASE6_PLATFORM_INTAKE_FILE_INVALID');
  const raw = await readFile(evidencePath, 'utf8');
  const expected = enforceEnvironment ? expectedFromEnvironment(raw) : undefined;
  const summary = validateEvidence(parseDocument(raw), expected);
  process.stdout.write(`${JSON.stringify({
    formatVersion: 1,
    suite: 'gaoq.phase6.production-platform-intake.verdict',
    intakeId: summary.intakeId,
    outcome: 'READY',
    commitSha: summary.commitSha,
    region: summary.region,
    clusterVersion: summary.clusterVersion,
    evidenceChecksum: digest(raw),
  }, null, 2)}\n`);
}

function expectedFromEnvironment(raw) {
  const expected = Object.freeze({
    checksum: process.env.PHASE6_DEPLOYMENT_PLATFORM_INTAKE_SHA256,
    commitSha: process.env.PHASE6_DEPLOYMENT_EXPECTED_COMMIT,
    deploymentManifestHash: process.env.PHASE6_DEPLOYMENT_EXPECTED_MANIFEST,
    guardrailsManifestHash: process.env.PHASE6_DEPLOYMENT_GUARDRAILS_MANIFEST_SHA256,
    region: process.env.GO_NO_GO_EXPECTED_REGION,
    platformNamespace: process.env.PHASE6_DEPLOYMENT_PLATFORM_NAMESPACE,
    controlNamespace: process.env.PHASE6_DEPLOYMENT_CONTROL_NAMESPACE,
    targetNamespace: process.env.PHASE6_DEPLOYMENT_TARGET_NAMESPACE,
    planGroup: process.env.PHASE6_DEPLOYMENT_PLAN_GROUP,
    applyGroup: process.env.PHASE6_DEPLOYMENT_APPLY_GROUP,
    kubectlVersion: process.env.PHASE6_DEPLOYMENT_KUBECTL_VERSION,
  });
  pattern(expected.checksum, SHA256, 'PHASE6_PLATFORM_INTAKE_EXPECTED_INVALID');
  equal(digest(raw), expected.checksum, 'PHASE6_PLATFORM_INTAKE_CHECKSUM_MISMATCH');
  pattern(expected.commitSha, COMMIT, 'PHASE6_PLATFORM_INTAKE_EXPECTED_INVALID');
  pattern(expected.deploymentManifestHash, SHA256, 'PHASE6_PLATFORM_INTAKE_EXPECTED_INVALID');
  pattern(expected.guardrailsManifestHash, SHA256, 'PHASE6_PLATFORM_INTAKE_EXPECTED_INVALID');
  pattern(expected.region, REGION, 'PHASE6_PLATFORM_INTAKE_EXPECTED_INVALID');
  for (const value of [
    expected.platformNamespace, expected.controlNamespace, expected.targetNamespace,
  ]) {
    pattern(value, DNS_LABEL, 'PHASE6_PLATFORM_INTAKE_EXPECTED_INVALID');
  }
  for (const value of [expected.planGroup, expected.applyGroup]) {
    pattern(value, GROUP, 'PHASE6_PLATFORM_INTAKE_EXPECTED_INVALID');
  }
  kubernetesVersion(expected.kubectlVersion);
  return expected;
}

function validateEvidence(document, expected, now = Date.now()) {
  ensureNoSensitiveMaterial(document);
  object(document, [
    'formatVersion', 'suite', 'intakeId', 'assessedAt', 'source', 'cluster', 'github',
    'services', 'approvals', 'decision',
  ], 'PHASE6_PLATFORM_INTAKE_DOCUMENT_INVALID');
  equal(document.formatVersion, 1, 'PHASE6_PLATFORM_INTAKE_FORMAT_INVALID');
  equal(document.suite, 'gaoq.phase6.production-platform-intake.v1',
    'PHASE6_PLATFORM_INTAKE_SUITE_INVALID');
  pattern(document.intakeId, ULID, 'PHASE6_PLATFORM_INTAKE_ID_INVALID');
  const assessedAt = timestamp(document.assessedAt);
  if (assessedAt > now + 5 * 60_000 || now - assessedAt > 24 * 60 * 60_000) {
    fail('PHASE6_PLATFORM_INTAKE_STALE');
  }
  validateSource(document.source);
  const cluster = validateCluster(document.cluster);
  validateGithub(document.github);
  validateServices(document.services);
  const approvalTimes = validateApprovals(document.approvals, assessedAt);
  validateDecision(document.decision, assessedAt, Math.max(...approvalTimes), now);
  if (expected !== undefined) validateExpected(document, expected);
  return Object.freeze({
    intakeId: document.intakeId,
    commitSha: document.source.commitSha,
    region: cluster.region,
    clusterVersion: cluster.version,
  });
}

function validateSource(source) {
  object(source, [
    'commitSha', 'deploymentManifestHash', 'guardrailsManifestHash', 'validatorSha256',
  ], 'PHASE6_PLATFORM_INTAKE_SOURCE_INVALID');
  pattern(source.commitSha, COMMIT, 'PHASE6_PLATFORM_INTAKE_SOURCE_INVALID');
  for (const field of ['deploymentManifestHash', 'guardrailsManifestHash']) {
    pattern(source[field], SHA256, 'PHASE6_PLATFORM_INTAKE_SOURCE_INVALID');
  }
  equal(source.validatorSha256, VALIDATOR_SHA256, 'PHASE6_PLATFORM_INTAKE_HARNESS_MISMATCH');
}

function validateCluster(cluster) {
  object(cluster, [
    'region', 'version', 'production', 'platformNamespace', 'controlNamespace',
    'targetNamespace', 'oidc', 'controls', 'evidenceHash',
  ], 'PHASE6_PLATFORM_INTAKE_CLUSTER_INVALID');
  pattern(cluster.region, REGION, 'PHASE6_PLATFORM_INTAKE_CLUSTER_INVALID');
  kubernetesVersion(cluster.version);
  equal(cluster.production, true, 'PHASE6_PLATFORM_INTAKE_CLUSTER_NOT_PRODUCTION');
  const namespaces = [cluster.platformNamespace, cluster.controlNamespace, cluster.targetNamespace];
  for (const namespace of namespaces) {
    pattern(namespace, DNS_LABEL, 'PHASE6_PLATFORM_INTAKE_NAMESPACE_INVALID');
  }
  if (new Set(namespaces).size !== namespaces.length) fail('PHASE6_PLATFORM_INTAKE_NAMESPACE_OVERLAP');
  validateOidc(cluster.oidc);
  object(cluster.controls, [
    'podSecurityRestricted', 'validatingAdmissionPolicy', 'networkPolicyDefaultDeny',
    'serverSideDryRunPassed', 'secretReadDenied', 'driftDetectionEnabled',
  ], 'PHASE6_PLATFORM_INTAKE_CLUSTER_CONTROLS_INVALID');
  for (const value of Object.values(cluster.controls)) {
    equal(value, true, 'PHASE6_PLATFORM_INTAKE_CLUSTER_CONTROLS_INVALID');
  }
  pattern(cluster.evidenceHash, SHA256, 'PHASE6_PLATFORM_INTAKE_CLUSTER_INVALID');
  return cluster;
}

function validateOidc(oidc) {
  object(oidc, [
    'issuerHash', 'planGroup', 'applyGroup', 'shortLived', 'maximumCredentialMinutes',
    'serviceAccountTokens',
  ], 'PHASE6_PLATFORM_INTAKE_OIDC_INVALID');
  pattern(oidc.issuerHash, SHA256, 'PHASE6_PLATFORM_INTAKE_OIDC_INVALID');
  pattern(oidc.planGroup, GROUP, 'PHASE6_PLATFORM_INTAKE_OIDC_INVALID');
  pattern(oidc.applyGroup, GROUP, 'PHASE6_PLATFORM_INTAKE_OIDC_INVALID');
  if (oidc.planGroup === oidc.applyGroup) fail('PHASE6_PLATFORM_INTAKE_OIDC_NOT_SEPARATED');
  equal(oidc.shortLived, true, 'PHASE6_PLATFORM_INTAKE_OIDC_INVALID');
  integer(oidc.maximumCredentialMinutes, 1, 60, 'PHASE6_PLATFORM_INTAKE_OIDC_INVALID');
  equal(oidc.serviceAccountTokens, false, 'PHASE6_PLATFORM_INTAKE_SERVICE_ACCOUNT_FORBIDDEN');
}

function validateGithub(github) {
  object(github, [
    'repositoryId', 'defaultBranch', 'plan', 'apply', 'runnersSeparated', 'evidenceHash',
  ], 'PHASE6_PLATFORM_INTAKE_GITHUB_INVALID');
  pattern(github.repositoryId, /^[1-9][0-9]{3,15}$/u, 'PHASE6_PLATFORM_INTAKE_GITHUB_INVALID');
  equal(github.defaultBranch, 'main', 'PHASE6_PLATFORM_INTAKE_GITHUB_INVALID');
  validateGithubEnvironment(github.plan, 'phase-6-production-plan', 1,
    'phase-6-deployment-plan');
  validateGithubEnvironment(github.apply, 'phase-6-production-deployment', 2,
    'phase-6-deployment-apply');
  equal(github.runnersSeparated, true, 'PHASE6_PLATFORM_INTAKE_RUNNERS_NOT_SEPARATED');
  pattern(github.evidenceHash, SHA256, 'PHASE6_PLATFORM_INTAKE_GITHUB_INVALID');
}

function validateGithubEnvironment(environment, name, minimumReviewers, runnerLabel) {
  object(environment, [
    'name', 'requiredReviewers', 'runnerLabels', 'ephemeralRunner', 'secretReadPermission',
  ], 'PHASE6_PLATFORM_INTAKE_GITHUB_ENV_INVALID');
  equal(environment.name, name, 'PHASE6_PLATFORM_INTAKE_GITHUB_ENV_INVALID');
  integer(environment.requiredReviewers, minimumReviewers, 20,
    'PHASE6_PLATFORM_INTAKE_REVIEWERS_INSUFFICIENT');
  const requiredLabels = ['self-hosted', 'linux', 'x64', runnerLabel];
  if (
    !Array.isArray(environment.runnerLabels) ||
    canonical([...environment.runnerLabels].sort()) !== canonical(requiredLabels.sort())
  ) fail('PHASE6_PLATFORM_INTAKE_RUNNER_LABELS_INVALID');
  equal(environment.ephemeralRunner, true, 'PHASE6_PLATFORM_INTAKE_RUNNER_NOT_EPHEMERAL');
  equal(environment.secretReadPermission, false, 'PHASE6_PLATFORM_INTAKE_SECRET_READ_FORBIDDEN');
}

function validateServices(services) {
  if (!Array.isArray(services) || services.length !== SERVICE_NAMES.length) {
    fail('PHASE6_PLATFORM_INTAKE_SERVICES_INCOMPLETE');
  }
  const names = [];
  const hashes = new Set();
  for (const service of services) {
    object(service, [
      'name', 'status', 'privateConnectivity', 'tls', 'encryptionAtRest', 'multiZone',
      'recoveryVerified', 'auditEnabled', 'evidenceHash',
    ], 'PHASE6_PLATFORM_INTAKE_SERVICE_INVALID');
    equal(service.status, 'ready', 'PHASE6_PLATFORM_INTAKE_SERVICE_NOT_READY');
    for (const field of [
      'privateConnectivity', 'tls', 'encryptionAtRest', 'multiZone', 'recoveryVerified',
      'auditEnabled',
    ]) equal(service[field], true, 'PHASE6_PLATFORM_INTAKE_SERVICE_CONTROL_MISSING');
    pattern(service.evidenceHash, SHA256, 'PHASE6_PLATFORM_INTAKE_SERVICE_INVALID');
    names.push(service.name);
    hashes.add(service.evidenceHash);
  }
  if (
    canonical(names.sort()) !== canonical(SERVICE_NAMES) || hashes.size !== SERVICE_NAMES.length
  ) fail('PHASE6_PLATFORM_INTAKE_SERVICES_INCOMPLETE');
}

function validateApprovals(approvals, assessedAt) {
  if (!Array.isArray(approvals) || approvals.length !== APPROVAL_ROLES.length) {
    fail('PHASE6_PLATFORM_INTAKE_APPROVALS_INCOMPLETE');
  }
  const roles = [];
  const actors = new Set();
  const evidence = new Set();
  const times = [];
  for (const approval of approvals) {
    object(approval, ['role', 'actorHash', 'status', 'approvedAt', 'evidenceHash'],
      'PHASE6_PLATFORM_INTAKE_APPROVAL_INVALID');
    pattern(approval.actorHash, SHA256, 'PHASE6_PLATFORM_INTAKE_APPROVAL_INVALID');
    pattern(approval.evidenceHash, SHA256, 'PHASE6_PLATFORM_INTAKE_APPROVAL_INVALID');
    equal(approval.status, 'approved', 'PHASE6_PLATFORM_INTAKE_APPROVAL_MISSING');
    const approvedAt = timestamp(approval.approvedAt);
    if (approvedAt < assessedAt || approvedAt - assessedAt > 24 * 60 * 60_000) {
      fail('PHASE6_PLATFORM_INTAKE_APPROVAL_TIME_INVALID');
    }
    roles.push(approval.role);
    actors.add(approval.actorHash);
    evidence.add(approval.evidenceHash);
    times.push(approvedAt);
  }
  if (
    canonical(roles.sort()) !== canonical(APPROVAL_ROLES) ||
    actors.size !== APPROVAL_ROLES.length || evidence.size !== APPROVAL_ROLES.length
  ) fail('PHASE6_PLATFORM_INTAKE_APPROVALS_INCOMPLETE');
  return times;
}

function validateDecision(decision, assessedAt, latestApproval, now) {
  object(decision, ['outcome', 'decidedAt', 'expiresAt', 'evidenceHash'],
    'PHASE6_PLATFORM_INTAKE_DECISION_INVALID');
  equal(decision.outcome, 'READY', 'PHASE6_PLATFORM_INTAKE_NOT_READY');
  const decidedAt = timestamp(decision.decidedAt);
  const expiresAt = timestamp(decision.expiresAt);
  if (
    decidedAt < assessedAt || decidedAt < latestApproval || decidedAt > now + 5 * 60_000 ||
    expiresAt <= now || expiresAt - decidedAt > 72 * 60 * 60_000
  ) fail('PHASE6_PLATFORM_INTAKE_DECISION_TIME_INVALID');
  pattern(decision.evidenceHash, SHA256, 'PHASE6_PLATFORM_INTAKE_DECISION_INVALID');
}

function validateExpected(document, expected) {
  equal(document.source.commitSha, expected.commitSha, 'PHASE6_PLATFORM_INTAKE_COMMIT_MISMATCH');
  equal(document.source.deploymentManifestHash, expected.deploymentManifestHash,
    'PHASE6_PLATFORM_INTAKE_MANIFEST_MISMATCH');
  equal(document.source.guardrailsManifestHash, expected.guardrailsManifestHash,
    'PHASE6_PLATFORM_INTAKE_GUARDRAILS_MISMATCH');
  equal(document.cluster.region, expected.region, 'PHASE6_PLATFORM_INTAKE_REGION_MISMATCH');
  equal(document.cluster.platformNamespace, expected.platformNamespace,
    'PHASE6_PLATFORM_INTAKE_PLATFORM_NAMESPACE_MISMATCH');
  equal(document.cluster.controlNamespace, expected.controlNamespace,
    'PHASE6_PLATFORM_INTAKE_CONTROL_NAMESPACE_MISMATCH');
  equal(document.cluster.targetNamespace, expected.targetNamespace,
    'PHASE6_PLATFORM_INTAKE_TARGET_NAMESPACE_MISMATCH');
  equal(document.cluster.oidc.planGroup, expected.planGroup,
    'PHASE6_PLATFORM_INTAKE_PLAN_GROUP_MISMATCH');
  equal(document.cluster.oidc.applyGroup, expected.applyGroup,
    'PHASE6_PLATFORM_INTAKE_APPLY_GROUP_MISMATCH');
  equal(kubernetesMinor(document.cluster.version), kubernetesMinor(expected.kubectlVersion),
    'PHASE6_PLATFORM_INTAKE_KUBERNETES_VERSION_MISMATCH');
}

function ensureNoSensitiveMaterial(value, path = '$') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => ensureNoSensitiveMaterial(item, `${path}[${index}]`));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key)) fail('PHASE6_PLATFORM_INTAKE_SENSITIVE_KEY_FORBIDDEN');
      ensureNoSensitiveMaterial(item, `${path}.${key}`);
    }
    return;
  }
  if (typeof value === 'string' && (
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/u.test(value) ||
    /^[a-z][a-z0-9+.-]*:\/\/[^/\s]+:[^/@\s]+@/iu.test(value)
  )) fail('PHASE6_PLATFORM_INTAKE_SENSITIVE_VALUE_FORBIDDEN');
}

function runSelfTest() {
  const now = Date.parse('2026-07-23T00:00:00.000Z');
  const hash = (character) => `sha256:${character.repeat(64)}`;
  const evidence = {
    formatVersion: 1,
    suite: 'gaoq.phase6.production-platform-intake.v1',
    intakeId: '01K00000000000000000000000',
    assessedAt: '2026-07-22T23:00:00.000Z',
    source: {
      commitSha: 'a'.repeat(40), deploymentManifestHash: hash('b'),
      guardrailsManifestHash: hash('c'), validatorSha256: VALIDATOR_SHA256,
    },
    cluster: {
      region: 'cn-test-1', version: 'v1.30.14', production: true,
      platformNamespace: 'gaoq-platform-system', controlNamespace: 'gaoq-erp-control',
      targetNamespace: 'gaoq-erp-prod',
      oidc: {
        issuerHash: hash('d'), planGroup: 'gaoq:phase6-plan', applyGroup: 'gaoq:phase6-apply',
        shortLived: true, maximumCredentialMinutes: 30, serviceAccountTokens: false,
      },
      controls: {
        podSecurityRestricted: true, validatingAdmissionPolicy: true,
        networkPolicyDefaultDeny: true, serverSideDryRunPassed: true,
        secretReadDenied: true, driftDetectionEnabled: true,
      },
      evidenceHash: hash('e'),
    },
    github: {
      repositoryId: '123456789', defaultBranch: 'main', runnersSeparated: true,
      plan: {
        name: 'phase-6-production-plan', requiredReviewers: 1,
        runnerLabels: ['self-hosted', 'linux', 'x64', 'phase-6-deployment-plan'],
        ephemeralRunner: true, secretReadPermission: false,
      },
      apply: {
        name: 'phase-6-production-deployment', requiredReviewers: 2,
        runnerLabels: ['self-hosted', 'linux', 'x64', 'phase-6-deployment-apply'],
        ephemeralRunner: true, secretReadPermission: false,
      },
      evidenceHash: hash('f'),
    },
    services: SERVICE_NAMES.map((name, index) => ({
      name, status: 'ready', privateConnectivity: true, tls: true, encryptionAtRest: true,
      multiZone: true, recoveryVerified: true, auditEnabled: true,
      evidenceHash: hash(String(index + 1)),
    })),
    approvals: APPROVAL_ROLES.map((role, index) => ({
      role, actorHash: hash(String.fromCharCode(97 + index)), status: 'approved',
      approvedAt: '2026-07-22T23:15:00.000Z',
      evidenceHash: hash(String(index + 1)),
    })),
    decision: {
      outcome: 'READY', decidedAt: '2026-07-22T23:30:00.000Z',
      expiresAt: '2026-07-24T23:30:00.000Z', evidenceHash: hash('0'),
    },
  };
  const expected = Object.freeze({
    commitSha: evidence.source.commitSha,
    deploymentManifestHash: evidence.source.deploymentManifestHash,
    guardrailsManifestHash: evidence.source.guardrailsManifestHash,
    region: evidence.cluster.region,
    platformNamespace: evidence.cluster.platformNamespace,
    controlNamespace: evidence.cluster.controlNamespace,
    targetNamespace: evidence.cluster.targetNamespace,
    planGroup: evidence.cluster.oidc.planGroup,
    applyGroup: evidence.cluster.oidc.applyGroup,
    kubectlVersion: 'v1.30.12',
  });
  validateEvidence(evidence, expected, now);
  for (const mutate of [
    (copy) => { copy.cluster.targetNamespace = copy.cluster.controlNamespace; },
    (copy) => { copy.cluster.oidc.applyGroup = copy.cluster.oidc.planGroup; },
    (copy) => { copy.github.apply.requiredReviewers = 1; },
    (copy) => { copy.services[0].tls = false; },
    (copy) => { copy.approvals[1].actorHash = copy.approvals[0].actorHash; },
    (copy) => { copy.decision.outcome = 'BLOCKED'; },
    (copy) => { copy.source.password = 'forbidden'; },
  ]) {
    const copy = structuredClone(evidence);
    mutate(copy);
    expectFailure(() => validateEvidence(copy, undefined, now));
  }
  const guardrailsMismatch = structuredClone(evidence);
  guardrailsMismatch.source.guardrailsManifestHash = hash('9');
  expectFailure(() => validateEvidence(guardrailsMismatch, expected, now));
}

function parseDocument(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return fail('PHASE6_PLATFORM_INTAKE_JSON_INVALID');
  }
}

function kubernetesVersion(value) {
  pattern(value, /^v1\.[0-9]{2}\.[0-9]+(?:[+-][A-Za-z0-9.-]+)?$/u,
    'PHASE6_PLATFORM_INTAKE_KUBERNETES_VERSION_INVALID');
  if (Number(value.split('.')[1]) < 30) fail('PHASE6_PLATFORM_INTAKE_KUBERNETES_VERSION_INVALID');
}

function kubernetesMinor(value) {
  kubernetesVersion(value);
  return value.split('.').slice(0, 2).join('.');
}

function object(value, keys, code) {
  if (
    value === null || typeof value !== 'object' || Array.isArray(value) ||
    canonical(Object.keys(value).sort()) !== canonical([...keys].sort())
  ) fail(code);
}

function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    fail('PHASE6_PLATFORM_INTAKE_TIMESTAMP_INVALID');
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail('PHASE6_PLATFORM_INTAKE_TIMESTAMP_INVALID');
  return parsed;
}

function integer(value, minimum, maximum, code) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) fail(code);
}

function pattern(value, expression, code) {
  if (typeof value !== 'string' || !expression.test(value)) fail(code);
}

function equal(actual, expected, code) {
  if (actual !== expected) fail(code);
}

function canonical(value) {
  return JSON.stringify(value);
}

function digest(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function expectFailure(operation) {
  try {
    operation();
  } catch {
    return;
  }
  fail('PHASE6_PLATFORM_INTAKE_SELF_TEST_EXPECTED_FAILURE');
}

function fail(code) {
  throw new Error(code);
}
