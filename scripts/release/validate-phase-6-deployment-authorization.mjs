import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from 'node:crypto';
import { lstat, open, readFile } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';

const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const DNS_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/u;
const REGION = /^[a-z0-9-]{2,32}$/u;
const RUN_ID = /^[1-9][0-9]{0,19}$/u;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/u;
const APPROVAL_ROLES = ['change_owner', 'sre_owner'];
const APPROVAL_SIGNATURE_SUITE = 'gaoq.phase6.deployment-authorization.approval.v1';
const PLAN_WORKFLOW_REF =
  'GTVigilante/gaoq_ai/.github/workflows/phase-6-deployment-plan.yml@refs/heads/main';
const FORBIDDEN_KEYS = new Set([
  'accessKey', 'apiKey', 'clientSecret', 'connectionString', 'credential', 'password',
  'privateKey', 'secret', 'secretValue', 'token',
]);
const VALIDATOR_SHA256 = digest(await readFile(new URL(import.meta.url)));

const argumentsList = process.argv.slice(2);
if (argumentsList.length === 1 && argumentsList[0] === '--self-test') {
  runSelfTest();
  process.stdout.write('Phase 6 外部签名部署授权证据门禁自测通过。\n');
} else if (argumentsList.length === 1 && argumentsList[0] === '--print-contract') {
  process.stdout.write(`${JSON.stringify({
    formatVersion: 2,
    suite: 'gaoq.phase6.deployment-authorization.v2',
    validatorSha256: VALIDATOR_SHA256,
    signatureAlgorithm: 'Ed25519',
    signatureSuite: APPROVAL_SIGNATURE_SUITE,
    signatureEncoding: 'base64url-unpadded',
    publicKeyEncoding: 'base64-spki-der',
    keyId: 'sha256:<lowercase-hex-of-spki-der>',
    canonicalization: 'RFC8785-compatible-validated-number-subset',
    signerKeysetCanonicalFields: ['role', 'keyId'],
    signerKeysetOrder: 'role-ascending',
    authorizationPayloadFields: [
      'formatVersion', 'suite', 'authorizationId', 'issuedAt', 'expiresAt', 'source',
      'target', 'approvals', 'decision', 'signerKeysetHash',
    ],
    authorizationApprovalFields: [
      'role', 'actorHash', 'status', 'approvedAt', 'evidenceHash',
    ],
    authorizationApprovalOrder: 'document-order',
    approvalPayloadFields: [
      'suite', 'authorizationPayloadHash', 'role', 'keyId', 'signedAt',
    ],
    approvalRoles: APPROVAL_ROLES,
    maximumLifetimeMinutes: 120,
    planWorkflowRef: PLAN_WORKFLOW_REF,
  }, null, 2)}\n`);
} else if (argumentsList.length === 3 && argumentsList[0] === '--write-plan-binding') {
  await writePlanBinding(argumentsList[1], argumentsList[2]);
  process.stdout.write('Phase 6 生产部署计划绑定已生成。\n');
} else {
  const enforceEnvironment = argumentsList[0] === '--enforce-environment';
  const evidencePath = argumentsList[enforceEnvironment ? 1 : 0];
  if (evidencePath === undefined || argumentsList.length !== (enforceEnvironment ? 2 : 1)) {
    fail('PHASE6_DEPLOYMENT_AUTHORIZATION_PATH_REQUIRED');
  }
  const metadata = await lstat(evidencePath);
  if (
    !metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 ||
    metadata.size > 256 * 1_024 || (metadata.mode & 0o022) !== 0
  ) fail('PHASE6_DEPLOYMENT_AUTHORIZATION_FILE_INVALID');
  const raw = await readFile(evidencePath, 'utf8');
  const expected = enforceEnvironment
    ? expectedFromEnvironment(raw)
    : Object.freeze({ enforceBindings: false });
  const summary = validateEvidence(parseDocument(raw), expected);
  process.stdout.write(`${JSON.stringify({
    formatVersion: 2,
    suite: 'gaoq.phase6.deployment-authorization.verdict',
    authorizationId: summary.authorizationId,
    outcome: 'APPROVED',
    commitSha: summary.commitSha,
    planRunId: summary.planRunId,
    planArtifactHash: summary.planArtifactHash,
    renderedManifestHash: summary.renderedManifestHash,
    expiresAt: summary.expiresAt,
    signerKeysetHash: summary.signerKeysetHash,
    authorizationPayloadHash: summary.authorizationPayloadHash,
    evidenceChecksum: digest(raw),
  }, null, 2)}\n`);
}

async function writePlanBinding(outputPath, renderedPath) {
  const runnerTemp = process.env.RUNNER_TEMP;
  if (
    typeof runnerTemp !== 'string' || !isAbsolute(runnerTemp) ||
    typeof outputPath !== 'string' || !isAbsolute(outputPath) ||
    !resolve(outputPath).startsWith(`${resolve(runnerTemp)}${sep}`)
  ) fail('PHASE6_DEPLOYMENT_PLAN_BINDING_PATH_INVALID');
  const sourcePaths = {
    valuesHash: process.env.PHASE6_DEPLOYMENT_VALUES_PATH,
    goNoGoHash: process.env.PHASE6_DEPLOYMENT_GO_NO_GO_PATH,
    platformIntakeHash: process.env.PHASE6_DEPLOYMENT_PLATFORM_INTAKE_PATH,
    renderedManifestHash: renderedPath,
  };
  const hashes = {};
  for (const [field, path] of Object.entries(sourcePaths)) {
    if (typeof path !== 'string' || !isAbsolute(path)) {
      fail('PHASE6_DEPLOYMENT_PLAN_BINDING_INPUT_INVALID');
    }
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o022) !== 0) {
      fail('PHASE6_DEPLOYMENT_PLAN_BINDING_INPUT_INVALID');
    }
    hashes[field] = digest(await readFile(path));
  }
  for (const [actualField, expectedName] of [
    ['valuesHash', 'PHASE6_DEPLOYMENT_VALUES_SHA256'],
    ['goNoGoHash', 'PHASE6_DEPLOYMENT_GO_NO_GO_SHA256'],
    ['platformIntakeHash', 'PHASE6_DEPLOYMENT_PLATFORM_INTAKE_SHA256'],
  ]) {
    equal(
      hashes[actualField],
      process.env[expectedName],
      'PHASE6_DEPLOYMENT_PLAN_BINDING_HASH_MISMATCH',
    );
  }
  const binding = {
    formatVersion: 1,
    suite: 'gaoq.phase6.deployment-plan-binding.v1',
    repositoryId: process.env.GITHUB_REPOSITORY_ID,
    commitSha: process.env.GITHUB_SHA,
    workflowRef: process.env.GITHUB_WORKFLOW_REF,
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
    ...hashes,
    deploymentManifestHash: process.env.PHASE6_DEPLOYMENT_EXPECTED_MANIFEST,
    validatorSha256: VALIDATOR_SHA256,
  };
  pattern(binding.repositoryId, /^[1-9][0-9]{3,15}$/u,
    'PHASE6_DEPLOYMENT_PLAN_BINDING_CONTEXT_INVALID');
  pattern(binding.commitSha, COMMIT, 'PHASE6_DEPLOYMENT_PLAN_BINDING_CONTEXT_INVALID');
  equal(binding.workflowRef, PLAN_WORKFLOW_REF,
    'PHASE6_DEPLOYMENT_PLAN_BINDING_CONTEXT_INVALID');
  pattern(binding.runId, RUN_ID, 'PHASE6_DEPLOYMENT_PLAN_BINDING_CONTEXT_INVALID');
  integer(binding.runAttempt, 1, 1_000, 'PHASE6_DEPLOYMENT_PLAN_BINDING_CONTEXT_INVALID');
  pattern(binding.deploymentManifestHash, SHA256,
    'PHASE6_DEPLOYMENT_PLAN_BINDING_CONTEXT_INVALID');
  const handle = await open(resolve(outputPath), 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(binding, null, 2)}\n`, 'utf8');
  } finally {
    await handle.close();
  }
}

function expectedFromEnvironment(raw) {
  const expected = Object.freeze({
    checksum: process.env.PHASE6_DEPLOYMENT_AUTHORIZATION_SHA256,
    repositoryId: process.env.GITHUB_REPOSITORY_ID,
    commitSha: process.env.PHASE6_DEPLOYMENT_EXPECTED_COMMIT,
    planRunId: process.env.PHASE6_DEPLOYMENT_AUTHORIZED_PLAN_RUN_ID,
    planRunAttempt: process.env.PHASE6_DEPLOYMENT_AUTHORIZED_PLAN_RUN_ATTEMPT,
    planArtifactHash: process.env.PHASE6_DEPLOYMENT_AUTHORIZED_PLAN_ARTIFACT_SHA256,
    valuesHash: process.env.PHASE6_DEPLOYMENT_VALUES_SHA256,
    goNoGoHash: process.env.PHASE6_DEPLOYMENT_GO_NO_GO_SHA256,
    platformIntakeHash: process.env.PHASE6_DEPLOYMENT_PLATFORM_INTAKE_SHA256,
    renderedManifestHash: process.env.PHASE6_DEPLOYMENT_EXPECTED_RENDERED_SHA256,
    deploymentManifestHash: process.env.PHASE6_DEPLOYMENT_EXPECTED_MANIFEST,
    environment: process.env.GO_NO_GO_EXPECTED_ENVIRONMENT,
    region: process.env.GO_NO_GO_EXPECTED_REGION,
    clusterHash: process.env.PHASE6_DEPLOYMENT_CLUSTER_SHA256,
    releaseName: process.env.PHASE6_DEPLOYMENT_RELEASE_NAME,
    controlNamespace: process.env.PHASE6_DEPLOYMENT_CONTROL_NAMESPACE,
    targetNamespace: process.env.PHASE6_DEPLOYMENT_TARGET_NAMESPACE,
    signerKeysetHash:
      process.env.PHASE6_DEPLOYMENT_AUTHORIZATION_SIGNER_KEYSET_SHA256,
  });
  for (const value of [
    expected.checksum, expected.planArtifactHash, expected.valuesHash, expected.goNoGoHash,
    expected.platformIntakeHash, expected.renderedManifestHash,
    expected.deploymentManifestHash, expected.clusterHash, expected.signerKeysetHash,
  ]) pattern(value, SHA256, 'PHASE6_DEPLOYMENT_AUTHORIZATION_EXPECTED_INVALID');
  equal(digest(raw), expected.checksum, 'PHASE6_DEPLOYMENT_AUTHORIZATION_CHECKSUM_MISMATCH');
  pattern(expected.repositoryId, /^[1-9][0-9]{3,15}$/u,
    'PHASE6_DEPLOYMENT_AUTHORIZATION_EXPECTED_INVALID');
  pattern(expected.commitSha, COMMIT, 'PHASE6_DEPLOYMENT_AUTHORIZATION_EXPECTED_INVALID');
  pattern(expected.planRunId, RUN_ID, 'PHASE6_DEPLOYMENT_AUTHORIZATION_EXPECTED_INVALID');
  integerText(
    expected.planRunAttempt,
    1,
    1_000,
    'PHASE6_DEPLOYMENT_AUTHORIZATION_EXPECTED_INVALID',
  );
  pattern(expected.region, REGION, 'PHASE6_DEPLOYMENT_AUTHORIZATION_EXPECTED_INVALID');
  pattern(expected.environment, /^(?:production|prod-[a-z0-9-]{2,24})$/u,
    'PHASE6_DEPLOYMENT_AUTHORIZATION_EXPECTED_INVALID');
  for (const value of [
    expected.releaseName, expected.controlNamespace, expected.targetNamespace,
  ]) pattern(value, DNS_LABEL, 'PHASE6_DEPLOYMENT_AUTHORIZATION_EXPECTED_INVALID');
  if (expected.controlNamespace === expected.targetNamespace) {
    fail('PHASE6_DEPLOYMENT_AUTHORIZATION_EXPECTED_INVALID');
  }
  return Object.freeze({ ...expected, enforceBindings: true });
}

function validateEvidence(document, expected, now = Date.now()) {
  ensureNoSensitiveMaterial(document);
  object(document, [
    'formatVersion', 'suite', 'authorizationId', 'issuedAt', 'expiresAt', 'source',
    'target', 'signingAuthorities', 'approvals', 'decision',
  ], 'PHASE6_DEPLOYMENT_AUTHORIZATION_DOCUMENT_INVALID');
  equal(document.formatVersion, 2, 'PHASE6_DEPLOYMENT_AUTHORIZATION_FORMAT_INVALID');
  equal(
    document.suite,
    'gaoq.phase6.deployment-authorization.v2',
    'PHASE6_DEPLOYMENT_AUTHORIZATION_SUITE_INVALID',
  );
  pattern(document.authorizationId, ULID, 'PHASE6_DEPLOYMENT_AUTHORIZATION_ID_INVALID');
  const issuedAt = timestamp(document.issuedAt);
  const expiresAt = timestamp(document.expiresAt);
  if (
    issuedAt > now + 5 * 60_000 || now - issuedAt > 2 * 60 * 60_000 ||
    expiresAt <= now || expiresAt - issuedAt > 2 * 60 * 60_000
  ) fail('PHASE6_DEPLOYMENT_AUTHORIZATION_TIME_INVALID');
  validateSource(document.source);
  validateTarget(document.target);
  const signingAuthorities = validateSigningAuthorities(document.signingAuthorities);
  if (expected.enforceBindings) {
    equal(
      signingAuthorities.keysetHash,
      expected.signerKeysetHash,
      'PHASE6_DEPLOYMENT_AUTHORIZATION_SIGNER_KEYSET_MISMATCH',
    );
  }
  const latestApproval = validateApprovalMetadata(document.approvals, issuedAt, expiresAt);
  validateDecision(document.decision, latestApproval, expiresAt);
  const authorizationPayloadHash = digest(
    authorizationPayload(document, signingAuthorities.keysetHash),
  );
  validateApprovalSignatures(
    document.approvals,
    signingAuthorities.byRole,
    authorizationPayloadHash,
    timestamp(document.decision.decidedAt),
    expiresAt,
  );
  if (expected.enforceBindings) validateExpected(document, expected);
  return Object.freeze({
    authorizationId: document.authorizationId,
    commitSha: document.source.commitSha,
    planRunId: document.source.planRunId,
    planArtifactHash: document.source.planArtifactHash,
    renderedManifestHash: document.source.renderedManifestHash,
    expiresAt: document.expiresAt,
    signerKeysetHash: signingAuthorities.keysetHash,
    authorizationPayloadHash,
  });
}

function validateSource(source) {
  object(source, [
    'repositoryId', 'commitSha', 'planWorkflowRef', 'planRunId', 'planRunAttempt',
    'planArtifactHash', 'valuesHash', 'goNoGoHash', 'platformIntakeHash',
    'renderedManifestHash', 'deploymentManifestHash', 'validatorSha256',
  ], 'PHASE6_DEPLOYMENT_AUTHORIZATION_SOURCE_INVALID');
  pattern(source.repositoryId, /^[1-9][0-9]{3,15}$/u,
    'PHASE6_DEPLOYMENT_AUTHORIZATION_SOURCE_INVALID');
  pattern(source.commitSha, COMMIT, 'PHASE6_DEPLOYMENT_AUTHORIZATION_SOURCE_INVALID');
  equal(source.planWorkflowRef, PLAN_WORKFLOW_REF,
    'PHASE6_DEPLOYMENT_AUTHORIZATION_PLAN_WORKFLOW_INVALID');
  pattern(source.planRunId, RUN_ID, 'PHASE6_DEPLOYMENT_AUTHORIZATION_SOURCE_INVALID');
  integer(source.planRunAttempt, 1, 1_000, 'PHASE6_DEPLOYMENT_AUTHORIZATION_SOURCE_INVALID');
  for (const field of [
    'planArtifactHash', 'valuesHash', 'goNoGoHash', 'platformIntakeHash',
    'renderedManifestHash', 'deploymentManifestHash',
  ]) pattern(source[field], SHA256, 'PHASE6_DEPLOYMENT_AUTHORIZATION_SOURCE_INVALID');
  equal(source.validatorSha256, VALIDATOR_SHA256,
    'PHASE6_DEPLOYMENT_AUTHORIZATION_HARNESS_MISMATCH');
}

function validateTarget(target) {
  object(target, [
    'environment', 'region', 'clusterHash', 'releaseName', 'controlNamespace',
    'targetNamespace',
  ], 'PHASE6_DEPLOYMENT_AUTHORIZATION_TARGET_INVALID');
  pattern(target.environment, /^(?:production|prod-[a-z0-9-]{2,24})$/u,
    'PHASE6_DEPLOYMENT_AUTHORIZATION_TARGET_INVALID');
  pattern(target.region, REGION, 'PHASE6_DEPLOYMENT_AUTHORIZATION_TARGET_INVALID');
  pattern(target.clusterHash, SHA256, 'PHASE6_DEPLOYMENT_AUTHORIZATION_TARGET_INVALID');
  for (const field of ['releaseName', 'controlNamespace', 'targetNamespace']) {
    pattern(target[field], DNS_LABEL, 'PHASE6_DEPLOYMENT_AUTHORIZATION_TARGET_INVALID');
  }
  if (target.controlNamespace === target.targetNamespace) {
    fail('PHASE6_DEPLOYMENT_AUTHORIZATION_NAMESPACE_OVERLAP');
  }
}

function validateSigningAuthorities(authorities) {
  if (!Array.isArray(authorities) || authorities.length !== APPROVAL_ROLES.length) {
    fail('PHASE6_DEPLOYMENT_AUTHORIZATION_SIGNING_AUTHORITIES_INCOMPLETE');
  }
  const roles = [];
  const keyIds = new Set();
  const byRole = new Map();
  const keyset = [];
  for (const authority of authorities) {
    object(
      authority,
      ['role', 'algorithm', 'keyId', 'publicKeySpkiBase64'],
      'PHASE6_DEPLOYMENT_AUTHORIZATION_SIGNING_AUTHORITY_INVALID',
    );
    if (!APPROVAL_ROLES.includes(authority.role)) {
      fail('PHASE6_DEPLOYMENT_AUTHORIZATION_SIGNING_AUTHORITY_INVALID');
    }
    equal(
      authority.algorithm,
      'Ed25519',
      'PHASE6_DEPLOYMENT_AUTHORIZATION_SIGNING_AUTHORITY_INVALID',
    );
    pattern(
      authority.keyId,
      SHA256,
      'PHASE6_DEPLOYMENT_AUTHORIZATION_SIGNING_AUTHORITY_INVALID',
    );
    const publicKey = publicKeyFromSpkiBase64(authority.publicKeySpkiBase64);
    equal(
      authority.keyId,
      publicKeyHash(publicKey),
      'PHASE6_DEPLOYMENT_AUTHORIZATION_SIGNING_AUTHORITY_KEY_MISMATCH',
    );
    roles.push(authority.role);
    keyIds.add(authority.keyId);
    byRole.set(authority.role, Object.freeze({ keyId: authority.keyId, publicKey }));
    keyset.push(Object.freeze({ role: authority.role, keyId: authority.keyId }));
  }
  if (
    canonicalJson(roles.sort()) !== canonicalJson(APPROVAL_ROLES) ||
    keyIds.size !== APPROVAL_ROLES.length ||
    byRole.size !== APPROVAL_ROLES.length
  ) fail('PHASE6_DEPLOYMENT_AUTHORIZATION_SIGNING_AUTHORITIES_INCOMPLETE');
  return Object.freeze({ byRole, keysetHash: signerKeysetHash(keyset) });
}

function validateApprovalMetadata(approvals, issuedAt, expiresAt) {
  if (!Array.isArray(approvals) || approvals.length !== APPROVAL_ROLES.length) {
    fail('PHASE6_DEPLOYMENT_AUTHORIZATION_APPROVALS_INCOMPLETE');
  }
  const roles = [];
  const actors = new Set();
  const evidenceHashes = new Set();
  const times = [];
  for (const approval of approvals) {
    object(
      approval,
      [
        'role', 'actorHash', 'status', 'approvedAt', 'evidenceHash', 'signedAt',
        'algorithm', 'keyId', 'signedPayloadSha256', 'signature',
      ],
      'PHASE6_DEPLOYMENT_AUTHORIZATION_APPROVAL_INVALID',
    );
    if (!APPROVAL_ROLES.includes(approval.role)) {
      fail('PHASE6_DEPLOYMENT_AUTHORIZATION_APPROVAL_INVALID');
    }
    pattern(approval.actorHash, SHA256, 'PHASE6_DEPLOYMENT_AUTHORIZATION_APPROVAL_INVALID');
    pattern(approval.evidenceHash, SHA256, 'PHASE6_DEPLOYMENT_AUTHORIZATION_APPROVAL_INVALID');
    equal(approval.status, 'approved', 'PHASE6_DEPLOYMENT_AUTHORIZATION_APPROVAL_MISSING');
    const approvedAt = timestamp(approval.approvedAt);
    if (approvedAt < issuedAt || approvedAt >= expiresAt) {
      fail('PHASE6_DEPLOYMENT_AUTHORIZATION_APPROVAL_TIME_INVALID');
    }
    roles.push(approval.role);
    actors.add(approval.actorHash);
    evidenceHashes.add(approval.evidenceHash);
    times.push(approvedAt);
  }
  if (
    canonicalJson(roles.sort()) !== canonicalJson(APPROVAL_ROLES) ||
    actors.size !== APPROVAL_ROLES.length ||
    evidenceHashes.size !== APPROVAL_ROLES.length
  ) fail('PHASE6_DEPLOYMENT_AUTHORIZATION_APPROVALS_INCOMPLETE');
  return Math.max(...times);
}

function validateDecision(decision, latestApproval, expiresAt) {
  object(decision, ['outcome', 'decidedAt', 'evidenceHash'],
    'PHASE6_DEPLOYMENT_AUTHORIZATION_DECISION_INVALID');
  equal(decision.outcome, 'APPROVED', 'PHASE6_DEPLOYMENT_AUTHORIZATION_NOT_APPROVED');
  const decidedAt = timestamp(decision.decidedAt);
  if (decidedAt < latestApproval || decidedAt >= expiresAt) {
    fail('PHASE6_DEPLOYMENT_AUTHORIZATION_DECISION_TIME_INVALID');
  }
  pattern(decision.evidenceHash, SHA256, 'PHASE6_DEPLOYMENT_AUTHORIZATION_DECISION_INVALID');
}

function validateApprovalSignatures(
  approvals,
  signingAuthorities,
  authorizationPayloadHash,
  decidedAt,
  expiresAt,
) {
  const signatures = new Set();
  for (const approval of approvals) {
    equal(
      approval.algorithm,
      'Ed25519',
      'PHASE6_DEPLOYMENT_AUTHORIZATION_APPROVAL_PROOF_INVALID',
    );
    pattern(
      approval.keyId,
      SHA256,
      'PHASE6_DEPLOYMENT_AUTHORIZATION_APPROVAL_PROOF_INVALID',
    );
    pattern(
      approval.signedPayloadSha256,
      SHA256,
      'PHASE6_DEPLOYMENT_AUTHORIZATION_APPROVAL_PROOF_INVALID',
    );
    pattern(
      approval.signature,
      SIGNATURE,
      'PHASE6_DEPLOYMENT_AUTHORIZATION_APPROVAL_PROOF_INVALID',
    );
    const signedAt = timestamp(approval.signedAt);
    if (signedAt < decidedAt || signedAt >= expiresAt) {
      fail('PHASE6_DEPLOYMENT_AUTHORIZATION_APPROVAL_SIGNATURE_TIME_INVALID');
    }
    const authority = signingAuthorities.get(approval.role);
    if (authority === undefined) {
      fail('PHASE6_DEPLOYMENT_AUTHORIZATION_APPROVAL_AUTHORITY_INVALID');
    }
    equal(
      approval.keyId,
      authority.keyId,
      'PHASE6_DEPLOYMENT_AUTHORIZATION_APPROVAL_KEY_MISMATCH',
    );
    const payload = approvalSignaturePayload(authorizationPayloadHash, approval);
    equal(
      approval.signedPayloadSha256,
      digest(payload),
      'PHASE6_DEPLOYMENT_AUTHORIZATION_APPROVAL_PAYLOAD_MISMATCH',
    );
    let signature;
    try {
      signature = Buffer.from(approval.signature, 'base64url');
    } catch {
      fail('PHASE6_DEPLOYMENT_AUTHORIZATION_APPROVAL_SIGNATURE_INVALID');
    }
    if (
      signature.length !== 64 ||
      signature.toString('base64url') !== approval.signature ||
      !verify(null, Buffer.from(payload, 'utf8'), authority.publicKey, signature)
    ) fail('PHASE6_DEPLOYMENT_AUTHORIZATION_APPROVAL_SIGNATURE_INVALID');
    signatures.add(approval.signature);
  }
  if (signatures.size !== APPROVAL_ROLES.length) {
    fail('PHASE6_DEPLOYMENT_AUTHORIZATION_APPROVALS_INCOMPLETE');
  }
}

function validateExpected(document, expected) {
  for (const [field, expectedField] of [
    ['repositoryId', 'repositoryId'],
    ['commitSha', 'commitSha'],
    ['planRunId', 'planRunId'],
    ['planArtifactHash', 'planArtifactHash'],
    ['valuesHash', 'valuesHash'],
    ['goNoGoHash', 'goNoGoHash'],
    ['platformIntakeHash', 'platformIntakeHash'],
    ['renderedManifestHash', 'renderedManifestHash'],
    ['deploymentManifestHash', 'deploymentManifestHash'],
  ]) {
    equal(
      document.source[field],
      expected[expectedField],
      `PHASE6_DEPLOYMENT_AUTHORIZATION_${field.toUpperCase()}_MISMATCH`,
    );
  }
  equal(
    document.source.planRunAttempt,
    Number(expected.planRunAttempt),
    'PHASE6_DEPLOYMENT_AUTHORIZATION_PLAN_RUN_ATTEMPT_MISMATCH',
  );
  for (const field of [
    'environment', 'region', 'clusterHash', 'releaseName', 'controlNamespace',
    'targetNamespace',
  ]) {
    equal(
      document.target[field],
      expected[field],
      `PHASE6_DEPLOYMENT_AUTHORIZATION_${field.toUpperCase()}_MISMATCH`,
    );
  }
}

function authorizationPayload(document, signerKeysetHashValue) {
  return canonicalJson({
    formatVersion: document.formatVersion,
    suite: document.suite,
    authorizationId: document.authorizationId,
    issuedAt: document.issuedAt,
    expiresAt: document.expiresAt,
    source: document.source,
    target: document.target,
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

function approvalSignaturePayload(authorizationPayloadHash, approval) {
  return canonicalJson({
    suite: APPROVAL_SIGNATURE_SUITE,
    authorizationPayloadHash,
    role: approval.role,
    keyId: approval.keyId,
    signedAt: approval.signedAt,
  });
}

function publicKeyFromSpkiBase64(value) {
  if (
    typeof value !== 'string' || value.length < 56 || value.length > 256 ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)
  ) fail('PHASE6_DEPLOYMENT_AUTHORIZATION_SIGNING_AUTHORITY_INVALID');
  try {
    const der = Buffer.from(value, 'base64');
    if (der.toString('base64') !== value) {
      fail('PHASE6_DEPLOYMENT_AUTHORIZATION_SIGNING_AUTHORITY_INVALID');
    }
    const publicKey = createPublicKey({ key: der, format: 'der', type: 'spki' });
    if (publicKey.asymmetricKeyType !== 'ed25519') {
      fail('PHASE6_DEPLOYMENT_AUTHORIZATION_SIGNING_AUTHORITY_INVALID');
    }
    return publicKey;
  } catch {
    return fail('PHASE6_DEPLOYMENT_AUTHORIZATION_SIGNING_AUTHORITY_INVALID');
  }
}

function publicKeyHash(publicKey) {
  return digest(publicKey.export({ type: 'spki', format: 'der' }));
}

function signerKeysetHash(authorities) {
  return digest(canonicalJson(authorities.map((authority) => ({
    role: authority.role,
    keyId: authority.keyId,
  })).sort((left, right) => left.role.localeCompare(right.role))));
}

function runSelfTest() {
  const now = Date.parse('2026-07-29T00:30:00.000Z');
  const hash = (character) => `sha256:${character.repeat(64)}`;
  const privateKeys = new Map();
  const evidence = {
    formatVersion: 2,
    suite: 'gaoq.phase6.deployment-authorization.v2',
    authorizationId: '01K00000000000000000000000',
    issuedAt: '2026-07-29T00:00:00.000Z',
    expiresAt: '2026-07-29T02:00:00.000Z',
    source: {
      repositoryId: '123456789',
      commitSha: 'a'.repeat(40),
      planWorkflowRef: PLAN_WORKFLOW_REF,
      planRunId: '30431500770',
      planRunAttempt: 1,
      planArtifactHash: hash('1'),
      valuesHash: hash('2'),
      goNoGoHash: hash('3'),
      platformIntakeHash: hash('4'),
      renderedManifestHash: hash('5'),
      deploymentManifestHash: hash('6'),
      validatorSha256: VALIDATOR_SHA256,
    },
    target: {
      environment: 'production',
      region: 'cn-test-1',
      clusterHash: hash('7'),
      releaseName: 'gaoq-erp',
      controlNamespace: 'gaoq-erp-control',
      targetNamespace: 'gaoq-erp-prod',
    },
    signingAuthorities: APPROVAL_ROLES.map((role) => {
      const { privateKey, publicKey } = generateKeyPairSync('ed25519');
      const der = publicKey.export({ type: 'spki', format: 'der' });
      privateKeys.set(role, privateKey);
      return {
        role,
        algorithm: 'Ed25519',
        keyId: digest(der),
        publicKeySpkiBase64: der.toString('base64'),
      };
    }),
    approvals: APPROVAL_ROLES.map((role, index) => ({
      role,
      actorHash: hash(String.fromCharCode(97 + index)),
      status: 'approved',
      approvedAt: `2026-07-29T00:1${index}:00.000Z`,
      evidenceHash: hash(String(index + 8)),
      signedAt: `2026-07-29T00:2${index + 1}:00.000Z`,
      algorithm: 'Ed25519',
      keyId: '',
      signedPayloadSha256: '',
      signature: '',
    })),
    decision: {
      outcome: 'APPROVED',
      decidedAt: '2026-07-29T00:20:00.000Z',
      evidenceHash: hash('b'),
    },
  };
  for (const approval of evidence.approvals) {
    const authority = evidence.signingAuthorities.find(
      (candidate) => candidate.role === approval.role,
    );
    if (authority === undefined) {
      fail('PHASE6_DEPLOYMENT_AUTHORIZATION_FIXTURE_AUTHORITY_MISSING');
    }
    approval.keyId = authority.keyId;
  }
  signFixtureApprovals(evidence, privateKeys);
  const expectedSignerKeysetHash = signerKeysetHash(evidence.signingAuthorities);
  const expected = {
    checksum: digest(JSON.stringify(evidence)),
    repositoryId: evidence.source.repositoryId,
    commitSha: evidence.source.commitSha,
    planRunId: evidence.source.planRunId,
    planRunAttempt: String(evidence.source.planRunAttempt),
    planArtifactHash: evidence.source.planArtifactHash,
    valuesHash: evidence.source.valuesHash,
    goNoGoHash: evidence.source.goNoGoHash,
    platformIntakeHash: evidence.source.platformIntakeHash,
    renderedManifestHash: evidence.source.renderedManifestHash,
    deploymentManifestHash: evidence.source.deploymentManifestHash,
    environment: evidence.target.environment,
    region: evidence.target.region,
    clusterHash: evidence.target.clusterHash,
    releaseName: evidence.target.releaseName,
    controlNamespace: evidence.target.controlNamespace,
    targetNamespace: evidence.target.targetNamespace,
    signerKeysetHash: expectedSignerKeysetHash,
    enforceBindings: true,
  };
  validateEvidence(evidence, expected, now);
  validateEvidence(evidence, { enforceBindings: false }, now);
  for (const mutate of [
    (copy) => { copy.source.commitSha = 'b'.repeat(40); },
    (copy) => { copy.source.planWorkflowRef = 'GTVigilante/gaoq_ai/other.yml@refs/heads/main'; },
    (copy) => { copy.source.planRunAttempt = 0; },
    (copy) => { copy.target.controlNamespace = copy.target.targetNamespace; },
    (copy) => { copy.approvals[1].actorHash = copy.approvals[0].actorHash; },
    (copy) => { copy.approvals[0].status = 'pending'; },
    (copy) => { copy.decision.outcome = 'REJECTED'; },
    (copy) => { copy.expiresAt = '2026-07-29T03:00:00.000Z'; },
    (copy) => { copy.source.password = 'forbidden'; },
    (copy) => {
      copy.approvals[0].signature =
        `${copy.approvals[0].signature[0] === 'A' ? 'B' : 'A'}${
          copy.approvals[0].signature.slice(1)
        }`;
    },
  ]) {
    const copy = structuredClone(evidence);
    mutate(copy);
    expectFailure(() => validateEvidence(copy, expected, now));
  }
  const reusedAuthority = structuredClone(evidence);
  reusedAuthority.signingAuthorities[1].keyId =
    reusedAuthority.signingAuthorities[0].keyId;
  reusedAuthority.signingAuthorities[1].publicKeySpkiBase64 =
    reusedAuthority.signingAuthorities[0].publicKeySpkiBase64;
  expectFailure(() => validateEvidence(reusedAuthority, expected, now));

  const roleSwap = structuredClone(evidence);
  roleSwap.approvals[0].keyId = roleSwap.approvals[1].keyId;
  expectFailure(() => validateEvidence(roleSwap, expected, now));

  const mismatched = structuredClone(expected);
  mismatched.renderedManifestHash = hash('f');
  expectFailure(() => validateEvidence(evidence, mismatched, now));

  const keysetDrift = structuredClone(expected);
  keysetDrift.signerKeysetHash = hash('f');
  expectFailure(() => validateEvidence(evidence, keysetDrift, now));
}

function signFixtureApprovals(document, privateKeys) {
  const payloadHash = digest(authorizationPayload(
    document,
    signerKeysetHash(document.signingAuthorities),
  ));
  for (const approval of document.approvals) {
    const privateKey = privateKeys.get(approval.role);
    if (privateKey === undefined) {
      fail('PHASE6_DEPLOYMENT_AUTHORIZATION_FIXTURE_KEY_MISSING');
    }
    const payload = approvalSignaturePayload(payloadHash, approval);
    approval.signedPayloadSha256 = digest(payload);
    approval.signature =
      sign(null, Buffer.from(payload, 'utf8'), privateKey).toString('base64url');
  }
}

function parseDocument(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return fail('PHASE6_DEPLOYMENT_AUTHORIZATION_JSON_INVALID');
  }
}

function ensureNoSensitiveMaterial(value) {
  if (Array.isArray(value)) {
    value.forEach((item) => ensureNoSensitiveMaterial(item));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key)) {
        fail('PHASE6_DEPLOYMENT_AUTHORIZATION_SENSITIVE_KEY_FORBIDDEN');
      }
      ensureNoSensitiveMaterial(item);
    }
    return;
  }
  if (typeof value === 'string' && (
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/u.test(value) ||
    /^[a-z][a-z0-9+.-]*:\/\/[^/\s]+:[^/@\s]+@/iu.test(value)
  )) fail('PHASE6_DEPLOYMENT_AUTHORIZATION_SENSITIVE_VALUE_FORBIDDEN');
}

function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) fail('PHASE6_DEPLOYMENT_AUTHORIZATION_NUMBER_INVALID');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return fail('PHASE6_DEPLOYMENT_AUTHORIZATION_VALUE_INVALID');
}

function object(value, keys, code) {
  if (
    value === null || typeof value !== 'object' || Array.isArray(value) ||
    canonicalJson(Object.keys(value).sort()) !== canonicalJson([...keys].sort())
  ) fail(code);
}

function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    fail('PHASE6_DEPLOYMENT_AUTHORIZATION_TIMESTAMP_INVALID');
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail('PHASE6_DEPLOYMENT_AUTHORIZATION_TIMESTAMP_INVALID');
  return parsed;
}

function integer(value, minimum, maximum, code) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) fail(code);
}

function integerText(value, minimum, maximum, code) {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/u.test(value)) fail(code);
  integer(Number(value), minimum, maximum, code);
}

function pattern(value, expression, code) {
  if (typeof value !== 'string' || !expression.test(value)) fail(code);
}

function equal(actual, expected, code) {
  if (actual !== expected) fail(code);
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
  fail('PHASE6_DEPLOYMENT_AUTHORIZATION_SELF_TEST_EXPECTED_FAILURE');
}

function fail(code) {
  throw new Error(code);
}
