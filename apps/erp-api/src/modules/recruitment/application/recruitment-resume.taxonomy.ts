import type {
  RecruitmentResumeTagCategory,
} from '../persistence/recruitment-resume.schemas.js';

export interface RecruitmentResumeTagDefinition {
  readonly category: RecruitmentResumeTagCategory;
  readonly code: string;
  readonly label: string;
}

/**
 * 受控候选人标签词表。
 *
 * AI 只能从该词表建议标签，避免自由文本污染检索、生成敏感属性或形成隐性歧视条件。
 */
export const RECRUITMENT_RESUME_TAG_TAXONOMY:
readonly RecruitmentResumeTagDefinition[] = Object.freeze([
  tag('role_family', 'role_engineering', '研发'),
  tag('role_family', 'role_data', '数据'),
  tag('role_family', 'role_product', '产品'),
  tag('role_family', 'role_design', '设计'),
  tag('role_family', 'role_sales', '销售'),
  tag('role_family', 'role_marketing', '市场'),
  tag('role_family', 'role_operations', '运营'),
  tag('role_family', 'role_finance', '财务'),
  tag('role_family', 'role_hr', '人力资源'),
  tag('role_family', 'role_legal', '法务'),
  tag('seniority', 'level_intern', '实习'),
  tag('seniority', 'level_junior', '初级'),
  tag('seniority', 'level_mid', '中级'),
  tag('seniority', 'level_senior', '高级'),
  tag('seniority', 'level_lead', '专家/负责人'),
  tag('seniority', 'level_manager', '管理者'),
  tag('skill', 'skill_javascript', 'JavaScript'),
  tag('skill', 'skill_typescript', 'TypeScript'),
  tag('skill', 'skill_java', 'Java'),
  tag('skill', 'skill_python', 'Python'),
  tag('skill', 'skill_go', 'Go'),
  tag('skill', 'skill_react', 'React'),
  tag('skill', 'skill_nodejs', 'Node.js'),
  tag('skill', 'skill_sql', 'SQL'),
  tag('skill', 'skill_data_analysis', '数据分析'),
  tag('skill', 'skill_machine_learning', '机器学习'),
  tag('skill', 'skill_project_management', '项目管理'),
  tag('skill', 'skill_enterprise_sales', '企业销售'),
  tag('skill', 'skill_content_strategy', '内容策略'),
  tag('skill', 'skill_financial_analysis', '财务分析'),
  tag('industry', 'industry_internet', '互联网'),
  tag('industry', 'industry_saas', 'SaaS'),
  tag('industry', 'industry_manufacturing', '制造业'),
  tag('industry', 'industry_retail', '零售'),
  tag('industry', 'industry_finance', '金融'),
  tag('industry', 'industry_healthcare', '医疗健康'),
  tag('industry', 'industry_education', '教育'),
  tag('industry', 'industry_media', '传媒'),
  tag('language', 'language_zh', '中文'),
  tag('language', 'language_en', '英语'),
  tag('language', 'language_ja', '日语'),
]);

const byCode = new Map(RECRUITMENT_RESUME_TAG_TAXONOMY.map((item) => [item.code, item]));

export function recruitmentResumeTag(code: string): RecruitmentResumeTagDefinition | null {
  return byCode.get(code) ?? null;
}

function tag(
  category: RecruitmentResumeTagCategory,
  code: string,
  label: string,
): RecruitmentResumeTagDefinition {
  return Object.freeze({ category, code, label });
}
