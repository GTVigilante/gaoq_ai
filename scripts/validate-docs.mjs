import { access, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requiredDocuments = [
  'README.md',
  'AGENTS.md',
  'CODEX.md',
  '.codex/AGENTS.md',
  'PRD-告趣ERP系统-v1.0.md',
  'docs/phase-0/README.md',
  'docs/phase-0/00-program-charter.md',
  'docs/phase-0/01-enterprise-architecture.md',
  'docs/phase-0/02-domain-data-standard.md',
  'docs/phase-0/03-integration-standard.md',
  'docs/phase-0/04-mcp-service-standard.md',
  'docs/phase-0/05-security-quality-cutover.md',
  'docs/phase-0/06-github-governance.md',
  'docs/implementation-completion-audit.md',
  'docs/phase-1/README.md',
  'docs/phase-2/README.md',
  'docs/phase-3/README.md',
  'docs/phase-4/README.md',
  'docs/phase-5/README.md',
  'docs/phase-6/README.md',
  'docs/phase-6/00-unified-cutover-contract.md',
  'docs/phase-6/01-hypercare-archive-contract.md',
  'docs/phase-6/02-production-execution-runbook.md',
  'docs/phase-6/03-production-execution-authorization.md',
  'docs/phase-6/04-kubernetes-deployment-baseline.md',
  'docs/phase-6/05-protected-production-deployment.md',
  'docs/phase-6/06-kubernetes-platform-guardrails.md',
  'docs/phase-6/07-production-platform-intake.md',
  'deploy/helm/gaoq-erp/README.md',
  'deploy/helm/gaoq-platform-guardrails/README.md',
  'scripts/github/validate-repository-governance.mjs',
  '.github/workflows/github-governance.yml',
];

const forbiddenPrdPatterns = [
  /"type":\s*"sse"/u,
  /\/mcp\/sse/u,
  /HTTP 200但业务失败/u,
  /X-Tenant-Id:\s*gaoq/u,
  /MCP Server（SSE模式）/u,
];

const governanceDocuments = ['AGENTS.md', 'CODEX.md', '.codex/AGENTS.md'];
const forbiddenGovernancePatterns = [
  /Phase 0执行中/u,
  /尚无应用脚手架/u,
  /当前仓库处于 Phase 0/u,
  /尚无可运行应用源码/u,
];

const requiredGovernanceMarkers = new Map([
  ['AGENTS.md', ['Phase 0–6', '真实联调', '标准 MCP']],
  ['CODEX.md', ['Phase 0–6', 'pnpm check', '生产完成', '.codex/AGENTS.md']],
  ['.codex/AGENTS.md', ['../AGENTS.md', '../CODEX.md', 'wordpress backup/', 'R3']],
]);

const deliveryBoundaryDocuments = [
  'docs/phase-0/06-github-governance.md',
  'docs/implementation-completion-audit.md',
  'docs/phase-3/README.md',
];
const forbiddenDeliveryBoundaryPatterns = [
  /状态更正/u,
  /校友下游数据删除证明仍未交付/u,
];
const requiredDeliveryBoundaryMarkers = new Map([
  ['docs/phase-0/06-github-governance.md',
    ['status:implementation-delivered', 'status:external-acceptance', 'Issue #41']],
  ['docs/implementation-completion-audit.md',
    ['仓库实施已交付', '外部验收待完成', '生产完成', 'PAYROLL_SYSTEM_MODE=external']],
  ['docs/phase-3/README.md',
    ['Phase 3 只能标记“代码已交付”', '不得标记生产完成']],
]);
const requiredRepositoryGovernanceMarkers = new Map([
  [
    'docs/phase-0/06-github-governance.md',
    [
      '.github/workflows/github-governance.yml',
      'github:governance:validate',
      'GOV-*',
    ],
  ],
  [
    '.github/workflows/github-governance.yml',
    [
      'issues: read',
      'pull-requests: read',
      'validate-repository-governance.mjs --self-test',
    ],
  ],
  [
    'scripts/github/validate-repository-governance.mjs',
    [
      'GOV-PR-ISSUE-MISSING',
      'GOV-ISSUE-PHASE-MISMATCH',
      'GOV-EPIC-CHILD-OPEN',
    ],
  ],
]);

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

for (const relativePath of governanceDocuments) {
  try {
    const content = await readFile(resolve(repoRoot, relativePath), 'utf8');
    for (const pattern of forbiddenGovernancePatterns) {
      if (pattern.test(content)) {
        errors.push(`${relativePath}: 仍包含过期系统状态 ${pattern}`);
      }
    }
    for (const marker of requiredGovernanceMarkers.get(relativePath) ?? []) {
      if (!content.includes(marker)) {
        errors.push(`${relativePath}: 缺少治理状态标记 ${marker}`);
      }
    }
  } catch {
    // 缺失文件已在上一阶段报告。
  }
}

for (const relativePath of deliveryBoundaryDocuments) {
  try {
    const content = await readFile(resolve(repoRoot, relativePath), 'utf8');
    for (const pattern of forbiddenDeliveryBoundaryPatterns) {
      if (pattern.test(content)) {
        errors.push(`${relativePath}: 仍包含自相矛盾的交付状态 ${pattern}`);
      }
    }
    for (const marker of requiredDeliveryBoundaryMarkers.get(relativePath) ?? []) {
      if (!content.includes(marker)) {
        errors.push(`${relativePath}: 缺少交付边界标记 ${marker}`);
      }
    }
  } catch {
    // 缺失文件已在第一阶段报告。
  }
}

for (const [relativePath, markers] of requiredRepositoryGovernanceMarkers) {
  try {
    const content = await readFile(resolve(repoRoot, relativePath), 'utf8');
    for (const marker of markers) {
      if (!content.includes(marker)) {
        errors.push(`${relativePath}: 缺少 GitHub 治理门禁标记 ${marker}`);
      }
    }
  } catch {
    // 缺失文件已在第一阶段报告。
  }
}

if (errors.length > 0) {
  for (const error of errors) {
    process.stderr.write(`${error}\n`);
  }
  process.exitCode = 1;
} else {
  process.stdout.write('项目文档结构、相对链接、治理状态和关键规范校验通过。\n');
}
