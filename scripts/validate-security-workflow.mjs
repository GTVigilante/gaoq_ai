import { readFile } from 'node:fs/promises';

const workflowPath = new URL('../.github/workflows/phase-5-security.yml', import.meta.url);
const packagePath = new URL('../package.json', import.meta.url);
const bearerIgnorePath = new URL('../bearer.ignore', import.meta.url);
const gitleaksConfigPath = new URL('../.gitleaks.toml', import.meta.url);
const workflow = await readFile(workflowPath, 'utf8');
const packageDocument = JSON.parse(await readFile(packagePath, 'utf8'));
const bearerIgnore = JSON.parse(await readFile(bearerIgnorePath, 'utf8'));
const gitleaksConfig = await readFile(gitleaksConfigPath, 'utf8');

const actionReferences = [...workflow.matchAll(/^\s*uses:\s*([^\s#]+)(?:\s*#.*)?$/gmu)]
  .map((match) => match[1]);
if (actionReferences.length < 9 || actionReferences.some(
  (reference) => reference === undefined || !/@[a-f0-9]{40}$/u.test(reference),
)) throw new Error('PHASE5_SECURITY_ACTION_NOT_PINNED');

for (const marker of [
  'dependency-review:',
  'sast:',
  'secret-scan:',
  'supply-chain:',
  'pnpm audit --audit-level high',
  'pnpm security:licenses',
  'Bearer/bearer/releases/download/v2.0.2',
  '865c80c5f80aaca1f83e98bca4decb0fd5b5d024e13f8ec48e94d69430d0d23b',
  'gitleaks/gitleaks/releases/download/v8.30.1',
  '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb',
  '--config .gitleaks.toml',
  '--severity critical,high',
  '--fail-on-severity critical,high',
  '--ignore-file bearer.ignore',
  'severity: HIGH,CRITICAL',
  'format: spdx-json',
  'dast-asvs-contract:',
  'OWASP/ASVS/releases/download/v5.0.0_release/OWASP_Application_Security_Verification_Standard_5.0.0_en.csv',
  '6124dba176dc563f66363a11ae0c47f9b86b8a4a84c66a793670bd196ed86cd5',
  'node scripts/security/run-phase-5-dast.mjs --self-test',
  'node scripts/security/validate-phase-5-dast-evidence.mjs --self-test',
]) {
  if (!workflow.includes(marker)) throw new Error('PHASE5_SECURITY_GATE_INCOMPLETE');
}

if (workflow.includes('actions/dependency-review-action@')) {
  throw new Error('PHASE5_SECURITY_GHAS_DEPENDENCY_FORBIDDEN');
}

const expectedBearerFingerprints = [
  '1d546f90f6a5a07e971e29ff4aec6097_0',
  'b951826b6dd26ef7f2d776a337264409_0',
];
const bearerEntries = Object.values(bearerIgnore);
if (JSON.stringify(Object.keys(bearerIgnore).sort()) !==
  JSON.stringify(expectedBearerFingerprints.sort()) ||
  bearerEntries.some((entry) =>
    typeof entry !== 'object' || entry === null || entry.false_positive !== true ||
    typeof entry.comment !== 'string')) {
  throw new Error('PHASE5_SECURITY_BEARER_EXCEPTION_INVALID');
}

const currentUtcDate = new Date().toISOString().slice(0, 10);
for (const entry of bearerEntries) {
  const reviewDeadline = entry.comment.match(/复核到期：(\d{4}-\d{2}-\d{2})/u)?.[1];
  if (reviewDeadline === undefined) {
    throw new Error('PHASE5_SECURITY_BEARER_EXCEPTION_INVALID');
  }
  if (currentUtcDate > reviewDeadline) {
    throw new Error('PHASE5_SECURITY_BEARER_EXCEPTION_EXPIRED');
  }
}

for (const marker of [
  'targetRules = ["generic-api-key"]',
  '"01J8ZQK7V0A2M4N6P8R0T2W4Y7"',
  '"01J8ZQK7V0A2M4N6P8R0T2W4Y8"',
  '"idempotency-key-001"',
]) {
  if (!gitleaksConfig.includes(marker)) throw new Error('PHASE5_SECURITY_GITLEAKS_ALLOWLIST_INVALID');
}
if (/paths\s*=|commits\s*=|disabledRules\s*=/u.test(gitleaksConfig)) {
  throw new Error('PHASE5_SECURITY_GITLEAKS_BROAD_ALLOWLIST_FORBIDDEN');
}

const sharpOverride = packageDocument?.pnpm?.overrides?.sharp;
if (typeof sharpOverride !== 'string' || sharpOverride !== '0.35.3') {
  throw new Error('PHASE5_SECURITY_SHARP_OVERRIDE_REQUIRED');
}

process.stdout.write('Phase 5 安全工作流固定版本与强制门禁校验通过。\n');
