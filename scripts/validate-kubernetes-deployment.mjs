import { readFile } from 'node:fs/promises';

const chartRoot = new URL('../deploy/helm/gaoq-erp/', import.meta.url);
const repositoryRoot = new URL('../', import.meta.url);

const requiredFiles = [
  'Chart.yaml',
  'values.yaml',
  'ci-values.yaml',
  'values.schema.json',
  'templates/_helpers.tpl',
  'templates/serviceaccount.yaml',
  'templates/deployment-api.yaml',
  'templates/deployment-worker.yaml',
  'templates/deployment-web.yaml',
  'templates/deployment-website.yaml',
  'templates/services.yaml',
  'templates/pdb.yaml',
  'templates/hpa.yaml',
  'templates/ingress.yaml',
  'templates/networkpolicy.yaml',
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

if (schema.$schema !== 'http://json-schema.org/draft-07/schema#') {
  throw new Error('KUBERNETES_VALUES_SCHEMA_DRAFT_INVALID');
}
if (schema.additionalProperties !== false) {
  throw new Error('KUBERNETES_VALUES_SCHEMA_UNKNOWN_FIELDS_ALLOWED');
}

assertIncludes(JSON.stringify(schema), [
  'targetNamespace',
  '^[a-f0-9]{40}$',
  '^sha256:[a-f0-9]{64}$',
  '"minimum":3',
  '"minimum":2',
  'httpsEgressCidrs',
  'mongodbCidrs',
  'redisCidrs',
], 'KUBERNETES_VALUES_SCHEMA_INCOMPLETE');

for (const [component, markers] of Object.entries({
  api: ['runtime.apiConfigMapName', 'runtime.apiSecretName', '/api/health/ready'],
  worker: ['runtime.workerConfigMapName', 'runtime.workerSecretName', '/health/live'],
  web: ['runtime.webConfigMapName', 'runtime.webSecretName', 'path: /', 'containerPort: 3000'],
  website: [
    'runtime.websiteConfigMapName',
    'runtime.websiteSecretName',
    '/zh-CN',
    'containerPort: 3002',
    'gaoq.io/website-public-config:',
  ],
})) {
  const deployment = contents.get(`templates/deployment-${component}.yaml`);
  assertIncludes(deployment, [
    'kind: Deployment',
    'automountServiceAccountToken: false',
    'enableServiceLinks: false',
    'runAsNonRoot: true',
    'runAsUser: 65532',
    'runAsGroup: 65532',
    'seccompProfile: { type: RuntimeDefault }',
    'allowPrivilegeEscalation: false',
    'readOnlyRootFilesystem: true',
    'capabilities: { drop: [ALL] }',
    'startupProbe:',
    'livenessProbe:',
    'readinessProbe:',
    'resources:',
    'topologySpreadConstraints:',
    'gaoq.io/release-commit:',
    'gaoq.io/deployment-manifest:',
    'gaoq-erp.targetNamespace',
    ...markers,
  ], `KUBERNETES_${component.toUpperCase()}_DEPLOYMENT_INCOMPLETE`);
}

const webDeployment = contents.get('templates/deployment-web.yaml');
assertIncludes(webDeployment, [
  'envFrom:',
  'runtime.webConfigMapName',
  'runtime.webSecretName',
], 'KUBERNETES_WEB_BFF_IDENTITY_MISSING');
if (
  webDeployment.includes('runtime.apiSecretName') ||
  webDeployment.includes('runtime.workerSecretName')
) throw new Error('KUBERNETES_WEB_BACKEND_SECRET_REUSE_FORBIDDEN');

const websiteDeployment = contents.get('templates/deployment-website.yaml');
if (
  websiteDeployment.includes('runtime.apiSecretName') ||
  websiteDeployment.includes('runtime.workerSecretName') ||
  websiteDeployment.includes('runtime.webSecretName')
) throw new Error('KUBERNETES_WEBSITE_SECRET_REUSE_FORBIDDEN');

const serviceAccount = contents.get('templates/serviceaccount.yaml');
assertIncludes(serviceAccount, [
  'kind: ServiceAccount',
  'automountServiceAccountToken: false',
], 'KUBERNETES_SERVICE_ACCOUNT_INCOMPLETE');
if (serviceAccount.includes('annotations:')) {
  throw new Error('KUBERNETES_SERVICE_ACCOUNT_CLOUD_IDENTITY_FORBIDDEN');
}

assertIncludes(contents.get('templates/services.yaml'), [
  'type: ClusterIP',
  'port: 3001',
  'port: 3000',
  'port: 3002',
  'port: 9464',
], 'KUBERNETES_SERVICES_INCOMPLETE');
assertIncludes(contents.get('templates/pdb.yaml'), [
  'apiVersion: policy/v1',
  'kind: PodDisruptionBudget',
  'apiMinAvailable',
  'workerMinAvailable',
  'webMinAvailable',
  'websiteMinAvailable',
], 'KUBERNETES_PDB_INCOMPLETE');
assertIncludes(contents.get('templates/hpa.yaml'), [
  'apiVersion: autoscaling/v2',
  'kind: HorizontalPodAutoscaler',
  'stabilizationWindowSeconds: 300',
  'averageUtilization:',
], 'KUBERNETES_HPA_INCOMPLETE');
assertIncludes(contents.get('templates/ingress.yaml'), [
  'apiVersion: networking.k8s.io/v1',
  'tlsSecretName',
  'ingressClassName:',
  'pathType: Prefix',
], 'KUBERNETES_INGRESS_INCOMPLETE');
assertIncludes(contents.get('templates/networkpolicy.yaml'), [
  'default-deny',
  'policyTypes: [Ingress, Egress]',
  'dns-egress',
  'gateway-to-',
  'monitoring-to-',
  'backend-private-egress',
  'httpsEgressCidrs',
  'mongodbCidrs',
  'redisCidrs',
  'port: 27017',
  'port: 6379',
  'port: 443',
], 'KUBERNETES_NETWORK_POLICY_INCOMPLETE');

for (const forbidden of [
  /kind:\s*Secret\b/u,
  /stringData:/u,
  /type:\s*(?:NodePort|LoadBalancer)\b/u,
  /(?:image|repository):[^\n]*:latest\b/u,
  /privileged:\s*true/u,
  /hostNetwork:\s*true/u,
  /hostPID:\s*true/u,
  /hostPath:/u,
  /cluster-admin/u,
  /0\.0\.0\.0\/0/u,
]) {
  if (forbidden.test(templates)) throw new Error('KUBERNETES_UNSAFE_TEMPLATE_DETECTED');
}

if (packageDocument.scripts?.['deployment:kubernetes:validate'] !==
  'node scripts/validate-kubernetes-deployment.mjs' ||
  !packageDocument.scripts?.check?.includes('pnpm deployment:kubernetes:validate')) {
  throw new Error('KUBERNETES_PACKAGE_GATE_MISSING');
}

assertIncludes(workflow, [
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
], 'KUBERNETES_CI_GATE_INCOMPLETE');

const renderedPath = process.argv[2];
if (renderedPath !== undefined) {
  const rendered = await readFile(renderedPath, 'utf8');
  const count = (kind) => [...rendered.matchAll(new RegExp(`^kind: ${kind}$`, 'gmu'))].length;

  for (const [kind, expected] of Object.entries({
    Deployment: 4,
    Service: 4,
    ServiceAccount: 1,
    PodDisruptionBudget: 4,
    HorizontalPodAutoscaler: 3,
    Ingress: 1,
    NetworkPolicy: 9,
  })) {
    if (count(kind) !== expected) throw new Error(`KUBERNETES_RENDERED_${kind.toUpperCase()}_COUNT_INVALID`);
  }

  const namespaces = [...rendered.matchAll(/^\s{2}namespace:\s*([^\s]+)\s*$/gmu)]
    .map((match) => match[1]);
  if (namespaces.length !== 26 || new Set(namespaces).size !== 1) {
    throw new Error('KUBERNETES_RENDERED_TARGET_NAMESPACE_INVALID');
  }

  if ([...rendered.matchAll(/^\s*image:\s*"?([^"\s]+)"?$/gmu)].some(
    (match) => !/@sha256:[a-f0-9]{64}$/u.test(match[1] ?? ''),
  )) throw new Error('KUBERNETES_RENDERED_IMAGE_NOT_IMMUTABLE');

  for (const forbidden of [
    /^kind:\s*Secret$/mu,
    /stringData:/u,
    /type:\s*(?:NodePort|LoadBalancer)\b/u,
    /:latest\b/u,
    /privileged:\s*true/u,
    /hostNetwork:\s*true/u,
    /hostPID:\s*true/u,
    /hostPath:/u,
    /cluster-admin/u,
    /0\.0\.0\.0\/0/u,
  ]) {
    if (forbidden.test(rendered)) throw new Error('KUBERNETES_UNSAFE_RENDERED_MANIFEST');
  }
}

process.stdout.write(
  renderedPath === undefined
    ? 'Kubernetes 生产编排静态契约校验通过。\n'
    : 'Kubernetes 生产编排渲染清单校验通过。\n',
);
