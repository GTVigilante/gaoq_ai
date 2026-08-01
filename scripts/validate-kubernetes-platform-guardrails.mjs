import { readFile } from 'node:fs/promises';

const chartRoot = new URL('../deploy/helm/gaoq-platform-guardrails/', import.meta.url);
const repositoryRoot = new URL('../', import.meta.url);
const requiredFiles = [
  'Chart.yaml',
  'README.md',
  'values.yaml',
  'ci-values.yaml',
  'values.schema.json',
  'templates/_helpers.tpl',
  'templates/namespaces.yaml',
  'templates/quotas.yaml',
  'templates/rbac.yaml',
  'templates/admission.yaml',
  'templates/NOTES.txt',
];

const contents = new Map(await Promise.all(requiredFiles.map(async (path) => [
  path,
  await readFile(new URL(path, chartRoot), 'utf8'),
])));
const packageDocument = JSON.parse(await readFile(new URL('package.json', repositoryRoot), 'utf8'));
const workflow = await readFile(
  new URL('.github/workflows/phase-5-security.yml', repositoryRoot),
  'utf8',
);
const schema = JSON.parse(contents.get('values.schema.json'));
const templates = [...contents.entries()]
  .filter(([path]) => path.startsWith('templates/'))
  .map(([, content]) => content)
  .join('\n');

const assertIncludes = (content, markers, code) => {
  for (const marker of markers) {
    if (!content.includes(marker)) throw new Error(code);
  }
};

if (
  schema.$schema !== 'http://json-schema.org/draft-07/schema#' ||
  schema.additionalProperties !== false
) throw new Error('KUBERNETES_GUARDRAILS_SCHEMA_INVALID');

assertIncludes(JSON.stringify(schema), [
  'namespaces',
  'workloadNamePrefix',
  'planGroup',
  'applyGroup',
  'runtimeReferences',
  'targetQuota',
  'targetLimitRange',
  'controlQuota',
], 'KUBERNETES_GUARDRAILS_SCHEMA_INCOMPLETE');

assertIncludes(contents.get('templates/namespaces.yaml'), [
  '控制命名空间与业务命名空间必须分离',
  '平台护栏 release 必须使用独立且预先存在的平台管理命名空间',
  '(eq .Release.Namespace .Values.namespaces.control)',
  '(eq .Release.Namespace .Values.namespaces.target)',
  'gaoq.io/deployment-boundary: helm-control',
  'gaoq.io/deployment-boundary: erp-target',
  'pod-security.kubernetes.io/enforce: restricted',
  'pod-security.kubernetes.io/enforce-version: v1.30',
  'pod-security.kubernetes.io/audit: restricted',
  'pod-security.kubernetes.io/warn: restricted',
], 'KUBERNETES_GUARDRAILS_NAMESPACES_INCOMPLETE');

assertIncludes(contents.get('templates/quotas.yaml'), [
  'kind: ResourceQuota',
  "count/secrets: '0'",
  "count/pods: '0'",
  'kind: LimitRange',
  'ephemeral-storage:',
], 'KUBERNETES_GUARDRAILS_QUOTA_INCOMPLETE');

const rbac = contents.get('templates/rbac.yaml');
assertIncludes(rbac, [
  'kind: ClusterRole',
  'resourceNames: [{{ .Values.namespaces.control | quote }}, {{ .Values.namespaces.target | quote }}]',
  'verbs: [get]',
  'kind: Group',
  'gaoq-deployment-plan-release-reader',
  'gaoq-deployment-plan-runtime-reader',
  'gaoq-deployment-apply-release-manager',
  'gaoq-deployment-apply-workload-manager',
  'resources: [pods]',
  'resources: [serviceaccounts, services]',
  'resources: [deployments]',
  'resources: [horizontalpodautoscalers]',
  'resources: [poddisruptionbudgets]',
  'resources: [ingresses, networkpolicies]',
], 'KUBERNETES_GUARDRAILS_RBAC_INCOMPLETE');

const admission = contents.get('templates/admission.yaml');
assertIncludes(admission, [
  'kind: ValidatingAdmissionPolicy',
  'failurePolicy: Fail',
  'gaoq.io/deployment-boundary: erp-target',
  'gaoq.io/deployment-boundary: helm-control',
  'request.userInfo.groups.exists',
  "request.operation == 'DELETE' ? oldObject : object",
  "metadata.labels['app.kubernetes.io/part-of'] == 'gaoq-os'",
  "metadata.labels['app.kubernetes.io/instance'] == '{{ .Values.releaseName }}'",
  "metadata.name.startsWith('{{ .Values.workloadNamePrefix }}')",
  "metadata.name.startsWith('sh.helm.release.v1.{{ .Values.releaseName }}.v')",
  "metadata.labels['owner'] == 'helm'",
  'validationActions: [Deny, Audit]',
], 'KUBERNETES_GUARDRAILS_ADMISSION_INCOMPLETE');

if ([...admission.matchAll(/variables\.isApplyIdentity &&/gu)].length !== 2) {
  throw new Error('KUBERNETES_GUARDRAILS_ADMISSION_IDENTITY_FAIL_CLOSED');
}

for (const forbidden of [
  /kind:\s*Secret\b/u,
  /stringData:/u,
  /cluster-admin/u,
  /kind:\s*ServiceAccount\b/u,
  /resources:\s*\[secrets\]/u,
  /verbs:\s*\[[^\]]*\*[^\]]*\]/u,
  /verbs:\s*\[[^\]]*(?:impersonate|escalate|bind)[^\]]*\]/u,
  /0\.0\.0\.0\/0/u,
]) {
  if (forbidden.test(templates)) throw new Error('KUBERNETES_GUARDRAILS_UNSAFE_TEMPLATE');
}

if (packageDocument.scripts?.['deployment:kubernetes:guardrails:validate'] !==
  'node scripts/validate-kubernetes-platform-guardrails.mjs' ||
  !packageDocument.scripts?.check?.includes('pnpm deployment:kubernetes:guardrails:validate')) {
  throw new Error('KUBERNETES_GUARDRAILS_PACKAGE_GATE_MISSING');
}

assertIncludes(workflow, [
  'node scripts/validate-kubernetes-platform-guardrails.mjs',
  'helm" lint deploy/helm/gaoq-platform-guardrails',
  'helm" template guardrails deploy/helm/gaoq-platform-guardrails',
  '--namespace gaoq-platform-system',
  'gaoq-platform-guardrails-rendered.yaml',
  '平台护栏不得把 release 存入控制命名空间',
  '平台护栏 values schema 必须拒绝未知字段',
], 'KUBERNETES_GUARDRAILS_CI_GATE_INCOMPLETE');

const renderedPath = process.argv[2];
if (renderedPath !== undefined) {
  const rendered = await readFile(renderedPath, 'utf8');
  const count = (kind) => [...rendered.matchAll(new RegExp(`^kind: ${kind}$`, 'gmu'))].length;
  for (const [kind, expected] of Object.entries({
    Namespace: 2,
    ResourceQuota: 2,
    LimitRange: 1,
    ClusterRole: 1,
    ClusterRoleBinding: 2,
    Role: 4,
    RoleBinding: 4,
    ValidatingAdmissionPolicy: 2,
    ValidatingAdmissionPolicyBinding: 2,
  })) {
    if (count(kind) !== expected) {
      throw new Error(`KUBERNETES_GUARDRAILS_RENDERED_${kind.toUpperCase()}_COUNT_INVALID`);
    }
  }
  assertIncludes(rendered, [
    'name: "gaoq:phase6-deployment-plan"',
    'name: "gaoq:phase6-deployment-apply"',
    'resourceNames: ["gaoq-erp-release-control", "gaoq-erp-prod"]',
    'count/secrets: \'0\'',
    'count/pods: \'0\'',
    'gaoq.io/deployment-boundary: helm-control',
    'gaoq.io/deployment-boundary: erp-target',
    "group == 'gaoq:phase6-deployment-apply'",
    "metadata.name.startsWith('gaoq-prod-gaoq-erp')",
    "metadata.name.startsWith('sh.helm.release.v1.gaoq-prod.v')",
  ], 'KUBERNETES_GUARDRAILS_RENDERED_BINDING_INVALID');
  for (const forbidden of [
    /^kind:\s*Secret$/mu,
    /resources:\s*\[secrets\]/u,
    /cluster-admin/u,
    /kind:\s*ServiceAccount$/mu,
    /verbs:\s*\[[^\]]*\*[^\]]*\]/u,
  ]) {
    if (forbidden.test(rendered)) throw new Error('KUBERNETES_GUARDRAILS_UNSAFE_RENDERED');
  }
}

process.stdout.write(
  renderedPath === undefined
    ? 'Kubernetes 平台护栏静态契约校验通过。\n'
    : 'Kubernetes 平台护栏渲染清单校验通过。\n',
);
