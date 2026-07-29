import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import ts from 'typescript';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sourceRoot = resolve(repoRoot, 'apps/erp-api/src');
const tsconfigPath = resolve(repoRoot, 'apps/erp-api/tsconfig.build.json');
const requestContractsPath = resolve(
  sourceRoot,
  'contracts/rest-request-contracts.ts',
);
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
const validationDecorators = new Set([
  'ArrayMaxSize',
  'ArrayMinSize',
  'ArrayNotEmpty',
  'ArrayUnique',
  'IsArray',
  'IsBoolean',
  'IsDateString',
  'IsDefined',
  'IsEmail',
  'IsEnum',
  'IsISO8601',
  'IsIn',
  'IsInt',
  'IsObject',
  'IsOptional',
  'IsString',
  'Length',
  'Matches',
  'Max',
  'MaxLength',
  'Min',
  'MinLength',
  'Type',
  'ValidateNested',
]);
const inlineRequestSchemaNames = new Map([
  [
    'PasskeyRegistrationController.verify',
    'PasskeyRegistrationVerifyRequest',
  ],
  [
    'RecruitmentChannelOperationsController.retry',
    'RecruitmentChannelRetryRequest',
  ],
  [
    'McpConfirmationController.strongAuthVerify',
    'McpStrongAuthVerifyRequest',
  ],
  [
    'OpController.retryApprovalResultDelivery',
    'OpApprovalResultRetryRequest',
  ],
]);

/** 将文件路径规范化为仓库内跨平台形式。 */
const normalizedPath = (value) => value.split(sep).join('/');

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

/** 递归寻找生产 TypeScript 文件，排除测试、迁移和构建产物。 */
const findProductionTypeScriptFiles = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(async (entry) => {
        const entryPath = resolve(directory, entry.name);
        if (entry.isDirectory()) {
          return entry.name === 'migrations' ? [] : findProductionTypeScriptFiles(entryPath);
        }
        return entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') ? [entryPath] : [];
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
const schemaForType = (typeText, { required = false, knownSchemaNames = new Set() } = {}) => {
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
  if (
    normalized.endsWith('[]') ||
    /^(?:Readonly)?Array<.+>$/u.test(normalized)
  ) {
    const itemType = normalized.endsWith('[]')
      ? normalized.slice(0, -2)
      : normalized.slice(normalized.indexOf('<') + 1, -1);
    return {
      type: 'array',
      items: schemaForType(itemType, { knownSchemaNames }),
      ...extension,
    };
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
  const unionParts = normalized
    .split('|')
    .map((part) => part.trim())
    .filter(Boolean);
  if (unionParts.length > 1) {
    return {
      anyOf: unionParts.map((part) =>
        part === 'null'
          ? { type: 'null' }
          : schemaForType(part, { knownSchemaNames }),
      ),
      ...extension,
    };
  }
  if (knownSchemaNames.has(normalized)) {
    return { $ref: `#/components/schemas/${normalized}`, ...extension };
  }
  return {
    type: 'object',
    additionalProperties: true,
    ...extension,
    ...(required ? { 'x-runtime-validation': 'ValidationPipe' } : {}),
  };
};

/** 创建可解析跨文件接口、类型别名和推断返回值的 TypeScript Program。 */
const createContractProgram = () => {
  const config = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (config.error !== undefined) {
    throw new Error(
      `读取 TypeScript 配置失败：${ts.flattenDiagnosticMessageText(config.error.messageText, '\n')}`,
    );
  }
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    dirname(tsconfigPath),
    undefined,
    tsconfigPath,
  );
  if (parsed.errors.length > 0) {
    throw new Error(
      `解析 TypeScript 配置失败：${parsed.errors
        .map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n'))
        .join('; ')}`,
    );
  }
  return ts.createProgram({
    rootNames: parsed.fileNames,
    options: parsed.options,
    projectReferences: parsed.projectReferences,
  });
};

/** 判断编译器类型是否包含指定 Flag。 */
const hasTypeFlag = (type, flag) => (type.flags & flag) !== 0;

/** 将 TypeScript 编译器类型递归转换为严格 JSON Schema。 */
const schemaForCompilerType = (
  type,
  checker,
  context,
  { seen = new Set(), depth = 0 } = {},
) => {
  const typeText = checker.typeToString(
    type,
    undefined,
    ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope,
  );
  const extension = { 'x-typescript-type': typeText };
  if (depth > 24) {
    throw new Error(`${context} 类型嵌套超过 24 层：${typeText}`);
  }
  if (hasTypeFlag(type, ts.TypeFlags.Any) || hasTypeFlag(type, ts.TypeFlags.Unknown)) {
    if (depth > 0) {
      return {
        ...extension,
        'x-intentionally-untyped': true,
      };
    }
    throw new Error(`${context} 不能生成显式 Schema：${typeText}`);
  }
  if (
    hasTypeFlag(type, ts.TypeFlags.Void) ||
    hasTypeFlag(type, ts.TypeFlags.Undefined) ||
    hasTypeFlag(type, ts.TypeFlags.Never)
  ) {
    return { ...extension, 'x-no-content': true };
  }
  if (hasTypeFlag(type, ts.TypeFlags.Null)) {
    return { type: 'null', ...extension };
  }
  if (hasTypeFlag(type, ts.TypeFlags.StringLiteral)) {
    return { type: 'string', const: type.value, ...extension };
  }
  if (hasTypeFlag(type, ts.TypeFlags.NumberLiteral)) {
    return { type: 'number', const: type.value, ...extension };
  }
  if (typeText === 'true' || typeText === 'false') {
    return { type: 'boolean', const: typeText === 'true', ...extension };
  }
  if (hasTypeFlag(type, ts.TypeFlags.StringLike)) {
    return { type: 'string', ...extension };
  }
  if (hasTypeFlag(type, ts.TypeFlags.NumberLike)) {
    return { type: 'number', ...extension };
  }
  if (hasTypeFlag(type, ts.TypeFlags.BooleanLike)) {
    return { type: 'boolean', ...extension };
  }
  if (hasTypeFlag(type, ts.TypeFlags.BigIntLike)) {
    return { type: 'integer', format: 'int64', ...extension };
  }
  if (type.isUnion()) {
    const members = type.types.filter(
      (member) => !hasTypeFlag(member, ts.TypeFlags.Undefined),
    );
    if (members.length === 1) {
      return {
        ...schemaForCompilerType(members[0], checker, context, { seen, depth: depth + 1 }),
        ...extension,
      };
    }
    const literalStrings = members.filter((member) =>
      hasTypeFlag(member, ts.TypeFlags.StringLiteral),
    );
    if (literalStrings.length === members.length) {
      return {
        type: 'string',
        enum: literalStrings.map((member) => member.value),
        ...extension,
      };
    }
    return {
      anyOf: members.map((member) =>
        schemaForCompilerType(member, checker, context, { seen, depth: depth + 1 }),
      ),
      ...extension,
    };
  }
  if (type.isIntersection()) {
    return {
      allOf: type.types.map((member) =>
        schemaForCompilerType(member, checker, context, { seen, depth: depth + 1 }),
      ),
      ...extension,
    };
  }
  if (checker.isTupleType(type)) {
    const items = checker
      .getTypeArguments(type)
      .map((item) =>
        schemaForCompilerType(item, checker, context, { seen, depth: depth + 1 }),
      );
    return {
      type: 'array',
      prefixItems: items,
      minItems: items.length,
      maxItems: items.length,
      ...extension,
    };
  }
  if (checker.isArrayType(type)) {
    const item = checker.getTypeArguments(type)[0];
    if (item === undefined) {
      throw new Error(`${context} 数组缺少元素类型：${typeText}`);
    }
    return {
      type: 'array',
      items: schemaForCompilerType(item, checker, context, { seen, depth: depth + 1 }),
      ...extension,
    };
  }
  if (!hasTypeFlag(type, ts.TypeFlags.Object)) {
    throw new Error(`${context} 暂不支持的 TypeScript 类型：${typeText}`);
  }
  if (typeText === 'Date') {
    return { type: 'string', format: 'date-time', ...extension };
  }
  if (seen.has(type)) {
    return {
      type: 'object',
      additionalProperties: false,
      ...extension,
      'x-recursive-boundary': true,
    };
  }
  const nextSeen = new Set(seen);
  nextSeen.add(type);
  const properties = {};
  const required = [];
  for (const property of checker.getPropertiesOfType(type)) {
    const declaration =
      property.valueDeclaration ??
      property.declarations?.[0] ??
      type.aliasSymbol?.declarations?.[0] ??
      type.symbol?.declarations?.[0];
    if (declaration === undefined) {
      continue;
    }
    const propertyType = checker.getTypeOfSymbolAtLocation(property, declaration);
    properties[property.name] = schemaForCompilerType(propertyType, checker, context, {
      seen: nextSeen,
      depth: depth + 1,
    });
    if ((property.flags & ts.SymbolFlags.Optional) === 0) {
      required.push(property.name);
    }
  }
  const stringIndex = checker.getIndexTypeOfType(type, ts.IndexKind.String);
  const numberIndex = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
  const indexType = stringIndex ?? numberIndex;
  if (Object.keys(properties).length === 0 && indexType === undefined) {
    throw new Error(`${context} 空对象类型没有可发布字段：${typeText}`);
  }
  return {
    type: 'object',
    additionalProperties:
      indexType === undefined
        ? false
        : schemaForCompilerType(indexType, checker, context, {
            seen: nextSeen,
            depth: depth + 1,
          }),
    properties,
    ...(required.length === 0 ? {} : { required: required.sort() }),
    ...extension,
  };
};

/** 解析静态数字参数。 */
const staticNumber = (node, sourceFile) => {
  if (node === undefined) {
    return undefined;
  }
  const value = Number(node.getText(sourceFile).replaceAll('_', ''));
  return Number.isFinite(value) ? value : undefined;
};

/** 解析装饰器中的静态字符串数组。 */
const staticStringArray = (node) => {
  if (!ts.isArrayLiteralExpression(node)) {
    return undefined;
  }
  const values = [];
  for (const element of node.elements) {
    if (!ts.isStringLiteral(element)) {
      return undefined;
    }
    values.push(element.text);
  }
  return values;
};

/** 从 Type(() => NestedDto) 读取嵌套 DTO 名称。 */
const nestedDtoName = (calls, sourceFile) => {
  const typeCall = calls.find(({ name }) => name === 'Type');
  const argument = typeCall?.args[0];
  if (argument === undefined || !ts.isArrowFunction(argument)) {
    return undefined;
  }
  const body = argument.body;
  return ts.isIdentifier(body) ? body.text : body.getText(sourceFile);
};

/** 将 class-validator 属性约束转换为 JSON Schema 2020-12。 */
const dtoPropertySchema = (property, sourceFile, knownSchemaNames) => {
  const calls = decoratorsOf(property).map((decorator) => decoratorCall(decorator, sourceFile));
  const callNames = new Set(calls.map(({ name }) => name));
  const typeText = property.type?.getText(sourceFile) ?? 'unknown';
  const nestedName = nestedDtoName(calls, sourceFile);
  let schema = schemaForType(typeText, { knownSchemaNames });
  if (callNames.has('IsString')) {
    schema = { type: 'string', 'x-typescript-type': typeText };
  } else if (callNames.has('IsInt')) {
    schema = { type: 'integer', 'x-typescript-type': typeText };
  } else if (callNames.has('IsBoolean')) {
    schema = { type: 'boolean', 'x-typescript-type': typeText };
  } else if (callNames.has('IsObject')) {
    schema = {
      type: 'object',
      additionalProperties: true,
      'x-typescript-type': typeText,
    };
  }
  if (callNames.has('IsArray')) {
    const itemType = typeText.endsWith('[]') ? typeText.slice(0, -2) : 'unknown';
    schema = {
      type: 'array',
      items:
        nestedName !== undefined && knownSchemaNames.has(nestedName)
          ? { $ref: `#/components/schemas/${nestedName}` }
          : schemaForType(itemType, { knownSchemaNames }),
      'x-typescript-type': typeText,
    };
  } else if (nestedName !== undefined && knownSchemaNames.has(nestedName)) {
    schema = {
      $ref: `#/components/schemas/${nestedName}`,
      'x-typescript-type': typeText,
    };
  }

  for (const call of calls) {
    const firstNumber = staticNumber(call.args[0], sourceFile);
    if (call.name === 'Min' && firstNumber !== undefined) schema.minimum = firstNumber;
    if (call.name === 'Max' && firstNumber !== undefined) schema.maximum = firstNumber;
    if (call.name === 'MinLength' && firstNumber !== undefined) schema.minLength = firstNumber;
    if (call.name === 'MaxLength' && firstNumber !== undefined) schema.maxLength = firstNumber;
    if (call.name === 'ArrayMinSize' && firstNumber !== undefined) schema.minItems = firstNumber;
    if (call.name === 'ArrayMaxSize' && firstNumber !== undefined) schema.maxItems = firstNumber;
    if (call.name === 'ArrayNotEmpty') schema.minItems = Math.max(schema.minItems ?? 0, 1);
    if (call.name === 'ArrayUnique') schema.uniqueItems = true;
    if (call.name === 'Length') {
      const secondNumber = staticNumber(call.args[1], sourceFile);
      if (firstNumber !== undefined) schema.minLength = firstNumber;
      if (secondNumber !== undefined) schema.maxLength = secondNumber;
    }
    if (call.name === 'IsEmail') schema.format = 'email';
    if (call.name === 'IsISO8601' || call.name === 'IsDateString') {
      schema['x-class-validator-format'] = 'ISO8601';
    }
    if (call.name === 'IsIn') {
      const values = staticStringArray(call.args[0]);
      if (values !== undefined) schema.enum = values;
    }
    if (call.name === 'IsEnum') {
      const values = staticStringArray(call.args[0]);
      if (values !== undefined) {
        schema.enum = values;
      } else if (call.args[0] !== undefined) {
        schema['x-class-validator-enum'] = call.args[0].getText(sourceFile);
      }
    }
    if (call.name === 'Matches' && call.args[0] !== undefined) {
      const argumentText = call.args[0].getText(sourceFile);
      const regex = argumentText.match(/^\/(.*)\/[a-z]*$/u);
      if (regex?.[1] !== undefined) {
        schema.pattern = regex[1];
      } else {
        schema['x-class-validator-pattern'] = argumentText;
      }
    }
  }
  schema['x-class-validator'] = calls
    .filter(({ name }) => validationDecorators.has(name) && name !== 'Type')
    .map(({ name }) => name)
    .sort();
  return schema;
};

/** 从 DTO 类生成字段级 JSON Schema，并保留继承关系。 */
const collectDtoSchemas = async () => {
  const definitions = new Map();
  for (const filePath of await findProductionTypeScriptFiles(sourceRoot)) {
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
      const properties = statement.members.filter(ts.isPropertyDeclaration);
      const hasValidationDecorator = properties.some((property) =>
        decoratorsOf(property)
          .map((decorator) => decoratorCall(decorator, sourceFile).name)
          .some((name) => validationDecorators.has(name)),
      );
      if (!statement.name.text.endsWith('Dto') && !hasValidationDecorator) {
        continue;
      }
      if (definitions.has(statement.name.text)) {
        throw new Error(`DTO Schema 名称重复：${statement.name.text}`);
      }
      const baseName = statement.heritageClauses
        ?.find(({ token }) => token === ts.SyntaxKind.ExtendsKeyword)
        ?.types[0]?.expression.getText(sourceFile);
      definitions.set(statement.name.text, {
        name: statement.name.text,
        baseName,
        properties,
        sourceFile,
        filePath,
      });
    }
  }
  const knownSchemaNames = new Set(definitions.keys());
  const schemas = {};
  for (const definition of [...definitions.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const properties = {};
    const required = [];
    for (const property of definition.properties) {
      if (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name)) {
        throw new Error(`${definition.name} 含动态 DTO 字段名`);
      }
      const name = property.name.text;
      const calls = decoratorsOf(property).map((decorator) =>
        decoratorCall(decorator, definition.sourceFile),
      );
      properties[name] = dtoPropertySchema(property, definition.sourceFile, knownSchemaNames);
      const optional =
        property.questionToken !== undefined ||
        property.type?.getText(definition.sourceFile).includes('undefined') ||
        calls.some((call) => call.name === 'IsOptional');
      if (!optional || calls.some((call) => call.name === 'IsDefined')) {
        required.push(name);
      }
    }
    const ownSchema = {
      type: 'object',
      additionalProperties: false,
      properties,
      ...(required.length === 0 ? {} : { required: required.sort() }),
      'x-source': normalizedPath(relative(repoRoot, definition.filePath)),
      'x-runtime-validation': 'class-validator + ValidationPipe',
    };
    schemas[definition.name] =
      definition.baseName !== undefined && knownSchemaNames.has(definition.baseName)
        ? {
            allOf: [
              { $ref: `#/components/schemas/${definition.baseName}` },
              ownSchema,
            ],
          }
        : ownSchema;
  }
  return schemas;
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
const requestContractOf = (method, sourceFile, knownSchemaNames, checker) => {
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
        const requestSchema =
          typeText === 'unknown' || knownSchemaNames.has(typeText)
            ? schemaForType(typeText, {
                required: !optional,
                knownSchemaNames,
              })
            : schemaForCompilerType(
                checker.getTypeAtLocation(parameter),
                checker,
                `${relative(repoRoot, sourceFile.fileName)}:${parameterName} 请求体`,
              );
        requestBody = {
          required: !optional,
          content: {
            'application/json': {
              schema: requestSchema,
            },
          },
        };
      } else if (call.name === 'Param' && declaredName) {
        parameters.push({
          name: declaredName,
          in: 'path',
          required: true,
          schema: schemaForType(typeText, { knownSchemaNames }),
        });
      } else if (call.name === 'Query') {
        parameters.push(
          declaredName
            ? {
                name: declaredName,
                in: 'query',
                required: !optional,
                schema: schemaForType(typeText, { knownSchemaNames }),
              }
            : {
                name: parameterName,
                in: 'query',
                required: false,
                style: 'deepObject',
                explode: true,
                schema: schemaForType(typeText, { knownSchemaNames }),
                'x-object-query': true,
              },
        );
      } else if (call.name === 'Headers' && declaredName) {
        parameters.push({
          name: declaredName,
          in: 'header',
          required: !optional,
          schema: schemaForType(typeText, { knownSchemaNames }),
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

/** 从 Express Response 调用链读取显式 status；未调用 status 时采用 200。 */
const expressResponseStatus = (call, sourceFile) => {
  const target = call.expression.expression;
  if (
    ts.isCallExpression(target) &&
    ts.isPropertyAccessExpression(target.expression) &&
    target.expression.name.text === 'status'
  ) {
    const value = staticNumber(target.arguments[0], sourceFile);
    return value === undefined ? undefined : String(value);
  }
  return '200';
};

/** 从 Express Response 调用链读取 type/contentType；缺省按 JSON。 */
const expressResponseContentType = (call, sourceFile) => {
  const target = call.expression.expression;
  if (
    ts.isCallExpression(target) &&
    ts.isPropertyAccessExpression(target.expression) &&
    ['type', 'contentType'].includes(target.expression.name.text)
  ) {
    return staticString(target.arguments[0], sourceFile, 'Response content type');
  }
  return 'application/json';
};

/** 合并同一状态码、同一媒体类型的多个返回分支。 */
const mergeResponseSchema = (current, next) => {
  if (current === undefined) {
    return next;
  }
  if (JSON.stringify(current) === JSON.stringify(next)) {
    return current;
  }
  const variants = current.anyOf === undefined ? [current] : current.anyOf;
  if (variants.some((variant) => JSON.stringify(variant) === JSON.stringify(next))) {
    return current;
  }
  return { anyOf: [...variants, next] };
};

/** 从 RawResponse 控制器内的 json/send/redirect 调用提取真实成功响应。 */
const rawSuccessResponsesOf = (method, sourceFile, checker, context, operationId) => {
  if (operationId.startsWith('McpController.handle.')) {
    return {
      200: {
        description: 'MCP Streamable HTTP 协议响应。',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              additionalProperties: true,
              'x-protocol-schema':
                'Model Context Protocol 2025-11-25 JSON-RPC response envelope',
            },
          },
          'text/event-stream': {
            schema: {
              type: 'string',
              'x-protocol-schema':
                'Model Context Protocol 2025-11-25 Streamable HTTP event stream',
            },
          },
        },
      },
    };
  }
  const collected = new Map();
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const callName = node.expression.name.text;
      if (callName === 'redirect') {
        const status = staticNumber(node.arguments[0], sourceFile);
        if (status !== undefined && status >= 200 && status < 400) {
          collected.set(String(status), {
            description: '请求成功后跳转至可信地址。',
            headers: {
              Location: {
                required: true,
                schema: { type: 'string', format: 'uri' },
              },
            },
          });
        }
      }
      if (callName === 'json' || callName === 'send') {
        const status = expressResponseStatus(node, sourceFile);
        const numericStatus = Number(status);
        if (
          status !== undefined &&
          numericStatus >= 200 &&
          numericStatus < 400
        ) {
          const argument = node.arguments[0];
          if (argument === undefined) {
            collected.set(status, {
              description: '请求成功，无响应体。',
            });
          } else {
            const contentType =
              operationId === 'MarketingCmsController.exportLeads'
                ? 'text/csv'
                : callName === 'json'
                ? 'application/json'
                : expressResponseContentType(node, sourceFile);
            const schema = schemaForCompilerType(
              checker.getTypeAtLocation(argument),
              checker,
              `${context} RawResponse ${status}`,
            );
            const existing = collected.get(status);
            const existingSchema = existing?.content?.[contentType]?.schema;
            collected.set(status, {
              description: '请求成功。',
              content: {
                ...(existing?.content ?? {}),
                [contentType]: {
                  schema: mergeResponseSchema(existingSchema, schema),
                },
              },
            });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  if (method.body !== undefined) {
    visit(method.body);
  }
  return Object.fromEntries(
    [...collected.entries()].sort(([left], [right]) => Number(left) - Number(right)),
  );
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
  knownSchemaNames,
  checker,
}) => {
  const methodDecorators = decoratorsOf(method);
  const methodSecurity = securityMetadata(methodDecorators, sourceFile);
  const scopes =
    methodSecurity.scopes.length > 0 ? methodSecurity.scopes : classSecurity.scopes;
  const isPublic = methodSecurity.isPublic || classSecurity.isPublic;
  if (isPublic && scopes.length > 0) {
    throw new Error(`${relative(repoRoot, filePath)}:${methodName} 同时声明 PublicRoute 和 Scope`);
  }
  const { parameters, requestBody, runtimeParameters } = requestContractOf(
    method,
    sourceFile,
    knownSchemaNames,
    checker,
  );
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

  const signature = checker.getSignatureFromDeclaration(method);
  if (signature === undefined) {
    throw new Error(`${relative(repoRoot, filePath)}:${methodName} 无法解析方法签名`);
  }
  const declaredReturnType = checker.getReturnTypeOfSignature(signature);
  const responseCompilerType =
    checker.getPromisedTypeOfPromise(declaredReturnType) ?? declaredReturnType;
  const responseStatus = responseStatusOf(methodDecorators, sourceFile, httpMethod);
  const line = sourceFile.getLineAndCharacterOfPosition(method.getStart(sourceFile)).line + 1;
  const successContentType =
    className === 'MetricsController' && methodName === 'scrape'
      ? 'text/plain; version=0.0.4'
      : 'application/json';
  const response =
    hasTypeFlag(responseCompilerType, ts.TypeFlags.Void) ||
    hasTypeFlag(responseCompilerType, ts.TypeFlags.Undefined)
      ? { description: '请求已处理，无结构化响应体。' }
      : {
          description: '请求成功。',
          content: {
            [successContentType]: {
              schema: schemaForCompilerType(
                responseCompilerType,
                checker,
                `${relative(repoRoot, filePath)}:${methodName} 成功响应`,
              ),
            },
          },
        };
  const guardNames = [...new Set([...classSecurity.guards, ...methodSecurity.guards])].sort();
  const operationId = `${className}.${methodName}${nestMethod === 'All' ? `.${httpMethod}` : ''}`;
  const rawResponses =
    hasTypeFlag(responseCompilerType, ts.TypeFlags.Void) ||
    hasTypeFlag(responseCompilerType, ts.TypeFlags.Undefined)
      ? rawSuccessResponsesOf(
          method,
          sourceFile,
          checker,
          `${relative(repoRoot, filePath)}:${methodName}`,
          operationId,
        )
      : {};
  const successResponses =
    Object.keys(rawResponses).length > 0
      ? rawResponses
      : { [responseStatus]: response };

  return {
    operationId,
    tags: [tagFor(filePath)],
    summary: jsDocSummary(method) || `${className}.${methodName}`,
    security: isPublic ? [] : [{ oauth2: [...new Set(scopes)].sort() }],
    parameters,
    ...(requestBody === undefined ? {} : { requestBody }),
    responses: {
      ...successResponses,
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
const collectOperations = async (files, knownSchemaNames, program) => {
  const checker = program.getTypeChecker();
  const operations = [];
  for (const filePath of files) {
    const sourceFile = program.getSourceFile(filePath);
    if (sourceFile === undefined) {
      throw new Error(`TypeScript Program 未包含 Controller：${relative(repoRoot, filePath)}`);
    }
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
              knownSchemaNames,
              checker,
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

/** 加载由运行时 Zod 源生成的请求契约，避免 OpenAPI 维护第二套字段规则。 */
const loadRuntimeRequestContracts = async () => {
  const moduleUrl = `${pathToFileURL(requestContractsPath).href}?contract=${Date.now()}`;
  const module = await import(moduleUrl);
  if (typeof module.openApiRequestContracts !== 'function') {
    throw new Error('REST 请求契约模块缺少 openApiRequestContracts 导出');
  }
  const contracts = module.openApiRequestContracts();
  for (const [operationId, contract] of Object.entries(contracts)) {
    let inheritedFilePath;
    for (const sourceRef of contract.runtimeSource.split('|')) {
      const [declaredFilePath, declaredFragment] = sourceRef.split('#');
      const filePath =
        declaredFragment === undefined ? inheritedFilePath : declaredFilePath;
      const fragment =
        declaredFragment === undefined ? declaredFilePath : declaredFragment;
      if (filePath === undefined || fragment === undefined || fragment.length === 0) {
        throw new Error(`${operationId} 的运行时 Schema 来源格式无效：${sourceRef}`);
      }
      inheritedFilePath = filePath;
      const source = await readFile(resolve(repoRoot, filePath), 'utf8').catch(() => undefined);
      if (source === undefined) {
        throw new Error(`${operationId} 的运行时 Schema 来源文件不存在：${filePath}`);
      }
      if (!source.includes(fragment)) {
        throw new Error(`${operationId} 的运行时 Schema 来源片段不存在：${sourceRef}`);
      }
    }
  }
  return contracts;
};

/** 将 unknown 与内联请求体提升为命名组件，并拒绝未登记或失效登记。 */
const bindNamedRequestSchemas = (operations, runtimeContracts) => {
  const schemas = {};
  const consumedRuntimeContracts = new Set();
  let inlineCount = 0;
  for (const { operation } of operations) {
    const content = operation.requestBody?.content;
    if (content === undefined) {
      if (runtimeContracts[operation.operationId] !== undefined) {
        throw new Error(`${operation.operationId} 登记了请求 Schema 但端点没有 Body`);
      }
      continue;
    }
    const jsonEntry = Object.entries(content)[0];
    if (jsonEntry === undefined) {
      throw new Error(`${operation.operationId} 请求体没有 content type`);
    }
    const [currentContentType, media] = jsonEntry;
    const currentSchema = media.schema;
    if (typeof currentSchema?.$ref === 'string') {
      continue;
    }
    const runtimeContract = runtimeContracts[operation.operationId];
    if (runtimeContract !== undefined) {
      if (schemas[runtimeContract.name] !== undefined) {
        throw new Error(`运行时请求 Schema 名称重复：${runtimeContract.name}`);
      }
      schemas[runtimeContract.name] = {
        ...runtimeContract.schema,
        'x-runtime-schema-source': runtimeContract.runtimeSource,
      };
      operation.requestBody.content = {
        [runtimeContract.contentType]: {
          schema: { $ref: `#/components/schemas/${runtimeContract.name}` },
        },
      };
      if (runtimeContract.required !== undefined) {
        operation.requestBody.required = runtimeContract.required;
      }
      operation.requestBody['x-runtime-schema-source'] = runtimeContract.runtimeSource;
      operation.requestBody['x-original-content-type'] = currentContentType;
      consumedRuntimeContracts.add(operation.operationId);
      continue;
    }
    const inlineName = inlineRequestSchemaNames.get(operation.operationId);
    if (inlineName === undefined) {
      throw new Error(`${operation.operationId} 含未登记的 unknown 或内联请求 Schema`);
    }
    if (schemas[inlineName] !== undefined) {
      throw new Error(`内联请求 Schema 名称重复：${inlineName}`);
    }
    schemas[inlineName] = {
      ...currentSchema,
      'x-runtime-schema-source': operation['x-source'],
    };
    operation.requestBody.content = {
      [currentContentType]: {
        schema: { $ref: `#/components/schemas/${inlineName}` },
      },
    };
    operation.requestBody['x-runtime-schema-source'] = operation['x-source'];
    inlineCount += 1;
  }
  const staleContracts = Object.keys(runtimeContracts).filter(
    (operationId) => !consumedRuntimeContracts.has(operationId),
  );
  if (staleContracts.length > 0) {
    throw new Error(`REST 请求 Schema 存在失效登记：${staleContracts.join(', ')}`);
  }
  if (inlineCount !== inlineRequestSchemaNames.size) {
    throw new Error(
      `内联请求 Schema 数量不一致：期望 ${inlineRequestSchemaNames.size}，实际 ${inlineCount}`,
    );
  }
  return {
    schemas,
    runtimeCount: consumedRuntimeContracts.size,
    inlineCount,
  };
};

/** 判断成功响应是否仍是未声明字段的顶层开放对象。 */
const isUnboundedTopLevelResponse = (schema) =>
  schema?.['x-intentionally-untyped'] === true ||
  (
    schema?.type === 'object' &&
    schema?.additionalProperties === true &&
    schema?.properties === undefined &&
    schema?.['x-protocol-schema'] === undefined
  );

/** 校验 OpenAPI 结构、操作唯一性和安全元数据。 */
const validateDocument = (document) => {
  const errors = [];
  if (document.openapi !== '3.1.0') {
    errors.push('openapi 必须为 3.1.0');
  }
  const operationIds = new Set();
  const schemas = document.components?.schemas ?? {};
  let operationCount = 0;
  let dtoRequestRefCount = 0;
  let requestBodyCount = 0;
  let namedRequestRefCount = 0;
  let explicitSuccessResponseCount = 0;
  let noContentSuccessResponseCount = 0;
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
      const requestSchema = operation.requestBody?.content?.['application/json']?.schema;
      const requestMedia = Object.values(operation.requestBody?.content ?? {})[0];
      const namedRequestSchema = requestMedia?.schema;
      if (operation.requestBody !== undefined) {
        requestBodyCount += 1;
      }
      if (typeof namedRequestSchema?.$ref === 'string') {
        namedRequestRefCount += 1;
        const schemaName = namedRequestSchema.$ref.replace('#/components/schemas/', '');
        if (schemas[schemaName] === undefined) {
          errors.push(`${method.toUpperCase()} ${path} 引用不存在的请求 Schema ${schemaName}`);
        }
      } else if (operation.requestBody !== undefined) {
        errors.push(`${method.toUpperCase()} ${path} 请求体必须绑定命名组件 Schema`);
      }
      if (typeof requestSchema?.$ref === 'string') {
        const schemaName = requestSchema.$ref.replace('#/components/schemas/', '');
        if (schemas[schemaName]?.['x-runtime-schema-source'] === undefined) {
          dtoRequestRefCount += 1;
        }
      }
      for (const [status, response] of Object.entries(operation.responses ?? {})) {
        if (status === 'default') {
          continue;
        }
        const responseContent = response.content;
        if (responseContent === undefined) {
          noContentSuccessResponseCount += 1;
          continue;
        }
        const responseMediaEntries = Object.entries(responseContent);
        if (responseMediaEntries.length === 0) {
          errors.push(`${method.toUpperCase()} ${path} 成功响应 content 不能为空`);
          continue;
        }
        let operationResponseIsExplicit = true;
        for (const [contentType, responseMedia] of responseMediaEntries) {
          const responseSchema = responseMedia?.schema;
          if (
            responseSchema === undefined ||
            responseSchema['x-typescript-type'] === 'unknown' ||
            isUnboundedTopLevelResponse(responseSchema)
          ) {
            operationResponseIsExplicit = false;
            errors.push(
              `${method.toUpperCase()} ${path} ${contentType} 成功响应缺少显式 Schema`,
            );
          }
        }
        if (operationResponseIsExplicit) {
          explicitSuccessResponseCount += 1;
        }
      }
    }
  }
  if (operationCount !== document['x-operation-count']) {
    errors.push(
      `x-operation-count 不一致：声明 ${document['x-operation-count']}，实际 ${operationCount}`,
    );
  }
  if (Object.keys(schemas).length !== document['x-component-schema-count']) {
    errors.push('x-component-schema-count 与 components.schemas 不一致');
  }
  if (dtoRequestRefCount !== document['x-dto-request-ref-count']) {
    errors.push('x-dto-request-ref-count 与请求体引用数量不一致');
  }
  if (requestBodyCount !== document['x-request-body-count']) {
    errors.push('x-request-body-count 与请求体数量不一致');
  }
  if (namedRequestRefCount !== document['x-named-request-ref-count']) {
    errors.push('x-named-request-ref-count 与命名请求引用数量不一致');
  }
  if (explicitSuccessResponseCount !== document['x-explicit-success-response-count']) {
    errors.push('x-explicit-success-response-count 与显式成功响应数量不一致');
  }
  if (noContentSuccessResponseCount !== document['x-no-content-success-response-count']) {
    errors.push('x-no-content-success-response-count 与无体成功响应数量不一致');
  }
  if (errors.length > 0) {
    throw new Error(`OpenAPI 校验失败：\n- ${errors.join('\n- ')}`);
  }
};

/** 组装最终 OpenAPI 3.1 文档。 */
const buildDocument = async () => {
  const controllerFiles = await findControllerFiles(sourceRoot);
  const program = createContractProgram();
  const dtoSchemas = await collectDtoSchemas();
  const operations = await collectOperations(
    controllerFiles,
    new Set(Object.keys(dtoSchemas)),
    program,
  );
  const runtimeRequestContracts = await loadRuntimeRequestContracts();
  const namedRequestSchemas = bindNamedRequestSchemas(
    operations,
    runtimeRequestContracts,
  );
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
        ...dtoSchemas,
        ...namedRequestSchemas.schemas,
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
    'x-dto-schema-count': Object.keys(dtoSchemas).length,
    'x-runtime-request-schema-count': namedRequestSchemas.runtimeCount,
    'x-inline-request-schema-count': namedRequestSchemas.inlineCount,
    'x-component-schema-count':
      1 + Object.keys(dtoSchemas).length + Object.keys(namedRequestSchemas.schemas).length,
    'x-request-body-count': operations.filter(
      ({ operation }) => operation.requestBody !== undefined,
    ).length,
    'x-named-request-ref-count': operations.filter(
      ({ operation }) => {
        const media = Object.values(operation.requestBody?.content ?? {})[0];
        return typeof media?.schema?.$ref === 'string';
      },
    ).length,
    'x-dto-request-ref-count': operations.filter(
      ({ operation }) =>
        typeof operation.requestBody?.content?.['application/json']?.schema?.$ref === 'string' &&
        operation.requestBody?.['x-runtime-schema-source'] === undefined,
    ).length,
    'x-explicit-success-response-count': operations.filter(({ operation }) =>
      Object.entries(operation.responses).some(
        ([status, response]) => status !== 'default' && response.content !== undefined,
      ),
    ).length,
    'x-no-content-success-response-count': operations.filter(({ operation }) =>
      Object.entries(operation.responses).some(
        ([status, response]) => status !== 'default' && response.content === undefined,
      ),
    ).length,
    'x-contract-limitations': [
      '全部 Body 均绑定命名组件；DTO 取自 class-validator，特殊请求取自运行时 Zod 注册表或编译器内联类型。',
      '成功响应由 TypeScript Program 展开；刻意开放的 Record<string, unknown> 字段使用 x-intentionally-untyped 标记。',
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
    components: { schemas: { Problem: {} } },
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
    'x-dto-schema-count': 0,
    'x-runtime-request-schema-count': 0,
    'x-inline-request-schema-count': 0,
    'x-component-schema-count': 1,
    'x-request-body-count': 0,
    'x-named-request-ref-count': 0,
    'x-dto-request-ref-count': 0,
    'x-explicit-success-response-count': 0,
    'x-no-content-success-response-count': 1,
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
    [
      '未命名请求体',
      {
        ...fixture,
        paths: {
          '/api/health': {
            post: {
              ...fixture.paths['/api/health'].get,
              operationId: 'HealthController.post',
              requestBody: {
                content: {
                  'application/json': {
                    schema: { type: 'object' },
                  },
                },
              },
            },
          },
        },
        'x-request-body-count': 1,
      },
    ],
    [
      'unknown 成功响应',
      {
        ...fixture,
        paths: {
          '/api/health': {
            get: {
              ...fixture.paths['/api/health'].get,
              responses: {
                200: {
                  description: 'ok',
                  content: {
                    'application/json': {
                      schema: { 'x-typescript-type': 'unknown' },
                    },
                  },
                },
              },
            },
          },
        },
        'x-explicit-success-response-count': 1,
        'x-no-content-success-response-count': 0,
      },
    ],
    [
      '顶层开放成功响应',
      {
        ...fixture,
        paths: {
          '/api/health': {
            get: {
              ...fixture.paths['/api/health'].get,
              responses: {
                200: {
                  description: 'ok',
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object',
                        additionalProperties: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
        'x-explicit-success-response-count': 1,
        'x-no-content-success-response-count': 0,
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
  const bindingFailures = [
    [
      '新增 unknown 请求未登记',
      () =>
        bindNamedRequestSchemas(
          [{
            operation: {
              operationId: 'FixtureController.write',
              requestBody: {
                content: {
                  'application/json': {
                    schema: { 'x-typescript-type': 'unknown' },
                  },
                },
              },
              'x-source': 'fixture.ts:1',
            },
          }],
          {},
        ),
    ],
    [
      '运行时请求登记失效',
      () =>
        bindNamedRequestSchemas(
          [],
          {
            'FixtureController.stale': {
              name: 'FixtureRequest',
              contentType: 'application/json',
              schema: {
                type: 'object',
                additionalProperties: false,
              },
              runtimeSource: 'fixture.ts#FixtureRequest',
            },
          },
        ),
    ],
  ];
  for (const [name, execute] of bindingFailures) {
    let rejected = false;
    try {
      execute();
    } catch {
      rejected = true;
    }
    if (!rejected) {
      throw new Error(`自测失败：${name} 未被拒绝`);
    }
  }
  process.stdout.write(
    `OpenAPI 生成器自测通过：1 个正向场景，${failures.length + bindingFailures.length} 个负向场景。\n`,
  );
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
      `OpenAPI 已生成：${relative(repoRoot, outputPath)}，${document['x-controller-count']} 个 Controller，${document['x-route-declaration-count']} 个路由声明，${document['x-operation-count']} 个操作，${document['x-dto-schema-count']} 个 DTO Schema。\n`,
    );
  } else {
    const existing = await readFile(outputPath, 'utf8').catch(() => '');
    if (existing !== serialized) {
      throw new Error(
        `OpenAPI 契约已漂移：请执行 pnpm contracts:openapi:generate 并提交 ${relative(repoRoot, outputPath)}`,
      );
    }
    process.stdout.write(
      `OpenAPI 契约校验通过：${document['x-route-declaration-count']} 个路由声明，${document['x-operation-count']} 个操作，${document['x-dto-schema-count']} 个 DTO Schema。\n`,
    );
  }
}
