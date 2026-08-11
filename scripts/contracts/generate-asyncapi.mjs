import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const outputPath = resolve(repoRoot, 'contracts/asyncapi/erp-events.asyncapi.json');
const args = new Set(process.argv.slice(2));
const domainEventPattern =
  /^(?:department|employee|person|employment|position|job_level|approval_[a-z0-9_]+|care|knowledge|onboarding|recruitment|attendance|payroll|treasury|dynamic_form|supplier|sourcing|engagement|payables)\.[a-z0-9_]+(?:\.[a-z0-9_]+)*$/u;
const fullEventPattern = /^cn\.gaoq\.(?:erp|payroll)\.[a-z0-9_]+(?:\.[a-z0-9_]+)*\.v[1-9][0-9]*$/u;

const eventGroups = [
  {
    name: 'org',
    source: '//gaoq-erp/org-module',
    classification: 'L2',
    files: ['apps/erp-api/src/modules/org/domain/org-events.ts'],
  },
  {
    name: 'approval',
    source: '//gaoq-erp/approval-module',
    classification: 'L2',
    files: ['apps/erp-api/src/modules/approval/domain/approval-events.ts'],
  },
  {
    name: 'care',
    source: '//gaoq-erp/care-module',
    classification: 'L2',
    files: ['apps/erp-api/src/modules/care/persistence/care-outbox.writer.ts'],
  },
  {
    name: 'knowledge',
    source: '//gaoq-erp/knowledge-module',
    classification: 'L2',
    files: ['apps/erp-api/src/modules/knowledge/persistence/knowledge-outbox.writer.ts'],
  },
  {
    name: 'onboarding',
    source: '//gaoq-erp/onboarding-module',
    classification: 'L2',
    files: ['apps/erp-api/src/modules/onboarding/persistence/onboarding-outbox.writer.ts'],
  },
  {
    name: 'recruitment',
    source: '//gaoq-erp/recruitment-module',
    classification: 'L2',
    files: ['apps/erp-api/src/modules/recruitment/persistence/recruitment-outbox.writer.ts'],
  },
  {
    name: 'attendance',
    source: '//gaoq-erp/attendance-module',
    classification: 'L2',
    files: ['apps/erp-api/src/modules/attendance/persistence/attendance-outbox.writer.ts'],
  },
  {
    name: 'payroll',
    source: '//gaoq-erp/payroll-module',
    classification: 'L3',
    files: ['apps/erp-api/src/modules/payroll/persistence/payroll-outbox.writer.ts'],
  },
  {
    name: 'treasury',
    source: '//gaoq-erp/treasury-module',
    classification: 'L3',
    files: ['apps/erp-api/src/modules/treasury/persistence/treasury-outbox.writer.ts'],
  },
  {
    name: 'talent-lifecycle',
    source: '//gaoq-erp/talent-lifecycle-module',
    classification: 'L2',
    files: [
      'apps/erp-api/src/modules/talent-lifecycle/persistence/talent-lifecycle-outbox.writer.ts',
    ],
    explicitTypes: [
      'cn.gaoq.erp.talent.touchpoint.created.v1',
      'cn.gaoq.erp.talent.touchpoint.completed.v1',
      'cn.gaoq.erp.talent.touchpoint.cancelled.v1',
    ],
  },
  {
    name: 'document',
    source: '//gaoq-erp/document-module',
    classification: 'L2',
    files: [
      'apps/erp-api/src/modules/document/persistence/business-attachment-outbox.writer.ts',
    ],
  },
  {
    name: 'op',
    source: '//gaoq-erp/op-module',
    classification: 'L2',
    files: ['apps/erp-api/src/modules/op/persistence/op-outbox.writer.ts'],
  },
  {
    name: 'marketing',
    source: '//gaoq-erp/marketing-cms',
    classification: 'L1',
    files: ['apps/erp-api/src/modules/marketing-cms/marketing-cms.types.ts'],
  },
  {
    name: 'dynamic-form',
    source: '//gaoq-erp/dynamic-form-module',
    classification: 'L2',
    files: ['apps/erp-api/src/modules/dynamic-form/persistence/dynamic-form-outbox.writer.ts'],
  },
  {
    name: 'supplier', source: '//gaoq-erp/supplier-module', classification: 'L2',
    files: [
      'apps/erp-api/src/modules/supplier/persistence/supplier-outbox.writer.ts',
      'apps/erp-api/src/modules/supplier/persistence/supplier-member-outbox.writer.ts',
    ],
  },
  {
    name: 'sourcing', source: '//gaoq-erp/sourcing-module', classification: 'L2',
    files: ['apps/erp-api/src/modules/sourcing/persistence/sourcing-outbox.writer.ts'],
  },
  {
    name: 'engagement', source: '//gaoq-erp/engagement-module', classification: 'L2',
    files: ['apps/erp-api/src/modules/engagement/persistence/engagement-outbox.writer.ts'],
  },
  {
    name: 'payables', source: '//gaoq-erp/payables-module', classification: 'L3',
    files: ['apps/erp-api/src/modules/payables/persistence/payable-outbox.writer.ts'],
  },
];

const platformContractFile = 'packages/platform-contracts/src/payroll-events.ts';
const platformSourceByType = {
  'cn.gaoq.erp.department.upserted.v1': '//gaoq-erp/org',
  'cn.gaoq.erp.employee.upserted.v1': '//gaoq-erp/org',
  'cn.gaoq.erp.employment.changed.v1': '//gaoq-erp/org',
  'cn.gaoq.payroll.run.status_changed.v1': '//gaoq-payroll/run',
  'cn.gaoq.payroll.payslip.published.v1': '//gaoq-payroll/payslip',
  'cn.gaoq.payroll.cost_summary.published.v1': '//gaoq-payroll/cost-summary',
  'cn.gaoq.payroll.reconciliation.completed.v1': '//gaoq-payroll/reconciliation',
};

/** 将仓库相对路径规范化为跨平台形式。 */
const normalizedPath = (value) => value.split(sep).join('/');

/** 读取 TypeScript 文件并建立可遍历 AST。 */
const parseSource = async (relativePath) => {
  const absolutePath = resolve(repoRoot, relativePath);
  return ts.createSourceFile(
    absolutePath,
    await readFile(absolutePath, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
};

/** 去掉 as const、satisfies 与括号包装，仅保留静态初始化表达式。 */
const unwrapExpression = (value) => {
  let current = value;
  while (
    current !== undefined &&
    (ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isParenthesizedExpression(current))
  ) {
    current = current.expression;
  }
  return current;
};

/** 返回属性声明的静态名称。 */
const propertyName = (node, sourceFile) =>
  node?.name?.getText(sourceFile).replace(/^['"]|['"]$/gu, '') ?? '';

/** 判断字符串是否处于真实事件类型声明位置，而不是状态、前缀或聚合名称。 */
const isDeclaredEventLiteral = (node, sourceFile) => {
  const parent = node.parent;
  if (ts.isPropertyAssignment(parent) && propertyName(parent, sourceFile) === 'type') {
    return true;
  }
  if (ts.isCallExpression(parent)) {
    const callee = parent.expression.getText(sourceFile);
    return callee.endsWith('.literal') || /EventSchema$/u.test(callee);
  }
  if (!ts.isLiteralTypeNode(parent)) {
    return false;
  }
  const owner = parent.parent;
  if (ts.isPropertySignature(owner) && propertyName(owner, sourceFile) === 'type') {
    return true;
  }
  if (
    ts.isUnionTypeNode(owner) &&
    ts.isPropertySignature(owner.parent) &&
    propertyName(owner.parent, sourceFile) === 'type'
  ) {
    return true;
  }
  return ts.isTypeReferenceNode(owner) && /Event$/u.test(owner.typeName.getText(sourceFile));
};

/** 读取固定 EVENT_TYPES 数组，覆盖表驱动事件注册。 */
const eventTypesArrayValues = (sourceFile) => {
  const values = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (declaration.name.getText(sourceFile) !== 'EVENT_TYPES') {
        continue;
      }
      const initializer = unwrapExpression(declaration.initializer);
      if (!ts.isArrayLiteralExpression(initializer)) {
        throw new Error(`${normalizedPath(sourceFile.fileName)} 的 EVENT_TYPES 必须为静态数组`);
      }
      for (const element of initializer.elements) {
        if (!ts.isStringLiteral(element)) {
          throw new Error(`${normalizedPath(sourceFile.fileName)} 的 EVENT_TYPES 含动态值`);
        }
        values.push(element.text);
      }
    }
  }
  return values;
};

/** 从生产源码提取领域事件并规范化为完整 CloudEvents type。 */
const extractEventTypes = async (files) => {
  const values = new Set();
  for (const relativePath of files) {
    const sourceFile = await parseSource(relativePath);
    for (const value of eventTypesArrayValues(sourceFile)) {
      if (!domainEventPattern.test(value)) {
        throw new Error(`${relativePath} 的 EVENT_TYPES 含非规范事件：${value}`);
      }
      values.add(`cn.gaoq.erp.${value}.v1`);
    }
    const visit = (node) => {
      if (
        ts.isStringLiteral(node) &&
        isDeclaredEventLiteral(node, sourceFile) &&
        domainEventPattern.test(node.text)
      ) {
        values.add(`cn.gaoq.erp.${node.text}.v1`);
      }
      if (ts.isStringLiteral(node) && fullEventPattern.test(node.text)) {
        values.add(node.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return [...values].sort();
};

/** 只读取平台契约的两个现行事件数组，明确排除兼容窗口旧 type。 */
const extractPlatformContractTypes = async () => {
  const sourceFile = await parseSource(platformContractFile);
  const acceptedNames = new Set([
    'ERP_PAYROLL_MASTER_DATA_EVENT_TYPES',
    'PAYROLL_ERP_SUMMARY_EVENT_TYPES',
  ]);
  const values = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      const name = declaration.name.getText(sourceFile);
      if (!acceptedNames.has(name)) {
        continue;
      }
      const initializer = unwrapExpression(declaration.initializer);
      if (!ts.isArrayLiteralExpression(initializer)) {
        throw new Error(`${platformContractFile} 的 ${name} 必须为静态数组`);
      }
      for (const element of initializer.elements) {
        if (!ts.isStringLiteral(element) || !fullEventPattern.test(element.text)) {
          throw new Error(`${platformContractFile} 的 ${name} 含非规范事件`);
        }
        values.push(element.text);
      }
    }
  }
  if (values.length !== Object.keys(platformSourceByType).length) {
    throw new Error(
      `专业算薪平台事件数量漂移：源码 ${values.length}，来源映射 ${Object.keys(platformSourceByType).length}`,
    );
  }
  for (const value of values) {
    if (platformSourceByType[value] === undefined) {
      throw new Error(`专业算薪平台事件缺少 source 映射：${value}`);
    }
  }
  return [...new Set(values)].sort();
};

/** 生成稳定且可读的 AsyncAPI 组件标识。 */
const componentName = (eventType) => eventType;

/** 构造 CloudEvents 结构化模式消息。 */
const messageFor = (event) => ({
  name: event.type,
  title: event.type,
  summary: `${event.group} 发布的 CloudEvents 1.0 事件。`,
  contentType: 'application/cloudevents+json',
  correlationId: {
    description: '跨 REST、Worker 与外部适配器关联的追踪标识。',
    location: '$message.payload#/traceId',
  },
  payload: {
    allOf: [
      { $ref: '#/components/schemas/CloudEventEnvelope' },
      {
        type: 'object',
        properties: {
          source: { const: event.source },
          type: { const: event.type },
        },
      },
    ],
  },
  'x-domain': event.group,
  'x-direction': event.action === 'send' ? 'outbound' : 'inbound',
  'x-authoritative-system':
    event.type.startsWith('cn.gaoq.payroll.') ? 'professional-payroll' : 'erp',
  'x-data-classification': event.classification,
  'x-runtime-schema-sources': event.files,
  'x-delivery': event.delivery,
});

/** 构建完整事件目录并拒绝 type 被多个运行时来源重复声明。 */
const collectEvents = async () => {
  const events = [];
  for (const group of eventGroups) {
    const discovered = new Set([
      ...(await extractEventTypes(group.files)),
      ...(group.explicitTypes ?? []),
    ]);
    for (const type of [...discovered].sort()) {
      events.push({
        type,
        group: group.name,
        source: group.source,
        classification: group.classification,
        files: group.files,
        action: 'send',
        delivery: 'transactional-outbox',
      });
    }
  }
  for (const type of await extractPlatformContractTypes()) {
    events.push({
      type,
      group: 'professional-payroll-contract',
      source: platformSourceByType[type],
      classification: 'L3',
      files: [
        platformContractFile,
        'packages/platform-contracts/src/payroll-event-schemas.ts',
      ],
      action: type.startsWith('cn.gaoq.payroll.') ? 'receive' : 'send',
      delivery: 'external-contract',
    });
  }
  const sorted = events.sort((left, right) => left.type.localeCompare(right.type));
  const duplicates = sorted.filter(
    (event, index) => index > 0 && sorted[index - 1]?.type === event.type,
  );
  if (duplicates.length > 0) {
    throw new Error(`事件 type 重复声明：${duplicates.map(({ type }) => type).join(', ')}`);
  }
  return sorted;
};

/** 校验 AsyncAPI 版本、引用、事件数量和收发方向。 */
const validateDocument = (document) => {
  const errors = [];
  if (document.asyncapi !== '3.0.0') {
    errors.push('asyncapi 必须为 3.0.0');
  }
  const messages = document.components?.messages ?? {};
  const channels = document.channels ?? {};
  const operations = document.operations ?? {};
  if (Object.keys(messages).length !== document['x-event-count']) {
    errors.push('x-event-count 与 message 数量不一致');
  }
  if (Object.keys(channels).length !== Object.keys(messages).length) {
    errors.push('每个 message 必须有唯一 channel');
  }
  if (Object.keys(operations).length !== Object.keys(messages).length) {
    errors.push('每个 message 必须有唯一 operation');
  }
  for (const [name, message] of Object.entries(messages)) {
    if (!fullEventPattern.test(message.name)) {
      errors.push(`${name} 的事件 type 不规范`);
    }
    if (!['inbound', 'outbound'].includes(message['x-direction'])) {
      errors.push(`${name} 缺少收发方向`);
    }
    if (!Array.isArray(message['x-runtime-schema-sources'])) {
      errors.push(`${name} 缺少运行时 Schema 来源`);
    }
  }
  if (errors.length > 0) {
    throw new Error(`AsyncAPI 校验失败：\n- ${errors.join('\n- ')}`);
  }
};

/** 组装 AsyncAPI 3.0 文档。 */
const buildDocument = async () => {
  const events = await collectEvents();
  const channels = {};
  const operations = {};
  const messages = {};
  for (const event of events) {
    const name = componentName(event.type);
    const channelName = `event_${name}`;
    const operationName = `${event.action}_${name}`;
    channels[channelName] = {
      address: event.type,
      messages: {
        [name]: { $ref: `#/components/messages/${name}` },
      },
      description: `${event.type} 的逻辑事件通道；物理 Broker 由目标环境准入决定。`,
    };
    operations[operationName] = {
      action: event.action,
      channel: { $ref: `#/channels/${channelName}` },
      messages: [{ $ref: `#/channels/${channelName}/messages/${name}` }],
      'x-idempotency-key': 'tenantId + type + aggregateId + version',
      'x-tenant-source': 'verified-identity-context',
    };
    messages[name] = messageFor(event);
  }
  const inboundCount = events.filter(({ action }) => action === 'receive').length;
  const document = {
    asyncapi: '3.0.0',
    info: {
      title: 'GaoQ ERP CloudEvents',
      version: '0.1.0',
      description:
        '由 ERP Outbox 与专业算薪平台契约确定性生成的事件目录；所有消息使用 CloudEvents 1.0 结构化 JSON。',
    },
    defaultContentType: 'application/cloudevents+json',
    channels,
    operations,
    components: {
      messages,
      schemas: {
        CloudEventEnvelope: {
          type: 'object',
          additionalProperties: false,
          required: [
            'specversion',
            'id',
            'source',
            'type',
            'subject',
            'time',
            'datacontenttype',
            'tenantId',
            'traceId',
            'idempotencyKey',
            'schemaVersion',
            'data',
          ],
          properties: {
            specversion: { const: '1.0' },
            id: {
              type: 'string',
              pattern: '^[0-9A-HJKMNP-TV-Z]{26}$',
              description: '单调 ULID 事件标识。',
            },
            source: { type: 'string', minLength: 1, maxLength: 256 },
            type: { type: 'string', pattern: '^cn\\.gaoq\\.(erp|payroll)\\..+\\.v[1-9][0-9]*$' },
            subject: { type: 'string', minLength: 1, maxLength: 512 },
            time: { type: 'string', format: 'date-time' },
            datacontenttype: { const: 'application/json' },
            tenantId: { type: 'string', minLength: 1, maxLength: 128 },
            traceId: { type: 'string', minLength: 1, maxLength: 128 },
            idempotencyKey: { type: 'string', minLength: 1, maxLength: 512 },
            schemaVersion: { const: '1' },
            data: {
              type: 'object',
              additionalProperties: true,
              description:
                '逐 type 负载由 x-runtime-schema-sources 指向的严格运行时 Schema 校验。',
            },
          },
        },
      },
    },
    'x-event-count': events.length,
    'x-outbound-count': events.length - inboundCount,
    'x-inbound-count': inboundCount,
    'x-generated-from': [
      ...new Set([
        ...eventGroups.flatMap(({ files }) => files),
        platformContractFile,
        'packages/platform-contracts/src/payroll-event-schemas.ts',
      ]),
    ].sort(),
    'x-contract-limitations': [
      '物理 Broker、Topic ACL、保留周期和死信拓扑属于目标环境平台准入，不在仓库中假定。',
      '通用信封在 AsyncAPI 中完整展开；逐 type data 字段继续由已列出的 Zod、TypeScript 和 JSON Schema 运行时契约约束。',
      '本目录不授权 AI 或 MCP 直接发布、重放或消费事件。',
    ],
  };
  validateDocument(document);
  return document;
};

/** 运行无文件写入的正负自测。 */
const runSelfTest = () => {
  const fixture = {
    asyncapi: '3.0.0',
    channels: { one: {} },
    operations: { sendOne: {} },
    components: {
      messages: {
        Event: {
          name: 'cn.gaoq.erp.example.changed.v1',
          'x-direction': 'outbound',
          'x-runtime-schema-sources': ['example.ts'],
        },
      },
    },
    'x-event-count': 1,
  };
  validateDocument(fixture);
  const candidates = [
    { ...fixture, asyncapi: '2.6.0' },
    { ...fixture, 'x-event-count': 2 },
    {
      ...fixture,
      components: {
        messages: {
          Event: {
            ...fixture.components.messages.Event,
            'x-direction': undefined,
          },
        },
      },
    },
  ];
  for (const candidate of candidates) {
    let rejected = false;
    try {
      validateDocument(candidate);
    } catch {
      rejected = true;
    }
    if (!rejected) {
      throw new Error('AsyncAPI 负向自测未失败关闭');
    }
  }
  process.stdout.write(`AsyncAPI 生成器自测通过：1 个正向场景，${candidates.length} 个负向场景。\n`);
};

if (args.has('--self-test')) {
  runSelfTest();
} else {
  const document = await buildDocument();
  const serialized = `${JSON.stringify(document, null, 2)}\n`;
  if (args.has('--write')) {
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, serialized, 'utf8');
    process.stdout.write(
      `AsyncAPI 已生成：${relative(repoRoot, outputPath)}，${document['x-event-count']} 个事件（出站 ${document['x-outbound-count']}，入站 ${document['x-inbound-count']}）。\n`,
    );
  } else {
    const existing = await readFile(outputPath, 'utf8').catch(() => '');
    if (existing !== serialized) {
      throw new Error(
        `AsyncAPI 契约已漂移：请执行 pnpm contracts:asyncapi:generate 并提交 ${relative(repoRoot, outputPath)}`,
      );
    }
    process.stdout.write(
      `AsyncAPI 契约校验通过：${document['x-event-count']} 个事件（出站 ${document['x-outbound-count']}，入站 ${document['x-inbound-count']}）。\n`,
    );
  }
}
