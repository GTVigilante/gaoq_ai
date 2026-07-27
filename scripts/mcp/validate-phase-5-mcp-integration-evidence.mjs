import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { catalog } from './validate-phase-5-mcp-catalog.mjs';

const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const CLIENTS = Object.freeze({
  'interactive-user-agent': 'authorization-code-pkce',
  'machine-service-agent': 'client-credentials',
  'read-only-audit-agent': 'authorization-code-pkce',
});
const INTEGRATIONS = ['attachment', 'bank', 'dingtalk', 'esign', 'feishu', 'op', 'tax', 'worm'];
const SIGNOFFS = ['integration_owner', 'mcp_owner', 'qa_owner', 'security_owner'];

if (process.argv[2] === '--self-test') {
  validate(fixture());
  const bound = fixture();
  process.env.MCP_INTEGRATION_EXPECTED_ENVIRONMENT = bound.environment.name;
  process.env.MCP_INTEGRATION_EXPECTED_COMMIT = bound.source.commitSha;
  process.env.MCP_INTEGRATION_EXPECTED_API_IMAGE = bound.source.images.api;
  process.env.MCP_INTEGRATION_EXPECTED_WORKER_IMAGE = bound.source.images.worker;
  process.env.MCP_INTEGRATION_EXPECTED_WEB_IMAGE = bound.source.images.web;
  validate(bound, true);
  const stale = fixture(); stale.source.catalogHash = digest('old');
  expectFailure(() => validate(stale), 'PHASE5_MCP_INTEGRATION_CATALOG_MISMATCH');
  const leaked = fixture(); leaked.integrations[0].upstreamTokenExposures = 1;
  expectFailure(() => validate(leaked), 'PHASE5_MCP_INTEGRATION_SECURITY_FAILED');
  const escaped = fixture(); escaped.authorization.crossTenantDenied = 29;
  expectFailure(() => validate(escaped), 'PHASE5_MCP_INTEGRATION_TENANT_ESCAPE');
  process.env.MCP_INTEGRATION_EXPECTED_COMMIT = 'b'.repeat(40);
  expectFailure(() => validate(bound, true), 'PHASE5_MCP_INTEGRATION_COMMIT_MISMATCH');
  process.stdout.write('Phase 5 MCP 客户端与跨系统联调证据门禁自测通过。\n');
} else {
  const enforce = process.argv[2] === '--enforce-environment';
  const path = process.argv[enforce ? 3 : 2];
  if (path === undefined || process.argv.length !== (enforce ? 4 : 3)) {
    fail('PHASE5_MCP_INTEGRATION_PATH_REQUIRED');
  }
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > 512 * 1_024 ||
      (stat.mode & 0o022) !== 0) fail('PHASE5_MCP_INTEGRATION_FILE_INVALID');
  const result = validate(JSON.parse(await readFile(path, 'utf8')), enforce);
  process.stdout.write(`${JSON.stringify({
    formatVersion: 1, suite: 'gaoq.phase5.integration-mcp.verdict', runId: result.runId,
    commitSha: result.commitSha, catalogHash: catalog.catalogHash,
    evidenceChecksum: digest(canonical(result)),
  }, null, 2)}\n`);
}

function validate(document, enforce = false) {
  exact(document, ['formatVersion', 'suite', 'runId', 'source', 'environment', 'clients',
    'integrations', 'authorization', 'safety', 'artifacts', 'signoffs']);
  equal(document.formatVersion, 1, 'PHASE5_MCP_INTEGRATION_FORMAT_INVALID');
  equal(document.suite, 'gaoq.phase5.integration-mcp.v1', 'PHASE5_MCP_INTEGRATION_SUITE_INVALID');
  pattern(document.runId, ULID, 'PHASE5_MCP_INTEGRATION_RUN_ID_INVALID');
  exact(document.source, ['commitSha', 'images', 'protocolVersion', 'catalogHash']);
  pattern(document.source.commitSha, COMMIT, 'PHASE5_MCP_INTEGRATION_COMMIT_INVALID');
  exact(document.source.images, ['api', 'worker', 'web']);
  for (const hash of Object.values(document.source.images)) pattern(hash, SHA256,
    'PHASE5_MCP_INTEGRATION_IMAGE_INVALID');
  equal(document.source.protocolVersion, '2025-11-25', 'PHASE5_MCP_INTEGRATION_PROTOCOL_INVALID');
  equal(document.source.catalogHash, catalog.catalogHash, 'PHASE5_MCP_INTEGRATION_CATALOG_MISMATCH');
  exact(document.environment, ['name', 'productionEquivalent', 'productionTraffic',
    'productionData', 'startedAt', 'endedAt']);
  equal(document.environment.productionEquivalent, true, 'PHASE5_MCP_INTEGRATION_ENV_INVALID');
  equal(document.environment.productionTraffic, false, 'PHASE5_MCP_INTEGRATION_PROD_FORBIDDEN');
  equal(document.environment.productionData, false, 'PHASE5_MCP_INTEGRATION_PROD_FORBIDDEN');
  if (!/(?:stage|staging|preprod|uat)/u.test(document.environment.name)) {
    fail('PHASE5_MCP_INTEGRATION_ENV_INVALID');
  }
  if (enforce) validateExpected(document);
  const started = time(document.environment.startedAt);
  const ended = time(document.environment.endedAt);
  if (ended - started < 30 * 60 * 1_000) fail('PHASE5_MCP_INTEGRATION_DURATION_INVALID');
  validateClients(document.clients);
  validateIntegrations(document.integrations);
  validateAuthorization(document.authorization);
  exact(document.safety, ['productionEndpointsUsed', 'productionSideEffects', 'r3ActionsEnabled',
    'secretsInEvidence', 'directDatabaseAccess', 'upstreamTokensReturned']);
  for (const value of Object.values(document.safety)) equal(value, false,
    'PHASE5_MCP_INTEGRATION_UNSAFE');
  exact(document.artifacts, ['protocolTranscriptsHash', 'oauthMatrixHash', 'catalogArtifactHash',
    'auditQueryHash', 'sandboxMatrixHash']);
  const artifactHashes = Object.values(document.artifacts);
  for (const hash of artifactHashes) pattern(hash, SHA256, 'PHASE5_MCP_INTEGRATION_ARTIFACT_INVALID');
  if (new Set(artifactHashes).size !== artifactHashes.length) fail('PHASE5_MCP_INTEGRATION_ARTIFACT_REUSED');
  validateSignoffs(document.signoffs, ended);
  return Object.freeze({ runId: document.runId, commitSha: document.source.commitSha,
    source: document.source, environment: document.environment, clients: document.clients,
    integrations: document.integrations, authorization: document.authorization,
    artifacts: document.artifacts });
}

function validateExpected(document) {
  const expected = {
    environment: process.env.MCP_INTEGRATION_EXPECTED_ENVIRONMENT,
    commit: process.env.MCP_INTEGRATION_EXPECTED_COMMIT,
    api: process.env.MCP_INTEGRATION_EXPECTED_API_IMAGE,
    worker: process.env.MCP_INTEGRATION_EXPECTED_WORKER_IMAGE,
    web: process.env.MCP_INTEGRATION_EXPECTED_WEB_IMAGE,
  };
  if (expected.environment === undefined || !/^[a-z][a-z0-9-]{2,31}$/u.test(expected.environment)) {
    fail('PHASE5_MCP_INTEGRATION_EXPECTED_SOURCE_REQUIRED');
  }
  pattern(expected.commit, COMMIT, 'PHASE5_MCP_INTEGRATION_EXPECTED_SOURCE_REQUIRED');
  for (const field of ['api', 'worker', 'web']) {
    pattern(expected[field], SHA256, 'PHASE5_MCP_INTEGRATION_EXPECTED_SOURCE_REQUIRED');
  }
  equal(document.environment.name, expected.environment, 'PHASE5_MCP_INTEGRATION_ENV_MISMATCH');
  equal(document.source.commitSha, expected.commit, 'PHASE5_MCP_INTEGRATION_COMMIT_MISMATCH');
  for (const image of ['api', 'worker', 'web']) {
    equal(document.source.images[image], expected[image], 'PHASE5_MCP_INTEGRATION_IMAGE_MISMATCH');
  }
}

function validateClients(clients) {
  if (!Array.isArray(clients) || clients.length !== 3) fail('PHASE5_MCP_INTEGRATION_CLIENTS_INCOMPLETE');
  const profiles = [];
  for (const client of clients) {
    exact(client, ['profile', 'authFlow', 'initialized', 'protocolVersion', 'catalogHash',
      'toolCount', 'resourceCount', 'resourceTemplateCount', 'promptCount', 'toolCalls',
      'structuredOutputFailures', 'schemaFailures', 'errorContractFailures',
      'timeoutCancellationFailures', 'idempotencyFailures', 'auditEvents', 'evidenceHash']);
    if (!Object.hasOwn(CLIENTS, client.profile)) fail('PHASE5_MCP_INTEGRATION_CLIENT_INVALID');
    profiles.push(client.profile);
    equal(client.authFlow, CLIENTS[client.profile], 'PHASE5_MCP_INTEGRATION_AUTH_FLOW_INVALID');
    equal(client.initialized, true, 'PHASE5_MCP_INTEGRATION_INITIALIZE_FAILED');
    equal(client.protocolVersion, '2025-11-25', 'PHASE5_MCP_INTEGRATION_PROTOCOL_INVALID');
    equal(client.catalogHash, catalog.catalogHash, 'PHASE5_MCP_INTEGRATION_CATALOG_MISMATCH');
    equal(client.toolCount, 44, 'PHASE5_MCP_INTEGRATION_CATALOG_MISMATCH');
    integer(client.resourceCount, 4, 10_000, 'PHASE5_MCP_INTEGRATION_COVERAGE');
    integer(client.resourceTemplateCount, 21, 10_000, 'PHASE5_MCP_INTEGRATION_COVERAGE');
    integer(client.promptCount, 19, 10_000, 'PHASE5_MCP_INTEGRATION_COVERAGE');
    integer(client.toolCalls, 10, Number.MAX_SAFE_INTEGER, 'PHASE5_MCP_INTEGRATION_COVERAGE');
    for (const field of ['structuredOutputFailures', 'schemaFailures', 'errorContractFailures',
      'timeoutCancellationFailures', 'idempotencyFailures']) equal(client[field], 0,
      'PHASE5_MCP_INTEGRATION_CLIENT_FAILED');
    integer(client.auditEvents, client.toolCalls, Number.MAX_SAFE_INTEGER,
      'PHASE5_MCP_INTEGRATION_AUDIT_INCOMPLETE');
    pattern(client.evidenceHash, SHA256, 'PHASE5_MCP_INTEGRATION_CLIENT_EVIDENCE_INVALID');
  }
  if (canonical(profiles.sort()) !== canonical(Object.keys(CLIENTS).sort())) {
    fail('PHASE5_MCP_INTEGRATION_CLIENTS_INCOMPLETE');
  }
}

function validateIntegrations(integrations) {
  if (!Array.isArray(integrations) || integrations.length !== 8) {
    fail('PHASE5_MCP_INTEGRATION_SYSTEMS_INCOMPLETE');
  }
  const names = []; const hashes = new Set();
  for (const item of integrations) {
    exact(item, ['name', 'sandbox', 'requests', 'successfulResponses', 'lostEvents',
      'duplicateBusinessEffects', 'unreconciledEvents', 'tenantMismatches',
      'upstreamTokenExposures', 'productionSideEffects', 'evidenceHash']);
    names.push(item.name); equal(item.sandbox, true, 'PHASE5_MCP_INTEGRATION_SANDBOX_REQUIRED');
    integer(item.requests, 10, Number.MAX_SAFE_INTEGER, 'PHASE5_MCP_INTEGRATION_COVERAGE');
    equal(item.successfulResponses, item.requests, 'PHASE5_MCP_INTEGRATION_SYSTEM_FAILED');
    for (const field of ['lostEvents', 'duplicateBusinessEffects', 'unreconciledEvents',
      'tenantMismatches', 'upstreamTokenExposures', 'productionSideEffects']) equal(item[field], 0,
      'PHASE5_MCP_INTEGRATION_SECURITY_FAILED');
    pattern(item.evidenceHash, SHA256, 'PHASE5_MCP_INTEGRATION_SYSTEM_EVIDENCE_INVALID');
    hashes.add(item.evidenceHash);
  }
  if (canonical(names.sort()) !== canonical(INTEGRATIONS) || hashes.size !== 8) {
    fail('PHASE5_MCP_INTEGRATION_SYSTEMS_INCOMPLETE');
  }
}

function validateAuthorization(value) {
  exact(value, ['crossTenantAttempts', 'crossTenantDenied', 'invalidScopeAttempts',
    'invalidScopeDenied', 'expiredConfirmationAttempts', 'expiredConfirmationDenied',
    'r3ToolsListed', 'auditEvents']);
  integer(value.crossTenantAttempts, 30, Number.MAX_SAFE_INTEGER, 'PHASE5_MCP_INTEGRATION_COVERAGE');
  equal(value.crossTenantDenied, value.crossTenantAttempts, 'PHASE5_MCP_INTEGRATION_TENANT_ESCAPE');
  integer(value.invalidScopeAttempts, 30, Number.MAX_SAFE_INTEGER, 'PHASE5_MCP_INTEGRATION_COVERAGE');
  equal(value.invalidScopeDenied, value.invalidScopeAttempts, 'PHASE5_MCP_INTEGRATION_SCOPE_ESCAPE');
  integer(value.expiredConfirmationAttempts, 10, Number.MAX_SAFE_INTEGER,
    'PHASE5_MCP_INTEGRATION_COVERAGE');
  equal(value.expiredConfirmationDenied, value.expiredConfirmationAttempts,
    'PHASE5_MCP_INTEGRATION_CONFIRMATION_REPLAY');
  equal(value.r3ToolsListed, 0, 'PHASE5_MCP_INTEGRATION_R3_EXPOSED');
  integer(value.auditEvents, 70, Number.MAX_SAFE_INTEGER, 'PHASE5_MCP_INTEGRATION_AUDIT_INCOMPLETE');
}

function validateSignoffs(signoffs, ended) {
  if (!Array.isArray(signoffs) || signoffs.length !== 4) fail('PHASE5_MCP_INTEGRATION_SIGNOFFS_INCOMPLETE');
  const roles = []; const ids = new Set();
  for (const item of signoffs) {
    exact(item, ['role', 'decision', 'evidenceId', 'signedAt']);
    equal(item.decision, 'approve', 'PHASE5_MCP_INTEGRATION_SIGNOFF_REJECTED');
    pattern(item.evidenceId, ULID, 'PHASE5_MCP_INTEGRATION_SIGNOFF_INVALID');
    if (time(item.signedAt) < ended) fail('PHASE5_MCP_INTEGRATION_SIGNOFF_TIME_INVALID');
    roles.push(item.role); ids.add(item.evidenceId);
  }
  if (canonical(roles.sort()) !== canonical(SIGNOFFS) || ids.size !== 4) {
    fail('PHASE5_MCP_INTEGRATION_SIGNOFFS_INCOMPLETE');
  }
}

function fixture() {
  const hash = (label) => digest(label);
  return { formatVersion: 1, suite: 'gaoq.phase5.integration-mcp.v1',
    runId: '01J8ZQK7V0A2M4N6P8R0T2W6E1', source: { commitSha: 'a'.repeat(40),
      images: { api: hash('api'), worker: hash('worker'), web: hash('web') },
      protocolVersion: '2025-11-25', catalogHash: catalog.catalogHash },
    environment: { name: 'mcp-uat', productionEquivalent: true, productionTraffic: false,
      productionData: false, startedAt: '2026-07-22T00:00:00.000Z',
      endedAt: '2026-07-22T01:00:00.000Z' },
    clients: Object.entries(CLIENTS).map(([profile, authFlow], index) => ({ profile, authFlow,
      initialized: true, protocolVersion: '2025-11-25', catalogHash: catalog.catalogHash,
      toolCount: 44, resourceCount: 4, resourceTemplateCount: 21, promptCount: 19,
      toolCalls: 20, structuredOutputFailures: 0, schemaFailures: 0,
      errorContractFailures: 0, timeoutCancellationFailures: 0, idempotencyFailures: 0,
      auditEvents: 20, evidenceHash: hash(`client-${index}`) })),
    integrations: INTEGRATIONS.map((name) => ({ name, sandbox: true, requests: 10,
      successfulResponses: 10, lostEvents: 0, duplicateBusinessEffects: 0,
      unreconciledEvents: 0, tenantMismatches: 0, upstreamTokenExposures: 0,
      productionSideEffects: 0, evidenceHash: hash(`integration-${name}`) })),
    authorization: { crossTenantAttempts: 30, crossTenantDenied: 30, invalidScopeAttempts: 30,
      invalidScopeDenied: 30, expiredConfirmationAttempts: 10, expiredConfirmationDenied: 10,
      r3ToolsListed: 0, auditEvents: 70 },
    safety: { productionEndpointsUsed: false, productionSideEffects: false,
      r3ActionsEnabled: false, secretsInEvidence: false, directDatabaseAccess: false,
      upstreamTokensReturned: false },
    artifacts: Object.fromEntries(['protocolTranscriptsHash', 'oauthMatrixHash',
      'catalogArtifactHash', 'auditQueryHash', 'sandboxMatrixHash'].map((key) => [key, hash(key)])),
    signoffs: SIGNOFFS.map((role, index) => ({ role, decision: 'approve',
      evidenceId: `01J8ZQK7V0A2M4N6P8R0T2W9${index}A`, signedAt: '2026-07-22T01:10:00.000Z' })) };
}

function exact(value, keys) { if (typeof value !== 'object' || value === null || Array.isArray(value) ||
  canonical(Object.keys(value).sort()) !== canonical([...keys].sort())) fail('PHASE5_MCP_INTEGRATION_SCHEMA_INVALID'); }
function equal(actual, expected, code) { if (actual !== expected) fail(code); }
function pattern(value, regex, code) { if (typeof value !== 'string' || !regex.test(value)) fail(code); }
function integer(value, min, max, code) { if (!Number.isSafeInteger(value) || value < min || value > max) fail(code); }
function time(value) { const parsed = Date.parse(value); if (typeof value !== 'string' || !Number.isFinite(parsed) ||
  new Date(parsed).toISOString() !== value) fail('PHASE5_MCP_INTEGRATION_TIME_INVALID'); return parsed; }
function canonical(value) { if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`; return JSON.stringify(value); }
function digest(value) { return `sha256:${createHash('sha256').update(value).digest('hex')}`; }
function expectFailure(callback, code) { try { callback(); } catch (error) {
  if (error instanceof Error && error.message === code) return; throw error; } fail(`SELF_TEST_DID_NOT_FAIL:${code}`); }
function fail(code) { throw new Error(code); }
