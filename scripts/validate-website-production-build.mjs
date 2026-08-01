import { access, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const repositoryRoot = new URL('../', import.meta.url);
const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const publicEnvironmentNames = [
  'NEXT_PUBLIC_WEBSITE_ORIGIN',
  'NEXT_PUBLIC_ERP_API_ORIGIN',
  'NEXT_PUBLIC_MARKETING_CAPTCHA_WIDGET_ORIGIN',
  'NEXT_PUBLIC_MARKETING_CAPTCHA_WIDGET_URL',
];
const validPublicEnvironment = Object.freeze({
  NEXT_PUBLIC_WEBSITE_ORIGIN: 'https://www.example.invalid',
  NEXT_PUBLIC_ERP_API_ORIGIN: 'https://erp.example.invalid',
  NEXT_PUBLIC_MARKETING_CAPTCHA_WIDGET_ORIGIN: 'https://captcha.example.invalid',
  NEXT_PUBLIC_MARKETING_CAPTCHA_WIDGET_URL:
    'https://captcha.example.invalid/widget',
});

const phaseOneWorkflow = await readFile(
  new URL('../.github/workflows/phase-1-ci.yml', import.meta.url),
  'utf8',
);
const buildStepMarker = '      - name: 构建工作区\n';
const buildStepStart = phaseOneWorkflow.indexOf(buildStepMarker);
const nextStepStart = phaseOneWorkflow.indexOf(
  '\n      - name: ',
  buildStepStart + buildStepMarker.length,
);
const buildStep = buildStepStart === -1
  ? ''
  : phaseOneWorkflow.slice(
      buildStepStart,
      nextStepStart === -1 ? undefined : nextStepStart,
    );
if (
  [...buildStep.matchAll(/^ {8}env:\s*$/gmu)].length !== 1 ||
  !buildStep.includes('        run: pnpm build')
) {
  throw new Error('WEBSITE_PHASE1_BUILD_STEP_INVALID');
}
for (const name of publicEnvironmentNames) {
  const declarations = [
    ...buildStep.matchAll(new RegExp(`^\\s{10}${name}:`, 'gmu')),
  ];
  if (declarations.length !== 1) {
    throw new Error('WEBSITE_PHASE1_BUILD_ENV_INVALID');
  }
}

const baseEnvironment = { ...process.env, NODE_ENV: 'production' };
for (const name of publicEnvironmentNames) delete baseEnvironment[name];

/** 执行一次 Website 生产构建并返回可审计结果。 */
const runBuild = (environment) => {
  const result = spawnSync(
    pnpmCommand,
    ['--filter', '@gaoq/website', 'build'],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: { ...baseEnvironment, ...environment },
      maxBuffer: 16 * 1_024 * 1_024,
    },
  );
  if (result.error !== undefined) throw result.error;
  return Object.freeze({
    output: `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
    status: result.status,
  });
};

const missing = runBuild({});
if (
  missing.status === 0 ||
  !missing.output.includes('NEXT_PUBLIC_WEBSITE_ORIGIN_REQUIRED')
) {
  throw new Error('WEBSITE_PRODUCTION_MISSING_ENV_NOT_REJECTED');
}

const localhost = runBuild({
  ...validPublicEnvironment,
  NEXT_PUBLIC_WEBSITE_ORIGIN: 'http://localhost:3002',
});
if (
  localhost.status === 0 ||
  !localhost.output.includes('NEXT_PUBLIC_WEBSITE_ORIGIN_INVALID')
) {
  throw new Error('WEBSITE_PRODUCTION_LOCALHOST_NOT_REJECTED');
}

const valid = runBuild(validPublicEnvironment);
if (valid.status !== 0) {
  process.stderr.write(valid.output);
  throw new Error('WEBSITE_PRODUCTION_VALID_BUILD_FAILED');
}

await Promise.all([
  access(new URL(
    '../apps/website/.next/standalone/apps/website/server.js',
    import.meta.url,
  )),
  access(new URL(
    '../apps/website/.next/standalone/apps/website/package.json',
    import.meta.url,
  )),
]);

process.stdout.write('Website 生产构建失败关闭与 standalone 产物校验通过。\n');
