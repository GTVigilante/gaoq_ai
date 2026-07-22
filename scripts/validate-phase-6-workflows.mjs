import { readFile } from 'node:fs/promises';

const cutoverPath = new URL('../.github/workflows/phase-6-cutover.yml', import.meta.url);
const hypercarePath = new URL('../.github/workflows/phase-6-hypercare.yml', import.meta.url);
const packagePath = new URL('../package.json', import.meta.url);
const [cutover, hypercare, packageContent] = await Promise.all([
  readFile(cutoverPath, 'utf8'),
  readFile(hypercarePath, 'utf8'),
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

const expectedScripts = {
  'release:phase6:cutover:validate-evidence':
    'node scripts/release/validate-phase-6-cutover-evidence.mjs',
  'release:phase6:cutover:self-test':
    'node scripts/release/validate-phase-6-cutover-evidence.mjs --self-test',
  'release:phase6:hypercare:validate-evidence':
    'node scripts/release/validate-phase-6-hypercare-evidence.mjs',
  'release:phase6:hypercare:self-test':
    'node scripts/release/validate-phase-6-hypercare-evidence.mjs --self-test',
  'release:phase6:workflows:validate': 'node scripts/validate-phase-6-workflows.mjs',
};
for (const [name, value] of Object.entries(expectedScripts)) {
  if (packageDocument.scripts?.[name] !== value) throw new Error('PHASE6_PACKAGE_SCRIPT_INVALID');
}
for (const name of [
  'release:phase6:cutover:self-test',
  'release:phase6:hypercare:self-test',
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
