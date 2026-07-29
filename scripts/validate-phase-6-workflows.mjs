import { access, readFile } from 'node:fs/promises';

const COMMON_FORBIDDEN = [
  'pull_request:', 'push:', 'workflow_call:', 'workflow_run:', '${{ inputs.', '${{ secrets.',
  'environment:', 'self-hosted', '/var/lib/gaoq', '--force', '--create-namespace',
  '--set ', '--set-string ', '--reuse-values', 'wget ', 'ssh ', 'terraform ', 'tofu ',
  'aws ', 'aliyun ', 'gcloud ', 'az ', 'kubectl delete', 'helm uninstall', 'helm rollback',
  'HELM_DRIVER: secret', 'PHASE6_DEPLOYMENT_NAMESPACE:',
];
const paths = {
  cutover: new URL('../.github/workflows/phase-6-cutover.yml', import.meta.url),
  hypercare: new URL('../.github/workflows/phase-6-hypercare.yml', import.meta.url),
  plan: new URL('../.github/workflows/phase-6-deployment-plan.yml', import.meta.url),
  apply: new URL('../.github/workflows/phase-6-deployment-apply.yml', import.meta.url),
  legacy: new URL('../.github/workflows/phase-6-deployment.yml', import.meta.url),
  package: new URL('../package.json', import.meta.url),
};
const [cutover, hypercare, plan, apply, packageContent] = await Promise.all([
  readFile(paths.cutover, 'utf8'),
  readFile(paths.hypercare, 'utf8'),
  readFile(paths.plan, 'utf8'),
  readFile(paths.apply, 'utf8'),
  readFile(paths.package, 'utf8'),
]);
try {
  await access(paths.legacy);
  throw new Error('PHASE6_LEGACY_COMBINED_DEPLOYMENT_FORBIDDEN');
} catch (error) {
  if (error instanceof Error && error.message === 'PHASE6_LEGACY_COMBINED_DEPLOYMENT_FORBIDDEN') {
    throw error;
  }
}
const packageDocument = JSON.parse(packageContent);

validateEvidenceWorkflow(cutover, {
  code: 'PHASE6_CUTOVER_WORKFLOW',
  policy: 'phase-6-cutover-acceptance',
  oidcAudience:
    'PHASE6_CUTOVER_EVIDENCE_OIDC_AUDIENCE: ${{ vars.PHASE6_CUTOVER_EVIDENCE_OIDC_AUDIENCE }}',
  evidenceUrl: 'PHASE6_CUTOVER_EVIDENCE_URL: ${{ vars.PHASE6_CUTOVER_EVIDENCE_URL }}',
  evidenceSha256:
    'PHASE6_CUTOVER_EVIDENCE_SHA256: ${{ vars.PHASE6_CUTOVER_EVIDENCE_SHA256 }}',
  evidencePath: '$RUNNER_TEMP/phase-6-cutover.json',
  validator: 'validate-phase-6-cutover-evidence.mjs',
  artifact: 'phase-6-cutover-verdict-${{ github.sha }}',
  requiredMarkers: [
    'PHASE6_CUTOVER_EXPECTED_ENVIRONMENT: ${{ vars.PHASE6_CUTOVER_ENVIRONMENT_NAME }}',
    'PHASE6_CUTOVER_EXPECTED_REGION: ${{ vars.PHASE6_CUTOVER_REGION }}',
    'PHASE6_CUTOVER_EXPECTED_COMMIT: ${{ github.sha }}',
    'PHASE6_CUTOVER_EXPECTED_API_IMAGE: ${{ vars.PHASE6_CUTOVER_API_IMAGE_DIGEST }}',
    'PHASE6_CUTOVER_EXPECTED_WORKER_IMAGE: ${{ vars.PHASE6_CUTOVER_WORKER_IMAGE_DIGEST }}',
    'PHASE6_CUTOVER_EXPECTED_WEB_IMAGE: ${{ vars.PHASE6_CUTOVER_WEB_IMAGE_DIGEST }}',
    'PHASE6_CUTOVER_EXPECTED_WEBSITE_IMAGE: ${{ vars.PHASE6_CUTOVER_WEBSITE_IMAGE_DIGEST }}',
    'PHASE6_CUTOVER_EXPECTED_DEPLOYMENT_MANIFEST: ${{ vars.PHASE6_CUTOVER_DEPLOYMENT_MANIFEST_SHA256 }}',
  ],
});

validateEvidenceWorkflow(hypercare, {
  code: 'PHASE6_HYPERCARE_WORKFLOW',
  policy: 'phase-6-hypercare-acceptance',
  oidcAudience:
    'PHASE6_HYPERCARE_EVIDENCE_OIDC_AUDIENCE: ${{ vars.PHASE6_HYPERCARE_EVIDENCE_OIDC_AUDIENCE }}',
  evidenceUrl: 'PHASE6_HYPERCARE_EVIDENCE_URL: ${{ vars.PHASE6_HYPERCARE_EVIDENCE_URL }}',
  evidenceSha256:
    'PHASE6_HYPERCARE_EVIDENCE_SHA256: ${{ vars.PHASE6_HYPERCARE_EVIDENCE_SHA256 }}',
  evidencePath: '$RUNNER_TEMP/phase-6-hypercare.json',
  validator: 'validate-phase-6-hypercare-evidence.mjs',
  artifact: 'phase-6-hypercare-verdict-${{ github.sha }}',
  requiredMarkers: [
    'PHASE6_HYPERCARE_EXPECTED_ENVIRONMENT: ${{ vars.PHASE6_HYPERCARE_ENVIRONMENT_NAME }}',
    'PHASE6_HYPERCARE_EXPECTED_REGION: ${{ vars.PHASE6_HYPERCARE_REGION }}',
    'PHASE6_HYPERCARE_EXPECTED_COMMIT: ${{ github.sha }}',
    'PHASE6_HYPERCARE_EXPECTED_RELEASE: ${{ vars.PHASE6_HYPERCARE_RELEASE_CANDIDATE }}',
    'PHASE6_HYPERCARE_EXPECTED_CUTOVER_EVIDENCE: ${{ vars.PHASE6_HYPERCARE_CUTOVER_EVIDENCE_SHA256 }}',
  ],
});

validateDeploymentWorkflow(plan, {
  code: 'PHASE6_DEPLOYMENT_PLAN_WORKFLOW',
  policy: 'phase-6-deployment-plan',
  concurrency: 'group: phase-6-production-deployment-plan',
  inputAudience:
    'PHASE6_DEPLOYMENT_INPUT_OIDC_AUDIENCE: ${{ vars.PHASE6_DEPLOYMENT_PLAN_INPUT_OIDC_AUDIENCE }}',
  kubernetesAudience:
    'PHASE6_KUBERNETES_OIDC_AUDIENCE: ${{ vars.PHASE6_DEPLOYMENT_PLAN_KUBERNETES_OIDC_AUDIENCE }}',
  artifact: 'phase-6-production-plan-${{ github.sha }}-${{ github.run_id }}',
  requiredMarkers: [
    '生成只读生产部署计划',
    'diff --unified',
    'kubectl auth can-i create deployments',
    'kubectl auth can-i patch deployments',
    'kubectl auth can-i delete deployments',
    '--write-plan-binding',
    '$RUNNER_TEMP/deployment-plan-binding.json',
    '保存待外部签名审批的计划',
  ],
  forbiddenMarkers: [
    'helm upgrade --install',
    'kubectl apply --server-side --dry-run=server',
    'PHASE6_DEPLOYMENT_AUTHORIZATION_URL:',
  ],
});

validateDeploymentWorkflow(apply, {
  code: 'PHASE6_DEPLOYMENT_APPLY_WORKFLOW',
  policy: 'phase-6-deployment-apply',
  concurrency: 'group: phase-6-production-deployment-apply',
  inputAudience:
    'PHASE6_DEPLOYMENT_INPUT_OIDC_AUDIENCE: ${{ vars.PHASE6_DEPLOYMENT_APPLY_INPUT_OIDC_AUDIENCE }}',
  kubernetesAudience:
    'PHASE6_KUBERNETES_OIDC_AUDIENCE: ${{ vars.PHASE6_DEPLOYMENT_APPLY_KUBERNETES_OIDC_AUDIENCE }}',
  artifact: 'phase-6-production-deployment-${{ github.sha }}-${{ github.run_id }}',
  requiredMarkers: [
    '验证外部签名授权并原子部署',
    'PHASE6_DEPLOYMENT_AUTHORIZATION_URL: ${{ vars.PHASE6_DEPLOYMENT_AUTHORIZATION_URL }}',
    'PHASE6_DEPLOYMENT_AUTHORIZATION_SHA256: ${{ vars.PHASE6_DEPLOYMENT_AUTHORIZATION_SHA256 }}',
    'PHASE6_DEPLOYMENT_AUTHORIZATION_PUBLIC_KEY_PEM_BASE64: ${{ vars.PHASE6_DEPLOYMENT_AUTHORIZATION_PUBLIC_KEY_PEM_BASE64 }}',
    'PHASE6_DEPLOYMENT_AUTHORIZATION_PUBLIC_KEY_SHA256: ${{ vars.PHASE6_DEPLOYMENT_AUTHORIZATION_PUBLIC_KEY_SHA256 }}',
    'PHASE6_DEPLOYMENT_AUTHORIZED_PLAN_RUN_ID: ${{ vars.PHASE6_DEPLOYMENT_AUTHORIZED_PLAN_RUN_ID }}',
    'PHASE6_DEPLOYMENT_AUTHORIZED_PLAN_RUN_ATTEMPT: ${{ vars.PHASE6_DEPLOYMENT_AUTHORIZED_PLAN_RUN_ATTEMPT }}',
    'PHASE6_DEPLOYMENT_AUTHORIZED_PLAN_ARTIFACT_SHA256: ${{ vars.PHASE6_DEPLOYMENT_AUTHORIZED_PLAN_ARTIFACT_SHA256 }}',
    'PHASE6_DEPLOYMENT_CLUSTER_SHA256: ${{ vars.PHASE6_DEPLOYMENT_CLUSTER_SHA256 }}',
    '$RUNNER_TEMP/phase-6-deployment-authorization.json',
    'validate-phase-6-deployment-authorization.mjs',
    'PHASE6_DEPLOYMENT_EXPECTED_RENDERED_SHA256=sha256:',
    'kubectl apply --server-side --dry-run=server',
    'helm upgrade --install',
    '--atomic --wait --timeout 15m --history-max 10',
    'kubectl rollout status deployment',
    'helm get manifest',
  ],
  forbiddenMarkers: [
    'needs:',
    'diff --unified',
    '--write-plan-binding',
  ],
});

if (plan.includes('phase-6-deployment-apply') || apply.includes('phase-6-deployment-plan.yml')) {
  throw new Error('PHASE6_DEPLOYMENT_WORKFLOWS_COUPLED');
}

const expectedScripts = {
  'release:phase6:cutover:validate-evidence':
    'node scripts/release/validate-phase-6-cutover-evidence.mjs',
  'release:phase6:cutover:self-test':
    'node scripts/release/validate-phase-6-cutover-evidence.mjs --self-test',
  'release:phase6:hypercare:validate-evidence':
    'node scripts/release/validate-phase-6-hypercare-evidence.mjs',
  'release:phase6:hypercare:self-test':
    'node scripts/release/validate-phase-6-hypercare-evidence.mjs --self-test',
  'release:phase6:deployment:validate-plan':
    'node scripts/release/validate-phase-6-deployment-plan.mjs',
  'release:phase6:deployment:self-test':
    'node scripts/release/validate-phase-6-deployment-plan.mjs --self-test',
  'release:phase6:deployment-authorization:validate-evidence':
    'node scripts/release/validate-phase-6-deployment-authorization.mjs',
  'release:phase6:deployment-authorization:self-test':
    'node scripts/release/validate-phase-6-deployment-authorization.mjs --self-test',
  'release:phase6:deployment-authorization:print-contract':
    'node scripts/release/validate-phase-6-deployment-authorization.mjs --print-contract',
  'release:phase6:platform-intake:validate-evidence':
    'node scripts/release/validate-phase-6-platform-intake.mjs',
  'release:phase6:platform-intake:self-test':
    'node scripts/release/validate-phase-6-platform-intake.mjs --self-test',
  'release:phase6:platform-intake:print-contract':
    'node scripts/release/validate-phase-6-platform-intake.mjs --print-contract',
  'release:phase6:workflows:validate': 'node scripts/validate-phase-6-workflows.mjs',
  'github:oidc-input:self-test':
    'node scripts/github/fetch-oidc-protected-input.mjs --self-test',
  'github:oidc-kubernetes:self-test':
    'node scripts/github/github-oidc-kubernetes-credential.mjs --self-test',
  'github:oidc-kubeconfig:self-test':
    'node scripts/github/write-oidc-kubeconfig.mjs --self-test',
};
for (const [name, value] of Object.entries(expectedScripts)) {
  if (packageDocument.scripts?.[name] !== value) throw new Error('PHASE6_PACKAGE_SCRIPT_INVALID');
}
for (const name of [
  'release:phase6:cutover:self-test',
  'release:phase6:hypercare:self-test',
  'release:phase6:deployment:self-test',
  'release:phase6:deployment-authorization:self-test',
  'release:phase6:platform-intake:self-test',
  'release:phase6:workflows:validate',
  'github:oidc-input:self-test',
  'github:oidc-kubernetes:self-test',
  'github:oidc-kubeconfig:self-test',
]) {
  if (!packageDocument.scripts?.check?.includes(`pnpm ${name}`)) {
    throw new Error('PHASE6_CHECK_GATE_MISSING');
  }
}

process.stdout.write('Phase 6 GitHub Free 受保护工作流与仓库门禁校验通过。\n');

/** 校验只读验收工作流。 */
function validateEvidenceWorkflow(workflow, contract) {
  validatePinnedActions(workflow, 5, contract.code);
  for (const marker of [
    'workflow_dispatch:',
    "test \"$GITHUB_REF\" = 'refs/heads/main'",
    'runs-on: ubuntu-latest',
    'id-token: write',
    `GAOQ_OIDC_POLICY: ${contract.policy}`,
    '--policy "$GAOQ_OIDC_POLICY"',
    contract.oidcAudience,
    contract.evidenceUrl,
    contract.evidenceSha256,
    contract.evidencePath,
    'scripts/github/fetch-oidc-protected-input.mjs',
    '--media-type application/json',
    `${contract.validator} --self-test`,
    '--enforce-environment',
    contract.artifact,
    'retention-days: 90',
    ...contract.requiredMarkers,
  ]) {
    if (!workflow.includes(marker)) throw new Error(`${contract.code}_INCOMPLETE`);
  }
  forbid(workflow, contract.code, [
    ...COMMON_FORBIDDEN,
    'kubectl ', 'helm ', 'terraform ', 'aws ', 'aliyun ', 'curl ', 'wget ', 'ssh ',
  ]);
  if ((workflow.match(/runs-on: ubuntu-latest/gu) ?? []).length !== 2) {
    throw new Error(`${contract.code}_HOSTED_RUNNER_INVALID`);
  }
}

/** 校验相互独立的生产 Plan 或 Apply 工作流。 */
function validateDeploymentWorkflow(workflow, contract) {
  validatePinnedActions(workflow, 3, contract.code);
  for (const marker of [
    'workflow_dispatch:',
    "test \"$GITHUB_REF\" = 'refs/heads/main'",
    contract.concurrency,
    'runs-on: ubuntu-latest',
    'id-token: write',
    `GAOQ_OIDC_POLICY: ${contract.policy}`,
    '--policy "$GAOQ_OIDC_POLICY"',
    contract.inputAudience,
    contract.kubernetesAudience,
    'PHASE6_DEPLOYMENT_VALUES_URL: ${{ vars.PHASE6_DEPLOYMENT_VALUES_URL }}',
    'PHASE6_DEPLOYMENT_VALUES_SHA256: ${{ vars.PHASE6_DEPLOYMENT_VALUES_SHA256 }}',
    'PHASE6_DEPLOYMENT_GO_NO_GO_URL: ${{ vars.PHASE6_DEPLOYMENT_GO_NO_GO_URL }}',
    'PHASE6_DEPLOYMENT_GO_NO_GO_SHA256: ${{ vars.PHASE6_DEPLOYMENT_GO_NO_GO_SHA256 }}',
    'PHASE6_DEPLOYMENT_PLATFORM_INTAKE_URL: ${{ vars.PHASE6_DEPLOYMENT_PLATFORM_INTAKE_URL }}',
    'PHASE6_DEPLOYMENT_PLATFORM_INTAKE_SHA256: ${{ vars.PHASE6_DEPLOYMENT_PLATFORM_INTAKE_SHA256 }}',
    'PHASE6_KUBERNETES_SERVER: ${{ vars.PHASE6_KUBERNETES_SERVER }}',
    'PHASE6_KUBERNETES_CA_SHA256: ${{ vars.PHASE6_KUBERNETES_CA_SHA256 }}',
    'PHASE6_KUBERNETES_CREDENTIAL_URL: ${{ vars.PHASE6_KUBERNETES_CREDENTIAL_URL }}',
    'scripts/github/fetch-oidc-protected-input.mjs',
    'scripts/github/write-oidc-kubeconfig.mjs',
    'validate-phase-5-go-no-go-evidence.mjs',
    'validate-phase-6-platform-intake.mjs',
    'validate-phase-6-deployment-plan.mjs',
    'validate-phase-6-deployment-authorization.mjs --self-test',
    'validate-kubernetes-deployment.mjs',
    "test \"$(node --version)\" = 'v22.23.1'",
    "test \"$(helm version --short)\" = 'v4.2.0+g0646808'",
    "test \"$(kubeconform -v)\" = 'v0.7.0'",
    'https://get.helm.sh/helm-v4.2.0-linux-amd64.tar.gz',
    "--proto '=https' --proto-redir '=https' --tlsv1.2",
    '97dbeb971be4ac4b27e3839976d9564c0fb35c6f3b1da89dd1e292d236af4096',
    'https://github.com/yannh/kubeconform/releases/download/v0.7.0/kubeconform-linux-amd64.tar.gz',
    'c31518ddd122663b3f3aa874cfe8178cb0988de944f29c74a0b9260920d115d3',
    'https://dl.k8s.io/release/v1.30.12/bin/linux/amd64/kubectl',
    '261a3c4eb12e09207b9e08f0b43d547220569317ed8d7a22638572100ace5b80',
    '987aa4ee419358d6ae108f54f6c42f4e90f22b70/{{.NormalizedKubernetesVersion}}-standalone-strict/{{.ResourceKind}}.json',
    'kubectl auth can-i get secrets',
    contract.artifact,
    'retention-days: 90',
    ...contract.requiredMarkers,
  ]) {
    if (!workflow.includes(marker)) throw new Error(`${contract.code}_INCOMPLETE`);
  }
  forbid(workflow, contract.code, [...COMMON_FORBIDDEN, ...contract.forbiddenMarkers]);
  if ((workflow.match(/runs-on: ubuntu-latest/gu) ?? []).length !== 1) {
    throw new Error(`${contract.code}_HOSTED_RUNNER_INVALID`);
  }
}

function validatePinnedActions(workflow, expectedCount, code) {
  const actions = [...workflow.matchAll(/^\s*uses:\s*([^\s#]+)(?:\s*#.*)?$/gmu)]
    .map((match) => match[1]);
  if (
    actions.length !== expectedCount ||
    actions.some((reference) => reference === undefined || !/@[a-f0-9]{40}$/u.test(reference))
  ) throw new Error(`${code}_ACTION_NOT_PINNED`);
}

function forbid(workflow, code, markers) {
  if (markers.some((marker) => workflow.includes(marker)) || /^\s*rm\s+/mu.test(workflow)) {
    throw new Error(`${code}_UNSAFE`);
  }
}
