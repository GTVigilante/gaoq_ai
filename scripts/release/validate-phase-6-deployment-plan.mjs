import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';

const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const DNS_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/u;
const ROLLOUT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u;
const IMAGE_REFERENCE = /^[^\s@]+@sha256:[a-f0-9]{64}$/u;
const COMPONENTS = ['api', 'worker', 'web'];

const argumentsList = process.argv.slice(2);
if (argumentsList.length === 1 && argumentsList[0] === '--validate-environment') {
  expectedFromEnvironment();
  process.stdout.write('Phase 6 生产部署环境变量契约校验通过。\n');
} else if (argumentsList.length === 1 && argumentsList[0] === '--self-test') {
  runSelfTest();
  process.stdout.write('Phase 6 生产部署计划绑定门禁自测通过。\n');
} else {
  const enforceEnvironment = argumentsList[0] === '--enforce-environment';
  const manifestPath = argumentsList[enforceEnvironment ? 1 : 0];
  if (manifestPath === undefined || argumentsList.length !== (enforceEnvironment ? 2 : 1)) {
    fail('PHASE6_DEPLOYMENT_MANIFEST_PATH_REQUIRED');
  }
  const metadata = await lstat(manifestPath);
  if (
    !metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 ||
    metadata.size > 2 * 1_024 * 1_024 || (metadata.mode & 0o022) !== 0
  ) fail('PHASE6_DEPLOYMENT_MANIFEST_FILE_INVALID');

  const manifest = await readFile(manifestPath, 'utf8');
  const expected = enforceEnvironment ? expectedFromEnvironment() : undefined;
  const summary = validateManifest(manifest, expected);
  process.stdout.write(`${JSON.stringify({
    formatVersion: 1,
    suite: 'gaoq.phase6.production-deployment-plan.verdict',
    outcome: 'VALID',
    releaseName: summary.releaseName,
    namespace: summary.namespace,
    commitSha: summary.commitSha,
    images: summary.images,
    deploymentManifestHash: summary.deploymentManifestHash,
    rolloutId: summary.rolloutId,
    runtimeReferences: summary.runtimeReferences,
    renderedManifestSha256: digest(manifest),
  }, null, 2)}\n`);
}

function expectedFromEnvironment() {
  const expected = Object.freeze({
    releaseName: process.env.PHASE6_DEPLOYMENT_RELEASE_NAME,
    namespace: process.env.PHASE6_DEPLOYMENT_NAMESPACE,
    commitSha: process.env.PHASE6_DEPLOYMENT_EXPECTED_COMMIT,
    apiImageDigest: process.env.PHASE6_DEPLOYMENT_EXPECTED_API_IMAGE,
    workerImageDigest: process.env.PHASE6_DEPLOYMENT_EXPECTED_WORKER_IMAGE,
    webImageDigest: process.env.PHASE6_DEPLOYMENT_EXPECTED_WEB_IMAGE,
    deploymentManifestHash: process.env.PHASE6_DEPLOYMENT_EXPECTED_MANIFEST,
    rolloutId: process.env.PHASE6_DEPLOYMENT_EXPECTED_ROLLOUT_ID,
    apiConfigMap: process.env.PHASE6_DEPLOYMENT_API_CONFIG_MAP,
    apiSecret: process.env.PHASE6_DEPLOYMENT_API_SECRET,
    workerConfigMap: process.env.PHASE6_DEPLOYMENT_WORKER_CONFIG_MAP,
    workerSecret: process.env.PHASE6_DEPLOYMENT_WORKER_SECRET,
  });
  name(expected.releaseName, 53);
  for (const field of ['namespace', 'apiConfigMap', 'apiSecret', 'workerConfigMap', 'workerSecret']) {
    name(expected[field], 63);
  }
  pattern(expected.commitSha, COMMIT, 'PHASE6_DEPLOYMENT_EXPECTED_COMMIT_INVALID');
  for (const field of ['apiImageDigest', 'workerImageDigest', 'webImageDigest', 'deploymentManifestHash']) {
    pattern(expected[field], SHA256, 'PHASE6_DEPLOYMENT_EXPECTED_DIGEST_INVALID');
  }
  pattern(expected.rolloutId, ROLLOUT_ID, 'PHASE6_DEPLOYMENT_EXPECTED_ROLLOUT_INVALID');
  return expected;
}

function validateManifest(manifest, expected) {
  for (const forbidden of [
    /^kind:\s*Secret$/mu,
    /stringData:/u,
    /type:\s*(?:NodePort|LoadBalancer)\b/u,
    /:latest\b/u,
    /privileged:\s*true/u,
    /hostNetwork:\s*true/u,
    /hostPID:\s*true/u,
    /hostPath:/u,
    /cluster-admin/u,
    /0\.0\.0\.0\/0/u,
  ]) {
    if (forbidden.test(manifest)) fail('PHASE6_DEPLOYMENT_MANIFEST_UNSAFE');
  }

  const deployments = manifest.split(/^---\s*$/gmu).filter((document) =>
    /^kind:\s*Deployment$/mu.test(document));
  if (deployments.length !== COMPONENTS.length) fail('PHASE6_DEPLOYMENT_COMPONENTS_INCOMPLETE');

  const summaries = {};
  for (const component of COMPONENTS) {
    const deployment = deployments.find((document) =>
      new RegExp(`app\\.kubernetes\\.io/component:\\s*${component}(?:\\s|$)`, 'u').test(document));
    if (deployment === undefined) fail('PHASE6_DEPLOYMENT_COMPONENTS_INCOMPLETE');
    const image = single(deployment, /^\s*image:\s*"?([^"\s]+)"?\s*$/gmu,
      'PHASE6_DEPLOYMENT_IMAGE_INVALID');
    pattern(image, IMAGE_REFERENCE, 'PHASE6_DEPLOYMENT_IMAGE_INVALID');
    if (image.includes('://') || image !== image.toLowerCase()) {
      fail('PHASE6_DEPLOYMENT_IMAGE_INVALID');
    }
    const commitSha = uniform(deployment, /gaoq\.io\/release-commit:\s*"?([^"\s]+)"?/gu,
      'PHASE6_DEPLOYMENT_COMMIT_BINDING_INVALID');
    const deploymentManifestHash = uniform(
      deployment,
      /gaoq\.io\/deployment-manifest:\s*"?([^"\s]+)"?/gu,
      'PHASE6_DEPLOYMENT_MANIFEST_BINDING_INVALID',
    );
    const rolloutId = single(deployment, /gaoq\.io\/rollout-id:\s*"?([^"\s]+)"?/gu,
      'PHASE6_DEPLOYMENT_ROLLOUT_BINDING_INVALID');
    const releaseName = uniform(
      deployment,
      /app\.kubernetes\.io\/instance:\s*"?([^"\s]+)"?/gu,
      'PHASE6_DEPLOYMENT_RELEASE_BINDING_INVALID',
    );
    summaries[component] = Object.freeze({
      image,
      digest: image.slice(image.lastIndexOf('@') + 1),
      commitSha,
      deploymentManifestHash,
      rolloutId,
      releaseName,
    });
  }

  const bindingFields = ['commitSha', 'deploymentManifestHash', 'rolloutId', 'releaseName'];
  for (const field of bindingFields) {
    if (new Set(COMPONENTS.map((component) => summaries[component][field])).size !== 1) {
      fail('PHASE6_DEPLOYMENT_COMPONENT_BINDING_MISMATCH');
    }
  }

  const runtimeReferences = Object.freeze({
    apiConfigMap: single(
      deployments.find((document) => /component:\s*api\b/u.test(document)),
      /configMapRef:\s*\{\s*name:\s*([^\s}]+)\s*\}/gu,
      'PHASE6_DEPLOYMENT_API_CONFIG_INVALID',
    ),
    apiSecret: single(
      deployments.find((document) => /component:\s*api\b/u.test(document)),
      /secretRef:\s*\{\s*name:\s*([^\s}]+)\s*\}/gu,
      'PHASE6_DEPLOYMENT_API_SECRET_INVALID',
    ),
    workerConfigMap: single(
      deployments.find((document) => /component:\s*worker\b/u.test(document)),
      /configMapRef:\s*\{\s*name:\s*([^\s}]+)\s*\}/gu,
      'PHASE6_DEPLOYMENT_WORKER_CONFIG_INVALID',
    ),
    workerSecret: single(
      deployments.find((document) => /component:\s*worker\b/u.test(document)),
      /secretRef:\s*\{\s*name:\s*([^\s}]+)\s*\}/gu,
      'PHASE6_DEPLOYMENT_WORKER_SECRET_INVALID',
    ),
  });
  if (/component:\s*web\b[\s\S]*?(?:secretRef:|envFrom:)/u.test(
    deployments.find((document) => /component:\s*web\b/u.test(document)),
  )) fail('PHASE6_DEPLOYMENT_WEB_SECRET_FORBIDDEN');

  const summary = Object.freeze({
    releaseName: summaries.api.releaseName,
    namespace: expected?.namespace ?? 'unbound',
    commitSha: summaries.api.commitSha,
    images: Object.freeze(Object.fromEntries(COMPONENTS.map((component) => [
      component,
      summaries[component].image,
    ]))),
    deploymentManifestHash: summaries.api.deploymentManifestHash,
    rolloutId: summaries.api.rolloutId,
    runtimeReferences,
  });
  if (expected !== undefined) validateExpected(summary, summaries, expected);
  return summary;
}

function validateExpected(summary, summaries, expected) {
  equal(summary.releaseName, expected.releaseName, 'PHASE6_DEPLOYMENT_RELEASE_MISMATCH');
  equal(summary.commitSha, expected.commitSha, 'PHASE6_DEPLOYMENT_COMMIT_MISMATCH');
  equal(summary.deploymentManifestHash, expected.deploymentManifestHash,
    'PHASE6_DEPLOYMENT_MANIFEST_MISMATCH');
  equal(summary.rolloutId, expected.rolloutId, 'PHASE6_DEPLOYMENT_ROLLOUT_MISMATCH');
  for (const component of COMPONENTS) {
    equal(summaries[component].digest, expected[`${component}ImageDigest`],
      'PHASE6_DEPLOYMENT_IMAGE_MISMATCH');
  }
  for (const field of ['apiConfigMap', 'apiSecret', 'workerConfigMap', 'workerSecret']) {
    equal(summary.runtimeReferences[field], expected[field],
      'PHASE6_DEPLOYMENT_RUNTIME_REFERENCE_MISMATCH');
  }
}

function single(content, expression, code) {
  if (typeof content !== 'string') fail(code);
  const values = [...content.matchAll(expression)].map((match) => match[1]);
  if (values.length !== 1 || values[0] === undefined) fail(code);
  return values[0];
}

function uniform(content, expression, code) {
  const values = [...content.matchAll(expression)].map((match) => match[1]);
  if (values.length < 1 || values.some((value) => value === undefined) || new Set(values).size !== 1) {
    fail(code);
  }
  return values[0];
}

function runSelfTest() {
  const sha = (character) => `sha256:${character.repeat(64)}`;
  const commitSha = 'a'.repeat(40);
  const manifestHash = sha('b');
  const documents = COMPONENTS.map((component, index) => {
    const runtime = component === 'api'
      ? '          envFrom:\n            - configMapRef: { name: api-config }\n            - secretRef: { name: api-secret }\n'
      : component === 'worker'
        ? '          envFrom:\n            - configMapRef: { name: worker-config }\n            - secretRef: { name: worker-secret }\n'
        : '';
    return `apiVersion: apps/v1
kind: Deployment
metadata:
  labels:
    app.kubernetes.io/instance: release-a
    app.kubernetes.io/component: ${component}
  annotations:
    gaoq.io/release-commit: "${commitSha}"
    gaoq.io/deployment-manifest: "${manifestHash}"
spec:
  template:
    metadata:
      labels:
        app.kubernetes.io/instance: release-a
        app.kubernetes.io/component: ${component}
      annotations:
        gaoq.io/rollout-id: "rollout-001"
        gaoq.io/release-commit: "${commitSha}"
        gaoq.io/deployment-manifest: "${manifestHash}"
    spec:
      containers:
        - name: ${component}
          image: "registry.example.invalid/gaoq/${component}@${sha(String(index + 1))}"
${runtime}`;
  }).join('\n---\n');
  const expected = Object.freeze({
    releaseName: 'release-a', namespace: 'erp-prod', commitSha,
    apiImageDigest: sha('1'), workerImageDigest: sha('2'), webImageDigest: sha('3'),
    deploymentManifestHash: manifestHash, rolloutId: 'rollout-001',
    apiConfigMap: 'api-config', apiSecret: 'api-secret',
    workerConfigMap: 'worker-config', workerSecret: 'worker-secret',
  });
  validateManifest(documents, expected);
  expectFailure(() => validateManifest(documents.replace(sha('1'), sha('9')), expected));
  expectFailure(() => validateManifest(documents.replace('api-secret', 'worker-secret'), expected));
  expectFailure(() => validateManifest(documents.replace('registry.example.invalid', 'https://registry.example.invalid'), expected));
  expectFailure(() => validateManifest(`${documents}\n---\nkind: Secret\n`, expected));
  expectFailure(() => name('-option', 53));
  expectFailure(() => name('a'.repeat(64), 63));
}

function expectFailure(operation) {
  try {
    operation();
  } catch {
    return;
  }
  fail('PHASE6_DEPLOYMENT_SELF_TEST_EXPECTED_FAILURE');
}

function pattern(value, expression, code) {
  if (typeof value !== 'string' || !expression.test(value)) fail(code);
}

function name(value, maximumLength) {
  pattern(value, DNS_LABEL, 'PHASE6_DEPLOYMENT_EXPECTED_NAME_INVALID');
  if (value.length > maximumLength) fail('PHASE6_DEPLOYMENT_EXPECTED_NAME_INVALID');
}

function equal(actual, expected, code) {
  if (actual !== expected) fail(code);
}

function digest(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function fail(code) {
  throw new Error(code);
}
