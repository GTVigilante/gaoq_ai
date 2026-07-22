import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { appendFile, chmod, mkdir, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ZAP_IMAGE =
  'zaproxy/zap-stable@sha256:c558ee87358911ab17278c70991e856f57793e115d9cd0f88ca475cf82907a1a';
const NON_PRODUCTION_LABELS = new Set(['dast', 'preprod', 'security', 'stage', 'staging', 'uat']);
const ZAP_SCRIPT_DIR = fileURLToPath(new URL('./zap/', import.meta.url));

if (process.argv[2] === '--self-test') {
  await validateWorkflow();
  runSelfTest();
  process.stdout.write('Phase 5 DAST 目标、安全边界与工作流自测通过。\n');
} else if (process.argv[2] === '--run') {
  await runScans(process.env);
} else {
  throw new Error('PHASE5_DAST_MODE_REQUIRED');
}

async function runScans(environment) {
  const config = parseConfig(environment);
  await mkdir(config.reportDir, { recursive: true, mode: 0o700 });
  await chmod(config.reportDir, 0o777);
  const results = [];
  try {
    for (const mode of ['unauthenticated', 'authenticated']) {
      process.stdout.write(`开始 Phase 5 ${mode} DAST。\n`);
      const code = await runDocker(config, mode);
      results.push({ mode, code });
      process.stdout.write(`Phase 5 ${mode} DAST 结束，退出码 ${code}。\n`);
    }
    await assertReportsSafe(config);
    if (typeof environment.GITHUB_OUTPUT === 'string' && environment.GITHUB_OUTPUT.length > 0) {
      await appendFile(environment.GITHUB_OUTPUT, 'reports_safe=true\n', 'utf8');
    }
  } finally {
    await chmod(config.reportDir, 0o700);
  }
  if (results.some((result) => result.code !== 0)) {
    throw new Error('PHASE5_DAST_SCAN_FINDING_OR_RUNTIME_FAILURE');
  }
}

async function assertReportsSafe(config) {
  const names = ['unauthenticated', 'authenticated'].flatMap((mode) => [
    `phase-5-zap-${mode}.json`,
    `phase-5-zap-${mode}.xml`,
    `phase-5-zap-${mode}.html`,
  ]);
  for (const name of names) {
    const path = join(config.reportDir, name);
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size < 2 || metadata.size > 512 * 1_024 * 1_024) {
      fail('PHASE5_DAST_REPORT_INVALID');
    }
    if (await containsText(path, config.authToken)) fail('PHASE5_DAST_TOKEN_IN_REPORT');
  }
}

async function containsText(path, needle) {
  let carry = '';
  for await (const chunk of createReadStream(path, { encoding: 'utf8' })) {
    const text = carry + chunk;
    if (text.includes(needle)) return true;
    carry = text.slice(-(needle.length - 1));
  }
  return false;
}

function runDocker(config, mode) {
  const authenticated = mode === 'authenticated';
  const reportPrefix = `phase-5-zap-${mode}`;
  const args = [
    'run', '--rm', '--pull=never', '--read-only',
    '--cap-drop=ALL', '--security-opt=no-new-privileges:true',
    '--pids-limit=2048', '--cpus=4', '--memory=8g',
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=2g',
    '--tmpfs', '/home/zap/.ZAP:rw,nosuid,nodev,size=4g',
    '--tmpfs', '/home/zap/.cache:rw,nosuid,nodev,size=2g',
    '--volume', `${config.reportDir}:/zap/wrk:rw`,
    '--volume', `${ZAP_SCRIPT_DIR}:/zap/gaoq:ro`,
  ];
  if (authenticated) {
    args.push(
      '--env', 'GAOQ_DAST_AUTH_TOKEN',
      '--env', 'GAOQ_DAST_AUTH_HOST',
    );
  }
  args.push(
    ZAP_IMAGE,
    'zap-full-scan.py',
    '-t', config.targetOrigin,
    '-m', '10',
    '-T', '90',
    '-j',
    '-s',
    '-J', `${reportPrefix}.json`,
    '-x', `${reportPrefix}.xml`,
    '-r', `${reportPrefix}.html`,
  );
  if (authenticated) args.push('--hook=/zap/gaoq/exact-auth-hook.py');
  const childEnvironment = { ...process.env };
  if (authenticated) {
    childEnvironment.GAOQ_DAST_AUTH_TOKEN = config.authToken;
    childEnvironment.GAOQ_DAST_AUTH_HOST = config.targetHostname;
  } else {
    delete childEnvironment.GAOQ_DAST_AUTH_TOKEN;
    delete childEnvironment.GAOQ_DAST_AUTH_HOST;
  }
  return new Promise((resolveCode, reject) => {
    const child = spawn('docker', args, { env: childEnvironment, stdio: 'inherit', shell: false });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal !== null) reject(new Error('PHASE5_DAST_DOCKER_SIGNALLED'));
      else resolveCode(code ?? 3);
    });
  });
}

function parseConfig(environment) {
  exact(environment.DAST_PRODUCTION_EQUIVALENT, 'true', 'PHASE5_DAST_ENV_NOT_EQUIVALENT');
  exact(environment.DAST_PRODUCTION_TRAFFIC, 'false', 'PHASE5_DAST_PRODUCTION_FORBIDDEN');
  exact(environment.DAST_ACTIVE_SCAN_APPROVED, 'true', 'PHASE5_DAST_APPROVAL_REQUIRED');
  const environmentName = match(
    environment.DAST_ENVIRONMENT_NAME,
    /^[a-z][a-z0-9-]{2,31}$/u,
    'PHASE5_DAST_ENVIRONMENT_INVALID',
  );
  if (['prod', 'production'].includes(environmentName)) fail('PHASE5_DAST_PRODUCTION_FORBIDDEN');
  const allowedSuffix = match(
    environment.DAST_ALLOWED_HOST_SUFFIX,
    /^\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u,
    'PHASE5_DAST_SUFFIX_INVALID',
  );
  const target = new URL(required(environment.DAST_BASE_URL, 'PHASE5_DAST_TARGET_REQUIRED'));
  const hostnameLabels = target.hostname.split('.');
  if (
    target.protocol !== 'https:' || target.username !== '' || target.password !== '' ||
    target.pathname !== '/' || target.search !== '' || target.hash !== '' ||
    (target.port !== '' && target.port !== '443') ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(target.hostname) ||
    !target.hostname.endsWith(allowedSuffix) || target.hostname === allowedSuffix.slice(1) ||
    hostnameLabels.some((label) => ['prod', 'production'].includes(label)) ||
    !hostnameLabels.some((label) => NON_PRODUCTION_LABELS.has(label))
  ) fail('PHASE5_DAST_TARGET_INVALID');
  const authToken = match(
    environment.DAST_AUTH_TOKEN,
    /^[\x21-\x7e]{32,8192}$/u,
    'PHASE5_DAST_TOKEN_INVALID',
  );
  if (/^Bearer/iu.test(authToken)) fail('PHASE5_DAST_TOKEN_PREFIX_FORBIDDEN');
  const runnerTemp = required(environment.RUNNER_TEMP, 'PHASE5_DAST_RUNNER_TEMP_REQUIRED');
  const reportDir = required(environment.DAST_REPORT_DIR, 'PHASE5_DAST_REPORT_DIR_REQUIRED');
  if (!isAbsolute(runnerTemp) || !isAbsolute(reportDir)) fail('PHASE5_DAST_REPORT_DIR_INVALID');
  const normalizedTemp = resolve(runnerTemp);
  const normalizedReport = resolve(reportDir);
  if (!normalizedReport.startsWith(`${normalizedTemp}${sep}`)) fail('PHASE5_DAST_REPORT_DIR_INVALID');
  return Object.freeze({
    environmentName,
    targetOrigin: target.origin,
    targetHostname: target.hostname,
    authToken,
    reportDir: normalizedReport,
  });
}

async function validateWorkflow() {
  const workflow = await readFile(
    new URL('../../.github/workflows/phase-5-dast.yml', import.meta.url),
    'utf8',
  );
  for (const marker of [
    'workflow_dispatch:',
    'environment: phase-5-dast',
    'DAST_BASE_URL: ${{ secrets.DAST_BASE_URL }}',
    'DAST_AUTH_TOKEN: ${{ secrets.DAST_AUTH_TOKEN }}',
    'DAST_ACTIVE_SCAN_APPROVED: ${{ vars.DAST_ACTIVE_SCAN_APPROVED }}',
    ZAP_IMAGE,
    'node scripts/security/run-phase-5-dast.mjs --run',
    "if: always() && steps.dast.outputs.reports_safe == 'true'",
  ]) {
    if (!workflow.includes(marker)) fail('PHASE5_DAST_WORKFLOW_INCOMPLETE');
  }
  const actions = [...workflow.matchAll(/^\s*uses:\s*([^\s#]+)(?:\s*#.*)?$/gmu)]
    .map((item) => item[1]);
  if (actions.length !== 2 || actions.some((action) => !/@[a-f0-9]{40}$/u.test(action ?? ''))) {
    fail('PHASE5_DAST_ACTION_NOT_PINNED');
  }
  if (/--include-system-env-vars|--privileged|network:\s*host|continue-on-error/u.test(workflow)) {
    fail('PHASE5_DAST_WORKFLOW_UNSAFE');
  }
  const authScript = await readFile(new URL('./zap/exact-auth-header.js', import.meta.url), 'utf8');
  const authHook = await readFile(new URL('./zap/exact-auth-hook.py', import.meta.url), 'utf8');
  for (const marker of [
    "hostname === allowedHost && msg.isInScope()",
    "System.getenv('GAOQ_DAST_AUTH_TOKEN')",
    "System.getenv('GAOQ_DAST_AUTH_HOST')",
  ]) {
    if (!authScript.includes(marker)) fail('PHASE5_DAST_AUTH_SCRIPT_UNSAFE');
  }
  for (const marker of [
    "'gaoq-exact-auth-header.js',",
    "'httpsender',",
    "'Graal.js',",
    "'/zap/gaoq/exact-auth-header.js',",
    "zap.script.enable('gaoq-exact-auth-header.js')",
  ]) {
    if (!authHook.includes(marker)) fail('PHASE5_DAST_AUTH_HOOK_INCOMPLETE');
  }
}

function runSelfTest() {
  const environment = fixtureEnvironment();
  const parsed = parseConfig(environment);
  exact(parsed.targetOrigin, 'https://erp.dast.security.example.com', 'PHASE5_DAST_SELF_TEST_FAILED');
  exact(parsed.reportDir, '/runner/temp/reports', 'PHASE5_DAST_SELF_TEST_FAILED');
  for (const mutation of [
    { DAST_BASE_URL: 'http://erp.dast.security.example.com' },
    { DAST_BASE_URL: 'https://erp.production.security.example.com' },
    { DAST_BASE_URL: 'https://erp.dast.attacker.example.net' },
    { DAST_BASE_URL: 'https://user@erp.dast.security.example.com' },
    { DAST_PRODUCTION_TRAFFIC: 'true' },
    { DAST_ACTIVE_SCAN_APPROVED: 'false' },
    { DAST_REPORT_DIR: '/runner/other/reports' },
  ]) expectFailure(() => parseConfig({ ...environment, ...mutation }));
}

function fixtureEnvironment() {
  return {
    DAST_PRODUCTION_EQUIVALENT: 'true',
    DAST_PRODUCTION_TRAFFIC: 'false',
    DAST_ACTIVE_SCAN_APPROVED: 'true',
    DAST_ENVIRONMENT_NAME: 'security-stage',
    DAST_ALLOWED_HOST_SUFFIX: '.security.example.com',
    DAST_BASE_URL: 'https://erp.dast.security.example.com',
    DAST_AUTH_TOKEN: 'A'.repeat(64),
    RUNNER_TEMP: '/runner/temp',
    DAST_REPORT_DIR: '/runner/temp/reports',
  };
}

function required(value, code) {
  if (typeof value !== 'string' || value.length === 0) fail(code);
  return value;
}

function match(value, expression, code) {
  const text = required(value, code);
  if (!expression.test(text)) fail(code);
  return text;
}

function exact(actual, expected, code) {
  if (actual !== expected) fail(code);
}

function expectFailure(operation) {
  try {
    operation();
  } catch {
    return;
  }
  fail('PHASE5_DAST_SELF_TEST_DID_NOT_FAIL');
}

function fail(code) {
  throw new Error(code);
}
