import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';

const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const DNS_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/u;
const ROLLOUT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u;
const IMAGE_REFERENCE = /^[^\s@]+@sha256:[a-f0-9]{64}$/u;
const COMPONENTS = ['api', 'worker', 'web', 'website'];

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
    controlNamespace: summary.controlNamespace,
    targetNamespace: summary.targetNamespace,
    commitSha: summary.commitSha,
    images: summary.images,
    deploymentManifestHash: summary.deploymentManifestHash,
    websitePublicConfigHash: summary.websitePublicConfigHash,
    rolloutId: summary.rolloutId,
    runtimeReferences: summary.runtimeReferences,
    runtimeConfiguration: summary.runtimeConfiguration,
    renderedManifestSha256: digest(manifest),
  }, null, 2)}\n`);
}

function expectedFromEnvironment() {
  const expected = Object.freeze({
    releaseName: process.env.PHASE6_DEPLOYMENT_RELEASE_NAME,
    controlNamespace: process.env.PHASE6_DEPLOYMENT_CONTROL_NAMESPACE,
    targetNamespace: process.env.PHASE6_DEPLOYMENT_TARGET_NAMESPACE,
    commitSha: process.env.PHASE6_DEPLOYMENT_EXPECTED_COMMIT,
    apiImageDigest: process.env.PHASE6_DEPLOYMENT_EXPECTED_API_IMAGE,
    workerImageDigest: process.env.PHASE6_DEPLOYMENT_EXPECTED_WORKER_IMAGE,
    webImageDigest: process.env.PHASE6_DEPLOYMENT_EXPECTED_WEB_IMAGE,
    websiteImageDigest: process.env.PHASE6_DEPLOYMENT_EXPECTED_WEBSITE_IMAGE,
    deploymentManifestHash: process.env.PHASE6_DEPLOYMENT_EXPECTED_MANIFEST,
    websitePublicConfigHash: process.env.PHASE6_DEPLOYMENT_WEBSITE_PUBLIC_CONFIG_SHA256,
    rolloutId: process.env.PHASE6_DEPLOYMENT_EXPECTED_ROLLOUT_ID,
    apiConfigMap: process.env.PHASE6_DEPLOYMENT_API_CONFIG_MAP,
    apiSecret: process.env.PHASE6_DEPLOYMENT_API_SECRET,
    workerConfigMap: process.env.PHASE6_DEPLOYMENT_WORKER_CONFIG_MAP,
    workerSecret: process.env.PHASE6_DEPLOYMENT_WORKER_SECRET,
    webConfigMap: process.env.PHASE6_DEPLOYMENT_WEB_CONFIG_MAP,
    webSecret: process.env.PHASE6_DEPLOYMENT_WEB_SECRET,
    websiteConfigMap: process.env.PHASE6_DEPLOYMENT_WEBSITE_CONFIG_MAP,
    websiteSecret: process.env.PHASE6_DEPLOYMENT_WEBSITE_SECRET,
    apiConfigMapHash: process.env.PHASE6_DEPLOYMENT_API_CONFIG_SHA256,
    workerConfigMapHash: process.env.PHASE6_DEPLOYMENT_WORKER_CONFIG_SHA256,
    runtimeContractHash: process.env.PHASE6_DEPLOYMENT_RUNTIME_CONTRACT_SHA256,
  });
  name(expected.releaseName, 53);
  for (const field of [
    'controlNamespace',
    'targetNamespace',
    'apiConfigMap',
    'apiSecret',
    'workerConfigMap',
    'workerSecret',
    'webConfigMap',
    'webSecret',
    'websiteConfigMap',
    'websiteSecret',
  ]) {
    name(expected[field], 63);
  }
  if (expected.controlNamespace === expected.targetNamespace) {
    fail('PHASE6_DEPLOYMENT_NAMESPACES_NOT_SEPARATED');
  }
  const runtimeNames = [
    expected.apiConfigMap,
    expected.apiSecret,
    expected.workerConfigMap,
    expected.workerSecret,
    expected.webConfigMap,
    expected.webSecret,
    expected.websiteConfigMap,
    expected.websiteSecret,
  ];
  if (new Set(runtimeNames).size !== runtimeNames.length) {
    fail('PHASE6_DEPLOYMENT_RUNTIME_REFERENCES_NOT_SEPARATED');
  }
  pattern(expected.commitSha, COMMIT, 'PHASE6_DEPLOYMENT_EXPECTED_COMMIT_INVALID');
  for (const field of [
    'apiImageDigest',
    'workerImageDigest',
    'webImageDigest',
    'websiteImageDigest',
    'deploymentManifestHash',
    'websitePublicConfigHash',
    'apiConfigMapHash',
    'workerConfigMapHash',
    'runtimeContractHash',
  ]) {
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
  const targetNamespaces = [...manifest.matchAll(/^\s{2}namespace:\s*([^\s]+)\s*$/gmu)]
    .map((match) => match[1]);
  if (targetNamespaces.length !== 26 || new Set(targetNamespaces).size !== 1) {
    fail('PHASE6_DEPLOYMENT_TARGET_NAMESPACE_INVALID');
  }

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
    webConfigMap: single(
      deployments.find((document) => /component:\s*web\b/u.test(document)),
      /configMapRef:\s*\{\s*name:\s*([^\s}]+)\s*\}/gu,
      'PHASE6_DEPLOYMENT_WEB_CONFIG_INVALID',
    ),
    webSecret: single(
      deployments.find((document) => /component:\s*web\b/u.test(document)),
      /secretRef:\s*\{\s*name:\s*([^\s}]+)\s*\}/gu,
      'PHASE6_DEPLOYMENT_WEB_SECRET_INVALID',
    ),
    websiteConfigMap: single(
      deployments.find((document) => /component:\s*website\b/u.test(document)),
      /configMapKeyRef:\s*\n\s*name:\s*([^\s]+)\s*/gu,
      'PHASE6_DEPLOYMENT_WEBSITE_CONFIG_INVALID',
    ),
    websiteSecret: single(
      deployments.find((document) => /component:\s*website\b/u.test(document)),
      /secretKeyRef:\s*\n\s*name:\s*([^\s]+)\s*/gu,
      'PHASE6_DEPLOYMENT_WEBSITE_SECRET_INVALID',
    ),
  });
  const websitePublicConfigHash = uniform(
    deployments.find((document) => /component:\s*website\b/u.test(document)),
    /gaoq\.io\/website-public-config:\s*"?([^"\s]+)"?/gu,
    'PHASE6_DEPLOYMENT_WEBSITE_PUBLIC_CONFIG_INVALID',
  );
  pattern(
    websitePublicConfigHash,
    SHA256,
    'PHASE6_DEPLOYMENT_WEBSITE_PUBLIC_CONFIG_INVALID',
  );
  const apiDeployment = deployments.find((document) => /component:\s*api\b/u.test(document));
  const workerDeployment = deployments.find(
    (document) => /component:\s*worker\b/u.test(document),
  );
  const runtimeConfiguration = Object.freeze({
    apiConfigMapHash: uniform(
      apiDeployment,
      /gaoq\.io\/runtime-config:\s*"?([^"\s]+)"?/gu,
      'PHASE6_DEPLOYMENT_API_CONFIG_HASH_INVALID',
    ),
    workerConfigMapHash: uniform(
      workerDeployment,
      /gaoq\.io\/runtime-config:\s*"?([^"\s]+)"?/gu,
      'PHASE6_DEPLOYMENT_WORKER_CONFIG_HASH_INVALID',
    ),
    runtimeContractHash: uniform(
      `${apiDeployment}\n${workerDeployment}`,
      /gaoq\.io\/runtime-contract:\s*"?([^"\s]+)"?/gu,
      'PHASE6_DEPLOYMENT_RUNTIME_CONTRACT_INVALID',
    ),
  });
  for (const value of Object.values(runtimeConfiguration)) {
    pattern(value, SHA256, 'PHASE6_DEPLOYMENT_RUNTIME_CONFIGURATION_INVALID');
  }

  const summary = Object.freeze({
    releaseName: summaries.api.releaseName,
    controlNamespace: expected?.controlNamespace ?? 'unbound',
    targetNamespace: targetNamespaces[0],
    commitSha: summaries.api.commitSha,
    images: Object.freeze(Object.fromEntries(COMPONENTS.map((component) => [
      component,
      summaries[component].image,
    ]))),
    deploymentManifestHash: summaries.api.deploymentManifestHash,
    websitePublicConfigHash,
    rolloutId: summaries.api.rolloutId,
    runtimeReferences,
    runtimeConfiguration,
  });
  if (expected !== undefined) validateExpected(summary, summaries, expected);
  return summary;
}

function validateExpected(summary, summaries, expected) {
  equal(summary.releaseName, expected.releaseName, 'PHASE6_DEPLOYMENT_RELEASE_MISMATCH');
  equal(summary.targetNamespace, expected.targetNamespace,
    'PHASE6_DEPLOYMENT_TARGET_NAMESPACE_MISMATCH');
  equal(summary.commitSha, expected.commitSha, 'PHASE6_DEPLOYMENT_COMMIT_MISMATCH');
  equal(summary.deploymentManifestHash, expected.deploymentManifestHash,
    'PHASE6_DEPLOYMENT_MANIFEST_MISMATCH');
  equal(
    summary.websitePublicConfigHash,
    expected.websitePublicConfigHash,
    'PHASE6_DEPLOYMENT_WEBSITE_PUBLIC_CONFIG_MISMATCH',
  );
  equal(summary.rolloutId, expected.rolloutId, 'PHASE6_DEPLOYMENT_ROLLOUT_MISMATCH');
  for (const component of COMPONENTS) {
    equal(summaries[component].digest, expected[`${component}ImageDigest`],
      'PHASE6_DEPLOYMENT_IMAGE_MISMATCH');
  }
  for (const field of [
    'apiConfigMap',
    'apiSecret',
    'workerConfigMap',
    'workerSecret',
    'webConfigMap',
    'webSecret',
    'websiteConfigMap',
    'websiteSecret',
  ]) {
    equal(summary.runtimeReferences[field], expected[field],
      'PHASE6_DEPLOYMENT_RUNTIME_REFERENCE_MISMATCH');
  }
  for (const field of ['apiConfigMapHash', 'workerConfigMapHash', 'runtimeContractHash']) {
    equal(summary.runtimeConfiguration[field], expected[field],
      'PHASE6_DEPLOYMENT_RUNTIME_CONFIGURATION_MISMATCH');
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
  const apiConfigMapHash = sha('5');
  const workerConfigMapHash = sha('6');
  const runtimeContractHash = sha('7');
  const deploymentDocuments = COMPONENTS.map((component, index) => {
    const runtime = component === 'website'
      ? `          env:
            - name: ERP_API_INTERNAL_ORIGIN
              valueFrom:
                configMapKeyRef:
                  name: website-config
                  key: ERP_API_INTERNAL_ORIGIN
            - name: MARKETING_REVALIDATE_SECRET
              valueFrom:
                secretKeyRef:
                  name: website-secret
                  key: MARKETING_REVALIDATE_SECRET
`
      : `          envFrom:
            - configMapRef: { name: ${component}-config }
            - secretRef: { name: ${component}-secret }
`;
    const websitePublicConfig = component === 'website'
      ? `    gaoq.io/website-public-config: "${sha('c')}"
`
      : '';
    const runtimeConfigBinding = component === 'api'
      ? `    gaoq.io/runtime-config: "${apiConfigMapHash}"
    gaoq.io/runtime-contract: "${runtimeContractHash}"
`
      : component === 'worker'
        ? `    gaoq.io/runtime-config: "${workerConfigMapHash}"
    gaoq.io/runtime-contract: "${runtimeContractHash}"
`
        : '';
    return `apiVersion: apps/v1
kind: Deployment
metadata:
  namespace: erp-prod
  labels:
    app.kubernetes.io/instance: release-a
    app.kubernetes.io/component: ${component}
  annotations:
    gaoq.io/release-commit: "${commitSha}"
    gaoq.io/deployment-manifest: "${manifestHash}"
${runtimeConfigBinding}
${websitePublicConfig}
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
${runtimeConfigBinding}
${websitePublicConfig}
    spec:
      containers:
        - name: ${component}
          image: "registry.example.invalid/gaoq/${component}@${sha(String(index + 1))}"
${runtime}`;
  });
  const supportDocuments = Array.from({ length: 22 }, (_, index) => `apiVersion: v1
kind: ConfigMap
metadata:
  name: support-${index}
  namespace: erp-prod
`);
  const documents = [...deploymentDocuments, ...supportDocuments].join('\n---\n');
  const expected = Object.freeze({
    releaseName: 'release-a', controlNamespace: 'erp-control', targetNamespace: 'erp-prod', commitSha,
    apiImageDigest: sha('1'), workerImageDigest: sha('2'), webImageDigest: sha('3'),
    websiteImageDigest: sha('4'), deploymentManifestHash: manifestHash,
    websitePublicConfigHash: sha('c'), rolloutId: 'rollout-001',
    apiConfigMap: 'api-config', apiSecret: 'api-secret',
    workerConfigMap: 'worker-config', workerSecret: 'worker-secret',
    webConfigMap: 'web-config', webSecret: 'web-secret',
    websiteConfigMap: 'website-config', websiteSecret: 'website-secret',
    apiConfigMapHash, workerConfigMapHash, runtimeContractHash,
  });
  validateManifest(documents, expected);
  expectFailure(() => validateManifest(documents.replace(sha('1'), sha('9')), expected));
  expectFailure(() => validateManifest(documents.replace('api-secret', 'worker-secret'), expected));
  expectFailure(() => validateManifest(documents.replace(apiConfigMapHash, sha('8')), expected));
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
