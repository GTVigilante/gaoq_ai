import { access, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requiredDocuments = [
  'README.md',
  'PRD-告趣ERP系统-v1.0.md',
  'docs/phase-0/README.md',
  'docs/phase-0/00-program-charter.md',
  'docs/phase-0/01-enterprise-architecture.md',
  'docs/phase-0/02-domain-data-standard.md',
  'docs/phase-0/03-integration-standard.md',
  'docs/phase-0/04-mcp-service-standard.md',
  'docs/phase-0/05-security-quality-cutover.md',
  'docs/phase-0/06-github-governance.md',
  'docs/phase-6/README.md',
  'docs/phase-6/00-unified-cutover-contract.md',
  'docs/phase-6/01-hypercare-archive-contract.md',
  'docs/phase-6/02-production-execution-runbook.md',
  'docs/phase-6/03-production-execution-authorization.md',
  'docs/phase-6/04-kubernetes-deployment-baseline.md',
  'docs/phase-6/05-protected-production-deployment.md',
  'docs/phase-6/06-kubernetes-platform-guardrails.md',
  'deploy/helm/gaoq-erp/README.md',
  'deploy/helm/gaoq-platform-guardrails/README.md',
];

const forbiddenPrdPatterns = [
  /"type":\s*"sse"/u,
  /\/mcp\/sse/u,
  /HTTP 200但业务失败/u,
  /X-Tenant-Id:\s*gaoq/u,
  /MCP Server（SSE模式）/u,
];

/**
 * 判断Markdown链接是否为需要在仓库内校验的相对文件。
 *
 * @param {string} target Markdown链接目标
 * @returns {boolean} 是否需要校验
 */
function isLocalTarget(target) {
  return !/^(?:https?:|mailto:|#)/u.test(target);
}

/**
 * 校验单个Markdown文件中的相对链接。
 *
 * @param {string} relativePath 仓库相对路径
 * @returns {Promise<string[]>} 错误列表
 */
async function validateLinks(relativePath) {
  const absolutePath = resolve(repoRoot, relativePath);
  const content = await readFile(absolutePath, 'utf8');
  const errors = [];
  const linkPattern = /\[[^\]]*\]\(([^)]+)\)/gu;

  for (const match of content.matchAll(linkPattern)) {
    const rawTarget = match[1].trim().replace(/^<|>$/gu, '');
    const target = rawTarget.split('#', 1)[0];
    if (!target || !isLocalTarget(target)) {
      continue;
    }

    const decodedTarget = decodeURIComponent(target);
    const linkedPath = resolve(dirname(absolutePath), decodedTarget);
    try {
      await access(linkedPath);
    } catch {
      errors.push(`${relativePath}: 无效相对链接 ${rawTarget}`);
    }
  }

  return errors;
}

const errors = [];
for (const relativePath of requiredDocuments) {
  try {
    await access(resolve(repoRoot, relativePath));
  } catch {
    errors.push(`缺少强制文档：${relativePath}`);
  }
}

for (const relativePath of requiredDocuments) {
  try {
    errors.push(...await validateLinks(relativePath));
  } catch {
    // 缺失文件已在上一阶段报告。
  }
}

try {
  const prd = await readFile(resolve(repoRoot, 'PRD-告趣ERP系统-v1.0.md'), 'utf8');
  for (const pattern of forbiddenPrdPatterns) {
    if (pattern.test(prd)) {
      errors.push(`PRD仍包含废弃规范：${pattern}`);
    }
  }
} catch {
  // 缺失文件已在上一阶段报告。
}

if (errors.length > 0) {
  for (const error of errors) {
    process.stderr.write(`${error}\n`);
  }
  process.exitCode = 1;
} else {
  process.stdout.write('Phase 0 文档结构、相对链接和关键规范校验通过。\n');
}
