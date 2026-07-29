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
  'docs/phase-0/07-payroll-system-boundary.md',
  'docs/phase-0/08-data-processing-register.md',
  'docs/phase-0/09-threat-model.md',
  'docs/phase-0/10-openapi-contract.md',
  'contracts/openapi/erp-api.openapi.json',
  'scripts/contracts/generate-openapi.mjs',
  'docs/adr/README.md',
  'docs/adr/0001-modular-monolith-and-runtime.md',
  'docs/adr/0002-erp-master-data-and-platform-adapters.md',
  'docs/adr/0003-standard-mcp-service-boundary.md',
  'docs/adr/0004-professional-payroll-system-boundary.md',
  'docs/adr/0005-github-hosted-oidc-delivery.md',
  'docs/adr/0006-unified-cutover-and-evidence-gates.md',
  'docs/implementation-completion-audit.md',
  'apps/erp-api/src/modules/integration/adapters/README.md',
  'apps/erp-api/src/modules/integration/adapters/dingtalk/mapping.md',
  'apps/erp-api/src/modules/integration/adapters/feishu/mapping.md',
  'apps/erp-api/src/modules/integration/adapters/op/mapping.md',
  'apps/erp-api/src/modules/integration/adapters/esign/mapping.md',
  'apps/erp-api/src/modules/integration/adapters/recruitment/mapping.md',
  'apps/erp-api/src/modules/integration/adapters/bank-file/mapping.md',
  'apps/erp-api/src/modules/integration/adapters/tax-file/mapping.md',
  'apps/erp-api/src/modules/integration/adapters/notification/mapping.md',
  'docs/phase-1/README.md',
  'docs/phase-2/README.md',
  'docs/phase-3/README.md',
  'docs/phase-4/README.md',
  'docs/phase-5/README.md',
  'docs/phase-5/12-data-migration-rehearsal-gate.md',
  'docs/phase-5/15-performance-capacity-gate.md',
  'docs/phase-5/16-dast-asvs-gate.md',
  'docs/phase-5/17-resilience-rehearsal-gate.md',
  'docs/phase-5/18-go-no-go-evidence-gate.md',
  'docs/phase-5/19-mcp-capability-catalog.md',
  'docs/phase-5/20-mcp-stdio-client-onboarding.md',
  'docs/phase-5/21-github-oidc-evidence-exchange.md',
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
  'scripts/github/fetch-oidc-protected-input.mjs',
  'scripts/github/github-oidc-kubernetes-credential.mjs',
  'scripts/github/write-oidc-kubeconfig.mjs',
  'scripts/performance/validate-phase-5-capacity.mjs',
  'scripts/migration/validate-phase-5-migration-rehearsal-evidence.mjs',
  'scripts/mcp/validate-phase-5-mcp-integration-evidence.mjs',
  'scripts/security/validate-phase-5-dast-evidence.mjs',
  'scripts/resilience/validate-phase-5-resilience-evidence.mjs',
  'scripts/release/validate-phase-6-cutover-evidence.mjs',
  'scripts/release/validate-phase-6-hypercare-evidence.mjs',
  'scripts/release/validate-phase-6-deployment-authorization.mjs',
  'scripts/release/validate-phase-6-platform-intake.mjs',
  'scripts/mcp/validate-kimi-mcp-client.mjs',
  'scripts/mcp/validate-mcp-inspector-client.mjs',
  'apps/erp-api/scripts/mcp-catalog-stdio-fixture.mjs',
  'tools/mcp-inspector-client/package.json',
  '.github/workflows/github-governance.yml',
  '.github/workflows/phase-5-performance.yml',
  '.github/workflows/phase-5-dast-evidence.yml',
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
  [
    '.codex/AGENTS.md',
    [
      '../AGENTS.md',
      '../CODEX.md',
      'wordpress backup/',
      'R3',
      '50 个 Tool',
      '27 Resource Template',
      '25 Prompt',
    ],
  ],
]);

const deliveryBoundaryDocuments = [
  'docs/phase-0/06-github-governance.md',
  'docs/implementation-completion-audit.md',
  'docs/phase-3/README.md',
  'docs/phase-4/05-payroll-core-implementation.md',
];
const forbiddenDeliveryBoundaryPatterns = [
  /状态更正/u,
  /校友下游数据删除证明仍未交付/u,
  /补充\/冲正和年度汇算是旧 ERP 算薪基线的未实现能力/u,
  /它不包含审批锁定、工资单、银行代发或税务申报/u,
];
const requiredDeliveryBoundaryMarkers = new Map([
  ['docs/phase-0/06-github-governance.md',
    ['status:implementation-delivered', 'status:external-acceptance', 'Issue #41']],
  ['docs/implementation-completion-audit.md',
    [
      '仓库实施已交付',
      '外部验收待完成',
      '生产完成',
      'PAYROLL_SYSTEM_MODE=external',
      '工资调整收付与税务结算闭环',
    ]],
  ['docs/phase-3/README.md',
    ['Phase 3 只能标记“代码已交付”', '不得标记生产完成']],
  ['docs/phase-4/05-payroll-core-implementation.md',
    [
      '后续 Phase 4 切片交付',
      '月中薪酬变更与跨法域自然日拆分已实现',
      '锁定工资的确定性差额',
      '不属于 ERP 自动执行范围',
    ]],
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
      'GOV-STORY-CONTRACT-SURFACES',
    ],
  ],
]);
const requiredAdapterMappingMarkers = new Map([
  [
    'apps/erp-api/src/modules/integration/adapters/README.md',
    ['dingtalk/mapping.md', 'feishu/mapping.md', 'op/mapping.md', '外部验收待完成'],
  ],
  [
    'apps/erp-api/src/modules/integration/adapters/dingtalk/mapping.md',
    ['source_identifier', 'externalEventId', 'x-client-token'],
  ],
  [
    'apps/erp-api/src/modules/integration/adapters/feishu/mapping.md',
    ['department_id', 'externalEventId', 'idempotency_key'],
  ],
  [
    'apps/erp-api/src/modules/integration/adapters/op/mapping.md',
    ['schemaVersion="1.0"', 'erpEmployeeId', 'HMAC-SHA-256'],
  ],
  [
    'apps/erp-api/src/modules/integration/adapters/esign/mapping.md',
    ['signFlowExpireTime', 'PROVIDER_COMPLETED', 'AES-256-GCM'],
  ],
  [
    'apps/erp-api/src/modules/integration/adapters/recruitment/mapping.md',
    ['externalApplicationId', 'attachmentReferences', 'not_committed'],
  ],
  [
    'apps/erp-api/src/modules/integration/adapters/bank-file/mapping.md',
    ['productionAuthorization', 'signatureEvidenceId', 'MCP'],
  ],
  [
    'apps/erp-api/src/modules/integration/adapters/tax-file/mapping.md',
    ['settlementUrl', 'Ed25519', '最小幂等账本'],
  ],
  [
    'apps/erp-api/src/modules/integration/adapters/notification/mapping.md',
    ['externalMessageId', 'recipientRef', '短信和邮件'],
  ],
]);
const requiredDataProcessingRegisterMarkers = new Map([
  [
    'docs/phase-0/08-data-processing-register.md',
    [
      '收集/处理目的',
      '依据（待现场确认）',
      '来源',
      '共享对象',
      '存储位置',
      '保留与删除/匿名化',
      '负责人',
      'MCP/OAuth 调用、确认账本和客户端目录证据',
      '任何未签署活动',
    ],
  ],
]);
const requiredAdrMarkers = new Map([
  ['docs/adr/0001-modular-monolith-and-runtime.md',
    ['状态：accepted', '## 背景', '## 决策', '## 后果', '## 被否决方案', '## 安全与数据影响']],
  ['docs/adr/0002-erp-master-data-and-platform-adapters.md',
    ['状态：accepted', 'ERP 是员工', '钉钉和飞书', '## 被否决方案']],
  ['docs/adr/0003-standard-mcp-service-boundary.md',
    ['状态：accepted', 'MCP `2025-11-25`', 'R3 永久不注册', '## 被否决方案']],
  ['docs/adr/0004-professional-payroll-system-boundary.md',
    ['状态：accepted', '唯一生产事实源', 'PAYROLL_SYSTEM_MODE=external', '## 被否决方案']],
  ['docs/adr/0005-github-hosted-oidc-delivery.md',
    ['状态：accepted', 'GitHub Hosted', '相同 commit 不重复空跑', '## 被否决方案']],
  ['docs/adr/0006-unified-cutover-and-evidence-gates.md',
    ['状态：accepted', '连续 28 天 Hypercare', 'Ed25519', '## 被否决方案']],
]);
const requiredThreatModelMarkers = new Map([
  [
    'docs/phase-0/09-threat-model.md',
    [
      'STRIDE',
      '## 2. 关键资产',
      '## 3. 信任边界',
      'TM-001',
      'TM-020',
      'Prompt injection',
      'GitHub Hosted OIDC',
      'Phase 0 退出需要架构、安全和业务',
    ],
  ],
]);
const requiredOpenApiContractMarkers = new Map([
  [
    'docs/phase-0/10-openapi-contract.md',
    [
      'contracts/openapi/erp-api.openapi.json',
      'pnpm contracts:openapi:validate',
      '47',
      '225',
      '231',
      'x-typescript-type',
      'GitHub Hosted Actions',
    ],
  ],
  [
    'scripts/contracts/generate-openapi.mjs',
    [
      "openapi: '3.1.0'",
      'x-required-scopes',
      'x-operation-count',
      'OpenAPI 契约已漂移',
    ],
  ],
  [
    'contracts/openapi/erp-api.openapi.json',
    [
      '"openapi": "3.1.0"',
      '"x-controller-count": 47',
      '"x-route-declaration-count": 225',
      '"x-operation-count": 231',
    ],
  ],
  [
    'package.json',
    [
      '"contracts:openapi:generate"',
      '"contracts:openapi:self-test"',
      '"contracts:openapi:validate"',
      '"pretypecheck"',
    ],
  ],
]);
const requiredMcpClientCompatibilityMarkers = new Map([
  [
    'docs/phase-5/20-mcp-stdio-client-onboarding.md',
    [
      'mcp:client:kimi:run',
      'mcp:client:inspector:run',
      'Kimi Code CLI 0.28.1',
      'MCP Inspector CLI 2.0.0',
      '不调用模型',
      '仍保持 No-Go',
    ],
  ],
  [
    'scripts/mcp/validate-kimi-mcp-client.mjs',
    [
      'gaoq.mcp.client.kimi.v1',
      'session/new',
      '/mcp',
      'modelInvoked: false',
    ],
  ],
  [
    'scripts/mcp/validate-mcp-inspector-client.mjs',
    [
      'gaoq.mcp.client.inspector.v1',
      'resources/templates/list',
      'runtimeContractHash',
      'modelInvoked: false',
    ],
  ],
  [
    'tools/mcp-inspector-client/package.json',
    [
      '@modelcontextprotocol/inspector',
      '2.0.0',
      '>=22.19.0',
    ],
  ],
  [
    'apps/erp-api/scripts/mcp-catalog-stdio-fixture.mjs',
    [
      'McpRuntimeService',
      'McpAuthenticatedStdioTransport',
      'MCP_CLIENT_FIXTURE_TOOL_CALL_FORBIDDEN',
    ],
  ],
]);
const requiredHostedOidcMarkers = new Map([
  [
    'docs/phase-5/21-github-oidc-evidence-exchange.md',
    [
      'GitHub Hosted `ubuntu-latest`',
      '`id-token: write`',
      '`runner_environment`',
      'X-GaoQ-Content-SHA256',
      'ExecCredential',
      '最长有效期 15 分钟',
    ],
  ],
  [
    'scripts/github/fetch-oidc-protected-input.mjs',
    [
      'gaoq.github.oidc-protected-input.receipt.v1',
      'runner_environment',
      'github-hosted',
      'x-gaoq-content-sha256',
      "mode: 0o600",
    ],
  ],
  [
    'scripts/github/github-oidc-kubernetes-credential.mjs',
    [
      'client.authentication.k8s.io/v1',
      'MAX_CREDENTIAL_SECONDS',
      'PHASE6_KUBERNETES_CREDENTIAL_URL',
    ],
  ],
  [
    'scripts/github/write-oidc-kubeconfig.mjs',
    [
      'staticCredentialWritten: false',
      'certificate-authority-data',
      'github-oidc-kubernetes-credential.mjs',
    ],
  ],
  [
    'scripts/performance/validate-phase-5-capacity.mjs',
    [
      'gaoq.phase5.capacity.v2',
      'gaoq.phase5.capacity.contract',
      'gaoq.phase5.capacity.signoff.v1',
      'signerKeysetHash',
      'approvalPayloadHash',
      'Ed25519',
      'performance_owner',
      'security_owner',
      'PERFORMANCE_EXPECTED_SIGNER_KEYSET_SHA256',
    ],
  ],
  [
    'docs/phase-5/15-performance-capacity-gate.md',
    [
      'gaoq.phase5.capacity.v2',
      '不同 Ed25519 公钥',
      'PERFORMANCE_SIGNER_KEYSET_SHA256',
      '72 小时内',
      'KMS/HSM',
      'performance:print-contract',
      'phase-5-performance',
    ],
  ],
  [
    'scripts/migration/validate-phase-5-migration-rehearsal-evidence.mjs',
    [
      'gaoq.phase5.migration-rehearsal.v2',
      'gaoq.phase5.migration-rehearsal.signoff.v1',
      'signerKeysetHash',
      'Ed25519',
      'architecture_owner',
      'security_owner',
      'MIGRATION_REHEARSAL_EXPECTED_SIGNER_KEYSET_SHA256',
    ],
  ],
  [
    'docs/phase-5/12-data-migration-rehearsal-gate.md',
    [
      'gaoq.phase5.migration-rehearsal.v2',
      '不同 Ed25519 公钥',
      'MIGRATION_REHEARSAL_SIGNER_KEYSET_SHA256',
      '24 小时内',
      'KMS/HSM',
    ],
  ],
  [
    'scripts/security/validate-phase-5-dast-evidence.mjs',
    [
      'gaoq.phase5.dast-asvs.v2',
      'gaoq.phase5.dast-asvs.contract',
      'gaoq.phase5.dast-asvs.signoff.v1',
      'signerKeysetHash',
      'approvalPayloadHash',
      'Ed25519',
      'appsec_owner',
      'risk_owner',
      'DAST_EXPECTED_SIGNER_KEYSET_SHA256',
    ],
  ],
  [
    'docs/phase-5/16-dast-asvs-gate.md',
    [
      'gaoq.phase5.dast-asvs.v2',
      '不同 Ed25519 公钥',
      'DAST_SIGNER_KEYSET_SHA256',
      '72 小时内',
      'KMS/HSM',
      'security:dast:print-contract',
      'phase-5-dast-evidence',
    ],
  ],
  [
    'scripts/mcp/validate-phase-5-mcp-integration-evidence.mjs',
    [
      'gaoq.phase5.integration-mcp.v3',
      'gaoq.phase5.integration-mcp.contract',
      'gaoq.phase5.integration-mcp.signoff.v1',
      'signerKeysetHash',
      'approvalPayloadHash',
      'Ed25519',
      'integration_owner',
      'mcp_owner',
      'security_owner',
      'MCP_INTEGRATION_EXPECTED_SIGNER_KEYSET_SHA256',
      'PHASE5_MCP_INTEGRATION_EVIDENCE_JSON_INVALID',
    ],
  ],
  [
    'docs/phase-5/19-mcp-capability-catalog.md',
    [
      'integration-mcp` v3',
      '不同 Ed25519 公钥',
      'MCP_INTEGRATION_SIGNER_KEYSET_SHA256',
      '24 小时内',
      'KMS/HSM',
      'mcp:integration:print-contract',
    ],
  ],
  [
    'scripts/resilience/validate-phase-5-resilience-evidence.mjs',
    [
      'gaoq.phase5.resilience.v4',
      'gaoq.phase5.resilience.contract',
      'gaoq.phase5.resilience.signoff.v1',
      'signerKeysetHash',
      'Ed25519',
      'business_continuity_owner',
      'sre_owner',
      'RESILIENCE_EXPECTED_SIGNER_KEYSET_SHA256',
      'RESILIENCE_EXPECTED_PAYROLL_CATALOG_HASH',
      'payroll_payslip_get_self',
      '--print-contract',
    ],
  ],
  [
    'docs/phase-5/17-resilience-rehearsal-gate.md',
    [
      'gaoq.phase5.resilience.v4',
      '七类负责人',
      '不同 Ed25519 公钥',
      'RESILIENCE_SIGNER_KEYSET_SHA256',
      '24 小时内',
      'KMS/HSM',
      'resilience:print-contract',
      '独立专业算薪',
      'RESILIENCE_PAYROLL_CATALOG_HASH',
    ],
  ],
  [
    'scripts/release/validate-phase-5-go-no-go-evidence.mjs',
    [
      'gaoq.phase5.go-no-go.v3',
      'gaoq.phase5.go-no-go.signoff.v1',
      'resilienceProfessionalPayrollBindingFields',
      'PHASE5_GO_NO_GO_RESILIENCE_PAYROLL_MISMATCH',
      'signerKeysetHash',
      'Ed25519',
      'project_sponsor',
      'GO_NO_GO_EXPECTED_SIGNER_KEYSET',
    ],
  ],
  [
    'docs/phase-5/18-go-no-go-evidence-gate.md',
    [
      'gaoq.phase5.go-no-go.v3',
      '专业算薪 Resource',
      'PHASE5_GO_NO_GO_RESILIENCE_PAYROLL_MISMATCH',
      '十方签署',
      'GO_NO_GO_SIGNER_KEYSET_SHA256',
      'release:go-no-go:print-contract',
    ],
  ],
  [
    'scripts/release/validate-phase-5-readiness-evidence.mjs',
    [
      'gaoq.phase5.readiness.v2',
      'gaoq.phase5.readiness.signoff.v1',
      'signerKeysetHash',
      'Ed25519',
      'architecture_owner',
      'support_owner',
      'READINESS_EXPECTED_SIGNER_KEYSET_SHA256',
    ],
  ],
  [
    'docs/phase-5/20-readiness-verdicts.md',
    [
      'gaoq.phase5.readiness.v2',
      '13 个治理角色',
      '独立 Ed25519',
      'READINESS_SIGNER_KEYSET_SHA256',
      '同一角色跨 Gate',
      'IAM/KMS',
    ],
  ],
  [
    'scripts/release/validate-phase-6-cutover-evidence.mjs',
    [
      'gaoq.phase6.cutover.v2',
      'signerKeysetHash',
      'Ed25519',
      'business_owner',
      'change_manager',
      'PHASE6_CUTOVER_SIGNER_KEYSET_SHA256',
    ],
  ],
  [
    'scripts/release/validate-phase-6-hypercare-evidence.mjs',
    [
      'gaoq.phase6.hypercare-archive.v2',
      'signerKeysetHash',
      'Ed25519',
      'finance_owner',
      'legal_owner',
      'PHASE6_HYPERCARE_SIGNER_KEYSET_SHA256',
    ],
  ],
  [
    'scripts/release/validate-phase-6-deployment-authorization.mjs',
    [
      'gaoq.phase6.deployment-authorization.v2',
      'signerKeysetHash',
      'Ed25519',
      'change_owner',
      'sre_owner',
      'PLAN_WORKFLOW_REF',
      'maximumLifetimeMinutes: 120',
    ],
  ],
  [
    'scripts/release/validate-phase-6-platform-intake.mjs',
    [
      'gaoq.phase6.production-platform-intake.v2',
      'signerKeysetHash',
      'Ed25519',
      'compliance_owner',
      'platform_owner',
      'PHASE6_DEPLOYMENT_PLATFORM_INTAKE_SIGNER_KEYSET_SHA256',
    ],
  ],
  [
    'docs/phase-6/05-protected-production-deployment.md',
    [
      'GitHub Hosted `ubuntu-latest`',
      'Plan 专用 OIDC audience',
      'Apply 专用 OIDC audience',
      '管理员 kubeconfig',
      'PHASE6_DEPLOYMENT_PLATFORM_INTAKE_SIGNER_KEYSET_SHA256',
    ],
  ],
  [
    'docs/phase-6/00-unified-cutover-contract.md',
    [
      'gaoq.phase6.cutover.v2',
      '五个不同主体',
      '五个不同 Ed25519',
      'signerKeysetHash',
      'PHASE6_CUTOVER_SIGNER_KEYSET_SHA256',
    ],
  ],
  [
    'docs/phase-6/01-hypercare-archive-contract.md',
    [
      'gaoq.phase6.hypercare-archive.v2',
      '三个不同主体',
      '三个不同 Ed25519',
      'signerKeysetHash',
      'PHASE6_HYPERCARE_SIGNER_KEYSET_SHA256',
      '`deletionAuthorized=false`',
    ],
  ],
  [
    'docs/phase-6/07-production-platform-intake.md',
    [
      'gaoq.phase6.production-platform-intake.v2',
      '六个不同主体',
      '不同 Ed25519 公钥',
      'signerKeysetHash',
      'PHASE6_DEPLOYMENT_PLATFORM_INTAKE_SIGNER_KEYSET_SHA256',
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
  if (!relativePath.endsWith('.md')) {
    continue;
  }
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

for (const [relativePath, markers] of requiredAdapterMappingMarkers) {
  try {
    const content = await readFile(resolve(repoRoot, relativePath), 'utf8');
    for (const marker of markers) {
      if (!content.includes(marker)) {
        errors.push(`${relativePath}: 缺少外部适配器映射标记 ${marker}`);
      }
    }
  } catch {
    // 缺失文件已在第一阶段报告。
  }
}

for (const [relativePath, markers] of requiredDataProcessingRegisterMarkers) {
  try {
    const content = await readFile(resolve(repoRoot, relativePath), 'utf8');
    for (const marker of markers) {
      if (!content.includes(marker)) {
        errors.push(`${relativePath}: 缺少数据处理登记标记 ${marker}`);
      }
    }
  } catch {
    // 缺失文件已在第一阶段报告。
  }
}

for (const [relativePath, markers] of requiredAdrMarkers) {
  try {
    const content = await readFile(resolve(repoRoot, relativePath), 'utf8');
    for (const marker of markers) {
      if (!content.includes(marker)) {
        errors.push(`${relativePath}: 缺少 ADR 决策标记 ${marker}`);
      }
    }
  } catch {
    // 缺失文件已在第一阶段报告。
  }
}

for (const [relativePath, markers] of requiredThreatModelMarkers) {
  try {
    const content = await readFile(resolve(repoRoot, relativePath), 'utf8');
    for (const marker of markers) {
      if (!content.includes(marker)) {
        errors.push(`${relativePath}: 缺少威胁模型标记 ${marker}`);
      }
    }
  } catch {
    // 缺失文件已在第一阶段报告。
  }
}

for (const [relativePath, markers] of requiredOpenApiContractMarkers) {
  try {
    const content = await readFile(resolve(repoRoot, relativePath), 'utf8');
    for (const marker of markers) {
      if (!content.includes(marker)) {
        errors.push(`${relativePath}: 缺少 OpenAPI 契约标记 ${marker}`);
      }
    }
  } catch {
    errors.push(`${relativePath}: 无法读取 OpenAPI 契约门禁文件`);
  }
}

for (const [relativePath, markers] of requiredMcpClientCompatibilityMarkers) {
  try {
    const content = await readFile(resolve(repoRoot, relativePath), 'utf8');
    for (const marker of markers) {
      if (!content.includes(marker)) {
        errors.push(`${relativePath}: 缺少 MCP 实体客户端门禁标记 ${marker}`);
      }
    }
  } catch {
    // 缺失文件已在第一阶段报告。
  }
}

for (const [relativePath, markers] of requiredHostedOidcMarkers) {
  try {
    const content = await readFile(resolve(repoRoot, relativePath), 'utf8');
    if (content.includes('/var/lib/gaoq')) {
      errors.push(`${relativePath}: 仍包含已废弃的本地证据挂载`);
    }
    for (const marker of markers) {
      if (!content.includes(marker)) {
        errors.push(`${relativePath}: 缺少 GitHub Hosted OIDC 标记 ${marker}`);
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
