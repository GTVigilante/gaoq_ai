import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const AUDIENCE = /^[A-Za-z0-9][A-Za-z0-9:._/-]{7,255}$/u;
const POLICY = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/u;
const MEDIA_TYPE = /^(?:application\/json|application\/yaml|text\/yaml)$/u;
const MAX_OIDC_RESPONSE_BYTES = 64 * 1_024;
const MAX_TOKEN_BYTES = 16 * 1_024;
const DEFAULT_TIMEOUT_MILLISECONDS = 20_000;

if (isMain(import.meta.url)) {
  const argumentsList = process.argv.slice(2);
  if (argumentsList.length === 1 && argumentsList[0] === '--self-test') {
    await runSelfTest();
    process.stdout.write('GitHub OIDC 受保护输入下载器自测通过。\n');
  } else {
    const configuration = parseArguments(argumentsList);
    const receipt = await fetchProtectedInput(configuration, {
      environment: process.env,
      fetchImplementation: globalThis.fetch,
    });
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  }
}

/** 解析严格成对的命令行参数。 */
export function parseArguments(argumentsList) {
  const allowed = new Set([
    '--audience', '--max-bytes', '--media-type', '--output', '--policy', '--sha256', '--url',
  ]);
  if (argumentsList.length !== 14) fail('OIDC_INPUT_ARGUMENTS_INVALID');
  const entries = new Map();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const key = argumentsList[index];
    const value = argumentsList[index + 1];
    if (
      key === undefined || value === undefined || !allowed.has(key) || entries.has(key) ||
      value.length === 0
    ) fail('OIDC_INPUT_ARGUMENTS_INVALID');
    entries.set(key, value);
  }
  const maxBytes = Number(entries.get('--max-bytes'));
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 2 || maxBytes > 2 * 1_024 * 1_024) {
    fail('OIDC_INPUT_MAX_BYTES_INVALID');
  }
  const configuration = Object.freeze({
    audience: entries.get('--audience'),
    policyName: entries.get('--policy'),
    expectedSha256: entries.get('--sha256'),
    maxBytes,
    mediaType: entries.get('--media-type'),
    outputPath: entries.get('--output'),
    sourceUrl: entries.get('--url'),
  });
  pattern(configuration.audience, AUDIENCE, 'OIDC_INPUT_AUDIENCE_INVALID');
  pattern(configuration.policyName, POLICY, 'OIDC_INPUT_POLICY_INVALID');
  pattern(configuration.expectedSha256, SHA256, 'OIDC_INPUT_SHA256_INVALID');
  pattern(configuration.mediaType, MEDIA_TYPE, 'OIDC_INPUT_MEDIA_TYPE_INVALID');
  if (
    typeof configuration.outputPath !== 'string' || configuration.outputPath.length > 1_024 ||
    configuration.outputPath.includes('\0')
  ) fail('OIDC_INPUT_OUTPUT_INVALID');
  const sourceUrl = protectedUrl(configuration.sourceUrl, 'OIDC_INPUT_SOURCE_URL_INVALID');
  validateOidcAudience(configuration.audience, sourceUrl.origin, configuration.policyName);
  return configuration;
}

/** 使用 GitHub 单次 OIDC 身份读取并固定一份受保护输入。 */
export async function fetchProtectedInput(configuration, dependencies) {
  const runtime = createGithubOidcRuntime(dependencies);
  validateRunnerTempPath(configuration.outputPath, runtime.environment.RUNNER_TEMP);
  const oidc = await requestGithubOidcToken({
    audience: configuration.audience,
    policyName: configuration.policyName,
  }, runtime);
  const response = await fetchWithTimeout(configuration.sourceUrl, {
    method: 'GET',
    redirect: 'error',
    headers: {
      accept: configuration.mediaType,
      authorization: `Bearer ${oidc.token}`,
      'user-agent': 'gaoq-github-oidc-input/1',
      'x-gaoq-commit-sha': runtime.context.sha,
      'x-gaoq-policy': configuration.policyName,
      'x-gaoq-repository-id': runtime.context.repositoryId,
    },
  }, runtime);
  if (response.status !== 200) fail('OIDC_INPUT_SOURCE_RESPONSE_INVALID');
  exactMediaType(response.headers.get('content-type'), configuration.mediaType);
  const responseHash = response.headers.get('x-gaoq-content-sha256');
  if (responseHash !== configuration.expectedSha256) fail('OIDC_INPUT_RESPONSE_SHA256_MISMATCH');
  const content = await boundedBody(response, configuration.maxBytes, 'OIDC_INPUT_BODY_INVALID');
  const actualSha256 = digest(content);
  if (actualSha256 !== configuration.expectedSha256) fail('OIDC_INPUT_BODY_SHA256_MISMATCH');
  validateBody(content, configuration.mediaType);
  await writeFile(configuration.outputPath, content, {
    flag: 'wx',
    mode: 0o600,
  }).catch(() => fail('OIDC_INPUT_OUTPUT_INVALID'));
  const metadata = await stat(configuration.outputPath);
  if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) fail('OIDC_INPUT_OUTPUT_INVALID');
  return Object.freeze({
    formatVersion: 1,
    suite: 'gaoq.github.oidc-protected-input.receipt.v1',
    repositoryId: runtime.context.repositoryId,
    commitSha: runtime.context.sha,
    policy: configuration.policyName,
    sourceOriginHash: digest(new TextEncoder().encode(new URL(configuration.sourceUrl).origin)),
    contentSha256: actualSha256,
    contentBytes: content.byteLength,
  });
}

function validateRunnerTempPath(outputPath, runnerTemp) {
  if (
    typeof runnerTemp !== 'string' || !isAbsolute(runnerTemp) ||
    !isAbsolute(outputPath)
  ) fail('OIDC_INPUT_OUTPUT_INVALID');
  const relativePath = relative(resolve(runnerTemp), resolve(outputPath));
  if (
    relativePath.length === 0 || relativePath.startsWith('..') ||
    isAbsolute(relativePath)
  ) fail('OIDC_INPUT_OUTPUT_INVALID');
}

/** 从 GitHub Runner 的受保护端点取得并检查 OIDC JWT。 */
export async function requestGithubOidcToken(configuration, runtime) {
  validateOidcAudience(configuration.audience, undefined, configuration.policyName);
  pattern(configuration.policyName, POLICY, 'OIDC_INPUT_POLICY_INVALID');
  const requestToken = runtime.environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (
    typeof requestToken !== 'string' || requestToken.length < 20 ||
    Buffer.byteLength(requestToken) > MAX_TOKEN_BYTES
  ) fail('OIDC_INPUT_REQUEST_TOKEN_INVALID');
  const requestUrl = githubOidcRequestUrl(
    runtime.environment.ACTIONS_ID_TOKEN_REQUEST_URL,
    configuration.audience,
  );
  const response = await fetchWithTimeout(requestUrl, {
    method: 'GET',
    redirect: 'error',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${requestToken}`,
      'user-agent': 'gaoq-github-oidc-input/1',
    },
  }, runtime);
  if (response.status !== 200) fail('OIDC_INPUT_TOKEN_RESPONSE_INVALID');
  exactMediaType(response.headers.get('content-type'), 'application/json');
  const body = await boundedBody(response, MAX_OIDC_RESPONSE_BYTES, 'OIDC_INPUT_TOKEN_RESPONSE_INVALID');
  const document = strictJson(body, 'OIDC_INPUT_TOKEN_RESPONSE_INVALID');
  if (!isPlainObject(document) || Object.keys(document).length !== 1) {
    fail('OIDC_INPUT_TOKEN_RESPONSE_INVALID');
  }
  const token = document.value;
  if (
    typeof token !== 'string' || token.length < 40 || Buffer.byteLength(token) > MAX_TOKEN_BYTES ||
    token.split('.').length !== 3
  ) fail('OIDC_INPUT_TOKEN_RESPONSE_INVALID');
  validateOidcClaims(token, configuration, runtime.context, runtime.now());
  return Object.freeze({ token });
}

/** 校验 audience 是与接收代理同 Origin 的规范 HTTPS URL。 */
export function validateOidcAudience(value, expectedOrigin, policyName) {
  pattern(value, AUDIENCE, 'OIDC_INPUT_AUDIENCE_INVALID');
  pattern(policyName, POLICY, 'OIDC_INPUT_POLICY_INVALID');
  let url;
  try {
    url = new URL(value);
  } catch {
    fail('OIDC_INPUT_AUDIENCE_INVALID');
  }
  if (
    url.protocol !== 'https:' || url.hostname.length === 0 || url.port !== '' ||
    url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '' ||
    url.pathname === '/' || url.href !== value ||
    url.pathname.split('/').filter(Boolean).at(-1) !== policyName ||
    (expectedOrigin !== undefined && url.origin !== expectedOrigin)
  ) fail('OIDC_INPUT_AUDIENCE_INVALID');
  return url.href;
}

export function createGithubOidcRuntime(dependencies) {
  if (
    dependencies === null || typeof dependencies !== 'object' ||
    typeof dependencies.fetchImplementation !== 'function'
  ) fail('OIDC_INPUT_RUNTIME_INVALID');
  const environment = dependencies.environment;
  if (environment === null || typeof environment !== 'object') fail('OIDC_INPUT_RUNTIME_INVALID');
  const context = Object.freeze({
    eventName: environment.GITHUB_EVENT_NAME,
    ref: environment.GITHUB_REF,
    repository: environment.GITHUB_REPOSITORY,
    repositoryId: environment.GITHUB_REPOSITORY_ID,
    sha: environment.GITHUB_SHA,
    workflowRef: environment.GITHUB_WORKFLOW_REF,
  });
  pattern(context.repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u, 'OIDC_INPUT_CONTEXT_INVALID');
  pattern(context.repositoryId, /^[1-9][0-9]{3,15}$/u, 'OIDC_INPUT_CONTEXT_INVALID');
  pattern(context.sha, /^[a-f0-9]{40}$/u, 'OIDC_INPUT_CONTEXT_INVALID');
  if (context.ref !== 'refs/heads/main' || context.eventName !== 'workflow_dispatch') {
    fail('OIDC_INPUT_CONTEXT_INVALID');
  }
  if (
    typeof context.workflowRef !== 'string' ||
    !context.workflowRef.startsWith(`${context.repository}/.github/workflows/`) ||
    !context.workflowRef.endsWith('@refs/heads/main')
  ) fail('OIDC_INPUT_CONTEXT_INVALID');
  return Object.freeze({
    context,
    environment,
    fetchImplementation: dependencies.fetchImplementation,
    now: dependencies.now ?? Date.now,
    timeoutMilliseconds: dependencies.timeoutMilliseconds ?? DEFAULT_TIMEOUT_MILLISECONDS,
  });
}

function validateOidcClaims(token, configuration, context, now) {
  let claims;
  try {
    claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  } catch {
    fail('OIDC_INPUT_TOKEN_CLAIMS_INVALID');
  }
  if (!isPlainObject(claims)) fail('OIDC_INPUT_TOKEN_CLAIMS_INVALID');
  const expected = {
    aud: configuration.audience,
    event_name: context.eventName,
    iss: 'https://token.actions.githubusercontent.com',
    job_workflow_ref: context.workflowRef,
    ref: context.ref,
    repository: context.repository,
    repository_id: context.repositoryId,
    runner_environment: 'github-hosted',
    sha: context.sha,
  };
  for (const [field, value] of Object.entries(expected)) {
    if (claims[field] !== value) fail('OIDC_INPUT_TOKEN_CLAIMS_INVALID');
  }
  if (
    claims.environment !== undefined ||
    typeof claims.sub !== 'string' || claims.sub.length > 512 ||
    claims.sub !== `repo:${context.repository}:ref:refs/heads/main`
  ) fail('OIDC_INPUT_TOKEN_CLAIMS_INVALID');
  const nowSeconds = Math.floor(now / 1_000);
  for (const field of ['iat', 'nbf', 'exp']) {
    if (!Number.isSafeInteger(claims[field])) fail('OIDC_INPUT_TOKEN_CLAIMS_INVALID');
  }
  if (
    claims.iat > nowSeconds + 30 || claims.nbf > nowSeconds + 30 ||
    claims.exp <= nowSeconds + 30 || claims.exp - nowSeconds > 15 * 60 ||
    claims.exp <= claims.iat
  ) fail('OIDC_INPUT_TOKEN_CLAIMS_INVALID');
}

function githubOidcRequestUrl(value, audience) {
  const url = protectedUrl(value, 'OIDC_INPUT_REQUEST_URL_INVALID');
  if (
    url.hostname !== 'actions.githubusercontent.com' &&
    !url.hostname.endsWith('.actions.githubusercontent.com')
  ) fail('OIDC_INPUT_REQUEST_URL_INVALID');
  url.searchParams.set('audience', audience);
  return url.href;
}

function protectedUrl(value, code) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(code);
  }
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.hash !== '' || url.hostname.length === 0 || url.port !== '' ||
    (code === 'OIDC_INPUT_SOURCE_URL_INVALID' && url.search !== '')
  ) fail(code);
  return url;
}

async function fetchWithTimeout(url, options, runtime) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), runtime.timeoutMilliseconds);
  try {
    return await runtime.fetchImplementation(url, { ...options, signal: controller.signal });
  } catch {
    fail('OIDC_INPUT_NETWORK_FAILED');
  } finally {
    clearTimeout(timeout);
  }
}

async function boundedBody(response, maximumBytes, code) {
  const declaredLength = response.headers.get('content-length');
  if (
    declaredLength !== null &&
    (!/^(?:0|[1-9][0-9]*)$/u.test(declaredLength) || Number(declaredLength) > maximumBytes)
  ) fail(code);
  if (response.body === null) fail(code);
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) fail(code);
      length += value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel();
        fail(code);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof Error && error.message === code) throw error;
    fail(code);
  }
  if (length < 2) fail(code);
  return Buffer.concat(chunks, length);
}

function validateBody(content, mediaType) {
  if (mediaType === 'application/json') strictJson(content, 'OIDC_INPUT_JSON_INVALID');
  else {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(content);
    } catch {
      fail('OIDC_INPUT_TEXT_INVALID');
    }
  }
}

function strictJson(content, code) {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(content);
    return JSON.parse(text);
  } catch {
    fail(code);
  }
}

function exactMediaType(value, expected) {
  if (typeof value !== 'string' || value.split(';', 1)[0]?.trim().toLowerCase() !== expected) {
    fail('OIDC_INPUT_MEDIA_TYPE_MISMATCH');
  }
}

function digest(content) {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function pattern(value, expression, code) {
  if (typeof value !== 'string' || !expression.test(value)) fail(code);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function isMain(moduleUrl) {
  return process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === moduleUrl;
}

function fail(code) {
  throw new Error(code);
}

async function runSelfTest() {
  const now = Date.parse('2026-07-29T08:00:00.000Z');
  const context = {
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_REPOSITORY: 'GTVigilante/gaoq_ai',
    GITHUB_REPOSITORY_ID: '123456789',
    GITHUB_SHA: 'a'.repeat(40),
    GITHUB_WORKFLOW_REF:
      'GTVigilante/gaoq_ai/.github/workflows/phase-5-performance.yml@refs/heads/main',
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://pipelines.actions.githubusercontent.com/oidc/token',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request-token-with-sufficient-length',
  };
  const policyName = 'phase-5-performance';
  const audience = 'https://evidence.example.invalid/oidc/phase-5-performance';
  const body = Buffer.from('{"formatVersion":1,"suite":"fixture"}');
  const expectedSha256 = digest(body);
  const configurationFor = (outputPath) => ({
    audience,
    policyName,
    expectedSha256,
    maxBytes: 4_096,
    mediaType: 'application/json',
    outputPath,
    sourceUrl: 'https://evidence.example.invalid/v1/performance/run-1',
  });
  const claims = {
    aud: audience,
    event_name: context.GITHUB_EVENT_NAME,
    iss: 'https://token.actions.githubusercontent.com',
    job_workflow_ref: context.GITHUB_WORKFLOW_REF,
    ref: context.GITHUB_REF,
    repository: context.GITHUB_REPOSITORY,
    repository_id: context.GITHUB_REPOSITORY_ID,
    runner_environment: 'github-hosted',
    sha: context.GITHUB_SHA,
    sub: 'repo:GTVigilante/gaoq_ai:ref:refs/heads/main',
    iat: now / 1_000 - 10,
    nbf: now / 1_000 - 10,
    exp: now / 1_000 + 300,
  };
  const tokenFor = (payload) => [
    Buffer.from('{"alg":"RS256","typ":"JWT"}').toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'signature',
  ].join('.');
  const response = (value, headers = {}) => new Response(value, {
    status: 200,
    headers,
  });
  const fetchFor = (claimOverrides = {}, sourceOverrides = {}) => {
    let call = 0;
    return async (_url, options) => {
      call += 1;
      if (call === 1) {
        if (!options.headers.authorization.startsWith('Bearer request-token')) fail('SELF_TEST');
        const token = tokenFor({ ...claims, ...claimOverrides });
        return response(JSON.stringify({ value: token }), {
          'content-type': 'application/json',
        });
      }
      if (!options.headers.authorization.startsWith('Bearer eyJ')) fail('SELF_TEST');
      return response(sourceOverrides.body ?? body, {
        'content-type': sourceOverrides.contentType ?? 'application/json',
        'x-gaoq-content-sha256': sourceOverrides.headerHash ?? expectedSha256,
      });
    };
  };
  const directory = await mkdtemp(join(tmpdir(), 'gaoq-oidc-input-'));
  try {
    context.RUNNER_TEMP = directory;
    const outputPath = join(directory, 'evidence.json');
    const receipt = await fetchProtectedInput(configurationFor(outputPath), {
      environment: context,
      fetchImplementation: fetchFor(),
      now: () => now,
      timeoutMilliseconds: 1_000,
    });
    if (
      receipt.contentSha256 !== expectedSha256 ||
      !Buffer.from(await readFile(outputPath)).equals(body) ||
      ((await stat(outputPath)).mode & 0o077) !== 0
    ) fail('SELF_TEST');

    const negativeCases = [
      { claims: { environment: 'phase-5-performance' } },
      { claims: { runner_environment: 'self-hosted' } },
      { claims: { sha: 'b'.repeat(40) } },
      { source: { headerHash: `sha256:${'b'.repeat(64)}` } },
      { source: { body: Buffer.from('{"changed":true}') } },
      { source: { contentType: 'text/html' } },
      { source: { body: Buffer.alloc(4_097, 0x61) } },
    ];
    for (const [index, negative] of negativeCases.entries()) {
      const path = join(directory, `negative-${index}.json`);
      await expectFailure(() => fetchProtectedInput(configurationFor(path), {
        environment: context,
        fetchImplementation: fetchFor(negative.claims, negative.source),
        now: () => now,
        timeoutMilliseconds: 1_000,
      }));
    }
    await expectFailure(() => fetchProtectedInput(configurationFor(outputPath), {
      environment: context,
      fetchImplementation: fetchFor(),
      now: () => now,
      timeoutMilliseconds: 1_000,
    }));
    await expectFailure(async () => {
      const copy = { ...context, GITHUB_REF: 'refs/heads/feature' };
      await fetchProtectedInput(configurationFor(join(directory, 'branch.json')), {
        environment: copy,
        fetchImplementation: fetchFor(),
        now: () => now,
      });
    });
    await expectFailure(async () => {
      const copy = { ...context, ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.invalid/token' };
      await fetchProtectedInput(configurationFor(join(directory, 'issuer.json')), {
        environment: copy,
        fetchImplementation: fetchFor(),
        now: () => now,
      });
    });
    await expectFailure(() => fetchProtectedInput({
      ...configurationFor(join(directory, 'audience-origin.json')),
      audience: 'https://other.example.invalid/oidc/phase-5-performance',
    }, {
      environment: context,
      fetchImplementation: fetchFor(),
      now: () => now,
    }));
    await expectFailure(() => fetchProtectedInput(
      configurationFor(join(tmpdir(), 'gaoq-oidc-outside.json')),
      {
        environment: context,
        fetchImplementation: fetchFor(),
        now: () => now,
      },
    ));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function expectFailure(operation) {
  try {
    await operation();
  } catch (error) {
    if (
      error instanceof Error &&
      /^[A-Z][A-Z0-9_]+$/u.test(error.message) &&
      !error.message.includes('token-with')
    ) return;
    throw error;
  }
  fail('SELF_TEST_EXPECTED_FAILURE');
}
