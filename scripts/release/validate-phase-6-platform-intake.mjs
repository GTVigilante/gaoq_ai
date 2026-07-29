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
const DNS_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/u;
const GROUP = /^[A-Za-z0-9][A-Za-z0-9:._/@-]{2,127}$/u;
const REGION = /^[a-z0-9-]{2,32}$/u;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/u;
const SERVICE_NAMES = [
  'egress-gateway', 'ingress-gateway', 'kms', 'mongodb', 'observability',
  'redis', 'registry', 'secret-manager', 'worm-storage',
];
const APPROVAL_ROLES = [
  'change_owner', 'compliance_owner', 'data_owner', 'platform_owner', 'security_owner',
  'sre_owner',
];
const APPROVAL_SIGNATURE_SUITE = 'gaoq.phase6.production-platform-intake.approval.v1';
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
    formatVersion: 2,
    suite: 'gaoq.phase6.production-platform-intake.v2',
    validatorSha256: VALIDATOR_SHA256,
    serviceNames: SERVICE_NAMES,
    approvalRoles: APPROVAL_ROLES,
    signatureSuite: APPROVAL_SIGNATURE_SUITE,
    signatureAlgorithm: 'Ed25519',
    signatureEncoding: 'base64url-unpadded',
    publicKeyEncoding: 'base64-spki-der',
    keyId: 'sha256:<lowercase-hex-of-spki-der>',
    canonicalization: 'RFC8785-compatible-validated-number-subset',
    signerKeysetCanonicalFields: ['role', 'keyId'],
    signerKeysetOrder: 'role-ascending',
    intakePayloadFields: [
      'formatVersion', 'suite', 'intakeId', 'assessedAt', 'source', 'cluster',
      'github', 'services', 'approvals', 'decision', 'signerKeysetHash',
    ],
    intakeApprovalFields: [
      'role', 'actorHash', 'status', 'approvedAt', 'evidenceHash',
    ],
    intakeApprovalOrder: 'document-order',
    approvalPayloadFields: [
      'suite', 'intakePayloadHash', 'role', 'keyId', 'signedAt',
    ],
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
    formatVersion: 2,
    suite: 'gaoq.phase6.production-platform-intake.verdict',
    intakeId: summary.intakeId,
    outcome: 'READY',
    commitSha: summary.commitSha,
    region: summary.region,
    clusterVersion: summary.clusterVersion,
    signerKeysetHash: summary.signerKeysetHash,
    intakePayloadHash: summary.intakePayloadHash,
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
    githubPolicy: process.env.GAOQ_OIDC_POLICY,
    evidenceOidcAudienceHash: process.env.PHASE6_DEPLOYMENT_INPUT_OIDC_AUDIENCE === undefined
      ? undefined
      : digest(process.env.PHASE6_DEPLOYMENT_INPUT_OIDC_AUDIENCE),
    kubernetesOidcAudienceHash: process.env.PHASE6_KUBERNETES_OIDC_AUDIENCE === undefined
      ? undefined
      : digest(process.env.PHASE6_KUBERNETES_OIDC_AUDIENCE),
    signerKeysetHash:
      process.env.PHASE6_DEPLOYMENT_PLATFORM_INTAKE_SIGNER_KEYSET_SHA256,
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
  if (![
    'phase-6-deployment-plan', 'phase-6-deployment-apply',
  ].includes(expected.githubPolicy)) fail('PHASE6_PLATFORM_INTAKE_EXPECTED_INVALID');
  pattern(
    expected.evidenceOidcAudienceHash,
    SHA256,
    'PHASE6_PLATFORM_INTAKE_EXPECTED_INVALID',
  );
  pattern(
    expected.kubernetesOidcAudienceHash,
    SHA256,
    'PHASE6_PLATFORM_INTAKE_EXPECTED_INVALID',
  );
  pattern(expected.signerKeysetHash, SHA256, 'PHASE6_PLATFORM_INTAKE_EXPECTED_INVALID');
  kubernetesVersion(expected.kubectlVersion);
  return expected;
}

function validateEvidence(document, expected, now = Date.now()) {
  ensureNoSensitiveMaterial(document);
  object(document, [
    'formatVersion', 'suite', 'intakeId', 'assessedAt', 'source', 'cluster', 'github',
    'services', 'signingAuthorities', 'approvals', 'decision',
  ], 'PHASE6_PLATFORM_INTAKE_DOCUMENT_INVALID');
  equal(document.formatVersion, 2, 'PHASE6_PLATFORM_INTAKE_FORMAT_INVALID');
  equal(document.suite, 'gaoq.phase6.production-platform-intake.v2',
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
  const signingAuthorities = validateSigningAuthorities(document.signingAuthorities);
  if (expected !== undefined) {
    equal(
      signingAuthorities.keysetHash,
      expected.signerKeysetHash,
      'PHASE6_PLATFORM_INTAKE_SIGNER_KEYSET_MISMATCH',
    );
  }
  const approvalTimes = validateApprovalMetadata(document.approvals, assessedAt);
  validateDecision(document.decision, assessedAt, Math.max(...approvalTimes), now);
  const intakePayloadHash = digest(
    intakePayload(document, signingAuthorities.keysetHash),
  );
  validateApprovalSignatures(
    document.approvals,
    signingAuthorities.byRole,
    intakePayloadHash,
    timestamp(document.decision.decidedAt),
    timestamp(document.decision.expiresAt),
    now,
  );
  if (expected !== undefined) validateExpected(document, expected);
  return Object.freeze({
    intakeId: document.intakeId,
    commitSha: document.source.commitSha,
    region: cluster.region,
    clusterVersion: cluster.version,
    signerKeysetHash: signingAuthorities.keysetHash,
    intakePayloadHash,
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
  integer(oidc.maximumCredentialMinutes, 1, 15, 'PHASE6_PLATFORM_INTAKE_OIDC_INVALID');
  equal(oidc.serviceAccountTokens, false, 'PHASE6_PLATFORM_INTAKE_SERVICE_ACCOUNT_FORBIDDEN');
}

function validateGithub(github) {
  object(github, [
    'repositoryId', 'defaultBranch', 'plan', 'apply', 'runnersSeparated', 'evidenceHash',
  ], 'PHASE6_PLATFORM_INTAKE_GITHUB_INVALID');
  pattern(github.repositoryId, /^[1-9][0-9]{3,15}$/u, 'PHASE6_PLATFORM_INTAKE_GITHUB_INVALID');
  equal(github.defaultBranch, 'main', 'PHASE6_PLATFORM_INTAKE_GITHUB_INVALID');
  validateGithubWorkflow(github.plan, {
    name: 'phase-6-deployment-plan',
    workflowRef:
      'GTVigilante/gaoq_ai/.github/workflows/phase-6-deployment-plan.yml@refs/heads/main',
    authorizationMode: 'read-only-plan',
    minimumExternalApprovals: 0,
  });
  validateGithubWorkflow(github.apply, {
    name: 'phase-6-deployment-apply',
    workflowRef:
      'GTVigilante/gaoq_ai/.github/workflows/phase-6-deployment-apply.yml@refs/heads/main',
    authorizationMode: 'external-signed-evidence',
    minimumExternalApprovals: 2,
  });
  if (
    github.plan.evidenceAudienceHash === github.apply.evidenceAudienceHash ||
    github.plan.kubernetesAudienceHash === github.apply.kubernetesAudienceHash
  ) {
    fail('PHASE6_PLATFORM_INTAKE_OIDC_AUDIENCE_NOT_SEPARATED');
  }
  equal(github.runnersSeparated, true, 'PHASE6_PLATFORM_INTAKE_RUNNERS_NOT_SEPARATED');
  pattern(github.evidenceHash, SHA256, 'PHASE6_PLATFORM_INTAKE_GITHUB_INVALID');
}

function validateGithubWorkflow(workflow, contract) {
  object(workflow, [
    'name', 'workflowRef', 'authorizationMode', 'minimumExternalApprovals',
    'runnerEnvironment', 'runnerImage', 'evidenceAudienceHash',
    'kubernetesAudienceHash', 'ephemeralRunner', 'secretReadPermission',
  ], 'PHASE6_PLATFORM_INTAKE_GITHUB_WORKFLOW_INVALID');
  equal(workflow.name, contract.name, 'PHASE6_PLATFORM_INTAKE_GITHUB_WORKFLOW_INVALID');
  equal(
    workflow.workflowRef,
    contract.workflowRef,
    'PHASE6_PLATFORM_INTAKE_GITHUB_WORKFLOW_INVALID',
  );
  equal(
    workflow.authorizationMode,
    contract.authorizationMode,
    'PHASE6_PLATFORM_INTAKE_GITHUB_AUTHORIZATION_INVALID',
  );
  equal(
    workflow.minimumExternalApprovals,
    contract.minimumExternalApprovals,
    'PHASE6_PLATFORM_INTAKE_GITHUB_AUTHORIZATION_INVALID',
  );
  equal(workflow.runnerEnvironment, 'github-hosted',
    'PHASE6_PLATFORM_INTAKE_RUNNER_ENVIRONMENT_INVALID');
  equal(workflow.runnerImage, 'ubuntu-latest', 'PHASE6_PLATFORM_INTAKE_RUNNER_IMAGE_INVALID');
  pattern(
    workflow.evidenceAudienceHash,
    SHA256,
    'PHASE6_PLATFORM_INTAKE_OIDC_AUDIENCE_INVALID',
  );
  pattern(
    workflow.kubernetesAudienceHash,
    SHA256,
    'PHASE6_PLATFORM_INTAKE_OIDC_AUDIENCE_INVALID',
  );
  if (workflow.evidenceAudienceHash === workflow.kubernetesAudienceHash) {
    fail('PHASE6_PLATFORM_INTAKE_OIDC_AUDIENCE_NOT_SEPARATED');
  }
  equal(workflow.ephemeralRunner, true, 'PHASE6_PLATFORM_INTAKE_RUNNER_NOT_EPHEMERAL');
  equal(workflow.secretReadPermission, false, 'PHASE6_PLATFORM_INTAKE_SECRET_READ_FORBIDDEN');
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

function validateSigningAuthorities(authorities) {
  if (!Array.isArray(authorities) || authorities.length !== APPROVAL_ROLES.length) {
    fail('PHASE6_PLATFORM_INTAKE_SIGNING_AUTHORITIES_INCOMPLETE');
  }
  const roles = [];
  const keyIds = new Set();
  const byRole = new Map();
  const keyset = [];
  for (const authority of authorities) {
    object(
      authority,
      ['role', 'algorithm', 'keyId', 'publicKeySpkiBase64'],
      'PHASE6_PLATFORM_INTAKE_SIGNING_AUTHORITY_INVALID',
    );
    if (!APPROVAL_ROLES.includes(authority.role)) {
      fail('PHASE6_PLATFORM_INTAKE_SIGNING_AUTHORITY_INVALID');
    }
    equal(
      authority.algorithm,
      'Ed25519',
      'PHASE6_PLATFORM_INTAKE_SIGNING_AUTHORITY_INVALID',
    );
    pattern(
      authority.keyId,
      SHA256,
      'PHASE6_PLATFORM_INTAKE_SIGNING_AUTHORITY_INVALID',
    );
    const publicKey = publicKeyFromSpkiBase64(authority.publicKeySpkiBase64);
    equal(
      authority.keyId,
      publicKeyHash(publicKey),
      'PHASE6_PLATFORM_INTAKE_SIGNING_AUTHORITY_KEY_MISMATCH',
    );
    roles.push(authority.role);
    keyIds.add(authority.keyId);
    byRole.set(authority.role, Object.freeze({ keyId: authority.keyId, publicKey }));
    keyset.push(Object.freeze({ role: authority.role, keyId: authority.keyId }));
  }
  if (
    canonical(roles.sort()) !== canonical(APPROVAL_ROLES) ||
    keyIds.size !== APPROVAL_ROLES.length ||
    byRole.size !== APPROVAL_ROLES.length
  ) fail('PHASE6_PLATFORM_INTAKE_SIGNING_AUTHORITIES_INCOMPLETE');
  return Object.freeze({ byRole, keysetHash: signerKeysetHash(keyset) });
}

function validateApprovalMetadata(approvals, assessedAt) {
  if (!Array.isArray(approvals) || approvals.length !== APPROVAL_ROLES.length) {
    fail('PHASE6_PLATFORM_INTAKE_APPROVALS_INCOMPLETE');
  }
  const roles = [];
  const actors = new Set();
  const evidence = new Set();
  const times = [];
  for (const approval of approvals) {
    object(
      approval,
      [
        'role', 'actorHash', 'status', 'approvedAt', 'evidenceHash', 'signedAt',
        'algorithm', 'keyId', 'signedPayloadSha256', 'signature',
      ],
      'PHASE6_PLATFORM_INTAKE_APPROVAL_INVALID',
    );
    if (!APPROVAL_ROLES.includes(approval.role)) {
      fail('PHASE6_PLATFORM_INTAKE_APPROVAL_INVALID');
    }
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

function validateApprovalSignatures(
  approvals,
  signingAuthorities,
  intakePayloadHash,
  decidedAt,
  expiresAt,
  now,
) {
  const signatures = new Set();
  for (const approval of approvals) {
    equal(
      approval.algorithm,
      'Ed25519',
      'PHASE6_PLATFORM_INTAKE_APPROVAL_PROOF_INVALID',
    );
    pattern(
      approval.keyId,
      SHA256,
      'PHASE6_PLATFORM_INTAKE_APPROVAL_PROOF_INVALID',
    );
    pattern(
      approval.signedPayloadSha256,
      SHA256,
      'PHASE6_PLATFORM_INTAKE_APPROVAL_PROOF_INVALID',
    );
    pattern(
      approval.signature,
      SIGNATURE,
      'PHASE6_PLATFORM_INTAKE_APPROVAL_PROOF_INVALID',
    );
    const signedAt = timestamp(approval.signedAt);
    if (
      signedAt < decidedAt ||
      signedAt >= expiresAt ||
      signedAt > now + 5 * 60_000
    ) {
      fail('PHASE6_PLATFORM_INTAKE_APPROVAL_SIGNATURE_TIME_INVALID');
    }
    const authority = signingAuthorities.get(approval.role);
    if (authority === undefined) {
      fail('PHASE6_PLATFORM_INTAKE_APPROVAL_AUTHORITY_INVALID');
    }
    equal(
      approval.keyId,
      authority.keyId,
      'PHASE6_PLATFORM_INTAKE_APPROVAL_KEY_MISMATCH',
    );
    const payload = approvalSignaturePayload(intakePayloadHash, approval);
    equal(
      approval.signedPayloadSha256,
      digest(payload),
      'PHASE6_PLATFORM_INTAKE_APPROVAL_PAYLOAD_MISMATCH',
    );
    let signature;
    try {
      signature = Buffer.from(approval.signature, 'base64url');
    } catch {
      fail('PHASE6_PLATFORM_INTAKE_APPROVAL_SIGNATURE_INVALID');
    }
    if (
      signature.length !== 64 ||
      signature.toString('base64url') !== approval.signature ||
      !verify(null, Buffer.from(payload, 'utf8'), authority.publicKey, signature)
    ) fail('PHASE6_PLATFORM_INTAKE_APPROVAL_SIGNATURE_INVALID');
    signatures.add(approval.signature);
  }
  if (signatures.size !== APPROVAL_ROLES.length) {
    fail('PHASE6_PLATFORM_INTAKE_APPROVALS_INCOMPLETE');
  }
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
  const githubWorkflow = expected.githubPolicy === 'phase-6-deployment-plan'
    ? document.github.plan
    : document.github.apply;
  equal(
    githubWorkflow.evidenceAudienceHash,
    expected.evidenceOidcAudienceHash,
    'PHASE6_PLATFORM_INTAKE_OIDC_AUDIENCE_MISMATCH',
  );
  equal(
    githubWorkflow.kubernetesAudienceHash,
    expected.kubernetesOidcAudienceHash,
    'PHASE6_PLATFORM_INTAKE_OIDC_AUDIENCE_MISMATCH',
  );
}

function intakePayload(document, signerKeysetHashValue) {
  return canonical({
    formatVersion: document.formatVersion,
    suite: document.suite,
    intakeId: document.intakeId,
    assessedAt: document.assessedAt,
    source: document.source,
    cluster: document.cluster,
    github: document.github,
    services: document.services,
    approvals: document.approvals.map((approval) => ({
      role: approval.role,
      actorHash: approval.actorHash,
      status: approval.status,
      approvedAt: approval.approvedAt,
      evidenceHash: approval.evidenceHash,
    })),
    decision: document.decision,
    signerKeysetHash: signerKeysetHashValue,
  });
}

function approvalSignaturePayload(intakePayloadHash, approval) {
  return canonical({
    suite: APPROVAL_SIGNATURE_SUITE,
    intakePayloadHash,
    role: approval.role,
    keyId: approval.keyId,
    signedAt: approval.signedAt,
  });
}

function publicKeyFromSpkiBase64(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
    fail('PHASE6_PLATFORM_INTAKE_SIGNING_AUTHORITY_INVALID');
  }
  let der;
  try {
    der = Buffer.from(value, 'base64');
  } catch {
    fail('PHASE6_PLATFORM_INTAKE_SIGNING_AUTHORITY_INVALID');
  }
  if (
    der.length < 32 ||
    der.length > 256 ||
    der.toString('base64') !== value
  ) fail('PHASE6_PLATFORM_INTAKE_SIGNING_AUTHORITY_INVALID');
  let publicKey;
  try {
    publicKey = createPublicKey({ key: der, format: 'der', type: 'spki' });
  } catch {
    fail('PHASE6_PLATFORM_INTAKE_SIGNING_AUTHORITY_INVALID');
  }
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    fail('PHASE6_PLATFORM_INTAKE_SIGNING_AUTHORITY_INVALID');
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
  const privateKeys = new Map();
  const signingAuthorities = APPROVAL_ROLES.map((role) => {
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
    suite: 'gaoq.phase6.production-platform-intake.v2',
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
        shortLived: true, maximumCredentialMinutes: 15, serviceAccountTokens: false,
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
        name: 'phase-6-deployment-plan',
        workflowRef:
          'GTVigilante/gaoq_ai/.github/workflows/phase-6-deployment-plan.yml@refs/heads/main',
        authorizationMode: 'read-only-plan', minimumExternalApprovals: 0,
        runnerEnvironment: 'github-hosted', runnerImage: 'ubuntu-latest',
        evidenceAudienceHash: hash('7'), kubernetesAudienceHash: hash('8'),
        ephemeralRunner: true, secretReadPermission: false,
      },
      apply: {
        name: 'phase-6-deployment-apply',
        workflowRef:
          'GTVigilante/gaoq_ai/.github/workflows/phase-6-deployment-apply.yml@refs/heads/main',
        authorizationMode: 'external-signed-evidence', minimumExternalApprovals: 2,
        runnerEnvironment: 'github-hosted', runnerImage: 'ubuntu-latest',
        evidenceAudienceHash: hash('9'), kubernetesAudienceHash: hash('a'),
        ephemeralRunner: true, secretReadPermission: false,
      },
      evidenceHash: hash('f'),
    },
    services: SERVICE_NAMES.map((name, index) => ({
      name, status: 'ready', privateConnectivity: true, tls: true, encryptionAtRest: true,
      multiZone: true, recoveryVerified: true, auditEnabled: true,
      evidenceHash: hash(String(index + 1)),
    })),
    signingAuthorities,
    approvals: APPROVAL_ROLES.map((role, index) => ({
      role, actorHash: hash(String.fromCharCode(97 + index)), status: 'approved',
      approvedAt: '2026-07-22T23:15:00.000Z',
      evidenceHash: hash(String(index + 1)),
      signedAt: `2026-07-22T23:${String(31 + index).padStart(2, '0')}:00.000Z`,
      algorithm: 'Ed25519',
      keyId: signingAuthorities[index].keyId,
      signedPayloadSha256: hash('0'),
      signature: 'A'.repeat(86),
    })),
    decision: {
      outcome: 'READY', decidedAt: '2026-07-22T23:30:00.000Z',
      expiresAt: '2026-07-24T23:30:00.000Z', evidenceHash: hash('0'),
    },
  };
  signFixtureApprovals(evidence, privateKeys);
  const keysetHash = signerKeysetHash(signingAuthorities);
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
    githubPolicy: 'phase-6-deployment-plan',
    evidenceOidcAudienceHash: evidence.github.plan.evidenceAudienceHash,
    kubernetesOidcAudienceHash: evidence.github.plan.kubernetesAudienceHash,
    signerKeysetHash: keysetHash,
  });
  validateEvidence(evidence, expected, now);
  for (const mutate of [
    (copy) => { copy.cluster.targetNamespace = copy.cluster.controlNamespace; },
    (copy) => { copy.cluster.oidc.applyGroup = copy.cluster.oidc.planGroup; },
    (copy) => { copy.github.apply.minimumExternalApprovals = 1; },
    (copy) => { copy.github.apply.workflowRef = copy.github.plan.workflowRef; },
    (copy) => { copy.github.plan.runnerEnvironment = 'self-hosted'; },
    (copy) => {
      copy.github.apply.evidenceAudienceHash = copy.github.plan.evidenceAudienceHash;
    },
    (copy) => {
      copy.github.plan.kubernetesAudienceHash = copy.github.plan.evidenceAudienceHash;
    },
    (copy) => { copy.services[0].tls = false; },
    (copy) => { copy.approvals[1].actorHash = copy.approvals[0].actorHash; },
    (copy) => { copy.decision.outcome = 'BLOCKED'; },
    (copy) => { copy.source.password = 'forbidden'; },
    (copy) => {
      copy.approvals[0].signature =
        `${copy.approvals[0].signature[0] === 'A' ? 'B' : 'A'}${copy.approvals[0].signature.slice(1)}`;
    },
    (copy) => {
      copy.signingAuthorities[1].keyId = copy.signingAuthorities[0].keyId;
      copy.signingAuthorities[1].publicKeySpkiBase64 =
        copy.signingAuthorities[0].publicKeySpkiBase64;
    },
    (copy) => {
      const firstKeyId = copy.approvals[0].keyId;
      copy.approvals[0].keyId = copy.approvals[1].keyId;
      copy.approvals[1].keyId = firstKeyId;
    },
  ]) {
    const copy = structuredClone(evidence);
    mutate(copy);
    expectFailure(() => validateEvidence(copy, undefined, now));
  }
  const guardrailsMismatch = structuredClone(evidence);
  guardrailsMismatch.source.guardrailsManifestHash = hash('9');
  expectFailure(() => validateEvidence(guardrailsMismatch, expected, now));
  const keysetMismatch = Object.freeze({ ...expected, signerKeysetHash: hash('9') });
  expectFailure(() => validateEvidence(evidence, keysetMismatch, now));
  const futureSignature = structuredClone(evidence);
  for (const approval of futureSignature.approvals) {
    approval.signedAt = '2026-07-24T00:00:00.000Z';
  }
  signFixtureApprovals(futureSignature, privateKeys);
  expectFailure(() => validateEvidence(futureSignature, undefined, now));
}

function signFixtureApprovals(evidence, privateKeys) {
  const keysetHash = signerKeysetHash(evidence.signingAuthorities);
  const payloadHash = digest(intakePayload(evidence, keysetHash));
  for (const approval of evidence.approvals) {
    const payload = approvalSignaturePayload(payloadHash, approval);
    approval.signedPayloadSha256 = digest(payload);
    approval.signature = sign(
      null,
      Buffer.from(payload, 'utf8'),
      privateKeys.get(approval.role),
    ).toString('base64url');
  }
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
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string'
  ) return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) fail('PHASE6_PLATFORM_INTAKE_NUMBER_INVALID');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonical(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  return fail('PHASE6_PLATFORM_INTAKE_VALUE_INVALID');
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
