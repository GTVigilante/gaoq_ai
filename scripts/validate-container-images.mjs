import { readFile } from 'node:fs/promises';

const dockerfile = await readFile(new URL('../Dockerfile', import.meta.url), 'utf8');
const dockerignore = await readFile(new URL('../.dockerignore', import.meta.url), 'utf8');
const workflow = await readFile(
  new URL('../.github/workflows/phase-5-security.yml', import.meta.url), 'utf8',
);
const dependabot = await readFile(new URL('../.github/dependabot.yml', import.meta.url), 'utf8');

for (const marker of [
  'node:22.23.1-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3',
  'gcr.io/distroless/nodejs22-debian13:nonroot@sha256:a2723a2817c5b01b8e7b98d567bc8b5a6b0e713e25bfb0a82b6ade4b9db06f50',
  'FROM runtime-base AS erp-api',
  'FROM runtime-base AS erp-worker',
  'FROM runtime-base AS erp-web',
  'USER 65532:65532',
  'org.opencontainers.image.revision',
  'NEXT_PUBLIC_ERP_API_ORIGIN',
  'ERP_MOBILE_FRAME_ANCESTORS',
]) {
  if (!dockerfile.includes(marker)) throw new Error('PHASE5_CONTAINER_BASELINE_INCOMPLETE');
}

if ((dockerfile.match(/^HEALTHCHECK /gmu) ?? []).length !== 3 ||
  /^USER\s+(?:0|root)(?::|\s|$)/mu.test(dockerfile)) {
  throw new Error('PHASE5_CONTAINER_RUNTIME_POLICY_INVALID');
}

for (const marker of [
  '.git', '.env.*', '**/.next', '**/dist', '**/node_modules', 'wordpress backup',
]) {
  if (!dockerignore.split('\n').includes(marker)) throw new Error('PHASE5_CONTAINER_CONTEXT_EXPOSED');
}

for (const marker of [
  'container-images:',
  'target: erp-api',
  'target: erp-worker',
  'target: erp-web',
  '--build-arg ERP_MOBILE_FRAME_ANCESTORS=https://container.example.invalid',
  "test \"$configured_user\" = '65532:65532'",
  'artifact-name: gaoq-os-${{ matrix.image }}-sbom',
  'image-ref: gaoq-os/${{ matrix.image }}:${{ github.sha }}',
]) {
  if (!workflow.includes(marker)) throw new Error('PHASE5_CONTAINER_CI_GATE_INCOMPLETE');
}

if (!/- package-ecosystem: docker\n\s+directory: \/$/mu.test(dependabot)) {
  throw new Error('PHASE5_CONTAINER_UPDATE_POLICY_MISSING');
}

process.stdout.write('Phase 5 生产镜像与镜像安全门禁校验通过。\n');
