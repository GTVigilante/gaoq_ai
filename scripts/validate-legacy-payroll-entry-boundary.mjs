import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const APPLICATION_DIRECTORIES = Object.freeze([
  'apps/erp-api/src/modules/payroll/application',
  'apps/erp-api/src/modules/treasury/application',
]);
const PUBLIC_ASYNC_METHOD =
  /^ {2}async ([A-Za-z0-9_]+)[\s\S]*?(?=^ {2}(?:async |private |protected |static |[A-Za-z0-9_]+\(|}|\/\*\*))/gm;

/** 校验旧工资与资金应用服务的统一事实源边界。 */
function validateSource(path, source) {
  const errors = [];
  if (!source.includes('LegacyPayrollBoundaryService')) {
    errors.push(`${path}: 未引用 LegacyPayrollBoundaryService`);
  }
  if (!source.includes('private readonly boundary: LegacyPayrollBoundaryService')) {
    errors.push(`${path}: 构造函数未强制注入共享边界`);
  }
  for (const match of source.matchAll(PUBLIC_ASYNC_METHOD)) {
    const method = match[1];
    const body = match[0];
    const guarded =
      body.includes('this.boundary.assertLegacy()') ||
      body.includes('this.assertLegacyBoundary()') ||
      body.includes('this.get(');
    if (!guarded) {
      errors.push(`${path}#${method}: 公开异步入口未在应用层校验旧事实源边界`);
    }
  }
  return errors;
}

/** 运行内存负向样例，避免门禁退化为只检查文件存在。 */
function selfTest() {
  const valid = `
import { LegacyPayrollBoundaryService } from '../legacy-payroll-boundary.service.js';
export class Example {
  constructor(private readonly boundary: LegacyPayrollBoundaryService) {}
  async execute(): Promise<void> {
    this.boundary.assertLegacy();
  }
}`;
  const missingEntryGuard = valid.replace('    this.boundary.assertLegacy();', '');
  const missingDependency = valid
    .replace(
      "import { LegacyPayrollBoundaryService } from '../legacy-payroll-boundary.service.js';",
      '',
    )
    .replace(
      'private readonly boundary: LegacyPayrollBoundaryService',
      'private readonly boundary: unknown',
    );
  if (validateSource('valid.ts', valid).length !== 0) {
    throw new Error('旧工资边界门禁正向自测失败');
  }
  if (validateSource('missing-entry.ts', missingEntryGuard).length === 0) {
    throw new Error('旧工资边界门禁未识别公开入口旁路');
  }
  if (validateSource('missing-dependency.ts', missingDependency).length < 2) {
    throw new Error('旧工资边界门禁未识别共享依赖缺失');
  }
}

/** 校验仓库内全部旧 Payroll/Treasury 应用服务。 */
function validateRepository() {
  const errors = [];
  let serviceCount = 0;
  let methodCount = 0;
  for (const directory of APPLICATION_DIRECTORIES) {
    const absoluteDirectory = resolve(ROOT, directory);
    const services = readdirSync(absoluteDirectory)
      .filter((name) => name.endsWith('.service.ts'))
      .sort();
    for (const name of services) {
      const path = `${directory}/${name}`;
      const source = readFileSync(resolve(ROOT, path), 'utf8');
      serviceCount += 1;
      methodCount += [...source.matchAll(PUBLIC_ASYNC_METHOD)].length;
      errors.push(...validateSource(path, source));
    }
  }
  if (errors.length !== 0) {
    throw new Error(`旧工资应用边界门禁失败：\n- ${errors.join('\n- ')}`);
  }
  return { serviceCount, methodCount };
}

if (process.argv.includes('--self-test')) selfTest();
const result = validateRepository();
process.stdout.write(
  `旧工资应用边界门禁通过：${result.serviceCount} 个服务、${result.methodCount} 个公开异步入口。\n`,
);
