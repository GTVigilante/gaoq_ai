import { readFile } from 'node:fs/promises';

const workflowPath = new URL('../.github/workflows/phase-5-security.yml', import.meta.url);
const performanceWorkflowPath = new URL('../.github/workflows/phase-5-performance.yml', import.meta.url);
const migrationRehearsalWorkflowPath = new URL(
  '../.github/workflows/phase-5-migration-rehearsal.yml',
  import.meta.url,
);
const resilienceWorkflowPath = new URL('../.github/workflows/phase-5-resilience.yml', import.meta.url);
const readinessWorkflowPath = new URL('../.github/workflows/phase-5-readiness.yml', import.meta.url);
const goNoGoWorkflowPath = new URL('../.github/workflows/phase-5-go-no-go.yml', import.meta.url);
const mcpIntegrationWorkflowPath = new URL('../.github/workflows/phase-5-mcp-integration.yml', import.meta.url);
const packagePath = new URL('../package.json', import.meta.url);
const bearerIgnorePath = new URL('../bearer.ignore', import.meta.url);
const gitleaksConfigPath = new URL('../.gitleaks.toml', import.meta.url);
const workflow = await readFile(workflowPath, 'utf8');
const performanceWorkflow = await readFile(performanceWorkflowPath, 'utf8');
const migrationRehearsalWorkflow = await readFile(migrationRehearsalWorkflowPath, 'utf8');
const resilienceWorkflow = await readFile(resilienceWorkflowPath, 'utf8');
const readinessWorkflow = await readFile(readinessWorkflowPath, 'utf8');
const goNoGoWorkflow = await readFile(goNoGoWorkflowPath, 'utf8');
const mcpIntegrationWorkflow = await readFile(mcpIntegrationWorkflowPath, 'utf8');
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
  'github-actions-contract:',
  'rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_linux_amd64.tar.gz',
  '8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8',
  '"$RUNNER_TEMP/actionlint-bin/actionlint"',
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
  'migration-rehearsal-contract:',
  'node scripts/migration/validate-phase-5-migration-rehearsal-evidence.mjs --self-test',
  'resilience-contract:',
  'node scripts/resilience/validate-phase-5-resilience-evidence.mjs --self-test',
  'readiness-contract:',
  'node scripts/release/validate-phase-5-readiness-evidence.mjs --self-test',
  'go-no-go-contract:',
  'node scripts/release/validate-phase-5-go-no-go-evidence.mjs --self-test',
  'mcp-catalog-contract:',
  'pnpm mcp:catalog:self-test',
  'kubernetes-deployment:',
  'https://get.helm.sh/helm-v4.2.0-linux-amd64.tar.gz',
  '97dbeb971be4ac4b27e3839976d9564c0fb35c6f3b1da89dd1e292d236af4096',
  'node scripts/validate-kubernetes-deployment.mjs',
  'helm" lint deploy/helm/gaoq-erp',
  'helm" template ci deploy/helm/gaoq-erp',
  'yannh/kubeconform/releases/download/v0.7.0/kubeconform-linux-amd64.tar.gz',
  'c31518ddd122663b3f3aa874cfe8178cb0988de944f29c74a0b9260920d115d3',
  '-strict -summary -kubernetes-version 1.30.0',
  '987aa4ee419358d6ae108f54f6c42f4e90f22b70/{{.NormalizedKubernetesVersion}}-standalone-strict/{{.ResourceKind}}.json',
  'node scripts/validate-kubernetes-platform-guardrails.mjs',
  'helm" lint deploy/helm/gaoq-platform-guardrails',
  'helm" template guardrails deploy/helm/gaoq-platform-guardrails',
  '--namespace gaoq-platform-system',
  'gaoq-platform-guardrails-rendered.yaml',
  '平台护栏不得把 release 存入控制命名空间',
  '平台护栏 values schema 必须拒绝未知字段',
]) {
  if (!workflow.includes(marker)) throw new Error('PHASE5_SECURITY_GATE_INCOMPLETE');
}

const performanceActionReferences = [
  ...performanceWorkflow.matchAll(/^\s*uses:\s*([^\s#]+)(?:\s*#.*)?$/gmu),
].map((match) => match[1]);
if (performanceActionReferences.length !== 5 || performanceActionReferences.some(
  (reference) => reference === undefined || !/@[a-f0-9]{40}$/u.test(reference),
)) throw new Error('PHASE5_PERFORMANCE_ACTION_NOT_PINNED');

for (const marker of [
  'workflow_dispatch:', "test \"$GITHUB_REF\" = 'refs/heads/main'",
  'environment: phase-5-performance', '- phase-5-performance',
  'PERFORMANCE_EVIDENCE_RUN_1_PATH: /var/lib/gaoq/performance/run-1.json',
  'PERFORMANCE_EVIDENCE_RUN_2_PATH: /var/lib/gaoq/performance/run-2.json',
  'PERFORMANCE_EVIDENCE_RUN_3_PATH: /var/lib/gaoq/performance/run-3.json',
  'PERFORMANCE_EXPECTED_ENVIRONMENT: ${{ vars.PERFORMANCE_ENVIRONMENT_NAME }}',
  'PERFORMANCE_EXPECTED_REGION: ${{ vars.PERFORMANCE_REGION }}',
  'PERFORMANCE_EXPECTED_COMMIT: ${{ github.sha }}',
  'PERFORMANCE_EXPECTED_API_IMAGE: ${{ vars.PERFORMANCE_API_IMAGE_DIGEST }}',
  'PERFORMANCE_EXPECTED_WORKER_IMAGE: ${{ vars.PERFORMANCE_WORKER_IMAGE_DIGEST }}',
  'PERFORMANCE_EXPECTED_WEB_IMAGE: ${{ vars.PERFORMANCE_WEB_IMAGE_DIGEST }}',
  'PERFORMANCE_EXPECTED_DEPLOYMENT_MANIFEST: ${{ vars.PERFORMANCE_DEPLOYMENT_MANIFEST_SHA256 }}',
  '--enforce-environment', 'phase-5-performance-verdict-${{ github.sha }}',
  'retention-days: 30',
]) {
  if (!performanceWorkflow.includes(marker)) {
    throw new Error('PHASE5_PERFORMANCE_WORKFLOW_INCOMPLETE');
  }
}
for (const forbidden of [
  'pull_request:', 'push:', 'workflow_call:', '${{ inputs.', '${{ secrets.',
]) {
  if (performanceWorkflow.includes(forbidden)) {
    throw new Error('PHASE5_PERFORMANCE_WORKFLOW_UNSAFE');
  }
}

const migrationRehearsalActionReferences = [
  ...migrationRehearsalWorkflow.matchAll(/^\s*uses:\s*([^\s#]+)(?:\s*#.*)?$/gmu),
].map((match) => match[1]);
if (migrationRehearsalActionReferences.length !== 5 ||
  migrationRehearsalActionReferences.some(
    (reference) => reference === undefined || !/@[a-f0-9]{40}$/u.test(reference),
  )) throw new Error('PHASE5_MIGRATION_REHEARSAL_ACTION_NOT_PINNED');
for (const marker of [
  'workflow_dispatch:', "test \"$GITHUB_REF\" = 'refs/heads/main'",
  'environment: phase-5-migration-rehearsal', '- phase-5-migration-rehearsal',
  'MIGRATION_REHEARSAL_EVIDENCE_PATH: /var/lib/gaoq/migration/phase-5-rehearsal.json',
  'MIGRATION_REHEARSAL_EXPECTED_ENVIRONMENT: ${{ vars.MIGRATION_REHEARSAL_ENVIRONMENT_NAME }}',
  'MIGRATION_REHEARSAL_EXPECTED_REGION: ${{ vars.MIGRATION_REHEARSAL_REGION }}',
  'MIGRATION_REHEARSAL_EXPECTED_COMMIT: ${{ github.sha }}',
  'MIGRATION_REHEARSAL_EXPECTED_API_IMAGE: ${{ vars.MIGRATION_REHEARSAL_API_IMAGE_DIGEST }}',
  'MIGRATION_REHEARSAL_EXPECTED_WORKER_IMAGE: ${{ vars.MIGRATION_REHEARSAL_WORKER_IMAGE_DIGEST }}',
  'MIGRATION_REHEARSAL_EXPECTED_WEB_IMAGE: ${{ vars.MIGRATION_REHEARSAL_WEB_IMAGE_DIGEST }}',
  'MIGRATION_REHEARSAL_EXPECTED_DEPLOYMENT_MANIFEST: ${{ vars.MIGRATION_REHEARSAL_DEPLOYMENT_MANIFEST_SHA256 }}',
  'MIGRATION_REHEARSAL_EXPECTED_SOURCE_SNAPSHOT: ${{ vars.MIGRATION_REHEARSAL_SOURCE_SNAPSHOT_SHA256 }}',
  'MIGRATION_REHEARSAL_EXPECTED_PACKAGE_MANIFEST: ${{ vars.MIGRATION_REHEARSAL_PACKAGE_MANIFEST_SHA256 }}',
  '--enforce-environment', 'phase-5-migration-rehearsal-verdict-${{ github.sha }}',
  'retention-days: 30',
]) {
  if (!migrationRehearsalWorkflow.includes(marker)) {
    throw new Error('PHASE5_MIGRATION_REHEARSAL_WORKFLOW_INCOMPLETE');
  }
}
for (const forbidden of [
  'pull_request:', 'push:', 'workflow_call:', '${{ inputs.', '${{ secrets.',
]) {
  if (migrationRehearsalWorkflow.includes(forbidden)) {
    throw new Error('PHASE5_MIGRATION_REHEARSAL_WORKFLOW_UNSAFE');
  }
}

const resilienceActionReferences = [
  ...resilienceWorkflow.matchAll(/^\s*uses:\s*([^\s#]+)(?:\s*#.*)?$/gmu),
].map((match) => match[1]);
if (resilienceActionReferences.length !== 5 || resilienceActionReferences.some(
  (reference) => reference === undefined || !/@[a-f0-9]{40}$/u.test(reference),
)) throw new Error('PHASE5_RESILIENCE_ACTION_NOT_PINNED');

for (const marker of [
  'workflow_dispatch:',
  "test \"$GITHUB_REF\" = 'refs/heads/main'",
  'environment: phase-5-resilience',
  '- phase-5-resilience',
  'RESILIENCE_EVIDENCE_PATH: /var/lib/gaoq/resilience/phase-5-resilience.json',
  'RESILIENCE_EXPECTED_ENVIRONMENT: ${{ vars.RESILIENCE_ENVIRONMENT_NAME }}',
  'RESILIENCE_EXPECTED_REGION: ${{ vars.RESILIENCE_REGION }}',
  'RESILIENCE_EXPECTED_COMMIT: ${{ github.sha }}',
  'RESILIENCE_EXPECTED_API_IMAGE: ${{ vars.RESILIENCE_API_IMAGE_DIGEST }}',
  'RESILIENCE_EXPECTED_WORKER_IMAGE: ${{ vars.RESILIENCE_WORKER_IMAGE_DIGEST }}',
  'RESILIENCE_EXPECTED_WEB_IMAGE: ${{ vars.RESILIENCE_WEB_IMAGE_DIGEST }}',
  'RESILIENCE_EXPECTED_DEPLOYMENT_MANIFEST: ${{ vars.RESILIENCE_DEPLOYMENT_MANIFEST_SHA256 }}',
  '--enforce-environment',
  'phase-5-resilience-verdict-${{ github.sha }}',
  'retention-days: 30',
]) {
  if (!resilienceWorkflow.includes(marker)) throw new Error('PHASE5_RESILIENCE_WORKFLOW_INCOMPLETE');
}
for (const forbidden of [
  'pull_request:', 'push:', 'workflow_call:', '${{ inputs.', '${{ secrets.',
]) {
  if (resilienceWorkflow.includes(forbidden)) {
    throw new Error('PHASE5_RESILIENCE_WORKFLOW_UNSAFE');
  }
}

const readinessActionReferences = [
  ...readinessWorkflow.matchAll(/^\s*uses:\s*([^\s#]+)(?:\s*#.*)?$/gmu),
].map((match) => match[1]);
if (readinessActionReferences.length !== 5 || readinessActionReferences.some(
  (reference) => reference === undefined || !/@[a-f0-9]{40}$/u.test(reference),
)) throw new Error('PHASE5_READINESS_ACTION_NOT_PINNED');
for (const marker of [
  'workflow_dispatch:', "test \"$GITHUB_REF\" = 'refs/heads/main'",
  'environment: phase-5-readiness', '- phase-5-readiness',
  'READINESS_EVIDENCE_PATH: /var/lib/gaoq/readiness/phase-5-readiness.json',
  'READINESS_EXPECTED_ENVIRONMENT: ${{ vars.READINESS_ENVIRONMENT_NAME }}',
  'READINESS_EXPECTED_REGION: ${{ vars.READINESS_REGION }}',
  'READINESS_EXPECTED_COMMIT: ${{ github.sha }}',
  'READINESS_EXPECTED_API_IMAGE: ${{ vars.READINESS_API_IMAGE_DIGEST }}',
  'READINESS_EXPECTED_WORKER_IMAGE: ${{ vars.READINESS_WORKER_IMAGE_DIGEST }}',
  'READINESS_EXPECTED_WEB_IMAGE: ${{ vars.READINESS_WEB_IMAGE_DIGEST }}',
  'READINESS_EXPECTED_DEPLOYMENT_MANIFEST: ${{ vars.READINESS_DEPLOYMENT_MANIFEST_SHA256 }}',
  '--enforce-environment', 'phase-5-readiness-verdicts-${{ github.sha }}',
  'retention-days: 30',
]) {
  if (!readinessWorkflow.includes(marker)) {
    throw new Error('PHASE5_READINESS_WORKFLOW_INCOMPLETE');
  }
}
for (const forbidden of [
  'pull_request:', 'push:', 'workflow_call:', '${{ inputs.', '${{ secrets.',
]) {
  if (readinessWorkflow.includes(forbidden)) {
    throw new Error('PHASE5_READINESS_WORKFLOW_UNSAFE');
  }
}

const goNoGoActionReferences = [
  ...goNoGoWorkflow.matchAll(/^\s*uses:\s*([^\s#]+)(?:\s*#.*)?$/gmu),
].map((match) => match[1]);
if (goNoGoActionReferences.length !== 5 || goNoGoActionReferences.some(
  (reference) => reference === undefined || !/@[a-f0-9]{40}$/u.test(reference),
)) throw new Error('PHASE5_GO_NO_GO_ACTION_NOT_PINNED');

for (const marker of [
  'workflow_dispatch:',
  "test \"$GITHUB_REF\" = 'refs/heads/main'",
  'environment: phase-5-go-no-go',
  '- phase-5-go-no-go',
  'GO_NO_GO_EVIDENCE_PATH: /var/lib/gaoq/go-no-go/phase-5-go-no-go.json',
  'GO_NO_GO_EXPECTED_ENVIRONMENT: ${{ vars.GO_NO_GO_ENVIRONMENT_NAME }}',
  'GO_NO_GO_EXPECTED_REGION: ${{ vars.GO_NO_GO_REGION }}',
  'GO_NO_GO_EXPECTED_COMMIT: ${{ github.sha }}',
  'GO_NO_GO_EXPECTED_API_IMAGE: ${{ vars.GO_NO_GO_API_IMAGE_DIGEST }}',
  'GO_NO_GO_EXPECTED_WORKER_IMAGE: ${{ vars.GO_NO_GO_WORKER_IMAGE_DIGEST }}',
  'GO_NO_GO_EXPECTED_WEB_IMAGE: ${{ vars.GO_NO_GO_WEB_IMAGE_DIGEST }}',
  'GO_NO_GO_EXPECTED_DEPLOYMENT_MANIFEST: ${{ vars.GO_NO_GO_DEPLOYMENT_MANIFEST_SHA256 }}',
  '--enforce-environment',
  'phase-5-go-no-go-verdict-${{ github.sha }}',
  'retention-days: 30',
]) {
  if (!goNoGoWorkflow.includes(marker)) throw new Error('PHASE5_GO_NO_GO_WORKFLOW_INCOMPLETE');
}
for (const forbidden of [
  'pull_request:', 'push:', 'workflow_call:', '${{ inputs.', '${{ secrets.',
]) {
  if (goNoGoWorkflow.includes(forbidden)) throw new Error('PHASE5_GO_NO_GO_WORKFLOW_UNSAFE');
}

const mcpIntegrationActions = [
  ...mcpIntegrationWorkflow.matchAll(/^\s*uses:\s*([^\s#]+)(?:\s*#.*)?$/gmu),
].map((match) => match[1]);
if (mcpIntegrationActions.length !== 7 || mcpIntegrationActions.some(
  (reference) => reference === undefined || !/@[a-f0-9]{40}$/u.test(reference),
)) throw new Error('PHASE5_MCP_INTEGRATION_ACTION_NOT_PINNED');
for (const marker of [
  'workflow_dispatch:', "test \"$GITHUB_REF\" = 'refs/heads/main'",
  'environment: phase-5-mcp-integration', 'phase-5-mcp-integration]',
  'MCP_INTEGRATION_EVIDENCE_PATH: /var/lib/gaoq/mcp/phase-5-mcp-integration.json',
  'MCP_INTEGRATION_EXPECTED_COMMIT: ${{ github.sha }}',
  'MCP_INTEGRATION_EXPECTED_API_IMAGE: ${{ vars.MCP_INTEGRATION_API_IMAGE_DIGEST }}',
  '--enforce-environment "$MCP_INTEGRATION_EVIDENCE_PATH"',
  'phase-5-mcp-integration-verdict-${{ github.sha }}', 'retention-days: 30',
]) {
  if (!mcpIntegrationWorkflow.includes(marker)) {
    throw new Error('PHASE5_MCP_INTEGRATION_WORKFLOW_INCOMPLETE');
  }
}
for (const forbidden of ['pull_request:', 'push:', 'workflow_call:', '${{ inputs.', '${{ secrets.']) {
  if (mcpIntegrationWorkflow.includes(forbidden)) {
    throw new Error('PHASE5_MCP_INTEGRATION_WORKFLOW_UNSAFE');
  }
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
  '"maximumApiP95Milliseconds"',
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
