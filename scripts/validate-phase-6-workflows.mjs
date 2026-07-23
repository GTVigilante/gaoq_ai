import { readFile } from 'node:fs/promises';

const cutoverPath = new URL('../.github/workflows/phase-6-cutover.yml', import.meta.url);
const hypercarePath = new URL('../.github/workflows/phase-6-hypercare.yml', import.meta.url);
const deploymentPath = new URL('../.github/workflows/phase-6-deployment.yml', import.meta.url);
const packagePath = new URL('../package.json', import.meta.url);
const [cutover, hypercare, deployment, packageContent] = await Promise.all([
  readFile(cutoverPath, 'utf8'),
  readFile(hypercarePath, 'utf8'),
  readFile(deploymentPath, 'utf8'),
  readFile(packagePath, 'utf8'),
]);
const packageDocument = JSON.parse(packageContent);

validateWorkflow(cutover, {
  code: 'PHASE6_CUTOVER_WORKFLOW',
  environment: 'phase-6-cutover-acceptance',
  runner: '- phase-6-cutover',
  evidencePath: 'PHASE6_CUTOVER_EVIDENCE_PATH: /var/lib/gaoq/phase-6/cutover.json',
  validator: 'validate-phase-6-cutover-evidence.mjs',
  artifact: 'phase-6-cutover-verdict-${{ github.sha }}',
  requiredMarkers: [
    'PHASE6_CUTOVER_EXPECTED_ENVIRONMENT: ${{ vars.PHASE6_CUTOVER_ENVIRONMENT_NAME }}',
    'PHASE6_CUTOVER_EXPECTED_REGION: ${{ vars.PHASE6_CUTOVER_REGION }}',
    'PHASE6_CUTOVER_EXPECTED_COMMIT: ${{ github.sha }}',
    'PHASE6_CUTOVER_EXPECTED_API_IMAGE: ${{ vars.PHASE6_CUTOVER_API_IMAGE_DIGEST }}',
    'PHASE6_CUTOVER_EXPECTED_WORKER_IMAGE: ${{ vars.PHASE6_CUTOVER_WORKER_IMAGE_DIGEST }}',
    'PHASE6_CUTOVER_EXPECTED_WEB_IMAGE: ${{ vars.PHASE6_CUTOVER_WEB_IMAGE_DIGEST }}',
    'PHASE6_CUTOVER_EXPECTED_DEPLOYMENT_MANIFEST: ${{ vars.PHASE6_CUTOVER_DEPLOYMENT_MANIFEST_SHA256 }}',
  ],
});

validateWorkflow(hypercare, {
  code: 'PHASE6_HYPERCARE_WORKFLOW',
  environment: 'phase-6-hypercare-acceptance',
  runner: '- phase-6-hypercare',
  evidencePath: 'PHASE6_HYPERCARE_EVIDENCE_PATH: /var/lib/gaoq/phase-6/hypercare.json',
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

validateDeploymentWorkflow(deployment);

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
  'release:phase6:platform-intake:validate-evidence':
    'node scripts/release/validate-phase-6-platform-intake.mjs',
  'release:phase6:platform-intake:self-test':
    'node scripts/release/validate-phase-6-platform-intake.mjs --self-test',
  'release:phase6:platform-intake:print-contract':
    'node scripts/release/validate-phase-6-platform-intake.mjs --print-contract',
  'release:phase6:workflows:validate': 'node scripts/validate-phase-6-workflows.mjs',
};
for (const [name, value] of Object.entries(expectedScripts)) {
  if (packageDocument.scripts?.[name] !== value) throw new Error('PHASE6_PACKAGE_SCRIPT_INVALID');
}
for (const name of [
  'release:phase6:cutover:self-test',
  'release:phase6:hypercare:self-test',
  'release:phase6:deployment:self-test',
  'release:phase6:platform-intake:self-test',
  'release:phase6:workflows:validate',
]) {
  if (!packageDocument.scripts?.check?.includes(`pnpm ${name}`)) {
    throw new Error('PHASE6_CHECK_GATE_MISSING');
  }
}

process.stdout.write('Phase 6 受保护工作流与仓库门禁校验通过。\n');

/** 校验工作流只能读取证据，不能执行生产变更。 */
function validateWorkflow(workflow, contract) {
  const actionReferences = [
    ...workflow.matchAll(/^\s*uses:\s*([^\s#]+)(?:\s*#.*)?$/gmu),
  ].map((match) => match[1]);
  if (
    actionReferences.length !== 5 || actionReferences.some(
      (reference) => reference === undefined || !/@[a-f0-9]{40}$/u.test(reference),
    )
  ) throw new Error(`${contract.code}_ACTION_NOT_PINNED`);
  for (const marker of [
    'workflow_dispatch:',
    "test \"$GITHUB_REF\" = 'refs/heads/main'",
    `environment: ${contract.environment}`,
    contract.runner,
    contract.evidencePath,
    `${contract.validator} --self-test`,
    '--enforce-environment',
    contract.artifact,
    'retention-days: 90',
    ...contract.requiredMarkers,
  ]) {
    if (!workflow.includes(marker)) throw new Error(`${contract.code}_INCOMPLETE`);
  }
  for (const forbidden of [
    'pull_request:', 'push:', 'workflow_call:', '${{ inputs.', '${{ secrets.',
    'kubectl ', 'helm ', 'terraform ', 'aws ', 'aliyun ', 'curl ', 'wget ', 'ssh ',
  ]) {
    if (workflow.includes(forbidden)) throw new Error(`${contract.code}_UNSAFE`);
  }
}

/** 校验生产部署只能由双环境、双 Runner 和人工批准执行。 */
function validateDeploymentWorkflow(workflow) {
  const actionReferences = [
    ...workflow.matchAll(/^\s*uses:\s*([^\s#]+)(?:\s*#.*)?$/gmu),
  ].map((match) => match[1]);
  if (
    actionReferences.length !== 6 || actionReferences.some(
      (reference) => reference === undefined || !/@[a-f0-9]{40}$/u.test(reference),
    )
  ) throw new Error('PHASE6_DEPLOYMENT_WORKFLOW_ACTION_NOT_PINNED');

  for (const marker of [
    'workflow_dispatch:',
    "test \"$GITHUB_REF\" = 'refs/heads/main'",
    'group: phase-6-production-deployment',
    '- phase-6-deployment-plan',
    '- phase-6-deployment-apply',
    'environment: phase-6-production-plan',
    'environment: phase-6-production-deployment',
    'PHASE6_DEPLOYMENT_VALUES_PATH: /var/lib/gaoq/deployment/production-values.yaml',
    'PHASE6_DEPLOYMENT_GO_NO_GO_PATH: /var/lib/gaoq/go-no-go/phase-5-go-no-go.json',
    'PHASE6_DEPLOYMENT_PLATFORM_INTAKE_PATH: /var/lib/gaoq/platform/phase-6-platform-intake.json',
    'PHASE6_DEPLOYMENT_PLATFORM_INTAKE_SHA256: ${{ vars.PHASE6_DEPLOYMENT_PLATFORM_INTAKE_SHA256 }}',
    'PHASE6_DEPLOYMENT_GUARDRAILS_MANIFEST_SHA256: ${{ vars.PHASE6_DEPLOYMENT_GUARDRAILS_MANIFEST_SHA256 }}',
    'PHASE6_DEPLOYMENT_PLATFORM_NAMESPACE: ${{ vars.PHASE6_DEPLOYMENT_PLATFORM_NAMESPACE }}',
    'PHASE6_DEPLOYMENT_PLAN_GROUP: ${{ vars.PHASE6_DEPLOYMENT_PLAN_GROUP }}',
    'PHASE6_DEPLOYMENT_APPLY_GROUP: ${{ vars.PHASE6_DEPLOYMENT_APPLY_GROUP }}',
    'PHASE6_DEPLOYMENT_CONTROL_NAMESPACE: ${{ vars.PHASE6_DEPLOYMENT_CONTROL_NAMESPACE }}',
    'PHASE6_DEPLOYMENT_TARGET_NAMESPACE: ${{ vars.PHASE6_DEPLOYMENT_TARGET_NAMESPACE }}',
    'HELM_DRIVER: configmap',
    "test \"$(node --version)\" = 'v22.23.1'",
    'validate-phase-5-go-no-go-evidence.mjs',
    'validate-phase-6-deployment-plan.mjs',
    'validate-phase-6-deployment-plan.mjs --validate-environment',
    'validate-phase-6-platform-intake.mjs',
    '--enforce-environment',
    'validate-kubernetes-deployment.mjs',
    "test \"$(helm version --short)\" = 'v4.2.0+g0646808'",
    "test \"$(kubeconform -v)\" = 'v0.7.0'",
    'v1.30.0-standalone-strict/{{.ResourceKind}}.json',
    'kubectl apply --server-side --dry-run=server',
    'diff --unified',
    'kubectl auth can-i get secrets',
    'kubectl auth can-i create deployments',
    'kubectl auth can-i patch deployments',
    'kubectl auth can-i delete deployments',
    'rendered_sha256: ${{ steps.plan_hash.outputs.rendered_sha256 }}',
    'go_no_go_sha256: ${{ steps.plan_hash.outputs.go_no_go_sha256 }}',
    'platform_intake_sha256: ${{ steps.plan_hash.outputs.platform_intake_sha256 }}',
    "test \"sha256:$rendered_hash\" = '${{ needs.plan.outputs.rendered_sha256 }}'",
    "test \"sha256:$go_no_go_hash\" = '${{ needs.plan.outputs.go_no_go_sha256 }}'",
    "test \"sha256:$platform_intake_hash\" = '${{ needs.plan.outputs.platform_intake_sha256 }}'",
    'helm upgrade --install',
    '--atomic --wait --timeout 15m --history-max 10',
    'kubectl rollout status deployment',
    'helm get manifest',
    'phase-6-production-plan-${{ github.sha }}',
    'phase-6-production-deployment-${{ github.sha }}',
    'platform-intake-verdict.json',
    'retention-days: 90',
  ]) {
    if (!workflow.includes(marker)) throw new Error('PHASE6_DEPLOYMENT_WORKFLOW_INCOMPLETE');
  }

  for (const forbidden of [
    'pull_request:', 'push:', 'workflow_call:', '${{ inputs.', '${{ secrets.',
    '--force', '--create-namespace', '--set ', '--set-string ', '--reuse-values',
    'curl ', 'wget ', 'ssh ', 'terraform ', 'tofu ', 'aws ', 'aliyun ', 'gcloud ', 'az ',
    'kubectl delete', 'helm uninstall', 'helm rollback',
    'HELM_DRIVER: secret', 'PHASE6_DEPLOYMENT_NAMESPACE:',
  ]) {
    if (workflow.includes(forbidden)) throw new Error('PHASE6_DEPLOYMENT_WORKFLOW_UNSAFE');
  }
  if (/^\s*rm\s+/mu.test(workflow)) throw new Error('PHASE6_DEPLOYMENT_WORKFLOW_UNSAFE');
}
