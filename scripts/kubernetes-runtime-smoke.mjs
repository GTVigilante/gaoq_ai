import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
} from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath, URL, URLSearchParams } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { catalog as expectedCatalog } from './mcp/validate-phase-5-mcp-catalog.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const docker = process.env.GAOQ_DOCKER_BIN ?? 'docker';
const kind = requiredTool('GAOQ_KIND_BIN');
const kubectl = requiredTool('GAOQ_KUBECTL_BIN');
const helm = requiredTool('GAOQ_HELM_BIN');
const releaseCommit = process.env.GITHUB_SHA ?? '0'.repeat(40);
const nodeImage = requiredEnvironment('GAOQ_KIND_NODE_IMAGE');
const registryImage = requiredEnvironment('GAOQ_KIND_REGISTRY_IMAGE');
const mongoImage = requiredEnvironment('GAOQ_KIND_MONGO_IMAGE');
const redisImage = requiredEnvironment('GAOQ_KIND_REDIS_IMAGE');

assert.match(releaseCommit, /^[a-f0-9]{40}$/u, 'KUBERNETES_SMOKE_RELEASE_COMMIT_INVALID');
for (const [name, image] of Object.entries({ nodeImage, registryImage, mongoImage, redisImage })) {
  assert.match(image, /@sha256:[a-f0-9]{64}$/u, `KUBERNETES_SMOKE_${name.toUpperCase()}_NOT_PINNED`);
}

const clusterName = 'gaoq-runtime-smoke';
const registryName = 'gaoq-kind-registry';
const registryPort = 50_001;
const namespace = 'gaoq-runtime-smoke';
const releaseName = 'gaoq-runtime';
const apiExternalOrigin = 'http://127.0.0.1:30112';
const apiIssuer = 'http://127.0.0.1:3001';
const apiResource = `${apiIssuer}/mcp`;
const allowedOrigin = 'http://127.0.0.1:3010';
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'gaoq-kubernetes-smoke-'));
const cleanupState = { cluster: false, registry: false, forwards: [] };

try {
  await assertPrerequisites();
  await assertTargetsAbsent();
  await startRegistry();
  await createCluster();
  await run(docker, ['network', 'connect', 'kind', registryName]);
  await run(kubectl, ['label', 'node', `${clusterName}-control-plane`,
    'topology.kubernetes.io/zone=kind-zone-a', '--overwrite']);

  const dependencyImages = await publishDependencyImages();
  await deployDependencies(dependencyImages);
  await initializeMongoReplicaSet();

  const images = await buildAndPublishApplicationImages();
  const runtime = await createRuntimeObjects();
  await deployApplication(images, runtime);
  await verifyRuntime(images, runtime);

  process.stdout.write(
    '真实 Kubernetes API、四类生产镜像、Worker、OAuth 与标准 MCP 运行时验证通过。\n',
  );
} catch (error) {
  await collectDiagnostics();
  const reason = error instanceof Error ? error.message : String(error);
  throw new Error(`KUBERNETES_RUNTIME_SMOKE_FAILED: ${reason}`, { cause: error });
} finally {
  await cleanup();
}

/** 校验外部工具存在且版本命令可执行。 */
async function assertPrerequisites() {
  await run(docker, ['version', '--format', '{{.Server.Version}}'], { capture: true });
  await run(kind, ['version'], { capture: true });
  await run(kubectl, ['version', '--client=true', '--output=json'], { capture: true });
  await run(helm, ['version', '--short'], { capture: true });
}

/** 禁止覆盖开发机上同名集群或 Registry。 */
async function assertTargetsAbsent() {
  const clusters = await run(kind, ['get', 'clusters'], { capture: true });
  assert.equal(clusters.split(/\s+/u).includes(clusterName), false,
    'KUBERNETES_SMOKE_CLUSTER_ALREADY_EXISTS');
  const registry = await run(docker, ['ps', '--all', '--filter', `name=^/${registryName}$`,
    '--format', '{{.Names}}'], { capture: true });
  assert.equal(registry.trim(), '', 'KUBERNETES_SMOKE_REGISTRY_ALREADY_EXISTS');
}

/** 启动只绑定回环地址的临时 OCI Registry。 */
async function startRegistry() {
  await run(docker, [
    'run', '--detach', '--name', registryName,
    '--publish', `127.0.0.1:${registryPort}:5000`,
    registryImage,
  ]);
  cleanupState.registry = true;
  await retry('KUBERNETES_SMOKE_REGISTRY_NOT_READY', 30, async () => {
    const response = await fetch(`http://127.0.0.1:${registryPort}/v2/`, {
      signal: AbortSignal.timeout(1_000),
    });
    assert.equal(response.status, 200);
  });
}

/** 创建固定 Kubernetes 版本并配置本地 Registry 镜像端点。 */
async function createCluster() {
  const configurationPath = join(temporaryDirectory, 'kind-config.yaml');
  await writeFile(configurationPath, [
    'kind: Cluster',
    'apiVersion: kind.x-k8s.io/v1alpha4',
    'containerdConfigPatches:',
    '- |-',
    `  [plugins."io.containerd.grpc.v1.cri".registry.mirrors."localhost:${registryPort}"]`,
    `    endpoint = ["http://${registryName}:5000"]`,
    'nodes:',
    '- role: control-plane',
    '',
  ].join('\n'), { mode: 0o600 });
  /** 从创建调用开始即接管这个已确认不存在的精确名称，失败时也必须清理半成品。 */
  cleanupState.cluster = true;
  await run(kind, [
    'create', 'cluster', '--name', clusterName, '--image', nodeImage,
    '--config', configurationPath, '--wait', '180s',
  ]);
}

/** 将固定上游摘要重新发布到回环 Registry，并返回 Registry 自身的不可变摘要。 */
async function publishDependencyImages() {
  const images = {};
  for (const [name, image] of Object.entries({ mongo: mongoImage, redis: redisImage })) {
    await run(docker, ['pull', image]);
    const repository = `localhost:${registryPort}/gaoq-dependencies/${name}`;
    const taggedImage = `${repository}:${releaseCommit}`;
    await run(docker, ['tag', image, taggedImage]);
    await run(docker, ['push', taggedImage]);
    images[name] = await resolveRepoDigest(repository, taggedImage, name);
  }
  return images;
}

/** 部署只服务本次冒烟的单节点 MongoDB Replica Set 与 Redis。 */
async function deployDependencies(images) {
  const objects = [
    {
      apiVersion: 'v1', kind: 'Namespace', metadata: { name: namespace },
    },
    {
      apiVersion: 'v1', kind: 'Service',
      metadata: { name: 'mongo', namespace },
      spec: {
        clusterIP: 'None', selector: { app: 'mongo' },
        ports: [{ name: 'mongodb', port: 27017, targetPort: 27017 }],
      },
    },
    {
      apiVersion: 'apps/v1', kind: 'StatefulSet',
      metadata: { name: 'mongo', namespace },
      spec: {
        serviceName: 'mongo', replicas: 1,
        selector: { matchLabels: { app: 'mongo' } },
        template: {
          metadata: { labels: { app: 'mongo' } },
          spec: {
            automountServiceAccountToken: false,
            containers: [{
              name: 'mongo', image: images.mongo, imagePullPolicy: 'IfNotPresent',
              args: ['mongod', '--replSet', 'rs0', '--bind_ip_all'],
              ports: [{ name: 'mongodb', containerPort: 27017 }],
              readinessProbe: {
                exec: { command: ['mongosh', '--quiet', '--eval',
                  'quit(db.adminCommand({ping:1}).ok === 1 ? 0 : 1)'] },
                periodSeconds: 3, timeoutSeconds: 2, failureThreshold: 20,
              },
              resources: {
                requests: { cpu: '20m', memory: '128Mi' },
                limits: { cpu: '1', memory: '1Gi' },
              },
            }],
          },
        },
      },
    },
    {
      apiVersion: 'v1', kind: 'Service',
      metadata: { name: 'redis', namespace },
      spec: {
        selector: { app: 'redis' },
        ports: [{ name: 'redis', port: 6379, targetPort: 6379 }],
      },
    },
    {
      apiVersion: 'apps/v1', kind: 'Deployment',
      metadata: { name: 'redis', namespace },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: 'redis' } },
        template: {
          metadata: { labels: { app: 'redis' } },
          spec: {
            automountServiceAccountToken: false,
            containers: [{
              name: 'redis', image: images.redis, imagePullPolicy: 'IfNotPresent',
              args: ['redis-server', '--save', '', '--appendonly', 'no'],
              ports: [{ name: 'redis', containerPort: 6379 }],
              readinessProbe: {
                exec: { command: ['redis-cli', 'ping'] },
                periodSeconds: 3, timeoutSeconds: 2, failureThreshold: 20,
              },
              resources: {
                requests: { cpu: '10m', memory: '32Mi' },
                limits: { cpu: '500m', memory: '256Mi' },
              },
            }],
          },
        },
      },
    },
  ];
  const path = await writeJson('dependencies.json', {
    apiVersion: 'v1', kind: 'List', items: objects,
  });
  await run(kubectl, ['apply', '--filename', path]);
  await run(kubectl, ['rollout', 'status', 'statefulset/mongo', '--namespace', namespace,
    '--timeout=180s']);
  await run(kubectl, ['rollout', 'status', 'deployment/redis', '--namespace', namespace,
    '--timeout=120s']);
}

/** 初始化单节点副本集并等待 PRIMARY，确保事务与索引路径可用。 */
async function initializeMongoReplicaSet() {
  const host = `mongo-0.mongo.${namespace}.svc.cluster.local:27017`;
  await run(kubectl, [
    'exec', '--namespace', namespace, 'mongo-0', '--', 'mongosh', '--quiet', '--eval',
    `rs.initiate({_id:'rs0',members:[{_id:0,host:'${host}'}]}).ok`,
  ]);
  await retry('KUBERNETES_SMOKE_MONGO_PRIMARY_NOT_READY', 60, async () => {
    const output = await run(kubectl, [
      'exec', '--namespace', namespace, 'mongo-0', '--', 'mongosh', '--quiet', '--eval',
      'rs.status().myState',
    ], { capture: true });
    assert.equal(output.trim(), '1');
  });
}

/** 构建四类生产目标并推送到临时 Registry，返回不可变 manifest digest。 */
async function buildAndPublishApplicationImages() {
  const images = {};
  for (const { name, target } of [
    { name: 'api', target: 'erp-api' },
    { name: 'worker', target: 'erp-worker' },
    { name: 'web', target: 'erp-web' },
    { name: 'website', target: 'erp-website' },
  ]) {
    const repository = `localhost:${registryPort}/gaoq-os/${name}`;
    const taggedImage = `${repository}:${releaseCommit}`;
    await run(docker, [
      'build', '--target', target,
      '--build-arg', `IMAGE_REVISION=${releaseCommit}`,
      '--build-arg', 'NEXT_PUBLIC_ERP_API_ORIGIN=https://erp.example.invalid',
      '--build-arg', 'NEXT_PUBLIC_WEBSITE_ORIGIN=https://www.example.invalid',
      '--build-arg',
      'NEXT_PUBLIC_MARKETING_CAPTCHA_WIDGET_ORIGIN=https://captcha.example.invalid',
      '--build-arg',
      'NEXT_PUBLIC_MARKETING_CAPTCHA_WIDGET_URL=https://captcha.example.invalid/widget',
      '--build-arg', 'ERP_MOBILE_FRAME_ANCESTORS=https://container.example.invalid',
      '--tag', taggedImage, '.',
    ], { cwd: root });
    await run(docker, ['push', taggedImage]);
    const pinned = await resolveRepoDigest(repository, taggedImage, name);
    const [pinnedRepository, digest] = pinned.split('@');
    assert.match(digest, /^sha256:[a-f0-9]{64}$/u);
    images[name] = { repository: pinnedRepository, digest };
  }
  return images;
}

/** 从本地镜像元数据解析指定 Registry 仓库的不可变摘要。 */
async function resolveRepoDigest(repository, taggedImage, name) {
  const repoDigests = JSON.parse(await run(docker, [
    'image', 'inspect', taggedImage, '--format', '{{json .RepoDigests}}',
  ], { capture: true }));
  assert.equal(Array.isArray(repoDigests), true);
  const pinned = repoDigests.find((item) => item.startsWith(`${repository}@sha256:`));
  assert.equal(typeof pinned, 'string',
    `KUBERNETES_SMOKE_${name.toUpperCase()}_DIGEST_MISSING`);
  return pinned;
}

/** 创建 API、Worker 与两个 Web 应用的临时 ConfigMap/Secret。 */
async function createRuntimeObjects() {
  const clientId = 'kind-mcp-smoke-client';
  const clientSecret = randomBytes(32).toString('base64url');
  const metricsToken = randomBytes(32).toString('base64url');
  const signingKey = generateKeyPairSync('rsa', { modulusLength: 2_048 }).privateKey.export({
    type: 'pkcs8', format: 'pem',
  }).toString();
  const auditKey = randomBytes(32).toString('base64url');
  const now = Date.now();
  const serviceClients = JSON.stringify([{
    clientId,
    clientName: 'Kind MCP 冒烟客户端',
    tenantId: 'kind-smoke-tenant',
    actorId: 'kind-smoke-agent',
    allowedScopes: ['erp:mcp:server:connect'],
    allowedResources: [apiResource],
    roleCodes: ['service-reader'],
    departmentIds: [],
    status: 'active',
    authentication: {
      method: 'client_secret_basic',
      credentials: [{
        credentialId: 'kind-mcp-smoke-credential',
        secretSha256: createHash('sha256').update(clientSecret).digest('base64url'),
        notBefore: new Date(now - 60_000).toISOString(),
        expiresAt: new Date(now + 3_600_000).toISOString(),
        status: 'active',
      }],
    },
  }]);
  const mongoUri = `mongodb://mongo-0.mongo.${namespace}.svc.cluster.local:27017/` +
    'gaoq_kind_smoke?replicaSet=rs0&directConnection=true';
  const apiConfig = {
    NODE_ENV: 'development', PORT: '3001', WEB_ORIGIN: allowedOrigin, LOG_LEVEL: 'warn',
    AUTH_ISSUER: apiIssuer, AUTH_AUDIENCE: 'gaoq-erp', AUTH_RESOURCE: apiResource,
    AUTH_ADDITIONAL_RESOURCES_JSON: '[]',
    AUTH_JWKS_URI: `${apiIssuer}/.well-known/jwks.json`,
    PAYROLL_SYSTEM_MODE: 'external',
    MCP_AUTHORIZATION_SERVER: apiIssuer, MCP_ALLOWED_ORIGINS: allowedOrigin,
    MCP_OAUTH_CLIENTS_JSON: '[]',
  };
  const apiSecrets = {
    MONGODB_URI: mongoUri, REDIS_URL: 'redis://redis:6379/1',
    AUTH_SIGNING_PRIVATE_KEY_BASE64: Buffer.from(signingKey).toString('base64'),
    AUTH_SIGNING_KEY_ID: 'kind-smoke-signing',
    AUDIT_INTEGRITY_KEYS: JSON.stringify({
      activeKeyId: 'kind-smoke-audit',
      keys: [{ keyId: 'kind-smoke-audit', keyBase64url: auditKey, status: 'active' }],
    }),
    METRICS_BEARER_TOKEN: metricsToken,
    MCP_SERVICE_CLIENTS_JSON: serviceClients,
  };
  const workerConfig = {
    NODE_ENV: 'development', LOG_LEVEL: 'warn', WORKER_METRICS_PORT: '9464',
  };
  const workerSecrets = {
    MONGODB_URI: mongoUri, REDIS_URL: 'redis://redis:6379/2',
    AUDIT_INTEGRITY_KEYS: apiSecrets.AUDIT_INTEGRITY_KEYS,
    METRICS_BEARER_TOKEN: metricsToken,
  };
  const webConfig = { NODE_ENV: 'production', ERP_API_ORIGIN: `http://${releaseName}-gaoq-erp-api:3001` };
  const webSecrets = {
    ERP_PORTAL_CLIENT_ID: clientId,
    ERP_PORTAL_CLIENT_SECRET: clientSecret,
    ERP_PORTAL_OAUTH_RESOURCE: apiResource,
  };
  const websiteConfig = {
    NODE_ENV: 'production',
    ERP_API_INTERNAL_ORIGIN: `http://${releaseName}-gaoq-erp-api:3001`,
  };
  const websiteSecrets = { MARKETING_REVALIDATE_SECRET: randomBytes(32).toString('base64url') };
  const items = [
    configMap('gaoq-kind-api-config', apiConfig), secret('gaoq-kind-api-secrets', apiSecrets),
    configMap('gaoq-kind-worker-config', workerConfig),
    secret('gaoq-kind-worker-secrets', workerSecrets),
    configMap('gaoq-kind-web-config', webConfig), secret('gaoq-kind-web-secrets', webSecrets),
    configMap('gaoq-kind-website-config', websiteConfig),
    secret('gaoq-kind-website-secrets', websiteSecrets),
  ];
  const path = await writeJson('runtime-objects.json', { apiVersion: 'v1', kind: 'List', items });
  await run(kubectl, ['apply', '--filename', path]);
  return {
    clientId, clientSecret, metricsToken,
    hashes: {
      api: sha256(apiConfig), worker: sha256(workerConfig),
      contract: sha256({ apiResource, catalog: expectedCatalog }),
      website: sha256(websiteConfig),
      manifest: sha256({ releaseCommit, apiConfig, workerConfig, websiteConfig }),
    },
  };
}

/** 使用生产 Helm Chart 部署全部四个组件并等待滚动就绪。 */
async function deployApplication(images, runtime) {
  const lowResources = {
    requests: { cpu: '10m', memory: '64Mi', 'ephemeral-storage': '16Mi' },
    limits: { cpu: '1', memory: '1Gi', 'ephemeral-storage': '512Mi' },
  };
  const values = {
    targetNamespace: namespace,
    release: {
      commitSha: releaseCommit,
      deploymentManifestHash: runtime.hashes.manifest,
      websitePublicConfigHash: runtime.hashes.website,
      rolloutId: `kind-${releaseCommit.slice(0, 12)}`,
    },
    images: { ...images, pullPolicy: 'IfNotPresent', pullSecrets: [] },
    runtime: {
      apiConfigMapName: 'gaoq-kind-api-config', apiConfigMapHash: runtime.hashes.api,
      apiSecretName: 'gaoq-kind-api-secrets',
      workerConfigMapName: 'gaoq-kind-worker-config',
      workerConfigMapHash: runtime.hashes.worker,
      workerSecretName: 'gaoq-kind-worker-secrets', contractHash: runtime.hashes.contract,
      webConfigMapName: 'gaoq-kind-web-config', webSecretName: 'gaoq-kind-web-secrets',
      websiteConfigMapName: 'gaoq-kind-website-config',
      websiteSecretName: 'gaoq-kind-website-secrets',
    },
    serviceAccount: { name: 'gaoq-kind-runtime' },
    resources: {
      api: lowResources, worker: lowResources, web: lowResources, website: lowResources,
    },
    autoscaling: {
      api: { enabled: false }, web: { enabled: false }, website: { enabled: false },
    },
    ingress: { enabled: false },
    networkPolicy: {
      mongodbCidrs: ['10.244.0.0/16'],
      redisCidrs: ['10.244.0.0/16'],
    },
    topologySpreadKey: 'topology.kubernetes.io/zone',
  };
  const valuesPath = await writeJson('smoke-values.json', values);
  await run(helm, [
    'upgrade', '--install', releaseName, 'deploy/helm/gaoq-erp',
    '--namespace', namespace,
    '--values', 'deploy/helm/gaoq-erp/ci-values.yaml', '--values', valuesPath,
    '--wait', '--timeout', '5m',
  ], { cwd: root });
  for (const component of ['api', 'worker', 'web', 'website']) {
    await run(kubectl, [
      'rollout', 'status', `deployment/${releaseName}-gaoq-erp-${component}`,
      '--namespace', namespace, '--timeout=180s',
    ]);
  }
}

/** 验证运行态安全上下文、健康端点、指标鉴权、OAuth 与 MCP 完整目录。 */
async function verifyRuntime(images, runtime) {
  const deployments = JSON.parse(await run(kubectl, [
    'get', 'deployments', '--namespace', namespace,
    '--selector', `app.kubernetes.io/instance=${releaseName}`, '--output=json',
  ], { capture: true }));
  assert.equal(deployments.items.length, 4);
  for (const deployment of deployments.items) {
    assert.equal(deployment.status.readyReplicas, deployment.spec.replicas);
    assert.equal(deployment.spec.template.spec.automountServiceAccountToken, false);
    for (const container of deployment.spec.template.spec.containers) {
      assert.match(container.image, /@sha256:[a-f0-9]{64}$/u);
      assert.equal(container.securityContext.readOnlyRootFilesystem, true);
      assert.equal(container.securityContext.allowPrivilegeEscalation, false);
    }
  }
  const pods = JSON.parse(await run(kubectl, [
    'get', 'pods', '--namespace', namespace,
    '--selector', `app.kubernetes.io/instance=${releaseName}`, '--output=json',
  ], { capture: true }));
  assert.equal(pods.items.length, 11);
  for (const pod of pods.items) {
    assert.equal(pod.status.phase, 'Running');
    for (const status of pod.status.containerStatuses ?? []) {
      assert.equal(status.ready, true);
      assert.equal(status.restartCount, 0);
    }
  }
  for (const image of Object.values(images)) {
    assert.match(image.digest, /^sha256:[a-f0-9]{64}$/u);
  }

  const forwards = await Promise.all([
    portForward(`${releaseName}-gaoq-erp-api`, '30112:3001'),
    portForward(`${releaseName}-gaoq-erp-worker-metrics`, '30946:9464'),
    portForward(`${releaseName}-gaoq-erp-web`, '30100:3000'),
    portForward(`${releaseName}-gaoq-erp-website`, '30102:3002'),
  ]);
  cleanupState.forwards.push(...forwards);
  await waitStableReady();
  await verifyWebEndpoints();
  await verifyWorkerMetrics(runtime.metricsToken);
  const token = await issueToken(runtime.clientId, runtime.clientSecret);
  await verifyMcpSdk(token);
}

/** 等待 API 连续五秒就绪，避免索引创建期间的瞬时就绪。 */
async function waitStableReady() {
  let readySince;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${apiExternalOrigin}/api/health/ready`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) {
        readySince ??= Date.now();
        if (Date.now() - readySince >= 5_000) return;
      } else readySince = undefined;
    } catch {
      readySince = undefined;
    }
    await setTimeout(250);
  }
  throw new Error('KUBERNETES_SMOKE_API_STABLE_READY_TIMEOUT');
}

/** 验证 API 与两个 Next.js 生产服务可经 Kubernetes Service 访问。 */
async function verifyWebEndpoints() {
  for (const endpoint of [
    `${apiExternalOrigin}/api/health/live`,
    'http://127.0.0.1:30100/',
    'http://127.0.0.1:30102/zh-CN',
  ]) {
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(5_000) });
    assert.equal(response.ok, true, `${endpoint} 返回 ${response.status}`);
  }
}

/** 验证 Worker 指标默认拒绝且只接受专用 Bearer。 */
async function verifyWorkerMetrics(metricsToken) {
  const unauthorized = await fetch('http://127.0.0.1:30946/metrics');
  assert.equal(unauthorized.status, 401);
  const authorized = await fetch('http://127.0.0.1:30946/metrics', {
    headers: { authorization: `Bearer ${metricsToken}` },
  });
  assert.equal(authorized.status, 200);
  assert.match(await authorized.text(), /# HELP /u);
}

/** 使用仅存摘要的 Client Secret 换取资源绑定访问令牌。 */
async function issueToken(clientId, clientSecret) {
  const response = await fetch(`${apiExternalOrigin}/api/auth/oauth/token`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials', resource: apiResource,
      scope: 'erp:mcp:server:connect',
    }),
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(response.status, 200, `OAuth token 端点返回 ${response.status}`);
  const payload = await response.json();
  assert.equal(payload.token_type, 'Bearer');
  assert.equal(payload.scope, 'erp:mcp:server:connect');
  assert.equal(typeof payload.access_token, 'string');
  return payload.access_token;
}

/** 使用官方 MCP SDK 比对四类运行时目录并拒绝 R3 工具。 */
async function verifyMcpSdk(token) {
  const client = new Client({ name: 'gaoq-kind-live-smoke', version: '1.0.0' });
  const authorizedFetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set('authorization', `Bearer ${token}`);
    headers.set('origin', allowedOrigin);
    return fetch(input, { ...init, headers });
  };
  const transport = new StreamableHTTPClientTransport(
    new URL(`${apiExternalOrigin}/mcp`), { fetch: authorizedFetch },
  );
  try {
    await client.connect(transport);
    const [tools, resources, templates, prompts] = await Promise.all([
      client.listTools(), client.listResources(),
      client.listResourceTemplates(), client.listPrompts(),
    ]);
    assert.deepEqual(
      tools.tools.map(({ name }) => name).sort(),
      expectedCatalog.tools.map(({ name }) => name).sort(),
    );
    assert.deepEqual(
      resources.resources.map(({ name, uri }) => `${name}\0${uri}`).sort(),
      expectedCatalog.resources.map(({ name, uri }) => `${name}\0${uri}`).sort(),
    );
    assert.deepEqual(
      templates.resourceTemplates.map(({ name, uriTemplate }) =>
        `${name}\0${uriTemplate}`).sort(),
      expectedCatalog.resourceTemplates.map(({ name, uriTemplate }) =>
        `${name}\0${uriTemplate}`).sort(),
    );
    assert.deepEqual(
      prompts.prompts.map(({ name }) => name).sort(),
      expectedCatalog.prompts.map(({ name }) => name).sort(),
    );
    const toolNames = new Set(tools.tools.map(({ name }) => name));
    for (const forbidden of [
      'treasury_disbursement_submit', 'treasury_bank_account_attest',
      'payroll_tax_filing_submit', 'payroll_period_lock',
    ]) assert.equal(toolNames.has(forbidden), false);
  } finally {
    await client.close();
  }
}

/** 启动仅绑定回环的 kubectl port-forward。 */
async function portForward(service, mapping) {
  const child = spawn(kubectl, [
    'port-forward', '--namespace', namespace, `service/${service}`, mapping,
    '--address', '127.0.0.1',
  ], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks = [];
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => chunks.push(String(chunk)));
  }
  await retry(`KUBERNETES_SMOKE_PORT_FORWARD_FAILED:${service}`, 40, async () => {
    assert.equal(child.exitCode, null, chunks.join('').slice(-2_000));
    assert.match(chunks.join(''), /Forwarding from 127\.0\.0\.1/u);
  });
  return child;
}

/** 失败时输出有界的非 Secret Kubernetes 状态。 */
async function collectDiagnostics() {
  if (!cleanupState.cluster) return;
  for (const args of [
    ['get', 'pods', '--namespace', namespace, '--output=wide'],
    ['get', 'events', '--namespace', namespace, '--sort-by=.lastTimestamp'],
  ]) {
    try {
      const output = await run(kubectl, args, { capture: true, allowFailure: true });
      process.stderr.write(`${output.slice(-12_000)}\n`);
    } catch {
      /** 诊断失败不得覆盖原始异常。 */
    }
  }
  try {
    const document = JSON.parse(await run(kubectl, [
      'get', 'pods', '--namespace', namespace, '--output=json',
    ], { capture: true, allowFailure: true }));
    for (const pod of document.items ?? []) {
      for (const container of pod.spec?.containers ?? []) {
        for (const previous of [false, true]) {
          const output = await run(kubectl, [
            'logs', '--namespace', namespace, pod.metadata.name,
            '--container', container.name, '--tail=100',
            ...(previous ? ['--previous'] : []),
          ], { capture: true, allowFailure: true });
          if (output.trim() !== '') process.stderr.write(
            `POD_LOG:${pod.metadata.name}:${container.name}:${previous ? 'previous' : 'current'}\n` +
            `${output.slice(-12_000)}\n`,
          );
        }
      }
    }
  } catch {
    /** 容器日志诊断失败不得覆盖原始异常。 */
  }
}

/** 清理本脚本创建的精确资源，保留任何预先存在的用户资源。 */
async function cleanup() {
  for (const child of cleanupState.forwards) {
    if (child.exitCode === null) child.kill('SIGTERM');
  }
  if (cleanupState.cluster) {
    await run(kind, ['delete', 'cluster', '--name', clusterName], { allowFailure: true });
  }
  if (cleanupState.registry) {
    await run(docker, ['rm', '--force', registryName], { allowFailure: true });
  }
  await rm(temporaryDirectory, { recursive: true, force: true });
}

/** 执行子进程并按需返回有界输出。 */
async function run(command, args, options = {}) {
  const { allowFailure = false, capture = false, cwd = root } = options;
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    const chunks = [];
    if (capture) {
      for (const stream of [child.stdout, child.stderr]) {
        stream.setEncoding('utf8');
        stream.on('data', (chunk) => {
          chunks.push(String(chunk));
          if (chunks.join('').length > 1_000_000) chunks.shift();
        });
      }
    }
    child.once('error', reject);
    child.once('exit', (code) => {
      const output = chunks.join('');
      if (code === 0 || allowFailure) resolve(output);
      else reject(new Error(`COMMAND_FAILED:${command}:${code}:${output.slice(-4_000)}`));
    });
  });
}

/** 有界重试瞬时就绪条件。 */
async function retry(code, attempts, operation) {
  let cause;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await operation();
      return;
    } catch (error) {
      cause = error;
      await setTimeout(500);
    }
  }
  throw new Error(code, { cause });
}

/** 生成命名空间内 ConfigMap。 */
function configMap(name, data) {
  return { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name, namespace }, data };
}

/** 生成命名空间内 Secret，值只进入临时文件。 */
function secret(name, values) {
  return {
    apiVersion: 'v1', kind: 'Secret', type: 'Opaque',
    metadata: { name, namespace },
    data: Object.fromEntries(Object.entries(values)
      .map(([key, value]) => [key, Buffer.from(value).toString('base64')])),
  };
}

/** 写入权限收紧的临时 JSON 文件。 */
async function writeJson(name, value) {
  const path = join(temporaryDirectory, name);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  return path;
}

/** 生成确定性的 sha256 注解值。 */
function sha256(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

/** 读取必填工具路径。 */
function requiredTool(name) {
  return requiredEnvironment(name);
}

/** 读取必填环境变量且拒绝空白。 */
function requiredEnvironment(name) {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') throw new Error(`${name}_REQUIRED`);
  return value;
}
