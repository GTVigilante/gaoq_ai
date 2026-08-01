import { pathToFileURL } from 'node:url';
import {
  createGithubOidcRuntime,
  requestGithubOidcToken,
  validateOidcAudience,
} from './fetch-oidc-protected-input.mjs';

const POLICY = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/u;
const MAX_RESPONSE_BYTES = 32 * 1_024;
const MAX_CREDENTIAL_SECONDS = 15 * 60;

if (isMain(import.meta.url)) {
  if (process.argv.length === 3 && process.argv[2] === '--self-test') {
    await runSelfTest();
    process.stdout.write('GitHub OIDC Kubernetes ExecCredential 插件自测通过。\n');
  } else {
    if (process.argv.length !== 2) fail('OIDC_KUBERNETES_ARGUMENTS_INVALID');
    const credential = await obtainKubernetesCredential({
      environment: process.env,
      fetchImplementation: globalThis.fetch,
    });
    process.stdout.write(`${JSON.stringify(credential)}\n`);
  }
}

/** 用 GitHub OIDC 换取不落盘的短期 Kubernetes ExecCredential。 */
export async function obtainKubernetesCredential(dependencies) {
  const runtime = createGithubOidcRuntime(dependencies);
  const audience = runtime.environment.PHASE6_KUBERNETES_OIDC_AUDIENCE;
  const policyName = runtime.environment.GAOQ_OIDC_POLICY;
  pattern(policyName, POLICY, 'OIDC_KUBERNETES_POLICY_INVALID');
  const brokerUrl = protectedBrokerUrl(
    runtime.environment.PHASE6_KUBERNETES_CREDENTIAL_URL,
  );
  validateOidcAudience(audience, new URL(brokerUrl).origin, policyName);
  const oidc = await requestGithubOidcToken({ audience, policyName }, runtime);
  const response = await fetchWithTimeout(brokerUrl, {
    method: 'POST',
    redirect: 'error',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${oidc.token}`,
      'content-type': 'application/json',
      'user-agent': 'gaoq-github-oidc-kubernetes/1',
      'x-gaoq-commit-sha': runtime.context.sha,
      'x-gaoq-policy': policyName,
      'x-gaoq-repository-id': runtime.context.repositoryId,
    },
    body: JSON.stringify({
      formatVersion: 1,
      suite: 'gaoq.github.oidc-kubernetes-credential.request.v1',
    }),
  }, runtime);
  if (response.status !== 200) fail('OIDC_KUBERNETES_RESPONSE_INVALID');
  if (
    response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !==
    'application/json'
  ) fail('OIDC_KUBERNETES_RESPONSE_INVALID');
  const body = await boundedBody(response, MAX_RESPONSE_BYTES);
  const credential = parseCredential(body, runtime.now());
  return Object.freeze(credential);
}

function parseCredential(body, now) {
  let document;
  try {
    document = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    fail('OIDC_KUBERNETES_RESPONSE_INVALID');
  }
  if (
    !plainObject(document) ||
    canonical(Object.keys(document)) !== canonical(['apiVersion', 'kind', 'status']) ||
    document.apiVersion !== 'client.authentication.k8s.io/v1' ||
    document.kind !== 'ExecCredential' ||
    !plainObject(document.status) ||
    canonical(Object.keys(document.status)) !== canonical(['expirationTimestamp', 'token'])
  ) fail('OIDC_KUBERNETES_RESPONSE_INVALID');
  const token = document.status.token;
  if (
    typeof token !== 'string' || token.length < 40 || Buffer.byteLength(token) > 16 * 1_024 ||
    /[\r\n\0]/u.test(token)
  ) fail('OIDC_KUBERNETES_TOKEN_INVALID');
  const expiresAt = Date.parse(document.status.expirationTimestamp);
  if (
    !Number.isFinite(expiresAt) || expiresAt <= now + 30_000 ||
    expiresAt - now > MAX_CREDENTIAL_SECONDS * 1_000
  ) fail('OIDC_KUBERNETES_EXPIRATION_INVALID');
  return {
    apiVersion: 'client.authentication.k8s.io/v1',
    kind: 'ExecCredential',
    status: {
      expirationTimestamp: new Date(expiresAt).toISOString(),
      token,
    },
  };
}

function protectedBrokerUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail('OIDC_KUBERNETES_BROKER_URL_INVALID');
  }
  if (
    url.protocol !== 'https:' || url.hostname.length === 0 || url.port !== '' ||
    url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== ''
  ) fail('OIDC_KUBERNETES_BROKER_URL_INVALID');
  return url.href;
}

async function fetchWithTimeout(url, options, runtime) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), runtime.timeoutMilliseconds);
  try {
    return await runtime.fetchImplementation(url, { ...options, signal: controller.signal });
  } catch {
    fail('OIDC_KUBERNETES_NETWORK_FAILED');
  } finally {
    clearTimeout(timeout);
  }
}

async function boundedBody(response, maximumBytes) {
  const declaredLength = response.headers.get('content-length');
  if (
    declaredLength !== null &&
    (!/^(?:0|[1-9][0-9]*)$/u.test(declaredLength) || Number(declaredLength) > maximumBytes)
  ) fail('OIDC_KUBERNETES_RESPONSE_INVALID');
  if (response.body === null) fail('OIDC_KUBERNETES_RESPONSE_INVALID');
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) fail('OIDC_KUBERNETES_RESPONSE_INVALID');
      length += value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel();
        fail('OIDC_KUBERNETES_RESPONSE_INVALID');
      }
      chunks.push(value);
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'OIDC_KUBERNETES_RESPONSE_INVALID'
    ) throw error;
    fail('OIDC_KUBERNETES_RESPONSE_INVALID');
  }
  if (length < 2) fail('OIDC_KUBERNETES_RESPONSE_INVALID');
  return Buffer.concat(chunks, length);
}

function pattern(value, expression, code) {
  if (typeof value !== 'string' || !expression.test(value)) fail(code);
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function canonical(value) {
  return JSON.stringify([...value].sort());
}

function isMain(moduleUrl) {
  return process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === moduleUrl;
}

function fail(code) {
  throw new Error(code);
}

async function runSelfTest() {
  const now = Date.parse('2026-07-29T08:00:00.000Z');
  const environment = {
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_REPOSITORY: 'GTVigilante/gaoq_ai',
    GITHUB_REPOSITORY_ID: '123456789',
    GITHUB_SHA: 'a'.repeat(40),
    GITHUB_WORKFLOW_REF:
      'GTVigilante/gaoq_ai/.github/workflows/phase-6-deployment-plan.yml@refs/heads/main',
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://pipelines.actions.githubusercontent.com/oidc/token',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request-token-with-sufficient-length',
    GAOQ_OIDC_POLICY: 'phase-6-deployment-plan',
    PHASE6_KUBERNETES_OIDC_AUDIENCE:
      'https://credential.example.invalid/oidc/phase-6-deployment-plan',
    PHASE6_KUBERNETES_CREDENTIAL_URL:
      'https://credential.example.invalid/v1/kubernetes/credential',
  };
  const claims = {
    aud: environment.PHASE6_KUBERNETES_OIDC_AUDIENCE,
    event_name: environment.GITHUB_EVENT_NAME,
    iss: 'https://token.actions.githubusercontent.com',
    job_workflow_ref: environment.GITHUB_WORKFLOW_REF,
    ref: environment.GITHUB_REF,
    repository: environment.GITHUB_REPOSITORY,
    repository_id: environment.GITHUB_REPOSITORY_ID,
    runner_environment: 'github-hosted',
    sha: environment.GITHUB_SHA,
    sub: 'repo:GTVigilante/gaoq_ai:ref:refs/heads/main',
    iat: now / 1_000 - 10,
    nbf: now / 1_000 - 10,
    exp: now / 1_000 + 300,
  };
  const jwt = [
    Buffer.from('{"alg":"RS256","typ":"JWT"}').toString('base64url'),
    Buffer.from(JSON.stringify(claims)).toString('base64url'),
    'signature',
  ].join('.');
  const credential = {
    apiVersion: 'client.authentication.k8s.io/v1',
    kind: 'ExecCredential',
    status: {
      expirationTimestamp: '2026-07-29T08:10:00.000Z',
      token: 'short-lived-kubernetes-token-with-sufficient-length',
    },
  };
  const fetchFor = (document = credential) => {
    let call = 0;
    return async (_url, options) => {
      call += 1;
      if (call === 1) {
        return new Response(JSON.stringify({ value: jwt }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (
        !options.headers.authorization.startsWith('Bearer eyJ') ||
        options.method !== 'POST'
      ) fail('SELF_TEST');
      return new Response(JSON.stringify(document), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
  };
  const actual = await obtainKubernetesCredential({
    environment,
    fetchImplementation: fetchFor(),
    now: () => now,
    timeoutMilliseconds: 1_000,
  });
  if (actual.status.token !== credential.status.token) fail('SELF_TEST');
  const negatives = [
    { ...credential, status: { ...credential.status, expirationTimestamp: '2026-07-29T09:00:00Z' } },
    { ...credential, status: { ...credential.status, token: 'short' } },
    { ...credential, clientCertificateData: 'forbidden' },
    { ...credential, apiVersion: 'client.authentication.k8s.io/v1beta1' },
  ];
  for (const document of negatives) {
    await expectFailure(() => obtainKubernetesCredential({
      environment,
      fetchImplementation: fetchFor(document),
      now: () => now,
      timeoutMilliseconds: 1_000,
    }));
  }
  await expectFailure(() => obtainKubernetesCredential({
    environment: {
      ...environment,
      PHASE6_KUBERNETES_CREDENTIAL_URL: 'http://credential.example.invalid/token',
    },
    fetchImplementation: fetchFor(),
    now: () => now,
  }));
  await expectFailure(() => obtainKubernetesCredential({
    environment: {
      ...environment,
      PHASE6_KUBERNETES_OIDC_AUDIENCE:
        'https://other.example.invalid/oidc/phase-6-deployment-plan',
    },
    fetchImplementation: fetchFor(),
    now: () => now,
  }));
}

async function expectFailure(operation) {
  try {
    await operation();
  } catch (error) {
    if (
      error instanceof Error && /^[A-Z][A-Z0-9_]+$/u.test(error.message) &&
      !error.message.includes('kubernetes-token')
    ) return;
    throw error;
  }
  fail('SELF_TEST_EXPECTED_FAILURE');
}
