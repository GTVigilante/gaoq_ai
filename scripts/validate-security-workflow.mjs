import { readFile } from 'node:fs/promises';

const workflowPath = new URL('../.github/workflows/phase-5-security.yml', import.meta.url);
const performanceWorkflowPath = new URL('../.github/workflows/phase-5-performance.yml', import.meta.url);
const dastEvidenceWorkflowPath = new URL(
  '../.github/workflows/phase-5-dast-evidence.yml',
  import.meta.url,
);
const migrationRehearsalWorkflowPath = new URL(
  '../.github/workflows/phase-5-migration-rehearsal.yml',
  import.meta.url,
);
const resilienceWorkflowPath = new URL('../.github/workflows/phase-5-resilience.yml', import.meta.url);
const readinessWorkflowPath = new URL('../.github/workflows/phase-5-readiness.yml', import.meta.url);
const goNoGoWorkflowPath = new URL('../.github/workflows/phase-5-go-no-go.yml', import.meta.url);
const mcpIntegrationWorkflowPath = new URL('../.github/workflows/phase-5-mcp-integration.yml', import.meta.url);
const kubernetesRuntimeSmokePath = new URL(
  '../scripts/kubernetes-runtime-smoke.mjs',
  import.meta.url,
);
const packagePath = new URL('../package.json', import.meta.url);
const webPackagePath = new URL('../apps/erp-web/package.json', import.meta.url);
const pnpmLockPath = new URL('../pnpm-lock.yaml', import.meta.url);
const vitestWorkspacePackagePaths = [
  '../apps/erp-api/package.json',
  '../apps/erp-web/package.json',
  '../apps/website/package.json',
  '../packages/platform-contracts/package.json',
  '../packages/shared-types/package.json',
  '../packages/shared-utils/package.json',
].map((relativePath) => new URL(relativePath, import.meta.url));
const bearerIgnorePath = new URL('../bearer.ignore', import.meta.url);
const gitleaksConfigPath = new URL('../.gitleaks.toml', import.meta.url);
const workflow = await readFile(workflowPath, 'utf8');
const performanceWorkflow = await readFile(performanceWorkflowPath, 'utf8');
const dastEvidenceWorkflow = await readFile(dastEvidenceWorkflowPath, 'utf8');
const migrationRehearsalWorkflow = await readFile(migrationRehearsalWorkflowPath, 'utf8');
const resilienceWorkflow = await readFile(resilienceWorkflowPath, 'utf8');
const readinessWorkflow = await readFile(readinessWorkflowPath, 'utf8');
const goNoGoWorkflow = await readFile(goNoGoWorkflowPath, 'utf8');
const mcpIntegrationWorkflow = await readFile(mcpIntegrationWorkflowPath, 'utf8');
const kubernetesRuntimeSmoke = await readFile(kubernetesRuntimeSmokePath, 'utf8');
const packageDocument = JSON.parse(await readFile(packagePath, 'utf8'));
const webPackageDocument = JSON.parse(await readFile(webPackagePath, 'utf8'));
const pnpmLock = await readFile(pnpmLockPath, 'utf8');
const vitestWorkspacePackageDocuments = await Promise.all(
  vitestWorkspacePackagePaths.map(async (workspacePackagePath) =>
    JSON.parse(await readFile(workspacePackagePath, 'utf8'))),
);
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
  '"$RUNNER_TEMP/bearer" scan .',
  'gitleaks/gitleaks/releases/download/v8.30.1',
  '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb',
  '"$RUNNER_TEMP/gitleaks" git',
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
  'node scripts/resilience/validate-phase-5-resilience-evidence.mjs --print-contract > /dev/null',
  'readiness-contract:',
  'node scripts/release/validate-phase-5-readiness-evidence.mjs --self-test',
  'go-no-go-contract:',
  'node scripts/release/validate-phase-5-go-no-go-evidence.mjs --self-test',
  'node scripts/release/validate-phase-5-go-no-go-evidence.mjs --print-contract > /dev/null',
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
  'kubernetes-runtime:',
  'Kubernetes 真实运行时集成',
  'kubernetes-sigs/kind/releases/download/v0.26.0/kind-linux-amd64',
  'd445b44c28297bc23fd67e51cc24bb294ae7b977712be2d4d312883d0835829b',
  'https://dl.k8s.io/release/v1.30.12/bin/linux/amd64/kubectl',
  '261a3c4eb12e09207b9e08f0b43d547220569317ed8d7a22638572100ace5b80',
  'GAOQ_KIND_NODE_IMAGE: kindest/node:v1.30.8@sha256:',
  'GAOQ_KIND_REGISTRY_IMAGE: registry:2.8.3@sha256:',
  'GAOQ_KIND_MONGO_IMAGE: mongo:7.0@sha256:',
  'GAOQ_KIND_REDIS_IMAGE: redis:7.2-alpine@sha256:',
  'run: pnpm smoke:kubernetes:live',
  '兜底清理临时 Kubernetes 与 Registry',
]) {
  if (!workflow.includes(marker)) throw new Error('PHASE5_SECURITY_GATE_INCOMPLETE');
}

if (packageDocument.scripts?.['smoke:kubernetes:live'] !==
  'node scripts/kubernetes-runtime-smoke.mjs') {
  throw new Error('PHASE5_KUBERNETES_RUNTIME_COMMAND_INCOMPLETE');
}
if (packageDocument.devDependencies?.['@modelcontextprotocol/sdk'] !== '^1.29.0') {
  throw new Error('PHASE5_KUBERNETES_RUNTIME_MCP_SDK_MISSING');
}

for (const marker of [
  'assertTargetsAbsent()',
  '/@sha256:[a-f0-9]{64}$/u',
  'publishDependencyImages()',
  'localhost:${registryPort}/gaoq-dependencies/${name}',
  "imagePullPolicy: 'IfNotPresent'",
  'automountServiceAccountToken: false',
  'container.securityContext.readOnlyRootFilesystem',
  'container.securityContext.allowPrivilegeEscalation',
  'status.restartCount, 0',
  'expectedCatalog.tools',
  'expectedCatalog.resources',
  'expectedCatalog.resourceTemplates',
  'expectedCatalog.prompts',
  'treasury_disbursement_submit',
  'payroll_period_lock',
  "'logs', '--namespace', namespace, pod.metadata.name",
  "'--tail=100'",
  "POD_LOG:${pod.metadata.name}",
  '{ mode: 0o600 }',
  "kind, ['delete', 'cluster', '--name', clusterName]",
  "docker, ['rm', '--force', registryName]",
]) {
  if (!kubernetesRuntimeSmoke.includes(marker)) {
    throw new Error('PHASE5_KUBERNETES_RUNTIME_GATE_INCOMPLETE');
  }
}

const performanceActionReferences = [
  ...performanceWorkflow.matchAll(/^\s*uses:\s*([^\s#]+)(?:\s*#.*)?$/gmu),
].map((match) => match[1]);
if (performanceActionReferences.length !== 5 || performanceActionReferences.some(
  (reference) => reference === undefined || !/@[a-f0-9]{40}$/u.test(reference),
)) throw new Error('PHASE5_PERFORMANCE_ACTION_NOT_PINNED');

for (const marker of [
  'workflow_dispatch:', "test \"$GITHUB_REF\" = 'refs/heads/main'",
  'runs-on: ubuntu-latest', 'id-token: write',
  'GAOQ_OIDC_POLICY: phase-5-performance', '--policy "$GAOQ_OIDC_POLICY"',
  'PERFORMANCE_EVIDENCE_OIDC_AUDIENCE: ${{ vars.PERFORMANCE_EVIDENCE_OIDC_AUDIENCE }}',
  'PERFORMANCE_EVIDENCE_RUN_1_URL: ${{ vars.PERFORMANCE_EVIDENCE_RUN_1_URL }}',
  'PERFORMANCE_EVIDENCE_RUN_1_SHA256: ${{ vars.PERFORMANCE_EVIDENCE_RUN_1_SHA256 }}',
  '$RUNNER_TEMP/phase-5-performance-run-1.json',
  'PERFORMANCE_EVIDENCE_RUN_2_URL: ${{ vars.PERFORMANCE_EVIDENCE_RUN_2_URL }}',
  'PERFORMANCE_EVIDENCE_RUN_2_SHA256: ${{ vars.PERFORMANCE_EVIDENCE_RUN_2_SHA256 }}',
  '$RUNNER_TEMP/phase-5-performance-run-2.json',
  'PERFORMANCE_EVIDENCE_RUN_3_URL: ${{ vars.PERFORMANCE_EVIDENCE_RUN_3_URL }}',
  'PERFORMANCE_EVIDENCE_RUN_3_SHA256: ${{ vars.PERFORMANCE_EVIDENCE_RUN_3_SHA256 }}',
  '$RUNNER_TEMP/phase-5-performance-run-3.json',
  'scripts/github/fetch-oidc-protected-input.mjs',
  'PERFORMANCE_EXPECTED_ENVIRONMENT: ${{ vars.PERFORMANCE_ENVIRONMENT_NAME }}',
  'PERFORMANCE_EXPECTED_REGION: ${{ vars.PERFORMANCE_REGION }}',
  'PERFORMANCE_EXPECTED_COMMIT: ${{ github.sha }}',
  'PERFORMANCE_EXPECTED_API_IMAGE: ${{ vars.PERFORMANCE_API_IMAGE_DIGEST }}',
  'PERFORMANCE_EXPECTED_WORKER_IMAGE: ${{ vars.PERFORMANCE_WORKER_IMAGE_DIGEST }}',
  'PERFORMANCE_EXPECTED_WEB_IMAGE: ${{ vars.PERFORMANCE_WEB_IMAGE_DIGEST }}',
  'PERFORMANCE_EXPECTED_WEBSITE_IMAGE: ${{ vars.PERFORMANCE_WEBSITE_IMAGE_DIGEST }}',
  'PERFORMANCE_EXPECTED_DEPLOYMENT_MANIFEST: ${{ vars.PERFORMANCE_DEPLOYMENT_MANIFEST_SHA256 }}',
  'PERFORMANCE_EXPECTED_SIGNER_KEYSET_SHA256: ${{ vars.PERFORMANCE_SIGNER_KEYSET_SHA256 }}',
  '--enforce-environment', 'phase-5-performance-verdict-${{ github.sha }}',
  'retention-days: 30',
]) {
  if (!performanceWorkflow.includes(marker)) {
    throw new Error('PHASE5_PERFORMANCE_WORKFLOW_INCOMPLETE');
  }
}
for (const forbidden of [
  'pull_request:', 'push:', 'workflow_call:', '${{ inputs.', '${{ secrets.',
  'self-hosted', '/var/lib/gaoq', 'environment:',
]) {
  if (performanceWorkflow.includes(forbidden)) {
    throw new Error('PHASE5_PERFORMANCE_WORKFLOW_UNSAFE');
  }
}
if ((performanceWorkflow.match(/runs-on: ubuntu-latest/gu) ?? []).length !== 2) {
  throw new Error('PHASE5_PERFORMANCE_HOSTED_RUNNER_INVALID');
}

const dastEvidenceActionReferences = [
  ...dastEvidenceWorkflow.matchAll(/^\s*uses:\s*([^\s#]+)(?:\s*#.*)?$/gmu),
].map((match) => match[1]);
if (
  dastEvidenceActionReferences.length !== 5 ||
  dastEvidenceActionReferences.some(
    (reference) => reference === undefined || !/@[a-f0-9]{40}$/u.test(reference),
  )
) throw new Error('PHASE5_DAST_EVIDENCE_ACTION_NOT_PINNED');
for (const marker of [
  'workflow_dispatch:', "test \"$GITHUB_REF\" = 'refs/heads/main'",
  'runs-on: ubuntu-latest', 'id-token: write',
  'GAOQ_OIDC_POLICY: phase-5-dast-evidence', '--policy "$GAOQ_OIDC_POLICY"',
  'DAST_EVIDENCE_OIDC_AUDIENCE: ${{ vars.DAST_EVIDENCE_OIDC_AUDIENCE }}',
  'DAST_EVIDENCE_URL: ${{ vars.DAST_EVIDENCE_URL }}',
  'DAST_EVIDENCE_SHA256: ${{ vars.DAST_EVIDENCE_SHA256 }}',
  '$RUNNER_TEMP/phase-5-dast-asvs.json',
  'scripts/github/fetch-oidc-protected-input.mjs',
  'DAST_EXPECTED_ENVIRONMENT: ${{ vars.DAST_ENVIRONMENT_NAME }}',
  'DAST_EXPECTED_REGION: ${{ vars.DAST_REGION }}',
  'DAST_EXPECTED_TARGET_ORIGIN_SHA256: ${{ vars.DAST_TARGET_ORIGIN_SHA256 }}',
  'DAST_EXPECTED_COMMIT: ${{ github.sha }}',
  'DAST_EXPECTED_API_IMAGE: ${{ vars.DAST_API_IMAGE_DIGEST }}',
  'DAST_EXPECTED_WORKER_IMAGE: ${{ vars.DAST_WORKER_IMAGE_DIGEST }}',
  'DAST_EXPECTED_WEB_IMAGE: ${{ vars.DAST_WEB_IMAGE_DIGEST }}',
  'DAST_EXPECTED_WEBSITE_IMAGE: ${{ vars.DAST_WEBSITE_IMAGE_DIGEST }}',
  'DAST_EXPECTED_SIGNER_KEYSET_SHA256: ${{ vars.DAST_SIGNER_KEYSET_SHA256 }}',
  '--enforce-environment', 'phase-5-dast-asvs-verdict-${{ github.sha }}',
  'retention-days: 30',
]) {
  if (!dastEvidenceWorkflow.includes(marker)) {
    throw new Error('PHASE5_DAST_EVIDENCE_WORKFLOW_INCOMPLETE');
  }
}
for (const forbidden of [
  'pull_request:', 'push:', 'workflow_call:', '${{ inputs.', '${{ secrets.',
  'self-hosted', '/var/lib/gaoq', 'environment:',
]) {
  if (dastEvidenceWorkflow.includes(forbidden)) {
    throw new Error('PHASE5_DAST_EVIDENCE_WORKFLOW_UNSAFE');
  }
}
if ((dastEvidenceWorkflow.match(/runs-on: ubuntu-latest/gu) ?? []).length !== 2) {
  throw new Error('PHASE5_DAST_EVIDENCE_HOSTED_RUNNER_INVALID');
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
  'runs-on: ubuntu-latest', 'id-token: write',
  'GAOQ_OIDC_POLICY: phase-5-migration-rehearsal', '--policy "$GAOQ_OIDC_POLICY"',
  'MIGRATION_REHEARSAL_EVIDENCE_OIDC_AUDIENCE: ${{ vars.MIGRATION_REHEARSAL_EVIDENCE_OIDC_AUDIENCE }}',
  'MIGRATION_REHEARSAL_EVIDENCE_URL: ${{ vars.MIGRATION_REHEARSAL_EVIDENCE_URL }}',
  'MIGRATION_REHEARSAL_EVIDENCE_SHA256: ${{ vars.MIGRATION_REHEARSAL_EVIDENCE_SHA256 }}',
  '$RUNNER_TEMP/phase-5-migration-rehearsal.json',
  'scripts/github/fetch-oidc-protected-input.mjs',
  'MIGRATION_REHEARSAL_EXPECTED_ENVIRONMENT: ${{ vars.MIGRATION_REHEARSAL_ENVIRONMENT_NAME }}',
  'MIGRATION_REHEARSAL_EXPECTED_REGION: ${{ vars.MIGRATION_REHEARSAL_REGION }}',
  'MIGRATION_REHEARSAL_EXPECTED_COMMIT: ${{ github.sha }}',
  'MIGRATION_REHEARSAL_EXPECTED_API_IMAGE: ${{ vars.MIGRATION_REHEARSAL_API_IMAGE_DIGEST }}',
  'MIGRATION_REHEARSAL_EXPECTED_WORKER_IMAGE: ${{ vars.MIGRATION_REHEARSAL_WORKER_IMAGE_DIGEST }}',
  'MIGRATION_REHEARSAL_EXPECTED_WEB_IMAGE: ${{ vars.MIGRATION_REHEARSAL_WEB_IMAGE_DIGEST }}',
  'MIGRATION_REHEARSAL_EXPECTED_WEBSITE_IMAGE: ${{ vars.MIGRATION_REHEARSAL_WEBSITE_IMAGE_DIGEST }}',
  'MIGRATION_REHEARSAL_EXPECTED_DEPLOYMENT_MANIFEST: ${{ vars.MIGRATION_REHEARSAL_DEPLOYMENT_MANIFEST_SHA256 }}',
  'MIGRATION_REHEARSAL_EXPECTED_SOURCE_SNAPSHOT: ${{ vars.MIGRATION_REHEARSAL_SOURCE_SNAPSHOT_SHA256 }}',
  'MIGRATION_REHEARSAL_EXPECTED_PACKAGE_MANIFEST: ${{ vars.MIGRATION_REHEARSAL_PACKAGE_MANIFEST_SHA256 }}',
  'MIGRATION_REHEARSAL_EXPECTED_SIGNER_KEYSET_SHA256: ${{ vars.MIGRATION_REHEARSAL_SIGNER_KEYSET_SHA256 }}',
  '--enforce-environment', 'phase-5-migration-rehearsal-verdict-${{ github.sha }}',
  'retention-days: 30',
]) {
  if (!migrationRehearsalWorkflow.includes(marker)) {
    throw new Error('PHASE5_MIGRATION_REHEARSAL_WORKFLOW_INCOMPLETE');
  }
}
for (const forbidden of [
  'pull_request:', 'push:', 'workflow_call:', '${{ inputs.', '${{ secrets.',
  'self-hosted', '/var/lib/gaoq', 'environment:',
]) {
  if (migrationRehearsalWorkflow.includes(forbidden)) {
    throw new Error('PHASE5_MIGRATION_REHEARSAL_WORKFLOW_UNSAFE');
  }
}
if ((migrationRehearsalWorkflow.match(/runs-on: ubuntu-latest/gu) ?? []).length !== 2) {
  throw new Error('PHASE5_MIGRATION_REHEARSAL_HOSTED_RUNNER_INVALID');
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
  'runs-on: ubuntu-latest',
  'id-token: write',
  'GAOQ_OIDC_POLICY: phase-5-resilience',
  '--policy "$GAOQ_OIDC_POLICY"',
  'RESILIENCE_EVIDENCE_OIDC_AUDIENCE: ${{ vars.RESILIENCE_EVIDENCE_OIDC_AUDIENCE }}',
  'RESILIENCE_EVIDENCE_URL: ${{ vars.RESILIENCE_EVIDENCE_URL }}',
  'RESILIENCE_EVIDENCE_SHA256: ${{ vars.RESILIENCE_EVIDENCE_SHA256 }}',
  '$RUNNER_TEMP/phase-5-resilience.json',
  'scripts/github/fetch-oidc-protected-input.mjs',
  'RESILIENCE_EXPECTED_ENVIRONMENT: ${{ vars.RESILIENCE_ENVIRONMENT_NAME }}',
  'RESILIENCE_EXPECTED_REGION: ${{ vars.RESILIENCE_REGION }}',
  'RESILIENCE_EXPECTED_COMMIT: ${{ github.sha }}',
  'RESILIENCE_EXPECTED_API_IMAGE: ${{ vars.RESILIENCE_API_IMAGE_DIGEST }}',
  'RESILIENCE_EXPECTED_WORKER_IMAGE: ${{ vars.RESILIENCE_WORKER_IMAGE_DIGEST }}',
  'RESILIENCE_EXPECTED_WEB_IMAGE: ${{ vars.RESILIENCE_WEB_IMAGE_DIGEST }}',
  'RESILIENCE_EXPECTED_WEBSITE_IMAGE: ${{ vars.RESILIENCE_WEBSITE_IMAGE_DIGEST }}',
  'RESILIENCE_EXPECTED_PAYROLL_IMAGE: ${{ vars.RESILIENCE_PAYROLL_IMAGE_DIGEST }}',
  'RESILIENCE_EXPECTED_PAYROLL_RESOURCE: ${{ vars.RESILIENCE_PAYROLL_RESOURCE }}',
  'RESILIENCE_EXPECTED_PAYROLL_AUTHORIZATION_SERVER: ${{ vars.RESILIENCE_PAYROLL_AUTHORIZATION_SERVER }}',
  'RESILIENCE_EXPECTED_PAYROLL_CONTRACT_HASH: ${{ vars.RESILIENCE_PAYROLL_CONTRACT_HASH }}',
  'RESILIENCE_EXPECTED_PAYROLL_CATALOG_HASH: ${{ vars.RESILIENCE_PAYROLL_CATALOG_HASH }}',
  'RESILIENCE_EXPECTED_DEPLOYMENT_MANIFEST: ${{ vars.RESILIENCE_DEPLOYMENT_MANIFEST_SHA256 }}',
  'RESILIENCE_EXPECTED_SIGNER_KEYSET_SHA256: ${{ vars.RESILIENCE_SIGNER_KEYSET_SHA256 }}',
  'node scripts/resilience/validate-phase-5-resilience-evidence.mjs --print-contract > /dev/null',
  '--enforce-environment',
  'phase-5-resilience-verdict-${{ github.sha }}',
  'retention-days: 30',
]) {
  if (!resilienceWorkflow.includes(marker)) throw new Error('PHASE5_RESILIENCE_WORKFLOW_INCOMPLETE');
}
for (const forbidden of [
  'pull_request:', 'push:', 'workflow_call:', '${{ inputs.', '${{ secrets.',
  'self-hosted', '/var/lib/gaoq', 'environment:',
]) {
  if (resilienceWorkflow.includes(forbidden)) {
    throw new Error('PHASE5_RESILIENCE_WORKFLOW_UNSAFE');
  }
}
if ((resilienceWorkflow.match(/runs-on: ubuntu-latest/gu) ?? []).length !== 2) {
  throw new Error('PHASE5_RESILIENCE_HOSTED_RUNNER_INVALID');
}

const readinessActionReferences = [
  ...readinessWorkflow.matchAll(/^\s*uses:\s*([^\s#]+)(?:\s*#.*)?$/gmu),
].map((match) => match[1]);
if (readinessActionReferences.length !== 5 || readinessActionReferences.some(
  (reference) => reference === undefined || !/@[a-f0-9]{40}$/u.test(reference),
)) throw new Error('PHASE5_READINESS_ACTION_NOT_PINNED');
for (const marker of [
  'workflow_dispatch:', "test \"$GITHUB_REF\" = 'refs/heads/main'",
  'runs-on: ubuntu-latest', 'id-token: write',
  'GAOQ_OIDC_POLICY: phase-5-readiness', '--policy "$GAOQ_OIDC_POLICY"',
  'READINESS_EVIDENCE_OIDC_AUDIENCE: ${{ vars.READINESS_EVIDENCE_OIDC_AUDIENCE }}',
  'READINESS_EVIDENCE_URL: ${{ vars.READINESS_EVIDENCE_URL }}',
  'READINESS_EVIDENCE_SHA256: ${{ vars.READINESS_EVIDENCE_SHA256 }}',
  '$RUNNER_TEMP/phase-5-readiness.json',
  'scripts/github/fetch-oidc-protected-input.mjs',
  'READINESS_EXPECTED_ENVIRONMENT: ${{ vars.READINESS_ENVIRONMENT_NAME }}',
  'READINESS_EXPECTED_REGION: ${{ vars.READINESS_REGION }}',
  'READINESS_EXPECTED_COMMIT: ${{ github.sha }}',
  'READINESS_EXPECTED_API_IMAGE: ${{ vars.READINESS_API_IMAGE_DIGEST }}',
  'READINESS_EXPECTED_WORKER_IMAGE: ${{ vars.READINESS_WORKER_IMAGE_DIGEST }}',
  'READINESS_EXPECTED_WEB_IMAGE: ${{ vars.READINESS_WEB_IMAGE_DIGEST }}',
  'READINESS_EXPECTED_WEBSITE_IMAGE: ${{ vars.READINESS_WEBSITE_IMAGE_DIGEST }}',
  'READINESS_EXPECTED_DEPLOYMENT_MANIFEST: ${{ vars.READINESS_DEPLOYMENT_MANIFEST_SHA256 }}',
  'READINESS_EXPECTED_SIGNER_KEYSET_SHA256: ${{ vars.READINESS_SIGNER_KEYSET_SHA256 }}',
  '--enforce-environment', 'phase-5-readiness-verdicts-${{ github.sha }}',
  'retention-days: 30',
]) {
  if (!readinessWorkflow.includes(marker)) {
    throw new Error('PHASE5_READINESS_WORKFLOW_INCOMPLETE');
  }
}
for (const forbidden of [
  'pull_request:', 'push:', 'workflow_call:', '${{ inputs.', '${{ secrets.',
  'self-hosted', '/var/lib/gaoq', 'environment:',
]) {
  if (readinessWorkflow.includes(forbidden)) {
    throw new Error('PHASE5_READINESS_WORKFLOW_UNSAFE');
  }
}
if ((readinessWorkflow.match(/runs-on: ubuntu-latest/gu) ?? []).length !== 2) {
  throw new Error('PHASE5_READINESS_HOSTED_RUNNER_INVALID');
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
  'runs-on: ubuntu-latest',
  'id-token: write',
  'GAOQ_OIDC_POLICY: phase-5-go-no-go',
  '--policy "$GAOQ_OIDC_POLICY"',
  'GO_NO_GO_EVIDENCE_OIDC_AUDIENCE: ${{ vars.GO_NO_GO_EVIDENCE_OIDC_AUDIENCE }}',
  'GO_NO_GO_EVIDENCE_URL: ${{ vars.GO_NO_GO_EVIDENCE_URL }}',
  'GO_NO_GO_EVIDENCE_SHA256: ${{ vars.GO_NO_GO_EVIDENCE_SHA256 }}',
  '$RUNNER_TEMP/phase-5-go-no-go.json',
  'scripts/github/fetch-oidc-protected-input.mjs',
  'GO_NO_GO_EXPECTED_ENVIRONMENT: ${{ vars.GO_NO_GO_ENVIRONMENT_NAME }}',
  'GO_NO_GO_EXPECTED_REGION: ${{ vars.GO_NO_GO_REGION }}',
  'GO_NO_GO_EXPECTED_COMMIT: ${{ github.sha }}',
  'GO_NO_GO_EXPECTED_API_IMAGE: ${{ vars.GO_NO_GO_API_IMAGE_DIGEST }}',
  'GO_NO_GO_EXPECTED_WORKER_IMAGE: ${{ vars.GO_NO_GO_WORKER_IMAGE_DIGEST }}',
  'GO_NO_GO_EXPECTED_WEB_IMAGE: ${{ vars.GO_NO_GO_WEB_IMAGE_DIGEST }}',
  'GO_NO_GO_EXPECTED_WEBSITE_IMAGE: ${{ vars.GO_NO_GO_WEBSITE_IMAGE_DIGEST }}',
  'GO_NO_GO_EXPECTED_DEPLOYMENT_MANIFEST: ${{ vars.GO_NO_GO_DEPLOYMENT_MANIFEST_SHA256 }}',
  'GO_NO_GO_EXPECTED_PAYROLL_RESOURCE: ${{ vars.GO_NO_GO_PAYROLL_RESOURCE }}',
  'GO_NO_GO_EXPECTED_PAYROLL_AUTHORIZATION_SERVER: ${{ vars.GO_NO_GO_PAYROLL_AUTHORIZATION_SERVER }}',
  'GO_NO_GO_EXPECTED_PAYROLL_IMAGE: ${{ vars.GO_NO_GO_PAYROLL_IMAGE_DIGEST }}',
  'GO_NO_GO_EXPECTED_PAYROLL_CONTRACT_HASH: ${{ vars.GO_NO_GO_PAYROLL_CONTRACT_HASH }}',
  'GO_NO_GO_EXPECTED_PAYROLL_CATALOG_HASH: ${{ vars.GO_NO_GO_PAYROLL_CATALOG_HASH }}',
  'GO_NO_GO_EXPECTED_SIGNER_KEYSET: ${{ vars.GO_NO_GO_SIGNER_KEYSET_SHA256 }}',
  'node scripts/release/validate-phase-5-go-no-go-evidence.mjs --print-contract > /dev/null',
  '--enforce-environment',
  'phase-5-go-no-go-verdict-${{ github.sha }}',
  'retention-days: 30',
]) {
  if (!goNoGoWorkflow.includes(marker)) throw new Error('PHASE5_GO_NO_GO_WORKFLOW_INCOMPLETE');
}
for (const forbidden of [
  'pull_request:', 'push:', 'workflow_call:', '${{ inputs.', '${{ secrets.',
  'self-hosted', '/var/lib/gaoq', 'environment:',
]) {
  if (goNoGoWorkflow.includes(forbidden)) throw new Error('PHASE5_GO_NO_GO_WORKFLOW_UNSAFE');
}
if ((goNoGoWorkflow.match(/runs-on: ubuntu-latest/gu) ?? []).length !== 2) {
  throw new Error('PHASE5_GO_NO_GO_HOSTED_RUNNER_INVALID');
}

const mcpIntegrationActions = [
  ...mcpIntegrationWorkflow.matchAll(/^\s*uses:\s*([^\s#]+)(?:\s*#.*)?$/gmu),
].map((match) => match[1]);
if (mcpIntegrationActions.length !== 7 || mcpIntegrationActions.some(
  (reference) => reference === undefined || !/@[a-f0-9]{40}$/u.test(reference),
)) throw new Error('PHASE5_MCP_INTEGRATION_ACTION_NOT_PINNED');
for (const marker of [
  'workflow_dispatch:', "test \"$GITHUB_REF\" = 'refs/heads/main'",
  'runs-on: ubuntu-latest', 'id-token: write',
  'GAOQ_OIDC_POLICY: phase-5-mcp-integration', '--policy "$GAOQ_OIDC_POLICY"',
  'MCP_INTEGRATION_EVIDENCE_OIDC_AUDIENCE: ${{ vars.MCP_INTEGRATION_EVIDENCE_OIDC_AUDIENCE }}',
  'MCP_INTEGRATION_EVIDENCE_URL: ${{ vars.MCP_INTEGRATION_EVIDENCE_URL }}',
  'MCP_INTEGRATION_EVIDENCE_SHA256: ${{ vars.MCP_INTEGRATION_EVIDENCE_SHA256 }}',
  '$RUNNER_TEMP/phase-5-mcp-integration.json',
  'scripts/github/fetch-oidc-protected-input.mjs',
  'MCP_INTEGRATION_EXPECTED_COMMIT: ${{ github.sha }}',
  'MCP_INTEGRATION_EXPECTED_API_IMAGE: ${{ vars.MCP_INTEGRATION_API_IMAGE_DIGEST }}',
  'MCP_INTEGRATION_EXPECTED_WORKER_IMAGE: ${{ vars.MCP_INTEGRATION_WORKER_IMAGE_DIGEST }}',
  'MCP_INTEGRATION_EXPECTED_WEB_IMAGE: ${{ vars.MCP_INTEGRATION_WEB_IMAGE_DIGEST }}',
  'MCP_INTEGRATION_EXPECTED_WEBSITE_IMAGE: ${{ vars.MCP_INTEGRATION_WEBSITE_IMAGE_DIGEST }}',
  'MCP_INTEGRATION_EXPECTED_PAYROLL_RESOURCE: ${{ vars.MCP_INTEGRATION_PAYROLL_RESOURCE }}',
  'MCP_INTEGRATION_EXPECTED_PAYROLL_AUTHORIZATION_SERVER: ${{ vars.MCP_INTEGRATION_PAYROLL_AUTHORIZATION_SERVER }}',
  'MCP_INTEGRATION_EXPECTED_PAYROLL_IMAGE: ${{ vars.MCP_INTEGRATION_PAYROLL_IMAGE_DIGEST }}',
  'MCP_INTEGRATION_EXPECTED_PAYROLL_CONTRACT_HASH: ${{ vars.MCP_INTEGRATION_PAYROLL_CONTRACT_HASH }}',
  'MCP_INTEGRATION_EXPECTED_PAYROLL_CATALOG_HASH: ${{ vars.MCP_INTEGRATION_PAYROLL_CATALOG_HASH }}',
  'MCP_INTEGRATION_EXPECTED_SIGNER_KEYSET_SHA256: ${{ vars.MCP_INTEGRATION_SIGNER_KEYSET_SHA256 }}',
  '--enforce-environment "$MCP_INTEGRATION_EVIDENCE_PATH"',
  'phase-5-mcp-integration-verdict-${{ github.sha }}', 'retention-days: 30',
]) {
  if (!mcpIntegrationWorkflow.includes(marker)) {
    throw new Error('PHASE5_MCP_INTEGRATION_WORKFLOW_INCOMPLETE');
  }
}
for (const forbidden of [
  'pull_request:', 'push:', 'workflow_call:', '${{ inputs.', '${{ secrets.',
  'self-hosted', '/var/lib/gaoq', 'environment:',
]) {
  if (mcpIntegrationWorkflow.includes(forbidden)) {
    throw new Error('PHASE5_MCP_INTEGRATION_WORKFLOW_UNSAFE');
  }
}
if ((mcpIntegrationWorkflow.match(/runs-on: ubuntu-latest/gu) ?? []).length !== 2) {
  throw new Error('PHASE5_MCP_INTEGRATION_HOSTED_RUNNER_INVALID');
}

if (workflow.includes('actions/dependency-review-action@')) {
  throw new Error('PHASE5_SECURITY_GHAS_DEPENDENCY_FORBIDDEN');
}

const expectedBearerFingerprints = [
  '1d546f90f6a5a07e971e29ff4aec6097_0',
  'b951826b6dd26ef7f2d776a337264409_0',
  'ec33c579b4fa5753a2cfe6ac4bb73ffb_0',
  'ec33c579b4fa5753a2cfe6ac4bb73ffb_1',
  '74ab5f22a836139b1aae3d64bb80ab50_0',
  '15469c792b2494f8acdfe491364006da_0',
  'ec33c579b4fa5753a2cfe6ac4bb73ffb_2',
  'ec33c579b4fa5753a2cfe6ac4bb73ffb_3',
  'b2c9a5f32bb09d448cbf32d5ae037ae8_0',
  '0e856c0e70c5e93097a67a73bb5c9841_0',
  '63a53819fc7bee2c39f18ac6a4c3abc7_0',
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
  '"01J8ZQK7V0A2M4N6P8R0T2W4H1"',
  '"01J8ZQK7V0A2M4N6P8R0T2W4E1"',
  '"approval-withdraw-001"',
  '"edge-verification-secret-at-least-32-characters"',
  '"marketing-key-001"',
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

if (webPackageDocument.dependencies?.next !== '16.2.12') {
  throw new Error('PHASE5_SECURITY_NEXT_PATCH_REQUIRED');
}
if (
  packageDocument.devDependencies?.vite !== '7.3.6' ||
  vitestWorkspacePackageDocuments.some(
    (workspacePackageDocument) => workspacePackageDocument.devDependencies?.vite !== '7.3.6',
  ) ||
  /\bvitest@4\.1\.10[^\n]*\(vite@8\./u.test(pnpmLock) ||
  !/\bvitest@4\.1\.10[^\n]*\(vite@7\.3\.6/u.test(pnpmLock)
) {
  throw new Error('PHASE5_TEST_TOOLCHAIN_VITE_BASELINE_REQUIRED');
}
if (
  packageDocument.pnpm?.overrides?.postcss !== '8.5.23' ||
  packageDocument.pnpm?.overrides?.['brace-expansion'] !== '5.0.9' ||
  packageDocument.pnpm?.overrides?.['fast-uri'] !== '3.1.5' ||
  packageDocument.pnpm?.overrides?.hono !== '4.12.34' ||
  packageDocument.pnpm?.overrides?.['ip-address'] !== '10.3.1' ||
  packageDocument.pnpm?.overrides?.['@hono/node-server'] !== '2.0.10'
) throw new Error('PHASE5_SECURITY_TRANSITIVE_PATCH_REQUIRED');

process.stdout.write('Phase 5 安全工作流固定版本与强制门禁校验通过。\n');
