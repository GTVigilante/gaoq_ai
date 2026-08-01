export type Locale = 'zh-CN' | 'en';

export const locales = ['zh-CN', 'en'] as const;
export const serviceSlugs = [
  'content', 'design', 'business', 'finance', 'legal', 'growth', 'editing', 'operations',
] as const;

const zh = {
  nav: ['创作者服务', '品牌合作', '案例', '洞察', '关于'],
  navLinks: ['creators', 'brands', 'cases', 'insights', 'about'],
  eyebrow: 'AI × 标准化运营 × 创作者商业增长',
  title: '让创作者专注创造，\n让专业团队负责增长。',
  summary: '告趣以 AI 提升内容与运营效率，用可审计的专业流程承接设计、商务、财务、法务、投流与剪辑，让每一次创作都更有价值。',
  creatorCta: '我是创作者',
  brandCta: '我是品牌方',
  serviceTitle: '一个团队，承接创作者经营的全部复杂度',
  serviceIntro: '从灵感到交付，从商务到回款，八大专业能力在同一套运营标准里协作。',
  services: [
    ['内容', '选题策略、脚本与内容日历，让创作持续稳定。'],
    ['设计', '视觉体系、封面与品牌资产，建立可识别表达。'],
    ['商务', '品牌撮合、报价谈判与履约管理，释放商业价值。'],
    ['财务', '回款、对账、预算与经营分析，让收入更清晰。'],
    ['法务', '合同审核、版权与风险把控，为合作建立边界。'],
    ['投流', '以数据验证内容潜力，放大值得增长的作品。'],
    ['剪辑', '从粗剪到包装的标准化产能，稳定交付品质。'],
    ['规范化运营', '项目、数据与知识沉淀，让个人影响力成为事业。'],
  ],
  methodTitle: 'AI 不是替代创作者，\n而是扩大创作者的可能性。',
  methodText: '我们把 AI 放进研究、策划、生产和复盘的每个环节，同时由专业人员完成判断、审核与最终交付。',
  metrics: [['8', '专业服务模块'], ['2×', '创作者与品牌双边能力'], ['1套', '透明可追踪的运营流程']],
  casesTitle: '把影响力，变成可持续的商业资产',
  cases: [
    ['美妆创作者品牌升级', '从零散接单到季度内容与商务规划', '+68%', '有效商务询盘'],
    ['知识博主内容工业化', 'AI 研究辅助与剪辑 SOP 协同', '2.4×', '稳定周更产能'],
    ['消费品牌达人战役', '策略、匹配、履约与复盘一体化', '93%', '节点准时交付'],
  ],
  processTitle: '合作不靠猜，增长有章法',
  process: [['01', '理解目标'], ['02', '建立策略'], ['03', '协同交付'], ['04', '数据复盘']],
  finalTitle: '下一次增长，从一次认真交流开始。',
  finalText: '告诉我们你正在创作什么，或你的品牌想影响谁。',
  contact: '预约咨询',
  footer: '为创作者提供长期、专业、可信赖的经营支持。',
};

const en = {
  nav: ['For Creators', 'For Brands', 'Work', 'Insights', 'About'],
  navLinks: ['creators', 'brands', 'cases', 'insights', 'about'],
  eyebrow: 'AI × OPERATIONAL EXCELLENCE × CREATOR GROWTH',
  title: 'You create.\nWe build the business around it.',
  summary: 'GaoQ combines AI-powered efficiency with expert operations across content, design, partnerships, finance, legal, media and editing.',
  creatorCta: 'I am a creator',
  brandCta: 'I represent a brand',
  serviceTitle: 'One team for every complex part of creator growth',
  serviceIntro: 'From the first idea to final payment, eight expert capabilities work through one accountable operating system.',
  services: [
    ['Content', 'Strategy, scripts and calendars for consistent creation.'],
    ['Design', 'Distinct visual systems, covers and brand assets.'],
    ['Partnerships', 'Brand matching, negotiation and delivery management.'],
    ['Finance', 'Collections, reconciliation, budgets and performance clarity.'],
    ['Legal', 'Contracts, copyright and practical risk controls.'],
    ['Growth Media', 'Data-informed distribution for content worth scaling.'],
    ['Editing', 'Reliable post-production capacity with consistent quality.'],
    ['Operations', 'Projects, data and knowledge that turn influence into a business.'],
  ],
  methodTitle: 'AI does not replace creators.\nIt expands what they can achieve.',
  methodText: 'AI supports research, planning, production and review. Experienced specialists remain accountable for judgment, approval and delivery.',
  metrics: [['8', 'specialist capabilities'], ['2×', 'creator and brand pathways'], ['1', 'transparent operating system']],
  casesTitle: 'Turning influence into a durable business asset',
  cases: [
    ['Beauty creator repositioning', 'From one-off deals to quarterly planning', '+68%', 'qualified enquiries'],
    ['Knowledge creator production', 'AI research and editing SOPs', '2.4×', 'weekly output'],
    ['Consumer brand campaign', 'Strategy, matching, delivery and review', '93%', 'on-time delivery'],
  ],
  processTitle: 'A clear system for meaningful growth',
  process: [['01', 'Understand'], ['02', 'Strategize'], ['03', 'Deliver'], ['04', 'Learn']],
  finalTitle: 'Your next stage starts with a thoughtful conversation.',
  finalText: 'Tell us what you create—or who your brand needs to reach.',
  contact: 'Book a consultation',
  footer: 'Long-term, professional and dependable operating support for creators.',
};

export function dictionary(locale: Locale) {
  return locale === 'zh-CN' ? zh : en;
}

export function routeTitle(locale: Locale, path: string[]): string {
  const key = path[0] ?? 'home';
  const labels: Record<string, readonly [string, string]> = {
    home: ['首页', 'Home'], creators: ['创作者服务', 'For Creators'],
    brands: ['品牌合作', 'For Brands'], services: ['专业服务', 'Services'],
    cases: ['合作案例', 'Work'], insights: ['行业洞察', 'Insights'],
    about: ['关于告趣', 'About GaoQ'], contact: ['预约咨询', 'Contact'],
    privacy: ['隐私政策', 'Privacy'], cookies: ['Cookie 政策', 'Cookie Policy'],
    terms: ['服务条款', 'Terms'],
  };
  return labels[key]?.[locale === 'zh-CN' ? 0 : 1] ?? (locale === 'zh-CN' ? '官网' : 'Website');
}
