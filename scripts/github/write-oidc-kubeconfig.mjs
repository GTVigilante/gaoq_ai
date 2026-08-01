import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

if (isMain(import.meta.url)) {
  const argumentsList = process.argv.slice(2);
  if (argumentsList.length === 1 && argumentsList[0] === '--self-test') {
    await runSelfTest();
    process.stdout.write('GitHub OIDC Kubernetes kubeconfig 生成器自测通过。\n');
  } else {
    if (
      argumentsList.length !== 2 || argumentsList[0] !== '--output' ||
      argumentsList[1] === undefined
    ) fail('OIDC_KUBECONFIG_ARGUMENTS_INVALID');
    const receipt = await writeOidcKubeconfig(argumentsList[1], process.env);
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  }
}

/** 写入不含静态凭据、只调用 OIDC ExecCredential 插件的 kubeconfig。 */
export async function writeOidcKubeconfig(outputPath, environment) {
  if (
    typeof outputPath !== 'string' || outputPath.length === 0 || outputPath.length > 1_024 ||
    outputPath.includes('\0')
  ) fail('OIDC_KUBECONFIG_OUTPUT_INVALID');
  const runnerTemp = environment.RUNNER_TEMP;
  if (
    typeof runnerTemp !== 'string' || !isAbsolute(runnerTemp) ||
    !isAbsolute(outputPath)
  ) fail('OIDC_KUBECONFIG_OUTPUT_INVALID');
  const relativePath = relative(resolve(runnerTemp), resolve(outputPath));
  if (
    relativePath.length === 0 || relativePath.startsWith('..') ||
    isAbsolute(relativePath)
  ) fail('OIDC_KUBECONFIG_OUTPUT_INVALID');
  const server = kubernetesServer(environment.PHASE6_KUBERNETES_SERVER);
  const caBase64 = environment.PHASE6_KUBERNETES_CA_BASE64;
  if (
    typeof caBase64 !== 'string' || caBase64.length < 16 || caBase64.length > 64 * 1_024 ||
    !BASE64.test(caBase64)
  ) fail('OIDC_KUBECONFIG_CA_INVALID');
  const ca = Buffer.from(caBase64, 'base64');
  if (
    ca.length < 16 || ca.length > 32 * 1_024 ||
    ca.toString('base64') !== caBase64
  ) fail('OIDC_KUBECONFIG_CA_INVALID');
  const expectedCaSha256 = environment.PHASE6_KUBERNETES_CA_SHA256;
  if (
    typeof expectedCaSha256 !== 'string' || !SHA256.test(expectedCaSha256) ||
    digest(ca) !== expectedCaSha256
  ) fail('OIDC_KUBECONFIG_CA_SHA256_MISMATCH');
  const document = {
    apiVersion: 'v1',
    kind: 'Config',
    clusters: [{
      name: 'gaoq-phase6',
      cluster: {
        server,
        'certificate-authority-data': caBase64,
      },
    }],
    users: [{
      name: 'github-oidc',
      user: {
        exec: {
          apiVersion: 'client.authentication.k8s.io/v1',
          command: 'node',
          args: ['scripts/github/github-oidc-kubernetes-credential.mjs'],
          interactiveMode: 'Never',
          provideClusterInfo: false,
        },
      },
    }],
    contexts: [{
      name: 'gaoq-phase6',
      context: {
        cluster: 'gaoq-phase6',
        user: 'github-oidc',
      },
    }],
    'current-context': 'gaoq-phase6',
  };
  await writeFile(outputPath, `${JSON.stringify(document)}\n`, {
    flag: 'wx',
    mode: 0o600,
  }).catch(() => fail('OIDC_KUBECONFIG_OUTPUT_INVALID'));
  const metadata = await stat(outputPath);
  if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) {
    fail('OIDC_KUBECONFIG_OUTPUT_INVALID');
  }
  return Object.freeze({
    formatVersion: 1,
    suite: 'gaoq.github.oidc-kubeconfig.receipt.v1',
    serverOriginHash: digest(new TextEncoder().encode(new URL(server).origin)),
    caSha256: expectedCaSha256,
    staticCredentialWritten: false,
  });
}

function kubernetesServer(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail('OIDC_KUBECONFIG_SERVER_INVALID');
  }
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.search !== '' || url.hash !== '' || url.hostname.length === 0 ||
    (url.pathname !== '' && url.pathname !== '/')
  ) fail('OIDC_KUBECONFIG_SERVER_INVALID');
  return url.href.replace(/\/$/u, '');
}

function digest(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function isMain(moduleUrl) {
  return process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === moduleUrl;
}

function fail(code) {
  throw new Error(code);
}

async function runSelfTest() {
  const directory = await mkdtemp(join(tmpdir(), 'gaoq-kubeconfig-'));
  const ca = Buffer.from('test-ca-certificate-material');
  const environment = {
    RUNNER_TEMP: directory,
    PHASE6_KUBERNETES_SERVER: 'https://kubernetes.example.invalid',
    PHASE6_KUBERNETES_CA_BASE64: ca.toString('base64'),
    PHASE6_KUBERNETES_CA_SHA256: digest(ca),
  };
  try {
    const path = join(directory, 'config.json');
    const receipt = await writeOidcKubeconfig(path, environment);
    const document = JSON.parse(await readFile(path, 'utf8'));
    if (
      receipt.staticCredentialWritten !== false ||
      document.users[0].user.exec.command !== 'node' ||
      document.users[0].user.token !== undefined ||
      ((await stat(path)).mode & 0o077) !== 0
    ) fail('SELF_TEST');
    await expectFailure(() => writeOidcKubeconfig(path, environment));
    await expectFailure(() => writeOidcKubeconfig(
      join(tmpdir(), 'gaoq-kubeconfig-outside.json'),
      environment,
    ));
    for (const invalid of [
      { ...environment, PHASE6_KUBERNETES_SERVER: 'http://kubernetes.example.invalid' },
      { ...environment, PHASE6_KUBERNETES_SERVER: 'https://user@kubernetes.example.invalid' },
      { ...environment, PHASE6_KUBERNETES_CA_SHA256: `sha256:${'a'.repeat(64)}` },
      { ...environment, PHASE6_KUBERNETES_CA_BASE64: 'not-base64' },
    ]) {
      await expectFailure(() => writeOidcKubeconfig(
        join(directory, `invalid-${Math.random()}.json`),
        invalid,
      ));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function expectFailure(operation) {
  try {
    await operation();
  } catch (error) {
    if (error instanceof Error && /^[A-Z][A-Z0-9_]+$/u.test(error.message)) return;
    throw error;
  }
  fail('SELF_TEST_EXPECTED_FAILURE');
}
