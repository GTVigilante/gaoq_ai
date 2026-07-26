import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const workerModulePath = path.join(root, 'apps/erp-api/src/worker.module.ts');
const workerMainPath = path.join(root, 'apps/erp-api/src/worker-main.ts');
const apiSourceRoot = path.join(root, 'apps/erp-api/src');
const forbiddenHttpShells = new Set([
  'analytics.module.js',
  'approval.module.js',
  'attendance.module.js',
  'care.module.js',
  'data-migration.module.js',
  'identity.module.js',
  'identity-core.module.js',
  'integration.module.js',
  'op.module.js',
  'org.module.js',
  'recruitment.module.js',
]);

const workerModule = parse(await readFile(workerModulePath, 'utf8'), workerModulePath);
assert.ok(
  hasNamedImport(workerModule, './infrastructure/redis/redis.module.js', 'RedisModule'),
  'WorkerModule 必须从共享 RedisModule 导入 REDIS_CLIENT',
);
assert.ok(
  moduleImportsContain(workerModule, 'WorkerModule', 'RedisModule'),
  'WorkerModule 的 @Module imports 必须显式装配 RedisModule',
);
assert.ok(
  hasNamedImport(workerModule, './config/environment.js', 'validateWorkerEnvironment'),
  'WorkerModule 必须使用独立 Worker 环境校验，禁止要求 API OAuth/MCP 配置',
);
assert.equal(
  hasNamedImport(workerModule, './config/environment.js', 'validateEnvironment'),
  false,
  'WorkerModule 禁止回退为 API 全量环境校验',
);

const workerMain = parse(await readFile(workerMainPath, 'utf8'), workerMainPath);
assert.ok(
  hasMethodCall(workerMain, 'application', 'flushLogs'),
  'Worker 启动完成前必须刷新 bufferLogs，避免启动与故障日志永久丢失',
);

const productionFiles = await listTypeScriptFiles(apiSourceRoot);
for (const file of productionFiles.filter((candidate) => !candidate.endsWith('.spec.ts'))) {
  const source = parse(await readFile(file, 'utf8'), file);
  assert.equal(
    hasDeprecatedMongooseNewOption(source),
    false,
    `${path.relative(root, file)} 禁止继续使用 Mongoose 已废弃的 new: true`,
  );
  if (file.endsWith('-core.module.ts') || file.endsWith('identity-persistence.module.ts')) {
    assert.equal(
      moduleMetadataHasProperty(source, 'controllers'),
      false,
      `${path.relative(root, file)} 核心模块禁止装配 HTTP Controller`,
    );
  }
  if (
    file.endsWith('-core.module.ts') &&
    !file.endsWith('identity-core.module.ts')
  ) {
    assert.equal(
      importedModuleBasenames(source).includes('identity-core.module.js'),
      false,
      `${path.relative(root, file)} Worker 核心图禁止装配 OAuth/SSO IdentityCoreModule`,
    );
  }
  if (
    file === workerModulePath ||
    file.endsWith('-core.module.ts') ||
    file.endsWith('-worker.module.ts') ||
    file.endsWith('approval-notification-infrastructure.module.ts')
  ) {
    assert.deepEqual(
      importedModuleBasenames(source).filter((name) => forbiddenHttpShells.has(name)),
      [],
      `${path.relative(root, file)} Worker 禁止导入 HTTP/OAuth 外壳模块`,
    );
  }
}

console.log('Worker 运行时依赖、模块边界、日志刷新和 Mongoose 兼容性校验通过。');

/**
 * 解析 TypeScript 源文件。
 *
 * @param {string} source - 源码。
 * @param {string} file - 文件路径。
 * @returns {ts.SourceFile} AST。
 */
function parse(source, file) {
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/**
 * 检查指定命名导入。
 *
 * @param {ts.SourceFile} source - AST。
 * @param {string} moduleName - 模块路径。
 * @param {string} importedName - 命名导入。
 * @returns {boolean} 是否存在。
 */
function hasNamedImport(source, moduleName, importedName) {
  return source.statements.some((statement) =>
    ts.isImportDeclaration(statement) &&
    ts.isStringLiteral(statement.moduleSpecifier) &&
    statement.moduleSpecifier.text === moduleName &&
    statement.importClause?.namedBindings !== undefined &&
    ts.isNamedImports(statement.importClause.namedBindings) &&
    statement.importClause.namedBindings.elements.some(
      (element) => element.name.text === importedName,
    ));
}

/**
 * 检查 Nest 模块 imports 数组是否含指定标识符。
 *
 * @param {ts.SourceFile} source - AST。
 * @param {string} className - 模块类名。
 * @param {string} importedName - imports 成员。
 * @returns {boolean} 是否存在。
 */
function moduleImportsContain(source, className, importedName) {
  const declaration = source.statements.find(
    (statement) => ts.isClassDeclaration(statement) && statement.name?.text === className,
  );
  if (declaration === undefined || !ts.isClassDeclaration(declaration)) return false;
  const decorator = ts.getDecorators(declaration)?.find((candidate) =>
    ts.isCallExpression(candidate.expression) &&
    ts.isIdentifier(candidate.expression.expression) &&
    candidate.expression.expression.text === 'Module');
  if (decorator === undefined || !ts.isCallExpression(decorator.expression)) return false;
  const metadata = decorator.expression.arguments[0];
  if (metadata === undefined || !ts.isObjectLiteralExpression(metadata)) return false;
  const imports = metadata.properties.find(
    (property) => ts.isPropertyAssignment(property) &&
      ts.isIdentifier(property.name) && property.name.text === 'imports',
  );
  return imports !== undefined && ts.isPropertyAssignment(imports) &&
    ts.isArrayLiteralExpression(imports.initializer) &&
    imports.initializer.elements.some(
      (element) => ts.isIdentifier(element) && element.text === importedName,
    );
}

/**
 * 检查对象方法调用。
 *
 * @param {ts.SourceFile} source - AST。
 * @param {string} objectName - 对象名。
 * @param {string} methodName - 方法名。
 * @returns {boolean} 是否存在。
 */
function hasMethodCall(source, objectName, methodName) {
  let found = false;
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === objectName &&
      node.expression.name.text === methodName
    ) found = true;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/**
 * 检查对象字面量中的 Mongoose 弃用选项。
 *
 * @param {ts.SourceFile} source - AST。
 * @returns {boolean} 是否存在 new: true。
 */
function hasDeprecatedMongooseNewOption(source) {
  let found = false;
  const visit = (node) => {
    if (
      ts.isPropertyAssignment(node) &&
      ((ts.isIdentifier(node.name) && node.name.text === 'new') ||
        (ts.isStringLiteral(node.name) && node.name.text === 'new')) &&
      node.initializer.kind === ts.SyntaxKind.TrueKeyword
    ) found = true;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/**
 * 检查任意 Nest @Module 元数据是否声明指定属性。
 *
 * @param {ts.SourceFile} source - AST。
 * @param {string} propertyName - 元数据属性。
 * @returns {boolean} 是否声明。
 */
function moduleMetadataHasProperty(source, propertyName) {
  return source.statements.some((statement) => {
    if (!ts.isClassDeclaration(statement)) return false;
    const decorator = ts.getDecorators(statement)?.find((candidate) =>
      ts.isCallExpression(candidate.expression) &&
      ts.isIdentifier(candidate.expression.expression) &&
      candidate.expression.expression.text === 'Module');
    if (decorator === undefined || !ts.isCallExpression(decorator.expression)) return false;
    const metadata = decorator.expression.arguments[0];
    return metadata !== undefined && ts.isObjectLiteralExpression(metadata) &&
      metadata.properties.some((property) =>
        ts.isPropertyAssignment(property) &&
        ((ts.isIdentifier(property.name) && property.name.text === propertyName) ||
          (ts.isStringLiteral(property.name) && property.name.text === propertyName)));
  });
}

/**
 * 返回文件内所有导入模块的 basename。
 *
 * @param {ts.SourceFile} source - AST。
 * @returns {readonly string[]} 模块 basename。
 */
function importedModuleBasenames(source) {
  return source.statements
    .filter((statement) =>
      ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier))
    .map((statement) => path.posix.basename(statement.moduleSpecifier.text));
}

/**
 * 递归列出 TypeScript 文件。
 *
 * @param {string} directory - 目录。
 * @returns {Promise<readonly string[]>} 文件列表。
 */
async function listTypeScriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return listTypeScriptFiles(target);
    return entry.isFile() && entry.name.endsWith('.ts') ? [target] : [];
  }));
  return nested.flat();
}
