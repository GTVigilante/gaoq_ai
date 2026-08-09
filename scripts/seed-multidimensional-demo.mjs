#!/usr/bin/env node
import { randomBytes } from 'node:crypto';

const ORIGIN = process.env.GAOQ_API_ORIGIN;
const DESIGNER_TOKEN = process.env.GAOQ_DESIGNER_ACCESS_TOKEN;
const PUBLISHER_TOKEN = process.env.GAOQ_PUBLISHER_ACCESS_TOKEN;
const TOKEN = /^[A-Za-z0-9._~-]{40,4096}$/u;
const BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

if (ORIGIN === undefined || !TOKEN.test(DESIGNER_TOKEN ?? '') || !TOKEN.test(PUBLISHER_TOKEN ?? '')) {
  throw new Error('DEMO_SEED_ENV_INVALID');
}

const origin = new URL(ORIGIN);
if (
  origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search !== '' ||
  origin.hash !== '' || origin.username !== '' || origin.password !== ''
) throw new Error('DEMO_SEED_ORIGIN_INVALID');

const option = (value, label, color) => ({ value, label, ...(color === undefined ? {} : { color }) });
const field = (key, label, type, extra = {}) => ({
  kind: 'field',
  field: {
    id: createUlid(), key, label, type,
    required: extra.required ?? false,
    sensitivity: extra.sensitivity ?? 'L2',
    width: extra.width ?? 'half',
    description: extra.description ?? '',
    placeholder: extra.placeholder ?? '',
    ...(extra.options === undefined ? {} : { options: extra.options }),
    ...(extra.relation === undefined ? {} : { relation: extra.relation }),
    ...(extra.relatedProperty === undefined ? {} : { relatedProperty: extra.relatedProperty }),
  },
});

/** 通过正式 REST 初始化可重复查看的招聘多维表示例。 */
async function main() {
  const jobs = await ensureForm('demo_jobs', {
    name: '招聘职位（演示）',
    description: '用于展示多维表格、筛选、分组和关联数据的虚构职位数据。',
    items: [
      field('job_title', '职位名称', 'short_text', { required: true, sensitivity: 'L1', width: 'full' }),
      field('department', '所属部门', 'department', { required: true, sensitivity: 'L2' }),
      field('location', '工作地点', 'short_text', { required: true, sensitivity: 'L1' }),
      field('headcount', '招聘人数', 'number', { required: true, sensitivity: 'L2' }),
      field('status', '职位状态', 'single_select', { required: true, sensitivity: 'L1', options: [
        option('open', '招聘中', '#16A34A'), option('paused', '已暂停', '#F59E0B'), option('closed', '已关闭', '#64748B'),
      ] }),
      field('recruiter', '招聘负责人', 'employee', { required: true, sensitivity: 'L2' }),
      field('monthly_budget', '月薪预算（分）', 'money_minor', { sensitivity: 'L3' }),
      field('open_date', '开放日期', 'date', { required: true, sensitivity: 'L1' }),
      field('tags', '职位标签', 'multi_select', { sensitivity: 'L1', width: 'full', options: [
        option('urgent', '急招', '#DC2626'), option('campus', '校招', '#2563EB'), option('social', '社招', '#7C3AED'), option('remote', '可远程', '#0891B2'),
      ] }),
    ],
  });
  const jobRows = await ensureRecords(jobs.id, [
    { job_title: '高级产品经理', department: 'dept-product', location: '上海', headcount: 2, status: 'open', recruiter: 'demo-recruiter-lin', monthly_budget: '3800000', open_date: '2026-08-01', tags: ['urgent', 'social'] },
    { job_title: '前端工程师', department: 'dept-engineering', location: '深圳', headcount: 3, status: 'open', recruiter: 'demo-recruiter-zhou', monthly_budget: '3200000', open_date: '2026-08-02', tags: ['social', 'remote'] },
    { job_title: 'HRBP', department: 'dept-hr', location: '北京', headcount: 1, status: 'open', recruiter: 'demo-recruiter-lin', monthly_budget: '2800000', open_date: '2026-08-03', tags: ['urgent', 'social'] },
    { job_title: '数据分析师', department: 'dept-data', location: '杭州', headcount: 2, status: 'paused', recruiter: 'demo-recruiter-zhou', monthly_budget: '3000000', open_date: '2026-07-25', tags: ['social'] },
    { job_title: '管培生', department: 'dept-strategy', location: '广州', headcount: 5, status: 'open', recruiter: 'demo-recruiter-lin', monthly_budget: '1600000', open_date: '2026-08-05', tags: ['campus'] },
  ], 'jobs');

  const candidates = await ensureForm('demo_candidates', {
    name: '候选人流程（演示）',
    description: '全部姓名与招聘信息均为虚构样例，用于展示关联字段、敏感等级和多视图。',
    items: [
      field('candidate_name', '候选人', 'short_text', { required: true, sensitivity: 'L2', width: 'full' }),
      field('job', '应聘职位', 'relation_single', { required: true, sensitivity: 'L2', relation: { targetFormId: jobs.id, displayFieldKey: 'job_title', allowCreate: false } }),
      field('job_department', '职位部门', 'related_property', { sensitivity: 'L2', relatedProperty: { relationFieldKey: 'job', targetFieldKey: 'department' } }),
      field('stage', '招聘阶段', 'single_select', { required: true, sensitivity: 'L1', options: [
        option('sourced', '人才寻访', '#64748B'), option('screening', '简历筛选', '#2563EB'), option('interview', '面试中', '#7C3AED'), option('offer', 'Offer', '#F59E0B'), option('hired', '已录用', '#16A34A'),
      ] }),
      field('owner', '招聘负责人', 'employee', { required: true, sensitivity: 'L2' }),
      field('source', '候选来源', 'single_select', { required: true, sensitivity: 'L1', options: [
        option('referral', '内部推荐', '#16A34A'), option('website', '招聘官网', '#2563EB'), option('linkedin', '社交招聘', '#0EA5E9'), option('agency', '猎头', '#7C3AED'),
      ] }),
      field('score', '综合评分', 'number', { sensitivity: 'L2' }),
      field('expected_salary', '期望月薪（分）', 'money_minor', { sensitivity: 'L4' }),
      field('city', '所在城市', 'short_text', { sensitivity: 'L2' }),
      field('priority', '优先级', 'radio', { required: true, sensitivity: 'L1', options: [
        option('high', '高', '#DC2626'), option('medium', '中', '#F59E0B'), option('normal', '普通', '#64748B'),
      ] }),
      field('tags', '人才标签', 'multi_select', { sensitivity: 'L2', width: 'full', options: [
        option('saas', 'SaaS', '#2563EB'), option('global', '国际化', '#7C3AED'), option('leadership', '带团队', '#DC2626'), option('data', '数据驱动', '#0891B2'), option('culture', '文化匹配', '#16A34A'),
      ] }),
      field('next_interview_date', '下次面试', 'date', { sensitivity: 'L2' }),
      field('active', '流程有效', 'boolean', { required: true, sensitivity: 'L1' }),
    ],
  });
  const candidateRows = await ensureRecords(candidates.id, [
    { candidate_name: '林晨（演示）', job: jobRows[0].id, stage: 'offer', owner: 'demo-recruiter-lin', source: 'referral', score: 92, expected_salary: '3600000', city: '上海', priority: 'high', tags: ['saas', 'leadership', 'culture'], next_interview_date: '2026-08-12', active: true },
    { candidate_name: '周悦（演示）', job: jobRows[1].id, stage: 'interview', owner: 'demo-recruiter-zhou', source: 'website', score: 88, expected_salary: '3000000', city: '深圳', priority: 'high', tags: ['global', 'data'], next_interview_date: '2026-08-11', active: true },
    { candidate_name: '陈拓（演示）', job: jobRows[2].id, stage: 'screening', owner: 'demo-recruiter-lin', source: 'linkedin', score: 84, expected_salary: '2600000', city: '北京', priority: 'medium', tags: ['leadership', 'culture'], next_interview_date: '2026-08-14', active: true },
    { candidate_name: '许宁（演示）', job: jobRows[1].id, stage: 'hired', owner: 'demo-recruiter-zhou', source: 'referral', score: 95, expected_salary: '3300000', city: '广州', priority: 'normal', tags: ['saas', 'global', 'culture'], active: false },
    { candidate_name: '唐婧（演示）', job: jobRows[3].id, stage: 'sourced', owner: 'demo-recruiter-zhou', source: 'agency', score: 79, expected_salary: '2900000', city: '杭州', priority: 'normal', tags: ['data'], active: true },
    { candidate_name: '顾航（演示）', job: jobRows[0].id, stage: 'interview', owner: 'demo-recruiter-lin', source: 'website', score: 90, expected_salary: '3700000', city: '苏州', priority: 'high', tags: ['saas', 'leadership'], next_interview_date: '2026-08-13', active: true },
    { candidate_name: '沈珂（演示）', job: jobRows[4].id, stage: 'screening', owner: 'demo-recruiter-lin', source: 'website', score: 82, expected_salary: '1500000', city: '广州', priority: 'medium', tags: ['culture', 'data'], next_interview_date: '2026-08-15', active: true },
    { candidate_name: '陆可（演示）', job: jobRows[2].id, stage: 'offer', owner: 'demo-recruiter-zhou', source: 'referral', score: 91, expected_salary: '2750000', city: '北京', priority: 'high', tags: ['leadership', 'culture'], next_interview_date: '2026-08-12', active: true },
  ], 'candidates');

  const interviews = await ensureForm('demo_interviews', {
    name: '面试安排（演示）',
    description: '以候选人为关联主键展示面试日历、评价和实时关联属性。',
    items: [
      field('candidate', '候选人', 'relation_single', { required: true, sensitivity: 'L2', relation: { targetFormId: candidates.id, displayFieldKey: 'candidate_name', allowCreate: false } }),
      field('candidate_stage', '当前招聘阶段', 'related_property', { sensitivity: 'L2', relatedProperty: { relationFieldKey: 'candidate', targetFieldKey: 'stage' } }),
      field('round', '面试轮次', 'single_select', { required: true, sensitivity: 'L1', options: [
        option('hr', 'HR 初试', '#2563EB'), option('professional', '专业面', '#7C3AED'), option('final', '终面', '#DC2626'),
      ] }),
      field('interviewer', '面试官', 'employee', { required: true, sensitivity: 'L2' }),
      field('scheduled_at', '面试时间', 'datetime', { required: true, sensitivity: 'L2' }),
      field('mode', '面试方式', 'single_select', { required: true, sensitivity: 'L1', options: [
        option('onsite', '现场', '#16A34A'), option('video', '视频', '#2563EB'), option('phone', '电话', '#64748B'),
      ] }),
      field('result', '面试结果', 'single_select', { required: true, sensitivity: 'L2', options: [
        option('pending', '待进行', '#64748B'), option('pass', '通过', '#16A34A'), option('hold', '待定', '#F59E0B'), option('reject', '不通过', '#DC2626'),
      ] }),
      field('score', '面试评分', 'number', { sensitivity: 'L2' }),
      field('feedback', '评价摘要', 'long_text', { sensitivity: 'L3', width: 'full' }),
    ],
  });
  await ensureRecords(interviews.id, [
    { candidate: candidateRows[0].id, round: 'final', interviewer: 'demo-manager-product', scheduled_at: '2026-08-12T06:00:00.000Z', mode: 'onsite', result: 'pending', score: 0, feedback: '演示数据：待终面。' },
    { candidate: candidateRows[1].id, round: 'professional', interviewer: 'demo-manager-engineering', scheduled_at: '2026-08-11T02:00:00.000Z', mode: 'video', result: 'pending', score: 0, feedback: '演示数据：重点考察工程质量。' },
    { candidate: candidateRows[3].id, round: 'final', interviewer: 'demo-vp-engineering', scheduled_at: '2026-08-06T07:00:00.000Z', mode: 'onsite', result: 'pass', score: 95, feedback: '演示数据：技术深度和协作能力优秀。' },
    { candidate: candidateRows[5].id, round: 'professional', interviewer: 'demo-manager-product', scheduled_at: '2026-08-13T03:00:00.000Z', mode: 'video', result: 'pending', score: 0, feedback: '演示数据：准备业务案例。' },
    { candidate: candidateRows[7].id, round: 'final', interviewer: 'demo-hr-director', scheduled_at: '2026-08-12T08:00:00.000Z', mode: 'onsite', result: 'pending', score: 0, feedback: '演示数据：关注组织发展经验。' },
    { candidate: candidateRows[2].id, round: 'hr', interviewer: 'demo-recruiter-lin', scheduled_at: '2026-08-14T01:30:00.000Z', mode: 'phone', result: 'pending', score: 0, feedback: '演示数据：确认求职动机。' },
  ], 'interviews');

  const base = await ensureBase({ jobs, candidates, interviews });
  process.stdout.write(`${JSON.stringify({
    status: 'ready', baseId: base.id, baseCode: base.code,
    forms: { jobs: jobs.id, candidates: candidates.id, interviews: interviews.id },
    records: { jobs: jobRows.length, candidates: candidateRows.length, interviews: 6 },
    link: `${origin.origin}/workspace/bases`,
  })}\n`);
}

async function ensureForm(code, definition) {
  const listed = await request(DESIGNER_TOKEN, '/dynamic-forms');
  let form = listed.items.find((item) => item.code === code);
  if (form === undefined) {
    const created = await request(DESIGNER_TOKEN, '/dynamic-forms', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': `demo-20260809:${code}:create` },
      body: JSON.stringify({ code, definition }),
    });
    form = created.form;
  }
  if (form.status === 'draft') {
    const published = await request(PUBLISHER_TOKEN, `/dynamic-forms/${form.id}/publish`, {
      method: 'POST',
      headers: { 'idempotency-key': `demo-20260809:${code}:publish`, 'if-match': `"${form.version}"` },
    });
    form = published.form;
  }
  if (form.status !== 'published') throw new Error('DEMO_FORM_NOT_PUBLISHED');
  return form;
}

async function ensureRecords(formId, values, namespace) {
  const listed = await request(DESIGNER_TOKEN, `/dynamic-forms/${formId}/records?limit=100`);
  if (listed.items.length > 0) return listed.items;
  const created = await request(DESIGNER_TOKEN, `/dynamic-forms/${formId}/records/bulk`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': `demo-20260809:${namespace}:records` },
    body: JSON.stringify({ items: values.map((item) => ({ values: item })) }),
  });
  return created.records;
}

async function ensureBase({ jobs, candidates, interviews }) {
  const listed = await request(DESIGNER_TOKEN, '/multidimensional-bases');
  const existing = listed.items.find((item) => item.code === 'demo_recruitment_ops');
  if (existing !== undefined) return existing;
  const view = (tableId, name, type, visibleFieldKeys, extra = {}) => ({
    id: createUlid(), tableId, name, type,
    config: { visibleFieldKeys, frozenFieldCount: 1, rowHeight: extra.rowHeight ?? 'medium', sorts: extra.sorts ?? [], groups: extra.groups ?? [], ...(extra.filter === undefined ? {} : { filter: extra.filter }) },
  });
  const definition = {
    name: '招聘运营中心（多维表示例）',
    description: '一套 Base 统一管理职位、候选人和面试；全部内容均为虚构演示数据。',
    tables: [
      { formId: candidates.id, name: '候选人', primaryFieldKey: 'candidate_name', position: 0 },
      { formId: jobs.id, name: '招聘职位', primaryFieldKey: 'job_title', position: 1 },
      { formId: interviews.id, name: '面试安排', primaryFieldKey: 'candidate', position: 2 },
    ],
    views: [
      view(candidates.id, '全部候选人', 'grid', ['candidate_name', 'job', 'job_department', 'stage', 'owner', 'source', 'score', 'expected_salary', 'city', 'priority', 'tags', 'next_interview_date', 'active'], { rowHeight: 'medium', sorts: [{ fieldKey: 'score', direction: 'desc' }] }),
      view(candidates.id, '招聘漏斗', 'kanban', ['candidate_name', 'job', 'stage', 'owner', 'priority'], { groups: ['stage'] }),
      view(candidates.id, '招聘仪表盘', 'dashboard', ['stage', 'source', 'score']),
      view(jobs.id, '开放职位', 'grid', ['job_title', 'department', 'location', 'headcount', 'status', 'recruiter', 'monthly_budget', 'open_date', 'tags'], { filter: { mode: 'all', conditions: [{ fieldKey: 'status', operator: 'eq', value: 'open' }] } }),
      view(interviews.id, '面试台账', 'grid', ['candidate', 'candidate_stage', 'round', 'interviewer', 'scheduled_at', 'mode', 'result', 'score', 'feedback'], { sorts: [{ fieldKey: 'scheduled_at', direction: 'asc' }] }),
      view(interviews.id, '面试日历', 'calendar', ['candidate', 'round', 'interviewer', 'scheduled_at', 'result']),
    ],
    automations: [{
      id: createUlid(), name: '高分候选人提醒（演示，未启用）', enabled: false,
      trigger: { type: 'record_updated', tableId: candidates.id, watchedFieldKeys: ['score', 'stage'] },
      conditions: { mode: 'all', items: [{ fieldKey: 'score', operator: 'gte', value: 85 }] },
      actions: [{ type: 'notify', channel: 'in_app', recipientFieldKey: 'owner', templateCode: 'candidate.owner.followup' }],
    }],
  };
  const result = await request(DESIGNER_TOKEN, '/multidimensional-bases', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'demo-20260809:recruitment-base:create' },
    body: JSON.stringify({ code: 'demo_recruitment_ops', definition }),
  });
  return result.base;
}

async function request(token, path, init = {}) {
  const response = await fetch(`${origin.origin}/api${path}`, {
    ...init,
    redirect: 'error',
    headers: { accept: 'application/json', authorization: `Bearer ${token}`, ...init.headers },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.code !== 'SUCCESS') {
    const code = typeof body?.code === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/u.test(body.code) ? body.code : `HTTP_${response.status}`;
    throw new Error(code);
  }
  return body.data;
}

function createUlid() {
  let time = BigInt(Date.now());
  let prefix = '';
  for (let index = 0; index < 10; index += 1) {
    prefix = BASE32[Number(time % 32n)] + prefix;
    time /= 32n;
  }
  const entropy = randomBytes(10);
  let random = 0n;
  for (const byte of entropy) random = (random << 8n) | BigInt(byte);
  let suffix = '';
  for (let index = 0; index < 16; index += 1) {
    suffix = BASE32[Number(random % 32n)] + suffix;
    random /= 32n;
  }
  return `${prefix}${suffix}`;
}

await main();
