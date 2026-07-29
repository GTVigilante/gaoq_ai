import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sourceRoot = resolve(repoRoot, 'apps/erp-api/src');
const outputPath = resolve(repoRoot, 'contracts/openapi/erp-api.openapi.json');
const args = new Set(process.argv.slice(2));
const httpDecorators = new Map([
  ['Get', ['get']],
  ['Post', ['post']],
  ['Put', ['put']],
  ['Patch', ['patch']],
  ['Delete', ['delete']],
  ['All', ['get', 'post', 'put', 'patch', 'delete', 'options', 'head']],
]);
const globalPrefixExclusions = new Set([
  'mcp',
  '.well-known/oauth-protected-resource',
  '.well-known/oauth-authorization-server',
  '.well-known/jwks.json',
]);

/** 按字典序递归寻找 Controller 源文件，确保生成结果与文件系统遍历顺序无关。 */
const findControllerFiles = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(async (entry) => {
        const entryPath = resolve(directory, entry.name);
        if (entry.isDirectory()) {
          return findControllerFiles(entryPath);
        }
        return entry.name.endsWith('.controller.ts') ? [entryPath] : [];
      }),
  );
  return nested.flat();
};

/** 返回节点上的 TypeScript 5 装饰器。 */
const decoratorsOf = (node) =>
  ts.canHaveDecorators(node) ? [...(ts.getDecorators(node) ?? [])] : [];

/** 解析装饰器名称和调用参数；属性访问形式保留末段名称。 */
const decoratorCall = (decorator, sourceFile) => {
  const expression = decorator.expression;
  if (!ts.isCallExpression(expression)) {
    return {
      name: expression.getText(sourceFile).split('.').at(-1),
      args: [],
      node: expression,
    };
  }
  return {
    name: expression.expression.getText(sourceFile).split('.').at(-1),
    args: [...expression.arguments],
    node: expression,
  };
};

/** 只接受静态字符串，拒绝让运行时表达式悄悄进入发布契约。 */
const staticString = (node, sourceFile, context) => {
  if (node === undefined) {
    return '';
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  throw new Error(`${context} 必须使用静态字符串，当前为 ${node.getText(sourceFile)}`);
};

/** 读取 JSDoc 第一行作为面向读者的操作摘要。 */
const jsDocSummary = (node) => {
  const raw = node.jsDoc?.at(-1)?.comment;
  const text =
    typeof raw === 'string'
      ? raw
      : Array.isArray(raw)
        ? raw.map((item) => item.text ?? '').join('')
        : '';
  return text.trim().split(/\r?\n/u)[0]?.trim() ?? '';
};

/** 规范化 Nest 路由片段。 */
const normalizeRoutePart = (value) => value.trim().replace(/^\/+|\/+$/gu, '');

/** 把 Nest 的 :param 路径转换为 OpenAPI 的 {param}。 */
const toOpenApiPath = (controllerPath, methodPath) => {
  const joined = [controllerPath, methodPath]
    .map(normalizeRoutePart)
    .filter(Boolean)
    .join('/');
  const withPrefix = globalPrefixExclusions.has(joined) ? joined : `api/${joined}`;
  return `/${withPrefix.replace(/:([A-Za-z0-9_]+)/gu, '{$1}')}`;
};

/** 从模块目录生成稳定标签。 */
const tagFor = (filePath) => {
  const normalized = relative(sourceRoot, filePath).split(sep).join('/');
  const moduleMatch = normalized.match(/^modules\/([^/]+)\//u);
  return moduleMatch?.[1] ?? normalized.split('/')[0];
};

/** 将源码类型保守映射为 OpenAPI Schema，并保留原始 TypeScript 类型。 */
const schemaForType = (typeText, { required = false } = {}) => {
  const compact = typeText.replace(/\s+/gu, ' ').trim();
  const withoutUndefined = compact
    .split('|')
    .map((part) => part.trim())
    .filter((part) => part !== 'undefined')
    .join(' | ');
  const normalized = withoutUndefined || compact || 'unknown';
  const extension = { 'x-typescript-type': normalized };
  if (normalized === 'string') {
    return { type: 'string', ...extension };
  }
  if (normalized === 'number') {
    return { type: 'number', ...extension };
  }
  if (normalized === 'boolean') {
    return { type: 'boolean', ...extension };
  }
  if (normalized === 'Date') {
    return { type: 'string', format: 'date-time', ...extension };
  }
  if (normalized.endsWith('[]') || /^ReadonlyArray<.+>$/u.test(normalized)) {
    const itemType = normalized.endsWith('[]')
      ? normalized.slice(0, -2)
      : normalized.slice('ReadonlyArray<'.length, -1);
    return { type: 'array', items: schemaForType(itemType), ...extension };
  }
  if (normalized === 'void' || normalized === 'undefined') {
    return extension;
  }
  const literalValues = normalized
    .split('|')
    .map((part) => part.trim())
    .filter((part) => /^(['"]).*\1$/u.test(part))
    .map((part) => part.slice(1, -1));
  if (literalValues.length > 0 && literalValues.length === normalized.split('|').length) {
    return { type: 'string', enum: literalValues, ...extension };
  }
  return {
    type: 'object',
    additionalProperties: true,
    ...extension,
    ...(required ? { 'x-runtime-validation': 'ValidationPipe' } : {}),
  };
};

/** 解开 Promise 返回类型并去掉多余空白。 */
const responseTypeOf = (method, sourceFile) => {
  const raw = method.type?.getText(sourceFile).replace(/\s+/gu, ' ').trim() ?? 'unknown';
  const promise = raw.match(/^Promise<(.+)>$/u);
  return promise?.[1] ?? raw;
};

/** 读取 RequiredScopes、PublicRoute 和 UseGuards 元数据。 */
const securityMetadata = (decorators, sourceFile) => {
  const scopes = [];
  const guards = [];
  let isPublic = false;
  for (const decorator of decorators) {
    const call = decoratorCall(decorator, sourceFile);
    if (call.name === 'RequiredScopes') {
      for (const argument of call.args) {
        scopes.push(staticString(argument, sourceFile, 'RequiredScopes'));
      }
    }
    if (call.name === 'PublicRoute') {
      isPublic = true;
    }
    if (call.name === 'UseGuards') {
      guards.push(...call.args.map((argument) => argument.getText(sourceFile)));
    }
  }
  return { scopes, guards, isPublic };
};

/** 把 Controller 方法参数转换为 OpenAPI 参数、请求体和运行时类型扩展。 */
const requestContractOf = (method, sourceFile) => {
  const parameters = [];
  let requestBody;
  const runtimeParameters = [];

  for (const parameter of method.parameters) {
    const typeText = parameter.type?.getText(sourceFile) ?? 'unknown';
    const optional = parameter.questionToken !== undefined || typeText.includes('undefined');
    const parameterName = parameter.name.getText(sourceFile);
    for (const decorator of decoratorsOf(parameter)) {
      const call = decoratorCall(decorator, sourceFile);
      if (!['Param', 'Query', 'Headers', 'Body', 'Req', 'Res', 'RawResponse'].includes(call.name)) {
        continue;
      }
      const supportsDeclaredName = ['Param', 'Query', 'Headers'].includes(call.name);
      const declaredName =
        !supportsDeclaredName || call.args[0] === undefined
          ? ''
          : staticString(call.args[0], sourceFile, `${call.name}(${parameterName})`);
      runtimeParameters.push({
        decorator: call.name,
        name: declaredName || parameterName,
        type: typeText,
      });

      if (call.name === 'Body') {
        requestBody = {
          required: !optional,
          content: {
            'application/json': {
              schema: schemaForType(typeText, { required: !optional }),
            },
          },
        };
      } else if (call.name === 'Param' && declaredName) {
        parameters.push({
          name: declaredName,
          in: 'path',
          required: true,
          schema: schemaForType(typeText),
        });
      } else if (call.name === 'Query') {
        parameters.push(
          declaredName
            ? {
                name: declaredName,
                in: 'query',
                required: !optional,
                schema: schemaForType(typeText),
              }
            : {
                name: parameterName,
                in: 'query',
                required: false,
                style: 'deepObject',
                explode: true,
                schema: schemaForType(typeText),
                'x-object-query': true,
              },
        );
      } else if (call.name === 'Headers' && declaredName) {
        parameters.push({
          name: declaredName,
          in: 'header',
          required: !optional,
          schema: schemaForType(typeText),
        });
      }
    }
  }

  return {
    parameters: parameters.sort(
      (left, right) => left.in.localeCompare(right.in) || left.name.localeCompare(right.name),
    ),
    requestBody,
    runtimeParameters,
  };
};

/** 读取显式 HttpCode；其余遵循 Nest 默认状态码。 */
const responseStatusOf = (decorators, sourceFile, httpMethod) => {
  const httpCode = decorators
    .map((decorator) => decoratorCall(decorator, sourceFile))
    .find((call) => call.name === 'HttpCode');
  if (httpCode?.args[0] !== undefined) {
    const value = Number(httpCode.args[0].getText(sourceFile));
    if (!Number.isInteger(value) || value < 100 || value > 599) {
      throw new Error(`HttpCode 必须为静态有效状态码：${httpCode.args[0].getText(sourceFile)}`);
    }
    return String(value);
  }
  return httpMethod === 'post' ? '201' : '200';
};

/** 构建单个操作并保留无法无损翻译的 Nest 运行时信息。 */
const buildOperation = ({
  className,
  method,
  methodName,
  sourceFile,
  filePath,
  httpMethod,
  nestMethod,
  path,
  classSecurity,
}) => {
  const methodDecorators = decoratorsOf(method);
  const methodSecurity = securityMetadata(methodDecorators, sourceFile);
  const scopes =
    methodSecurity.scopes.length > 0 ? methodSecurity.scopes : classSecurity.scopes;
  const isPublic = methodSecurity.isPublic || classSecurity.isPublic;
  if (isPublic && scopes.length > 0) {
    throw new Error(`${relative(repoRoot, filePath)}:${methodName} 同时声明 PublicRoute 和 Scope`);
  }
  const { parameters, requestBody, runtimeParameters } = requestContractOf(method, sourceFile);
  const pathVariables = [...path.matchAll(/\{([^}]+)\}/gu)].map((match) => match[1]);
  const declaredPathVariables = parameters
    .filter((parameter) => parameter.in === 'path')
    .map((parameter) => parameter.name);
  const missingPathVariables = pathVariables.filter(
    (variable) => !declaredPathVariables.includes(variable),
  );
  const excessPathVariables = declaredPathVariables.filter(
    (variable) => !pathVariables.includes(variable),
  );
  if (missingPathVariables.length > 0 || excessPathVariables.length > 0) {
    throw new Error(
      `${relative(repoRoot, filePath)}:${methodName} 路径参数不一致；缺失=${missingPathVariables.join(',') || '-'} 多余=${excessPathVariables.join(',') || '-'}`,
    );
  }

  const responseType = responseTypeOf(method, sourceFile);
  const responseStatus = responseStatusOf(methodDecorators, sourceFile, httpMethod);
  const line = sourceFile.getLineAndCharacterOfPosition(method.getStart(sourceFile)).line + 1;
  const response =
    responseType === 'void'
      ? { description: '请求已处理，无结构化响应体。' }
      : {
          description: '请求成功。',
          content: {
            'application/json': {
              schema: schemaForType(responseType),
            },
          },
        };
  const guardNames = [...new Set([...classSecurity.guards, ...methodSecurity.guards])].sort();
  const operationId = `${className}.${methodName}${nestMethod === 'All' ? `.${httpMethod}` : ''}`;

  return {
    operationId,
    tags: [tagFor(filePath)],
    summary: jsDocSummary(method) || `${className}.${methodName}`,
    security: isPublic ? [] : [{ oauth2: [...new Set(scopes)].sort() }],
    parameters,
    ...(requestBody === undefined ? {} : { requestBody }),
    responses: {
      [responseStatus]: response,
      default: { $ref: '#/components/responses/Problem' },
    },
    'x-source': `${relative(repoRoot, filePath).split(sep).join('/')}:${line}`,
    'x-controller': className,
    'x-handler': methodName,
    'x-nest-method': nestMethod.toUpperCase(),
    'x-authentication': isPublic
      ? 'public'
      : scopes.length > 0
        ? 'oauth-scoped'
        : 'authenticated',
    'x-required-scopes': [...new Set(scopes)].sort(),
    'x-guards': guardNames,
    'x-runtime-parameters': runtimeParameters,
  };
};

/** 扫描 Controller AST 并生成按路径和方法排序的操作集合。 */
const collectOperations = async (files) => {
  const operations = [];
  for (const filePath of files) {
    const sourceText = await readFile(filePath, 'utf8');
    const sourceFile = ts.createSourceFile(
      filePath,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    for (const statement of sourceFile.statements) {
      if (!ts.isClassDeclaration(statement) || statement.name === undefined) {
        continue;
      }
      const classDecorators = decoratorsOf(statement);
      const controller = classDecorators
        .map((decorator) => decoratorCall(decorator, sourceFile))
        .find((call) => call.name === 'Controller');
      if (controller === undefined) {
        continue;
      }
      const controllerPath = staticString(
        controller.args[0],
        sourceFile,
        `${statement.name.text} Controller`,
      );
      const classSecurity = securityMetadata(classDecorators, sourceFile);
      for (const member of statement.members) {
        if (!ts.isMethodDeclaration(member) || member.name === undefined) {
          continue;
        }
        const methodDecorators = decoratorsOf(member);
        const route = methodDecorators
          .map((decorator) => decoratorCall(decorator, sourceFile))
          .find((call) => httpDecorators.has(call.name));
        if (route === undefined) {
          continue;
        }
        const methodPath = staticString(
          route.args[0],
          sourceFile,
          `${statement.name.text}.${member.name.getText(sourceFile)} 路由`,
        );
        const path = toOpenApiPath(controllerPath, methodPath);
        const methodName = member.name.getText(sourceFile);
        for (const httpMethod of httpDecorators.get(route.name)) {
          operations.push({
            path,
            httpMethod,
            operation: buildOperation({
              className: statement.name.text,
              method: member,
              methodName,
              sourceFile,
              filePath,
              httpMethod,
              nestMethod: route.name,
              path,
              classSecurity,
            }),
          });
        }
      }
    }
  }
  return operations.sort(
    (left, right) =>
      left.path.localeCompare(right.path) || left.httpMethod.localeCompare(right.httpMethod),
  );
};

/** 校验 OpenAPI 结构、操作唯一性和安全元数据。 */
const validateDocument = (document) => {
  const errors = [];
  if (document.openapi !== '3.1.0') {
    errors.push('openapi 必须为 3.1.0');
  }
  const operationIds = new Set();
  let operationCount = 0;
  for (const [path, pathItem] of Object.entries(document.paths ?? {})) {
    if (!path.startsWith('/')) {
      errors.push(`路径必须以 / 开头：${path}`);
    }
    for (const [method, operation] of Object.entries(pathItem)) {
      operationCount += 1;
      if (operationIds.has(operation.operationId)) {
        errors.push(`operationId 重复：${operation.operationId}`);
      }
      operationIds.add(operation.operationId);
      if (!Array.isArray(operation.security) || operation.security.length > 1) {
        errors.push(`${method.toUpperCase()} ${path} 必须显式声明单一安全策略或 public []`);
      }
      if (!Array.isArray(operation['x-required-scopes'])) {
        errors.push(`${method.toUpperCase()} ${path} 缺少 x-required-scopes`);
      }
      if (Object.keys(operation.responses ?? {}).length === 0) {
        errors.push(`${method.toUpperCase()} ${path} 缺少响应定义`);
      }
    }
  }
  if (operationCount !== document['x-operation-count']) {
    errors.push(
      `x-operation-count 不一致：声明 ${document['x-operation-count']}，实际 ${operationCount}`,
    );
  }
  if (errors.length > 0) {
    throw new Error(`OpenAPI 校验失败：\n- ${errors.join('\n- ')}`);
  }
};

/** 组装最终 OpenAPI 3.1 文档。 */
const buildDocument = async () => {
  const controllerFiles = await findControllerFiles(sourceRoot);
  const operations = await collectOperations(controllerFiles);
  const paths = {};
  const scopes = new Set();
  for (const { path, httpMethod, operation } of operations) {
    paths[path] ??= {};
    if (paths[path][httpMethod] !== undefined) {
      throw new Error(`${httpMethod.toUpperCase()} ${path} 存在重复 Controller 路由`);
    }
    paths[path][httpMethod] = operation;
    for (const scope of operation['x-required-scopes']) {
      scopes.add(scope);
    }
  }
  const document = {
    openapi: '3.1.0',
    info: {
      title: 'GaoQ ERP API',
      version: '0.1.0',
      description:
        '由 NestJS Controller 源码确定性生成的 REST 契约。字段级约束仍由 DTO 与全局 ValidationPipe 执行；x-typescript-type 保留无法无损转换的源码类型。',
    },
    servers: [
      {
        url: 'https://{erpHost}',
        description: '由环境配置注入的 ERP HTTPS 入口。',
        variables: {
          erpHost: {
            default: 'erp.example.invalid',
            description: '占位域名；禁止将测试值视为生产地址。',
          },
        },
      },
    ],
    paths,
    components: {
      securitySchemes: {
        oauth2: {
          type: 'oauth2',
          description: 'OAuth 2.1 授权码 + PKCE 或客户端凭证；租户仅来自已验证身份上下文。',
          flows: {
            authorizationCode: {
              authorizationUrl: '/api/auth/oauth/authorize',
              tokenUrl: '/api/auth/oauth/token',
              scopes: Object.fromEntries(
                [...scopes].sort().map((scope) => [scope, `访问 ${scope} 保护的 ERP 能力。`]),
              ),
            },
            clientCredentials: {
              tokenUrl: '/api/auth/oauth/token',
              scopes: Object.fromEntries(
                [...scopes].sort().map((scope) => [scope, `访问 ${scope} 保护的 ERP 能力。`]),
              ),
            },
          },
        },
      },
      schemas: {
        Problem: {
          type: 'object',
          additionalProperties: true,
          required: ['code', 'message'],
          properties: {
            code: { type: 'string' },
            message: { type: 'string' },
            traceId: { type: 'string' },
          },
        },
      },
      responses: {
        Problem: {
          description: '统一业务或协议错误。',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/Problem' },
            },
          },
        },
      },
    },
    'x-generated-from': controllerFiles.map((filePath) =>
      relative(repoRoot, filePath).split(sep).join('/'),
    ),
    'x-controller-count': controllerFiles.length,
    'x-route-declaration-count': operations.filter(
      ({ operation }) =>
        operation['x-nest-method'] !== 'ALL' || operation.operationId.endsWith('.get'),
    ).length,
    'x-operation-count': operations.length,
    'x-contract-limitations': [
      '对象字段级约束未在当前生成器中展开；消费者必须读取 x-typescript-type，并以 DTO、ValidationPipe 和契约测试为最终字段约束。',
      '@All 路由展开为 OpenAPI 支持的七种 HTTP 方法，x-nest-method 保留原始 ALL 语义。',
      '生产域名和 OAuth 客户端注册属于环境配置，不写入仓库。',
    ],
  };
  validateDocument(document);
  return document;
};

/** 运行不触碰仓库文件的负向自测。 */
const runSelfTest = () => {
  const fixture = {
    openapi: '3.1.0',
    paths: {
      '/api/health': {
        get: {
          operationId: 'HealthController.get',
          security: [],
          responses: { 200: { description: 'ok' } },
          'x-required-scopes': [],
        },
      },
    },
    'x-operation-count': 1,
  };
  validateDocument(fixture);
  const failures = [
    ['版本漂移', { ...fixture, openapi: '3.0.3' }],
    ['数量漂移', { ...fixture, 'x-operation-count': 2 }],
    [
      '缺少安全策略',
      {
        ...fixture,
        paths: {
          '/api/health': {
            get: {
              ...fixture.paths['/api/health'].get,
              security: undefined,
            },
          },
        },
      },
    ],
  ];
  for (const [name, candidate] of failures) {
    let rejected = false;
    try {
      validateDocument(candidate);
    } catch {
      rejected = true;
    }
    if (!rejected) {
      throw new Error(`自测失败：${name} 未被拒绝`);
    }
  }
  process.stdout.write(`OpenAPI 生成器自测通过：1 个正向场景，${failures.length} 个负向场景。\n`);
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
      `OpenAPI 已生成：${relative(repoRoot, outputPath)}，${document['x-controller-count']} 个 Controller，${document['x-route-declaration-count']} 个路由声明，${document['x-operation-count']} 个操作。\n`,
    );
  } else {
    const existing = await readFile(outputPath, 'utf8').catch(() => '');
    if (existing !== serialized) {
      throw new Error(
        `OpenAPI 契约已漂移：请执行 pnpm contracts:openapi:generate 并提交 ${relative(repoRoot, outputPath)}`,
      );
    }
    process.stdout.write(
      `OpenAPI 契约校验通过：${document['x-route-declaration-count']} 个路由声明，${document['x-operation-count']} 个操作。\n`,
    );
  }
}
