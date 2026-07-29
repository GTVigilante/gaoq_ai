import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const METRICS = Object.freeze(['branches', 'functions', 'lines', 'statements']);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API_ROOT = path.join(ROOT, 'apps', 'erp-api');
const CRITICAL_ROOTS = Object.freeze([
  'src/core/tenant',
  'src/modules/identity',
  'src/modules/approval',
  'src/modules/payroll',
  'src/modules/treasury',
  'src/modules/mcp',
]);
const CRITICAL_EXCLUDED_SUFFIXES = Object.freeze([
  '.spec.ts',
  '.module.ts',
  '.dto.ts',
  '.types.ts',
  '.decorators.ts',
  '.ports.ts',
  '/index.ts',
]);

/**
 * 读取静态属性名。
 *
 * @param {import('typescript').PropertyName} name 属性节点
 * @returns {string | null} 静态属性名
 */
function propertyName(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return null;
}

/**
 * 读取且唯一匹配对象属性。
 *
 * @param {import('typescript').ObjectLiteralExpression} object 对象节点
 * @param {string} name 属性名
 * @returns {import('typescript').PropertyAssignment} 属性节点
 */
function requiredProperty(object, name) {
  const matches = object.properties.filter((property) =>
    ts.isPropertyAssignment(property) && propertyName(property.name) === name);
  if (matches.length !== 1) {
    throw new Error(`COVERAGE_POLICY_PROPERTY_COUNT_INVALID:${name}:${matches.length}`);
  }
  return matches[0];
}

/**
 * 强制表达式为对象字面量。
 *
 * @param {import('typescript').Expression} expression 表达式
 * @param {string} label 诊断标签
 * @returns {import('typescript').ObjectLiteralExpression} 对象节点
 */
function requiredObject(expression, label) {
  if (!ts.isObjectLiteralExpression(expression)) {
    throw new Error(`COVERAGE_POLICY_OBJECT_REQUIRED:${label}`);
  }
  return expression;
}

/**
 * 强制表达式为数值字面量。
 *
 * @param {import('typescript').Expression} expression 表达式
 * @param {string} label 诊断标签
 * @returns {number} 数值
 */
function requiredNumber(expression, label) {
  if (!ts.isNumericLiteral(expression)) {
    throw new Error(`COVERAGE_POLICY_NUMBER_REQUIRED:${label}`);
  }
  return Number(expression.text);
}

/**
 * 建立对象属性索引并拒绝重复键。
 *
 * @param {import('typescript').ObjectLiteralExpression} object 对象节点
 * @param {string} label 诊断标签
 * @returns {Map<string, import('typescript').PropertyAssignment>} 属性索引
 */
function uniqueProperties(object, label) {
  const result = new Map();
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = propertyName(property.name);
    if (name === null) {
      throw new Error(`COVERAGE_POLICY_COMPUTED_PROPERTY_FORBIDDEN:${label}`);
    }
    if (result.has(name)) {
      throw new Error(`COVERAGE_POLICY_DUPLICATE_PROPERTY:${label}:${name}`);
    }
    result.set(name, property);
  }
  return result;
}

/**
 * 从 Vitest 配置抽取全局与逐文件覆盖率策略。
 *
 * @param {string} sourceText 配置源码
 * @returns {{
 *   include: string[];
 *   globalThresholds: Record<string, number>;
 *   fileThresholds: Map<string, Record<string, number>>;
 * }} 覆盖率策略
 */
function parseCoverageConfig(sourceText) {
  const source = ts.createSourceFile(
    'vitest.config.ts',
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  /** @type {import('typescript').PropertyAssignment[]} */
  const coverageProperties = [];
  const visit = (node) => {
    if (ts.isPropertyAssignment(node) && propertyName(node.name) === 'coverage') {
      coverageProperties.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (coverageProperties.length !== 1) {
    throw new Error(`COVERAGE_POLICY_COVERAGE_COUNT_INVALID:${coverageProperties.length}`);
  }

  const coverage = requiredObject(coverageProperties[0].initializer, 'coverage');
  const includeProperty = requiredProperty(coverage, 'include');
  if (!ts.isArrayLiteralExpression(includeProperty.initializer)) {
    throw new Error('COVERAGE_POLICY_INCLUDE_ARRAY_REQUIRED');
  }
  const include = includeProperty.initializer.elements.map((element) => {
    if (!ts.isStringLiteral(element)) {
      throw new Error('COVERAGE_POLICY_INCLUDE_LITERAL_REQUIRED');
    }
    return element.text;
  });

  const thresholds = requiredObject(
    requiredProperty(coverage, 'thresholds').initializer,
    'thresholds',
  );
  const thresholdProperties = uniqueProperties(thresholds, 'thresholds');
  const globalThresholds = Object.fromEntries(METRICS.map((metric) => {
    const property = thresholdProperties.get(metric);
    if (property === undefined) {
      throw new Error(`COVERAGE_POLICY_GLOBAL_THRESHOLD_MISSING:${metric}`);
    }
    return [metric, requiredNumber(property.initializer, `global:${metric}`)];
  }));

  const fileThresholds = new Map();
  for (const [file, property] of thresholdProperties) {
    if (!file.startsWith('src/') || !file.endsWith('.ts')) continue;
    const filePolicy = requiredObject(property.initializer, file);
    const fileProperties = uniqueProperties(filePolicy, file);
    fileThresholds.set(file, Object.fromEntries(METRICS.map((metric) => {
      const metricProperty = fileProperties.get(metric);
      if (metricProperty === undefined) {
        throw new Error(`COVERAGE_POLICY_FILE_THRESHOLD_MISSING:${file}:${metric}`);
      }
      return [metric, requiredNumber(metricProperty.initializer, `${file}:${metric}`)];
    })));
  }
  return { include, globalThresholds, fileThresholds };
}

/**
 * 解析 precheck/check 可达的根质量脚本和 ERP API 专项脚本。
 *
 * @param {Record<string, string>} rootScripts 根脚本
 * @returns {{ reachable: Set<string>; appCoverageScripts: Set<string> }} 可达脚本
 */
function resolveQualityScripts(rootScripts) {
  const reachable = new Set();
  const appCoverageScripts = new Set();
  const visit = (name) => {
    if (reachable.has(name)) return;
    const command = rootScripts[name];
    if (command === undefined) {
      throw new Error(`COVERAGE_POLICY_ROOT_SCRIPT_MISSING:${name}`);
    }
    reachable.add(name);
    for (const match of command.matchAll(/pnpm\s+(quality:[\w:-]+)/g)) {
      visit(match[1]);
    }
    for (const match of command.matchAll(/test:coverage:([\w-]+)/g)) {
      appCoverageScripts.add(`test:coverage:${match[1]}`);
    }
  };
  visit('precheck');
  visit('check');
  return { reachable, appCoverageScripts };
}

/**
 * 展开专项脚本声明的全部生产文件。
 *
 * @param {Set<string>} appCoverageScripts ERP API 专项脚本
 * @param {Record<string, string>} appScripts ERP API 脚本
 * @returns {Set<string>} 生产文件
 */
function resolveTargetFiles(appCoverageScripts, appScripts) {
  const files = new Set();
  for (const script of appCoverageScripts) {
    const command = appScripts[script];
    if (command === undefined) {
      throw new Error(`COVERAGE_POLICY_API_SCRIPT_MISSING:${script}`);
    }
    const patterns = [...command.matchAll(/--coverage\.include=([^\s"']+)/g)]
      .map((match) => match[1]);
    if (patterns.length === 0) {
      throw new Error(`COVERAGE_POLICY_INCLUDE_MISSING:${script}`);
    }
    for (const pattern of patterns) {
      const matches = fs.globSync(pattern, { cwd: API_ROOT });
      if (matches.length === 0) {
        throw new Error(`COVERAGE_POLICY_INCLUDE_UNMATCHED:${script}:${pattern}`);
      }
      for (const file of matches) files.add(file.split(path.sep).join('/'));
    }
  }
  return files;
}

/**
 * 解析章程关键域必须纳入逐文件门禁的权威生产文件集合。
 *
 * 模块装配、纯传输类型和测试文件不承载独立业务控制，仍由全量 80% 分母覆盖；
 * 租户、身份、审批、薪资、资金和 MCP 的其余实现必须全部拥有专项 90% 门禁。
 *
 * @returns {Set<string>} 章程关键生产文件
 */
function resolveCriticalFiles() {
  const files = new Set();
  for (const root of CRITICAL_ROOTS) {
    for (const platformFile of fs.globSync(`${root}/**/*.ts`, { cwd: API_ROOT })) {
      const file = platformFile.split(path.sep).join('/');
      if (CRITICAL_EXCLUDED_SUFFIXES.some((suffix) => file.endsWith(suffix))) continue;
      files.add(file);
    }
  }
  return files;
}

/**
 * 验证全量分母、阈值、专项脚本和生产文件闭包。
 *
 * @param {{
 *   include: readonly string[];
 *   globalThresholds: Record<string, number>;
 *   fileThresholds: Map<string, Record<string, number>>;
 *   targetFiles: Set<string>;
 *   criticalFiles: Set<string>;
 *   reachable: Set<string>;
 * }} policy 策略快照
 * @param {(file: string) => boolean} exists 文件存在性检查
 */
function validatePolicy(policy, exists) {
  if (!policy.include.includes('src/**/*.ts')) {
    throw new Error('COVERAGE_POLICY_ALL_PRODUCTION_SOURCE_REQUIRED');
  }
  for (const metric of METRICS) {
    if (policy.globalThresholds[metric] < 80) {
      throw new Error(`COVERAGE_POLICY_GLOBAL_THRESHOLD_TOO_LOW:${metric}`);
    }
  }
  if (!policy.reachable.has('quality:critical-coverage-policy')) {
    throw new Error('COVERAGE_POLICY_NOT_CONNECTED_TO_PRECHECK');
  }
  for (const [file, thresholds] of policy.fileThresholds) {
    if (!exists(file)) {
      throw new Error(`COVERAGE_POLICY_TARGET_FILE_MISSING:${file}`);
    }
    for (const metric of METRICS) {
      if (thresholds[metric] < 90) {
        throw new Error(`COVERAGE_POLICY_FILE_THRESHOLD_TOO_LOW:${file}:${metric}`);
      }
    }
  }
  for (const file of policy.targetFiles) {
    if (!policy.fileThresholds.has(file)) {
      throw new Error(`COVERAGE_POLICY_EXPLICIT_FILE_THRESHOLD_MISSING:${file}`);
    }
  }
  for (const file of policy.criticalFiles) {
    if (!policy.targetFiles.has(file)) {
      throw new Error(`COVERAGE_POLICY_CRITICAL_FILE_DEDICATED_GATE_MISSING:${file}`);
    }
  }
  for (const file of policy.fileThresholds.keys()) {
    if (!policy.targetFiles.has(file)) {
      throw new Error(`COVERAGE_POLICY_DEDICATED_GATE_MISSING:${file}`);
    }
  }
}

/**
 * 深复制可变策略字段，供负向自测使用。
 *
 * @param {ReturnType<typeof parseCoverageConfig> & {
 *   targetFiles: Set<string>;
 *   criticalFiles: Set<string>;
 *   reachable: Set<string>;
 * }} policy 策略快照
 * @returns {{
 *   include: string[];
 *   globalThresholds: Record<string, number>;
 *   fileThresholds: Map<string, Record<string, number>>;
 *   targetFiles: Set<string>;
 *   criticalFiles: Set<string>;
 *   reachable: Set<string>;
 * }} 策略副本
 */
function clonePolicy(policy) {
  return {
    include: [...policy.include],
    globalThresholds: { ...policy.globalThresholds },
    fileThresholds: new Map([...policy.fileThresholds].map(([file, thresholds]) =>
      [file, { ...thresholds }])),
    targetFiles: new Set(policy.targetFiles),
    criticalFiles: new Set(policy.criticalFiles),
    reachable: new Set(policy.reachable),
  };
}

/**
 * 断言篡改后的策略必须失败关闭。
 *
 * @param {string} label 用例标签
 * @param {ReturnType<typeof clonePolicy>} policy 策略副本
 * @param {(policy: ReturnType<typeof clonePolicy>) => void} mutate 篡改动作
 * @param {string} expected 期望错误片段
 */
function expectFailure(label, policy, mutate, expected) {
  mutate(policy);
  try {
    validatePolicy(policy, (file) => fs.existsSync(path.join(API_ROOT, file)));
  } catch (error) {
    if (error instanceof Error && error.message.includes(expected)) return;
    throw new Error(`COVERAGE_POLICY_SELF_TEST_WRONG_FAILURE:${label}`, { cause: error });
  }
  throw new Error(`COVERAGE_POLICY_SELF_TEST_DID_NOT_FAIL:${label}`);
}

const rootPackage = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const apiPackage = JSON.parse(fs.readFileSync(path.join(API_ROOT, 'package.json'), 'utf8'));
const parsed = parseCoverageConfig(
  fs.readFileSync(path.join(API_ROOT, 'vitest.config.ts'), 'utf8'),
);
const scripts = resolveQualityScripts(rootPackage.scripts ?? {});
const targetFiles = resolveTargetFiles(scripts.appCoverageScripts, apiPackage.scripts ?? {});
const criticalFiles = resolveCriticalFiles();
const policy = {
  ...parsed,
  targetFiles,
  criticalFiles,
  reachable: scripts.reachable,
};
const exists = (file) => fs.existsSync(path.join(API_ROOT, file));
validatePolicy(policy, exists);

if (process.argv.includes('--self-test')) {
  const firstFile = [...policy.targetFiles].sort()[0];
  expectFailure(
    '全量分母',
    clonePolicy(policy),
    (candidate) => candidate.include.splice(candidate.include.indexOf('src/**/*.ts'), 1),
    'COVERAGE_POLICY_ALL_PRODUCTION_SOURCE_REQUIRED',
  );
  expectFailure(
    '全局阈值',
    clonePolicy(policy),
    (candidate) => { candidate.globalThresholds.branches = 79; },
    'COVERAGE_POLICY_GLOBAL_THRESHOLD_TOO_LOW',
  );
  expectFailure(
    '逐文件阈值',
    clonePolicy(policy),
    (candidate) => { candidate.fileThresholds.get(firstFile).lines = 89; },
    'COVERAGE_POLICY_FILE_THRESHOLD_TOO_LOW',
  );
  expectFailure(
    '专项遗漏',
    clonePolicy(policy),
    (candidate) => { candidate.fileThresholds.delete(firstFile); },
    'COVERAGE_POLICY_EXPLICIT_FILE_THRESHOLD_MISSING',
  );
  const firstCriticalFile = [...policy.criticalFiles].sort()[0];
  expectFailure(
    '关键域分类遗漏',
    clonePolicy(policy),
    (candidate) => { candidate.targetFiles.delete(firstCriticalFile); },
    'COVERAGE_POLICY_CRITICAL_FILE_DEDICATED_GATE_MISSING',
  );
  expectFailure(
    '生命周期断开',
    clonePolicy(policy),
    (candidate) => { candidate.reachable.delete('quality:critical-coverage-policy'); },
    'COVERAGE_POLICY_NOT_CONNECTED_TO_PRECHECK',
  );
}

console.log(
  `关键覆盖率策略校验通过：${scripts.appCoverageScripts.size} 个专项脚本、` +
  `${targetFiles.size} 个生产文件均显式执行逐文件四维 90% 门禁；` +
  `${criticalFiles.size} 个章程关键域文件全部闭包；全生产源码四维 80% 门禁已接入 precheck。`,
);
