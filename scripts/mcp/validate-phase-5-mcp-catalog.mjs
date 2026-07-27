import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const runtimeUrl = new URL('../../apps/erp-api/src/modules/mcp/mcp-runtime.service.ts', import.meta.url);
const toolServiceUrl = new URL('../../apps/erp-api/src/modules/mcp/mcp-tool.service.ts', import.meta.url);
const RISK = Object.freeze({
  R0: [
    'get_my_permissions', 'approval_get_inbox', 'approval_get', 'approval_timeline_get', 'get_org_chart',
    'recruitment_application_get', 'recruitment_requisition_get', 'recruitment_position_get',
    'recruitment_interview_get', 'recruitment_offer_get', 'onboarding_get',
    'knowledge_course_get', 'knowledge_assignment_get', 'knowledge_exam_run_get',
    'knowledge_search', 'care_case_get', 'care_occasion_summary_get_self',
    'talent_lifecycle_get',
    'attendance_month_get', 'payroll_period_get', 'op_operating_summary_get',
    'op_approval_bridge_get',
  ],
  R1: [
    'approval_submit_prepare', 'approval_submit_execute', 'approval_withdraw_prepare',
    'approval_withdraw_execute', 'payroll_payslip_get_self', 'payroll_tax_filing_get',
    'payroll_reconciliation_get', 'payroll_shadow_cycle_get',
    'payroll_cutover_readiness_get', 'management_dashboard_get',
    'data_migration_report_get', 'attendance_correction_prepare',
    'attendance_correction_execute', 'recruitment_position_transition_prepare',
    'recruitment_position_transition_execute', 'marketing_side_effect_get',
  ],
  R2: [
    'approval_decide_prepare', 'approval_decide_execute',
    'management_dashboard_export_prepare', 'management_dashboard_export_execute',
    'recruitment_requisition_submit_prepare', 'recruitment_requisition_submit_execute',
    'recruitment_offer_send_prepare', 'recruitment_offer_send_execute',
  ],
});
const EMPTY_INPUT = new Set([
  'get_my_permissions',
  'approval_get_inbox',
  'get_org_chart',
  'care_occasion_summary_get_self',
]);

const runtime = await readFile(runtimeUrl, 'utf8');
const toolService = await readFile(toolServiceUrl, 'utf8');
export const catalog = buildCatalog(runtime, toolService);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length === 2 || process.argv[2] === '--self-test') {
    const broken = runtime.replace('outputSchema: permissionsOutputSchema',
      'missingOutputSchema: permissionsOutputSchema');
    expectFailure(() => buildCatalog(broken, toolService), 'PHASE5_MCP_OUTPUT_SCHEMA_MISSING');
    process.stdout.write('Phase 5 MCP 确定性能力目录门禁自测通过。\n');
  } else if (process.argv.length === 3 && process.argv[2] === '--print') {
    process.stdout.write(`${JSON.stringify(catalog, null, 2)}\n`);
  } else {
    fail('PHASE5_MCP_ARGUMENT_INVALID');
  }
}

function buildCatalog(runtimeSource, toolServiceSource) {
  for (const forbidden of [
    '/persistence/', '.repository', 'Model<', '.collection', 'mongoose', 'fetch(',
  ]) {
    if (toolServiceSource.includes(forbidden)) fail('PHASE5_MCP_DIRECT_INFRASTRUCTURE_ACCESS');
  }
  if (!toolServiceSource.includes('只复用业务应用服务，不直接访问数据库或上游 Token')) {
    fail('PHASE5_MCP_APPLICATION_SERVICE_BOUNDARY_MISSING');
  }
  const sourceFile = ts.createSourceFile('mcp-runtime.service.ts', runtimeSource,
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const registrations = [];
  walk(sourceFile, (node) => {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression) ||
        node.expression.name.text !== 'registerTool') return;
    const [nameNode, metadataNode] = node.arguments;
    if (!ts.isStringLiteral(nameNode) || !ts.isObjectLiteralExpression(metadataNode)) {
      fail('PHASE5_MCP_REGISTRATION_DYNAMIC');
    }
    registrations.push(parseRegistration(nameNode.text, metadataNode));
  });
  const riskByName = new Map(Object.entries(RISK).flatMap(([risk, names]) =>
    names.map((name) => [name, risk])));
  if (riskByName.size !== 46 || registrations.length !== 46) fail('PHASE5_MCP_TOOL_COUNT_INVALID');
  const names = registrations.map((item) => item.name);
  if (new Set(names).size !== names.length || names.some((name) => !riskByName.has(name))) {
    fail('PHASE5_MCP_RISK_CATALOG_INCOMPLETE');
  }
  const tools = registrations.map((item) => {
    const riskLevel = riskByName.get(item.name);
    if (!item.hasOutputSchema) fail('PHASE5_MCP_OUTPUT_SCHEMA_MISSING');
    if (!item.hasInputSchema && !EMPTY_INPUT.has(item.name)) fail('PHASE5_MCP_INPUT_SCHEMA_MISSING');
    if (!item.annotations.idempotentHint) fail('PHASE5_MCP_IDEMPOTENCY_ANNOTATION_MISSING');
    if (riskLevel !== 'R0' && item.annotations.openWorldHint !== false) {
      fail('PHASE5_MCP_OPEN_WORLD_FORBIDDEN');
    }
    if (item.name.endsWith('_prepare') && item.annotations.destructiveHint) {
      fail('PHASE5_MCP_PREPARE_DESTRUCTIVE');
    }
    return {
      ...item,
      inputSchema: item.hasInputSchema ? 'declared' : 'empty-object',
      outputSchema: 'declared',
      riskLevel,
      domain: domain(item.name),
      operation: item.name.endsWith('_prepare') ? 'prepare' :
        item.name.endsWith('_execute') ? 'execute' : 'read',
    };
  });
  const core = {
    formatVersion: 1,
    suite: 'gaoq.phase5.mcp-catalog.v1',
    protocolVersion: '2025-11-25',
    transport: 'streamable-http',
    oauthProfile: 'oauth-2.1',
    counts: { total: 46, R0: 22, R1: 16, R2: 8, R3: 0 },
    tools,
  };
  return { ...core, catalogHash: digest(canonical(core)) };
}

function parseRegistration(name, metadata) {
  const properties = new Map(metadata.properties.filter(ts.isPropertyAssignment).map((property) =>
    [property.name.getText().replaceAll(/["']/gu, ''), property.initializer]));
  const title = stringValue(properties.get('title'));
  const description = stringValue(properties.get('description'));
  if (title === null || description === null || !/[\u3400-\u9fff]/u.test(`${title}${description}`)) {
    fail('PHASE5_MCP_CHINESE_METADATA_MISSING');
  }
  const annotationsNode = properties.get('annotations');
  if (!ts.isObjectLiteralExpression(annotationsNode)) fail('PHASE5_MCP_ANNOTATIONS_MISSING');
  const annotations = Object.fromEntries(annotationsNode.properties
    .filter(ts.isPropertyAssignment)
    .map((property) => [property.name.getText(), booleanValue(property.initializer)]));
  return {
    name, title, description,
    hasInputSchema: properties.has('inputSchema'),
    hasOutputSchema: properties.has('outputSchema'),
    annotations,
  };
}

function domain(name) {
  if (name.startsWith('approval_')) return 'approval';
  if (name.startsWith('recruitment_')) return 'recruitment';
  if (name.startsWith('payroll_')) return 'payroll';
  if (name.startsWith('attendance_')) return 'attendance';
  if (name.startsWith('op_')) return 'op';
  if (name.startsWith('management_')) return 'analytics';
  if (name.startsWith('data_migration_')) return 'migration';
  if (name.startsWith('knowledge_')) return 'knowledge';
  if (name.startsWith('care_')) return 'care';
  if (name.startsWith('talent_lifecycle_')) return 'talent-lifecycle';
  if (name.startsWith('marketing_')) return 'marketing';
  if (name.startsWith('onboarding_')) return 'onboarding';
  if (name === 'get_org_chart') return 'org';
  return 'identity';
}

function walk(node, visitor) {
  visitor(node);
  node.forEachChild((child) => walk(child, visitor));
}

function stringValue(node) {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : null;
}

function booleanValue(node) {
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  return null;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function expectFailure(callback, code) {
  try { callback(); } catch (error) {
    if (error instanceof Error && error.message === code) return;
    throw error;
  }
  fail(`SELF_TEST_DID_NOT_FAIL:${code}`);
}

function fail(code) {
  throw new Error(code);
}
