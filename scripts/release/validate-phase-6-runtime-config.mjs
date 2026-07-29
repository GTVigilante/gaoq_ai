import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';

const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const DNS_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/u;
const SENSITIVE_KEY = /(?:PASSWORD|SECRET|TOKEN|PRIVATE_KEY|API_KEY|ENCRYPTION_KEYS|BLIND_INDEX_KEYS|INTEGRITY_KEYS|MONGODB_URI|REDIS_URL)/u;
const EXPLICITLY_SENSITIVE_KEYS = new Set(['CARE_ALUMNI_CLEANUP_TARGETS_JSON']);
const PLATFORM_CONTRACT_VERSION = '1.0.0';
const argumentsList = process.argv.slice(2);

if (argumentsList.length === 1 && argumentsList[0] === '--print-contract') {
  process.stdout.write(`${JSON.stringify({
    formatVersion: 1,
    suite: 'gaoq.phase6.production-runtime-config.contract',
    inputs: ['apiConfigMapJson', 'workerConfigMapJson'],
    preparationCommand:
      'GO_NO_GO_EXPECTED_PAYROLL_RESOURCE=... GO_NO_GO_EXPECTED_PAYROLL_CONTRACT_HASH=sha256:... node scripts/release/validate-phase-6-runtime-config.mjs --calculate <api.json> <worker.json>',
    requiredRuntimeValues: {
      api: { NODE_ENV: 'production', RUNTIME_ROLE: 'api', PAYROLL_SYSTEM_MODE: 'external' },
      worker: {
        NODE_ENV: 'production',
        RUNTIME_ROLE: 'worker',
        PAYROLL_SYSTEM_MODE: 'external',
      },
    },
    professionalPayrollBinding: {
      resourceSource: 'GO_NO_GO_EXPECTED_PAYROLL_RESOURCE',
      eventContractHashSource: 'GO_NO_GO_EXPECTED_PAYROLL_CONTRACT_HASH',
      platformContractVersion: PLATFORM_CONTRACT_VERSION,
    },
    security: {
      immutableConfigMapsRequired: true,
      binaryDataAllowed: false,
      sensitiveKeyNamesAllowed: false,
      secretReadRequired: false,
    },
  }, null, 2)}\n`);
} else if (argumentsList.length === 1 && argumentsList[0] === '--self-test') {
  runSelfTest();
  process.stdout.write('Phase 6 生产运行配置绑定门禁自测通过。\n');
} else {
  const enforceEnvironment = argumentsList[0] === '--enforce-environment';
  const calculate = argumentsList[0] === '--calculate';
  const paths = argumentsList.slice(enforceEnvironment || calculate ? 1 : 0);
  if (paths.length !== 2) fail('PHASE6_RUNTIME_CONFIG_PATHS_REQUIRED');
  const [apiDocument, workerDocument] = await Promise.all(paths.map(readDocument));
  const expected = enforceEnvironment ? expectedFromEnvironment() : undefined;
  const payrollBinding = enforceEnvironment
    ? undefined
    : payrollBindingFromEnvironment();
  const summary = validateRuntimeConfig(apiDocument, workerDocument, expected, payrollBinding);
  process.stdout.write(`${JSON.stringify({
    formatVersion: 1,
    suite: 'gaoq.phase6.production-runtime-config.verdict',
    outcome: 'VALID',
    targetNamespace: summary.targetNamespace,
    apiConfigMap: summary.apiConfigMap,
    workerConfigMap: summary.workerConfigMap,
    apiConfigMapHash: summary.apiConfigMapHash,
    workerConfigMapHash: summary.workerConfigMapHash,
    runtimeContractHash: summary.runtimeContractHash,
    payrollSystemMode: 'external',
    professionalPayrollResource: summary.professionalPayrollResource,
    professionalPayrollEventContractHash: summary.professionalPayrollEventContractHash,
    platformContractVersion: PLATFORM_CONTRACT_VERSION,
    secretMaterialInspected: false,
  }, null, 2)}\n`);
}

async function readDocument(path) {
  const metadata = await lstat(path);
  if (
    !metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 ||
    metadata.size > 768 * 1_024 || (metadata.mode & 0o022) !== 0
  ) fail('PHASE6_RUNTIME_CONFIG_FILE_INVALID');
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    fail('PHASE6_RUNTIME_CONFIG_JSON_INVALID');
  }
}

function expectedFromEnvironment() {
  const expected = Object.freeze({
    targetNamespace: process.env.PHASE6_DEPLOYMENT_TARGET_NAMESPACE,
    apiConfigMap: process.env.PHASE6_DEPLOYMENT_API_CONFIG_MAP,
    workerConfigMap: process.env.PHASE6_DEPLOYMENT_WORKER_CONFIG_MAP,
    apiConfigMapHash: process.env.PHASE6_DEPLOYMENT_API_CONFIG_SHA256,
    workerConfigMapHash: process.env.PHASE6_DEPLOYMENT_WORKER_CONFIG_SHA256,
    runtimeContractHash: process.env.PHASE6_DEPLOYMENT_RUNTIME_CONTRACT_SHA256,
    professionalPayrollResource: process.env.GO_NO_GO_EXPECTED_PAYROLL_RESOURCE,
    professionalPayrollEventContractHash:
      process.env.GO_NO_GO_EXPECTED_PAYROLL_CONTRACT_HASH,
  });
  for (const field of ['targetNamespace', 'apiConfigMap', 'workerConfigMap']) {
    name(expected[field]);
  }
  if (expected.apiConfigMap === expected.workerConfigMap) {
    fail('PHASE6_RUNTIME_CONFIG_REFERENCES_NOT_SEPARATED');
  }
  for (const field of [
    'apiConfigMapHash',
    'workerConfigMapHash',
    'runtimeContractHash',
    'professionalPayrollEventContractHash',
  ]) pattern(expected[field], SHA256, 'PHASE6_RUNTIME_CONFIG_EXPECTED_DIGEST_INVALID');
  httpsOrigin(
    expected.professionalPayrollResource,
    'PHASE6_RUNTIME_CONFIG_PAYROLL_RESOURCE_INVALID',
  );
  return expected;
}

function payrollBindingFromEnvironment() {
  const value = Object.freeze({
    professionalPayrollResource: process.env.GO_NO_GO_EXPECTED_PAYROLL_RESOURCE,
    professionalPayrollEventContractHash:
      process.env.GO_NO_GO_EXPECTED_PAYROLL_CONTRACT_HASH,
  });
  httpsOrigin(
    value.professionalPayrollResource,
    'PHASE6_RUNTIME_CONFIG_PAYROLL_RESOURCE_INVALID',
  );
  pattern(
    value.professionalPayrollEventContractHash,
    SHA256,
    'PHASE6_RUNTIME_CONFIG_EXPECTED_DIGEST_INVALID',
  );
  return value;
}

function validateRuntimeConfig(apiDocument, workerDocument, expected, payrollBinding) {
  const api = validateConfigMap(apiDocument, 'api', expected);
  const worker = validateConfigMap(workerDocument, 'worker', expected);
  if (api.namespace !== worker.namespace) fail('PHASE6_RUNTIME_CONFIG_NAMESPACE_MISMATCH');

  const professionalPayrollResource = expected?.professionalPayrollResource ??
    payrollBinding?.professionalPayrollResource;
  const professionalPayrollEventContractHash =
    expected?.professionalPayrollEventContractHash ??
    payrollBinding?.professionalPayrollEventContractHash;
  httpsOrigin(
    professionalPayrollResource,
    'PHASE6_RUNTIME_CONFIG_PAYROLL_RESOURCE_INVALID',
  );
  pattern(
    professionalPayrollEventContractHash,
    SHA256,
    'PHASE6_RUNTIME_CONFIG_EXPECTED_DIGEST_INVALID',
  );
  validateApiPayrollResource(api.data, professionalPayrollResource);

  const runtimeContractHash = digest(canonical({
    formatVersion: 1,
    suite: 'gaoq.phase6.production-runtime-config.binding',
    targetNamespace: api.namespace,
    apiConfigMap: api.name,
    workerConfigMap: worker.name,
    apiConfigMapHash: api.hash,
    workerConfigMapHash: worker.hash,
    payrollSystemMode: 'external',
    professionalPayrollResource,
    professionalPayrollEventContractHash,
    platformContractVersion: PLATFORM_CONTRACT_VERSION,
  }));

  if (expected !== undefined) {
    equal(api.hash, expected.apiConfigMapHash, 'PHASE6_RUNTIME_CONFIG_API_HASH_MISMATCH');
    equal(
      worker.hash,
      expected.workerConfigMapHash,
      'PHASE6_RUNTIME_CONFIG_WORKER_HASH_MISMATCH',
    );
    equal(
      runtimeContractHash,
      expected.runtimeContractHash,
      'PHASE6_RUNTIME_CONFIG_CONTRACT_HASH_MISMATCH',
    );
  }

  return Object.freeze({
    targetNamespace: api.namespace,
    apiConfigMap: api.name,
    workerConfigMap: worker.name,
    apiConfigMapHash: api.hash,
    workerConfigMapHash: worker.hash,
    runtimeContractHash,
    professionalPayrollResource,
    professionalPayrollEventContractHash,
  });
}

function validateConfigMap(document, role, expected) {
  if (
    !isRecord(document) || document.apiVersion !== 'v1' || document.kind !== 'ConfigMap' ||
    document.immutable !== true || 'binaryData' in document || !isRecord(document.metadata) ||
    !isRecord(document.data)
  ) fail('PHASE6_RUNTIME_CONFIG_OBJECT_INVALID');

  const nameValue = document.metadata.name;
  const namespace = document.metadata.namespace;
  name(nameValue);
  name(namespace);
  if (
    expected !== undefined &&
    (
      namespace !== expected.targetNamespace ||
      nameValue !== expected[`${role}ConfigMap`]
    )
  ) fail('PHASE6_RUNTIME_CONFIG_IDENTITY_MISMATCH');

  const entries = Object.entries(document.data);
  if (entries.length < 3 || entries.length > 256) fail('PHASE6_RUNTIME_CONFIG_DATA_INVALID');
  let totalBytes = 0;
  for (const [key, value] of entries) {
    if (
      !/^[A-Z][A-Z0-9_]{0,127}$/u.test(key) || typeof value !== 'string' ||
      SENSITIVE_KEY.test(key) || EXPLICITLY_SENSITIVE_KEYS.has(key)
    ) fail('PHASE6_RUNTIME_CONFIG_SENSITIVE_OR_INVALID_KEY');
    totalBytes += Buffer.byteLength(key) + Buffer.byteLength(value);
  }
  if (totalBytes > 512 * 1_024) fail('PHASE6_RUNTIME_CONFIG_DATA_INVALID');
  equal(document.data.NODE_ENV, 'production', 'PHASE6_RUNTIME_CONFIG_NODE_ENV_INVALID');
  equal(document.data.RUNTIME_ROLE, role, 'PHASE6_RUNTIME_CONFIG_ROLE_INVALID');
  equal(
    document.data.PAYROLL_SYSTEM_MODE,
    'external',
    'PHASE6_RUNTIME_CONFIG_PAYROLL_MODE_INVALID',
  );

  const normalized = {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name: nameValue, namespace },
    immutable: true,
    data: document.data,
  };
  return Object.freeze({
    name: nameValue,
    namespace,
    data: document.data,
    hash: digest(canonical(normalized)),
  });
}

function validateApiPayrollResource(data, expectedResource) {
  httpsResource(data.AUTH_RESOURCE, 'PHASE6_RUNTIME_CONFIG_ERP_RESOURCE_INVALID');
  let resources;
  try {
    resources = JSON.parse(data.AUTH_ADDITIONAL_RESOURCES_JSON);
  } catch {
    fail('PHASE6_RUNTIME_CONFIG_ADDITIONAL_RESOURCES_INVALID');
  }
  if (!Array.isArray(resources) || resources.length < 1 || resources.length > 20) {
    fail('PHASE6_RUNTIME_CONFIG_ADDITIONAL_RESOURCES_INVALID');
  }
  const normalized = resources.map((entry) => {
    if (
      !isRecord(entry) || Object.keys(entry).sort().join(',') !== 'audience,resource' ||
      typeof entry.audience !== 'string' || entry.audience.length < 1 ||
      entry.audience.length > 256 || typeof entry.resource !== 'string'
    ) fail('PHASE6_RUNTIME_CONFIG_ADDITIONAL_RESOURCES_INVALID');
    httpsOrigin(entry.resource, 'PHASE6_RUNTIME_CONFIG_ADDITIONAL_RESOURCES_INVALID');
    return entry;
  });
  if (normalized.filter((entry) => entry.resource === expectedResource).length !== 1) {
    fail('PHASE6_RUNTIME_CONFIG_PAYROLL_RESOURCE_MISMATCH');
  }
  if (data.AUTH_RESOURCE === expectedResource) {
    fail('PHASE6_RUNTIME_CONFIG_PAYROLL_RESOURCE_NOT_SEPARATED');
  }
}

function runSelfTest() {
  const namespace = 'erp-prod';
  const payrollResource = 'https://payroll.example.invalid';
  const payrollBinding = Object.freeze({
    professionalPayrollResource: payrollResource,
    professionalPayrollEventContractHash: digest('self-test-event-contract'),
  });
  const configMap = (role, data = {}) => ({
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name: `${role}-config`, namespace, resourceVersion: '42' },
    immutable: true,
    data: {
      NODE_ENV: 'production',
      RUNTIME_ROLE: role,
      PAYROLL_SYSTEM_MODE: 'external',
      ...data,
    },
  });
  const api = configMap('api', {
    AUTH_RESOURCE: 'https://erp.example.invalid/api',
    AUTH_ADDITIONAL_RESOURCES_JSON:
      JSON.stringify([{ resource: payrollResource, audience: 'professional-payroll' }]),
  });
  const worker = configMap('worker');
  const first = validateRuntimeConfig(api, worker, undefined, payrollBinding);
  const second = validateRuntimeConfig({
    ...api,
    metadata: { ...api.metadata, resourceVersion: '99', uid: 'ignored' },
  }, worker, undefined, payrollBinding);
  equal(first.apiConfigMapHash, second.apiConfigMapHash, 'PHASE6_RUNTIME_CONFIG_HASH_UNSTABLE');
  expectFailure(() => validateRuntimeConfig(
    { ...api, immutable: false },
    worker,
    undefined,
    payrollBinding,
  ));
  expectFailure(() => validateRuntimeConfig(
    api,
    configMap('worker', { PAYROLL_SYSTEM_MODE: 'legacy' }),
    undefined,
    payrollBinding,
  ));
  expectFailure(() => validateRuntimeConfig(
    configMap('api', {
      AUTH_RESOURCE: 'https://erp.example.invalid/api',
      AUTH_ADDITIONAL_RESOURCES_JSON: '[]',
    }),
    worker,
    undefined,
    payrollBinding,
  ));
  expectFailure(() => validateRuntimeConfig(
    configMap('api', {
      AUTH_RESOURCE: 'https://erp.example.invalid/api',
      AUTH_ADDITIONAL_RESOURCES_JSON:
        JSON.stringify([{ resource: payrollResource, audience: 'professional-payroll' }]),
      DATABASE_PASSWORD: 'forbidden',
    }),
    worker,
    undefined,
    payrollBinding,
  ));
  expectFailure(() => validateRuntimeConfig(
    configMap('api', {
      AUTH_ADDITIONAL_RESOURCES_JSON:
        JSON.stringify([{ resource: payrollResource, audience: 'professional-payroll' }]),
    }),
    worker,
    undefined,
    payrollBinding,
  ));
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function httpsOrigin(value, code) {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
      url.pathname !== '/' || url.search !== '' || url.hash !== '' ||
      (url.port !== '' && url.port !== '443')
    ) fail(code);
  } catch {
    fail(code);
  }
}

function httpsResource(value, code) {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
      url.search !== '' || url.hash !== '' ||
      (url.port !== '' && url.port !== '443')
    ) fail(code);
  } catch {
    fail(code);
  }
}

function expectFailure(operation) {
  try {
    operation();
  } catch {
    return;
  }
  fail('PHASE6_RUNTIME_CONFIG_SELF_TEST_EXPECTED_FAILURE');
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function name(value) {
  pattern(value, DNS_LABEL, 'PHASE6_RUNTIME_CONFIG_NAME_INVALID');
  if (value.length > 63) fail('PHASE6_RUNTIME_CONFIG_NAME_INVALID');
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

function fail(code) {
  throw new Error(code);
}
