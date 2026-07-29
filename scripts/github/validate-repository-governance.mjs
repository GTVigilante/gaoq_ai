import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const API_VERSION = '2022-11-28';
const PAGE_SIZE = 100;
const MAX_PAGES = 20;
const MILESTONE_PHASES = new Map([
  ['Phase 0：治理与规范', 'phase:0'],
  ['Phase 1：平台与主数据底座', 'phase:1'],
  ['Phase 2：审批工作流MVP', 'phase:2'],
  ['Phase 3：人才与学习闭环', 'phase:3'],
  ['Phase 4：薪酬闭环', 'phase:4'],
  ['Phase 5：连接与生产加固', 'phase:5'],
  ['Phase 6：统一大切换', 'phase:6'],
]);
const TYPE_PREFIXES = new Map([
  ['type:epic', '[Epic]'],
  ['type:story', '[Story]'],
  ['type:task', '[Task]'],
  ['type:bug', '[Bug]'],
  ['type:adr', '[ADR]'],
  ['type:security', '[Security]'],
]);
const LABEL_GROUPS = Object.freeze([
  { prefix: 'type:', minimum: 1, maximum: 1, code: 'GOV-ISSUE-LABEL-TYPE' },
  {
    prefix: 'domain:',
    minimum: 1,
    maximum: Number.POSITIVE_INFINITY,
    code: 'GOV-ISSUE-LABEL-DOMAIN',
  },
  { prefix: 'phase:', minimum: 1, maximum: 1, code: 'GOV-ISSUE-LABEL-PHASE' },
  { prefix: 'priority:', minimum: 1, maximum: 1, code: 'GOV-ISSUE-LABEL-PRIORITY' },
]);
const VALIDATION_EVIDENCE_PATTERN = /(?:验证|测试|pnpm|npm\s+run|node\s+scripts\/)/u;
const REVIEW_APPROVAL_PATTERN = /## CR 结论[\s\S]*\[OK\]/u;
const ISSUE_REFERENCE_PATTERN = /(?:^|[^\w])#(\d+)\b/gu;
const EPIC_CHILD_PATTERN = /-\s*\[[ xX]\]\s*#(\d+)\b/gu;

/**
 * 创建稳定、无外部响应正文的治理错误。
 *
 * @param {string} code 稳定错误码
 * @param {string} resource 资源标识
 * @param {string} message 低敏说明
 * @returns {Error} 治理错误
 */
function governanceError(code, resource, message) {
  const error = new Error(`[${code}] ${resource}: ${message}`);
  error.code = code;
  return error;
}

/**
 * 解析严格且无重复的命令行参数。
 *
 * @param {string[]} argv 命令行参数
 * @returns {{ selfTest: boolean; repository: string | null; snapshot: string | null }} 参数
 */
function parseArguments(argv) {
  const result = { selfTest: false, repository: null, snapshot: null };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!['--self-test', '--repository', '--snapshot'].includes(argument)) {
      throw governanceError('GOV-CLI-ARGUMENT-UNKNOWN', 'cli', argument);
    }
    if (seen.has(argument)) {
      throw governanceError('GOV-CLI-ARGUMENT-DUPLICATE', 'cli', argument);
    }
    seen.add(argument);
    if (argument === '--self-test') {
      result.selfTest = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw governanceError('GOV-CLI-ARGUMENT-VALUE', 'cli', argument);
    }
    index += 1;
    if (argument === '--repository') result.repository = value;
    if (argument === '--snapshot') result.snapshot = value;
  }
  if (result.selfTest && (result.repository !== null || result.snapshot !== null)) {
    throw governanceError('GOV-CLI-MODE-CONFLICT', 'cli', '--self-test');
  }
  if (result.repository !== null
    && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(result.repository)) {
    throw governanceError('GOV-CLI-REPOSITORY-INVALID', 'cli', result.repository);
  }
  return result;
}

/**
 * 将 GitHub 标签投影为名称。
 *
 * @param {unknown} labels GitHub 标签集合
 * @returns {string[]} 标签名
 */
function labelNames(labels) {
  if (!Array.isArray(labels)) return [];
  return labels
    .map((label) => typeof label === 'string' ? label : label?.name)
    .filter((label) => typeof label === 'string');
}

/**
 * 从正文提取去重后的 Issue 编号。
 *
 * @param {unknown} body 正文
 * @param {RegExp} pattern 引用表达式
 * @returns {number[]} Issue 编号
 */
function referencedIssueNumbers(body, pattern) {
  if (typeof body !== 'string') return [];
  return [...new Set([...body.matchAll(pattern)].map((match) => Number(match[1])))];
}

/**
 * 校验 GitHub 仓库快照。
 *
 * @param {unknown} rawSnapshot 仓库快照
 * @returns {{ milestoneCount: number; issueCount: number; pullCount: number }} 摘要
 */
export function validateRepositoryGovernance(rawSnapshot) {
  if (rawSnapshot === null || typeof rawSnapshot !== 'object') {
    throw governanceError('GOV-SNAPSHOT-OBJECT', 'snapshot', '必须为对象');
  }
  const { milestones, issues: rawIssues, pulls } = rawSnapshot;
  if (!Array.isArray(milestones) || !Array.isArray(rawIssues) || !Array.isArray(pulls)) {
    throw governanceError('GOV-SNAPSHOT-COLLECTIONS', 'snapshot', '集合缺失');
  }
  const issues = rawIssues.filter((issue) => issue?.pull_request === undefined);

  const milestoneTitles = milestones.map((milestone) => milestone?.title);
  for (const expectedTitle of MILESTONE_PHASES.keys()) {
    const count = milestoneTitles.filter((title) => title === expectedTitle).length;
    if (count !== 1) {
      throw governanceError(
        'GOV-MILESTONE-COUNT',
        expectedTitle,
        `期望 1 个，实际 ${count} 个`,
      );
    }
  }
  const unknownMilestones = milestoneTitles
    .filter((title) => !MILESTONE_PHASES.has(title));
  if (unknownMilestones.length > 0) {
    throw governanceError(
      'GOV-MILESTONE-UNKNOWN',
      'milestone',
      String(unknownMilestones[0]),
    );
  }

  const issueByNumber = new Map();
  for (const issue of issues) {
    if (!Number.isSafeInteger(issue?.number) || issue.number <= 0
      || issueByNumber.has(issue.number)) {
      throw governanceError(
        'GOV-ISSUE-NUMBER',
        'issue',
        Number.isSafeInteger(issue?.number) ? String(issue.number) : 'invalid',
      );
    }
    issueByNumber.set(issue.number, issue);
  }

  for (const issue of issues) {
    const resource = `issue#${issue.number}`;
    const labels = labelNames(issue.labels);
    for (const group of LABEL_GROUPS) {
      const count = labels.filter((label) => label.startsWith(group.prefix)).length;
      if (count < group.minimum || count > group.maximum) {
        throw governanceError(group.code, resource, `${group.prefix} 数量为 ${count}`);
      }
    }

    const milestoneTitle = issue.milestone?.title;
    if (!MILESTONE_PHASES.has(milestoneTitle)) {
      throw governanceError('GOV-ISSUE-MILESTONE', resource, '缺少或使用未知里程碑');
    }
    const phaseLabel = labels.find((label) => label.startsWith('phase:'));
    if (phaseLabel !== MILESTONE_PHASES.get(milestoneTitle)) {
      throw governanceError('GOV-ISSUE-PHASE-MISMATCH', resource, '阶段标签与里程碑不一致');
    }

    const typeLabel = labels.find((label) => label.startsWith('type:'));
    const expectedPrefix = TYPE_PREFIXES.get(typeLabel);
    if (expectedPrefix === undefined || typeof issue.title !== 'string'
      || !issue.title.startsWith(expectedPrefix)) {
      throw governanceError('GOV-ISSUE-TITLE-PREFIX', resource, '标题前缀与类型不一致');
    }

    if (labels.includes('status:external-acceptance') && issue.state !== 'open') {
      throw governanceError('GOV-ISSUE-EXTERNAL-CLOSED', resource, '外部验收未完成时必须开放');
    }
    if (labels.includes('status:blocked')) {
      if (issue.state !== 'open') {
        throw governanceError('GOV-ISSUE-BLOCKED-CLOSED', resource, '阻塞项必须开放');
      }
      if (typeof issue.body !== 'string'
        || !issue.body.includes('## 当前阻塞')
        || !issue.body.includes('## 解除方式')) {
        throw governanceError(
          'GOV-ISSUE-BLOCKED-SECTIONS',
          resource,
          '缺少当前阻塞或解除方式',
        );
      }
    }

    if (typeLabel === 'type:epic') {
      const children = referencedIssueNumbers(issue.body, EPIC_CHILD_PATTERN);
      if (children.length === 0) {
        throw governanceError('GOV-EPIC-CHILDREN', resource, '缺少勾选框子 Issue');
      }
      for (const childNumber of children) {
        const child = issueByNumber.get(childNumber);
        if (child === undefined) {
          throw governanceError(
            'GOV-EPIC-CHILD-MISSING',
            resource,
            `子 Issue #${childNumber} 不存在`,
          );
        }
        if (issue.state === 'closed' && child.state !== 'closed') {
          throw governanceError(
            'GOV-EPIC-CHILD-OPEN',
            resource,
            `子 Issue #${childNumber} 未关闭`,
          );
        }
      }
    }
  }

  for (const pull of pulls) {
    const pullNumber = Number.isSafeInteger(pull?.number) ? pull.number : 'invalid';
    const resource = `pull#${pullNumber}`;
    if (!Number.isSafeInteger(pull?.number) || pull.number <= 0) {
      throw governanceError('GOV-PR-NUMBER', resource, 'PR 编号无效');
    }
    if (!MILESTONE_PHASES.has(pull.milestone?.title)) {
      throw governanceError('GOV-PR-MILESTONE', resource, '缺少或使用未知里程碑');
    }
    if (pull.state === 'open' && pull.draft !== true
      && (typeof pull.body !== 'string' || !REVIEW_APPROVAL_PATTERN.test(pull.body))) {
      throw governanceError(
        'GOV-PR-READY-WITHOUT-CR',
        resource,
        '转 Ready 前缺少 CR [OK] 结论',
      );
    }
    const references = referencedIssueNumbers(pull.body, ISSUE_REFERENCE_PATTERN);
    if (references.length === 0) {
      throw governanceError('GOV-PR-ISSUE-REFERENCE', resource, '缺少 Issue 引用');
    }
    if (!references.some((number) => issueByNumber.has(number))) {
      throw governanceError('GOV-PR-ISSUE-MISSING', resource, '引用的 Issue 均不存在');
    }
    if (typeof pull.body !== 'string' || !VALIDATION_EVIDENCE_PATTERN.test(pull.body)) {
      throw governanceError('GOV-PR-VALIDATION', resource, '缺少验证证据');
    }
    if (pull.head?.ref === 'main') {
      throw governanceError('GOV-PR-HEAD-MAIN', resource, '禁止以 main 作为来源分支');
    }
  }

  return {
    milestoneCount: milestones.length,
    issueCount: issues.length,
    pullCount: pulls.length,
  };
}

/**
 * 使用 GitHub REST API 拉取全部分页。
 *
 * @param {string} repository owner/repo
 * @param {string} endpoint API 端点
 * @param {string} token GitHub Token
 * @returns {Promise<unknown[]>} 响应集合
 */
async function fetchAllPages(repository, endpoint, token) {
  const result = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url = new URL(`https://api.github.com/repos/${repository}/${endpoint}`);
    url.searchParams.set('state', 'all');
    url.searchParams.set('per_page', String(PAGE_SIZE));
    url.searchParams.set('page', String(page));
    let response;
    try {
      response = await fetch(url, {
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'x-github-api-version': API_VERSION,
          'user-agent': 'gaoq-repository-governance-validator',
        },
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw governanceError('GOV-GITHUB-REQUEST', endpoint, '请求失败');
    }
    if (!response.ok) {
      throw governanceError('GOV-GITHUB-STATUS', endpoint, `HTTP ${response.status}`);
    }
    let pageItems;
    try {
      pageItems = await response.json();
    } catch {
      throw governanceError('GOV-GITHUB-JSON', endpoint, '响应不是 JSON');
    }
    if (!Array.isArray(pageItems)) {
      throw governanceError('GOV-GITHUB-SHAPE', endpoint, '响应不是集合');
    }
    result.push(...pageItems);
    if (pageItems.length < PAGE_SIZE) return result;
  }
  throw governanceError('GOV-GITHUB-PAGINATION', endpoint, '超过最大分页');
}

/**
 * 使用工作流注入的短时 Token 拉取仓库快照。
 *
 * @param {string} repository owner/repo
 * @param {string} token GitHub Token
 * @returns {Promise<{ milestones: unknown[]; issues: unknown[]; pulls: unknown[] }>} 快照
 */
async function loadSnapshotWithToken(repository, token) {
  const [milestones, issues, pulls] = await Promise.all([
    fetchAllPages(repository, 'milestones', token),
    fetchAllPages(repository, 'issues', token),
    fetchAllPages(repository, 'pulls', token),
  ]);
  return { milestones, issues, pulls };
}

/**
 * 使用本机已认证 gh CLI 拉取仓库快照，不把凭据放入命令行。
 *
 * @param {string} repository owner/repo
 * @returns {Promise<{ milestones: unknown[]; issues: unknown[]; pulls: unknown[] }>} 快照
 */
async function loadSnapshotWithGh(repository) {
  const loadEndpoint = async (endpoint) => {
    let stdout;
    try {
      ({ stdout } = await execFileAsync(
        'gh',
        [
          'api',
          '--paginate',
          '--slurp',
          `repos/${repository}/${endpoint}?state=all&per_page=${PAGE_SIZE}`,
        ],
        { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 30_000 },
      ));
    } catch {
      throw governanceError('GOV-GH-REQUEST', endpoint, 'gh api 执行失败');
    }
    let pages;
    try {
      pages = JSON.parse(stdout);
    } catch {
      throw governanceError('GOV-GH-JSON', endpoint, 'gh 输出不是 JSON');
    }
    if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
      throw governanceError('GOV-GH-SHAPE', endpoint, 'gh 分页输出无效');
    }
    return pages.flat();
  };
  const [milestones, issues, pulls] = await Promise.all([
    loadEndpoint('milestones'),
    loadEndpoint('issues'),
    loadEndpoint('pulls'),
  ]);
  return { milestones, issues, pulls };
}

/**
 * 生成可通过全部规则的最小仓库快照。
 *
 * @returns {{ milestones: object[]; issues: object[]; pulls: object[] }} 快照
 */
function createValidFixture() {
  const milestones = [...MILESTONE_PHASES.keys()].map((title, index) => ({
    number: index + 1,
    title,
  }));
  const phaseZero = { title: 'Phase 0：治理与规范' };
  const common = ['domain:docs', 'phase:0', 'priority:p1'];
  return {
    milestones,
    issues: [
      {
        number: 1,
        title: '[Epic] 治理基线',
        body: '- [ ] #2',
        state: 'open',
        milestone: phaseZero,
        labels: ['type:epic', ...common],
      },
      {
        number: 2,
        title: '[Task] 实施治理',
        body: '验证治理。',
        state: 'open',
        milestone: phaseZero,
        labels: ['type:task', ...common],
      },
      {
        number: 3,
        title: '[Task] 外部阻塞',
        body: '## 当前阻塞\n权限不足。\n\n## 解除方式\n授权后继续。',
        state: 'open',
        milestone: phaseZero,
        labels: ['type:task', ...common, 'status:blocked'],
      },
      {
        number: 4,
        title: '[Story] 外部验收',
        body: '等待现场证据。',
        state: 'open',
        milestone: phaseZero,
        labels: ['type:story', ...common, 'status:external-acceptance'],
      },
    ],
    pulls: [
      {
        number: 10,
        state: 'open',
        draft: true,
        milestone: phaseZero,
        body: 'Closes #2\n\n验证：pnpm test',
        head: { ref: 'agent/github-governance' },
      },
    ],
  };
}

/**
 * 断言负向样例必须以指定错误码失败。
 *
 * @param {string} expectedCode 期望错误码
 * @param {(fixture: ReturnType<typeof createValidFixture>) => void} mutate 变异函数
 */
function assertFails(expectedCode, mutate) {
  const fixture = structuredClone(createValidFixture());
  mutate(fixture);
  try {
    validateRepositoryGovernance(fixture);
  } catch (error) {
    if (error?.code === expectedCode) return;
    throw governanceError(
      'GOV-SELF-TEST-WRONG-CODE',
      expectedCode,
      typeof error?.code === 'string' ? error.code : 'unknown',
    );
  }
  throw governanceError('GOV-SELF-TEST-NOT-FAILED', expectedCode, '负向样例未失败');
}

/**
 * 执行治理规则正负向自测。
 */
function runSelfTest() {
  validateRepositoryGovernance(createValidFixture());
  const cases = [
    ['GOV-MILESTONE-COUNT', (fixture) => fixture.milestones.pop()],
    ['GOV-MILESTONE-UNKNOWN', (fixture) => fixture.milestones.push({ title: '未知' })],
    ['GOV-ISSUE-LABEL-TYPE', (fixture) => fixture.issues[1].labels.shift()],
    ['GOV-ISSUE-LABEL-DOMAIN', (fixture) => {
      fixture.issues[1].labels = fixture.issues[1].labels
        .filter((label) => !label.startsWith('domain:'));
    }],
    ['GOV-ISSUE-LABEL-PHASE', (fixture) => {
      fixture.issues[1].labels.push('phase:1');
    }],
    ['GOV-ISSUE-LABEL-PRIORITY', (fixture) => {
      fixture.issues[1].labels = fixture.issues[1].labels
        .filter((label) => !label.startsWith('priority:'));
    }],
    ['GOV-ISSUE-PHASE-MISMATCH', (fixture) => {
      fixture.issues[1].labels[2] = 'phase:1';
    }],
    ['GOV-ISSUE-NUMBER', (fixture) => {
      fixture.issues[1].number = 0;
    }],
    ['GOV-ISSUE-MILESTONE', (fixture) => {
      fixture.issues[1].milestone = null;
    }],
    ['GOV-ISSUE-TITLE-PREFIX', (fixture) => {
      fixture.issues[1].title = '[Story] 错误类型';
    }],
    ['GOV-ISSUE-EXTERNAL-CLOSED', (fixture) => {
      fixture.issues[3].state = 'closed';
    }],
    ['GOV-ISSUE-BLOCKED-SECTIONS', (fixture) => {
      fixture.issues[2].body = '缺少固定章节';
    }],
    ['GOV-ISSUE-BLOCKED-CLOSED', (fixture) => {
      fixture.issues[2].state = 'closed';
    }],
    ['GOV-EPIC-CHILDREN', (fixture) => {
      fixture.issues[0].body = '没有子项';
    }],
    ['GOV-EPIC-CHILD-MISSING', (fixture) => {
      fixture.issues[0].body = '- [ ] #999';
    }],
    ['GOV-EPIC-CHILD-OPEN', (fixture) => {
      fixture.issues[0].state = 'closed';
    }],
    ['GOV-PR-MILESTONE', (fixture) => {
      fixture.pulls[0].milestone = null;
    }],
    ['GOV-PR-READY-WITHOUT-CR', (fixture) => {
      fixture.pulls[0].draft = false;
    }],
    ['GOV-PR-NUMBER', (fixture) => {
      fixture.pulls[0].number = 0;
    }],
    ['GOV-PR-ISSUE-REFERENCE', (fixture) => {
      fixture.pulls[0].body = '验证：pnpm test';
    }],
    ['GOV-PR-ISSUE-MISSING', (fixture) => {
      fixture.pulls[0].body = 'Closes #999\n\n验证：pnpm test';
    }],
    ['GOV-PR-VALIDATION', (fixture) => {
      fixture.pulls[0].body = 'Closes #2';
    }],
    ['GOV-PR-HEAD-MAIN', (fixture) => {
      fixture.pulls[0].head.ref = 'main';
    }],
  ];
  for (const [code, mutate] of cases) assertFails(code, mutate);
  process.stdout.write(`GitHub 仓库治理校验器自测通过：${cases.length} 个负向场景。\n`);
}

/**
 * 执行命令行入口。
 */
async function main() {
  const arguments_ = parseArguments(process.argv.slice(2));
  if (arguments_.selfTest) {
    runSelfTest();
    return;
  }

  let snapshot;
  let source;
  if (arguments_.snapshot !== null) {
    try {
      snapshot = JSON.parse(await readFile(arguments_.snapshot, 'utf8'));
    } catch {
      throw governanceError('GOV-SNAPSHOT-READ', 'snapshot', '无法读取有效 JSON');
    }
    source = 'snapshot';
  } else {
    const repository = arguments_.repository ?? process.env.GITHUB_REPOSITORY;
    if (repository === undefined
      || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
      throw governanceError('GOV-REPOSITORY-REQUIRED', 'repository', '需要 owner/repo');
    }
    const token = process.env.GITHUB_TOKEN;
    snapshot = typeof token === 'string' && token.length > 0
      ? await loadSnapshotWithToken(repository, token)
      : await loadSnapshotWithGh(repository);
    source = repository;
  }

  const summary = validateRepositoryGovernance(snapshot);
  process.stdout.write(
    `GitHub 仓库治理校验通过（${source}）：`
    + `${summary.milestoneCount} 个 Milestone，`
    + `${summary.issueCount} 个 Issue，${summary.pullCount} 个 PR。\n`,
  );
}

try {
  await main();
} catch (error) {
  const message = typeof error?.message === 'string'
    ? error.message
    : '[GOV-UNEXPECTED] validator: 未知错误';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
