# 智能薪酬自建系统 — 产品需求文档（PRD）

> **文档版本**：v1.0  
> **目标**：完整替代钉钉智能薪酬（人力家），覆盖算薪、个税、社保、工资条、成本分析全链路。  
> **后续交付**：本 PRD 可直接交由 Kimi Code / Codex / 开发团队进行技术实现。

---

## 1. 项目概述

### 1.1 背景
公司目前使用钉钉「智能薪酬」（由人力家提供）进行月度薪酬核算，因续费成本、数据自主可控、二次扩展性等因素，决定自建一套薪酬管理系统，实现核心能力替代。

### 1.2 目标
- **功能对齐**：覆盖现有智能薪酬 100% 高频功能（薪酬核算、社保公积金、个税、工资条、成本报表）。
- **数据打通**：与现有钉钉/飞书/企业微信的考勤、审批、人事花名册数据对接。
- **合规保障**：紧跟国家个税累计预扣法、社保政策、各地公积金基数调整。
- **成本可控**：一次性研发投入 + 低运维成本，替代逐年 SaaS 订阅费用。
- **扩展预留**：支持后续接入绩效、期权、福利、多法人集团化等进阶场景。

### 1.3 用户角色

| 角色 | 职责 | 核心诉求 |
|------|------|----------|
| 系统管理员 | 初始化系统、配置薪酬方案、管理权限 | 灵活配置、低代码规则 |
| HR 薪酬专员 | 月度算薪、数据核对、异常处理 | 一键算薪、差错预警、可溯源 |
| 普通员工 | 查看工资条、确认收入、申诉异常 | 移动端随时查看、数据安全 |
| 财务/管理层 | 人力成本分析、预算管控 | 实时看板、多维度报表 |

---

## 2. 功能全景图

```
┌─────────────────────────────────────────────────────────────┐
│                        接入层（Integration）                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐    │
│  │ 考勤数据  │  │ 审批数据  │  │ 绩效数据  │  │ 花名册    │    │
│  │ (钉钉API) │  │ (钉钉API) │  │ (导入/接口)│  │ (导入/接口)│   │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘    │
└───────┼────────────┼────────────┼────────────┼────────────┘
        │            │            │            │
        ▼            ▼            ▼            ▼
┌─────────────────────────────────────────────────────────────┐
│                        数据层（Data Layer）                     │
│  员工主数据 │ 薪酬档案 │ 社保政策库 │ 个税规则库 │ 考勤流水   │
└─────────────────────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────────┐
│                      核心引擎层（Core Engine）                  │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐            │
│  │ 薪酬规则引擎 │  │ 个税计算引擎 │  │ 社保计算引擎 │            │
│  │ (Rule Engine)│  │ (Tax Engine)│  │ (SI/HF Engine)│           │
│  └─────┬──────┘  └─────┬──────┘  └─────┬──────┘            │
│        │              │              │                     │
│        ▼              ▼              ▼                     │
│  ┌─────────────────────────────────────────────────┐      │
│  │              薪资计算引擎 (Payroll Engine)          │      │
│  │         薪酬项 + 考勤 + 绩效 + 社保 + 个税           │      │
│  └────────────────────────┬──────────────────────────┘      │
└──────────────────────────┼────────────────────────────────┘
                           │
        ┌──────────────────┼──────────────────┐
        ▼                  ▼                  ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│  电子工资条    │  │  审批与发放   │  │  人力成本报表  │
│  (Payslip)   │  │  (Approval)  │  │  (Analytics) │
└──────────────┘  └──────────────┘  └──────────────┘
```

---

## 3. 核心功能模块详细设计

### 3.1 组织架构与员工主数据（基础底座）

> **定位**：薪酬系统的数据底座，需与现有 HR 系统或钉钉花名册打通。

#### 3.1.1 功能清单

| 功能点 | 说明 | 优先级 |
|--------|------|--------|
| 组织架构管理 | 部门树、成本中心、汇报线，支持多法人 | P0 |
| 员工档案 | 姓名、工号、入职/离职日期、岗位、职级、合同类型、发薪地 | P0 |
| 银行信息 | 开户行、支行、银行卡号、联行号 | P0 |
| 纳税信息 | 纳税人识别号、专项附加扣除、子女教育/房贷/赡养老人等 | P0 |
| 社保信息 | 参保城市、社保基数、公积金基数、缴纳比例（个人/公司） | P0 |
| 员工异动 | 入职、转正、调岗、调薪、离职，异动记录自动关联薪资 | P0 |
| 批量导入/导出 | 支持 Excel 模板批量导入员工信息 | P0 |
| 数据同步 | 对接钉钉/飞书 API 或 Webhook 自动同步人员变动 | P1 |

#### 3.1.2 关键字段设计

```
Employee
├── id, emp_no, name, id_card, phone, email
├── dept_id, dept_path, cost_center
├── position, level, job_type (full_time/part_time/intern/contractor)
├── entry_date, probation_end_date, formal_date, leave_date, status
├── bank_name, bank_branch, bank_account, bank_code
├── tax_region, tax_id, special_deduct_json
├── si_city, si_base, hf_base, si_ratio_person, si_ratio_company, hf_ratio_person, hf_ratio_company
├── salary_group_id, pay_scheme_id
├── created_at, updated_at, created_by
```

---

### 3.2 薪酬体系配置（规则引擎）

> **定位**：支持多套薪酬方案，灵活配置算薪规则，零代码/低代码扩展。

#### 3.2.1 功能清单

| 功能点 | 说明 | 优先级 |
|--------|------|--------|
| 薪酬组管理 | 按部门/岗位/职级/地区划分薪酬组，如「正式员工组」「外包组」 | P0 |
| 薪酬项定义 | 自定义工资项：基本工资、岗位津贴、绩效奖金、加班费、餐补、交通补等 | P0 |
| 薪酬项属性 | 类型（固定/浮动/考勤关联/绩效关联）、计税方式（应税/非税/年终奖）、增减方向（加项/减项） | P0 |
| 计算公式配置 | 支持公式编辑器：引用考勤天数、绩效系数、社保基数、固定系数等 | P0 |
| 计薪周期 | 自然月、非自然月（如上月度 21-本月 20）、半月薪 | P1 |
| 多币种支持 | 人民币、美元等（汇率自动换算） | P2 |
| 薪酬版本 | 薪酬方案历史版本，可追溯任意月份的算薪规则 | P1 |

#### 3.2.2 薪酬项类型定义

```
PayItem
├── id, code, name, category (fixed / variable / attendance / performance / allowance / deduction)
├── tax_type (taxable / non_taxable / annual_bonus / tax_exempt)
├── direction (addition / deduction)
├── formula: string (e.g., "base_salary * 0.1 + performance_score * 1000")
├── dependencies: ["attendance.actual_days", "performance.score", "si.pension_company"]
├── default_value, min_value, max_value
├── group_id, effective_date, expire_date
├── status (active / inactive)
```

#### 3.2.3 公式引擎能力

- **基础运算**：`+`, `-`, `*`, `/`, `()`, `IF`, `MAX`, `MIN`, `ROUND`
- **上下文变量**：`base_salary`, `attendance.actual_days`, `attendance.standard_days`, `performance.score`, `si.total_person`, `tax.cumulative_taxable_income`
- **跨表引用**：支持引用其他员工或汇总数据（如部门平均绩效）
- **校验机制**：公式保存前自动校验语法和依赖项闭环

---

### 3.3 薪资档案管理

> **定位**：记录每位员工全生命周期的薪资历史，支持调薪追溯。

#### 3.3.1 功能清单

| 功能点 | 说明 | 优先级 |
|--------|------|--------|
| 个人薪资档案 | 每个员工独立的薪资档案，记录生效日期、失效日期 | P0 |
| 调薪记录 | 每次调薪生成变更记录，支持审批流 | P0 |
| 薪资版本对比 | 对比不同时间段的薪资构成变化 | P1 |
| 批量调薪 | 按部门/职级批量调整薪酬（普调、晋升调薪） | P1 |
| 薪资试算 | 调薪前模拟算薪，预测月度成本变化 | P1 |
| 历史归档 | 自动归档历年薪资数据，支持查询与导出 | P0 |

#### 3.3.2 数据模型

```
SalaryRecord
├── id, employee_id, effective_date, expire_date
├── items: [
│     { item_code: "base_salary", amount: 15000 },
│     { item_code: "position_allowance", amount: 2000 }
│   ]
├── created_by, approved_by, change_reason, attachment_url
├── created_at, updated_at
```

---

### 3.4 考勤与绩效数据集成

> **定位**：自动拉取考勤、请假、加班、绩效数据，参与薪酬计算。

#### 3.4.1 功能清单

| 功能点 | 说明 | 优先级 |
|--------|------|--------|
| 考勤数据导入 | 支持从钉钉/飞书/企业微信 API 拉取，或 Excel 导入 | P0 |
| 考勤项映射 | 迟到、早退、旷工、请假（事假/病假/年假/婚假等）、加班、出差 | P0 |
| 考勤扣款规则 | 迟到扣款、旷工扣款、事假扣款公式配置 | P0 |
| 假期额度管理 | 年假、调休、病假额度自动计算与扣减 | P1 |
| 绩效数据导入 | 绩效评分、绩效系数、奖金系数导入 | P0 |
| 数据校验 | 异常考勤标记、缺失数据预警、重复数据检测 | P0 |
| 手动修正 | HR 可对异常考勤/绩效数据进行手动调整并留痕 | P0 |

#### 3.4.2 考勤数据模型

```
AttendanceRecord
├── id, employee_id, period_year, period_month
├── standard_days, actual_days, working_days, rest_days
├── late_count, late_minutes, early_count, early_minutes
├── absent_days, leave_days, sick_leave_days, annual_leave_days
├── overtime_hours_normal, overtime_hours_weekend, overtime_hours_holiday
├── business_trip_days, on_duty_days
├── status (draft / confirmed / adjusted)
├── source (api / excel / manual), adjusted_by, adjusted_reason
```

---

### 3.5 社保公积金管理

> **定位**：覆盖多城市社保政策，自动计算企业与个人缴纳额，支持政策更新。

#### 3.5.1 功能清单

| 功能点 | 说明 | 优先级 |
|--------|------|--------|
| 城市政策库 | 维护全国 400+ 城市的社保/公积金缴纳基数上下限、比例 | P0 |
| 基数自动调整 | 每年 7 月基数调整时自动提醒，支持批量更新 | P0 |
| 缴纳明细计算 | 养老、医疗、失业、工伤、生育、公积金（个人+企业）分项计算 | P0 |
| 缴纳比例配置 | 支持企业自定义比例（如公积金 12%/5% 可选） | P0 |
| 补缴/退缴 | 入离职月份社保按天折算，支持补缴记录 | P1 |
| 异地缴纳 | 员工工作地与参保地分离时的处理 | P2 |
| 政策版本管理 | 社保政策历史版本记录，算薪时按生效月份匹配 | P1 |
| 社保报表导出 | 生成社保局/公积金中心要求的申报表格 | P1 |

#### 3.5.2 社保计算规则

```
SIPolicy (按城市+年份+月份)
├── city_code, city_name, effective_year, effective_month
├── pension_base_min, pension_base_max, pension_ratio_person, pension_ratio_company
├── medical_base_min, medical_base_max, medical_ratio_person, medical_ratio_company
├── unemployment_base_min, unemployment_base_max, unemployment_ratio_person, unemployment_ratio_company
├── injury_ratio_company, maternity_ratio_company (个人不缴)
├── hf_base_min, hf_base_max, hf_ratio_person, hf_ratio_company
├── insurance_order: [pension, medical, unemployment, injury, maternity, hf]
```

**计算逻辑**：
1. 取员工 `si_base` 与 `hf_base`，落入 `[min, max]` 区间。
2. 若员工未设定基数，取其上年度月平均工资或当地最低基数。
3. 分项计算：个人缴纳 = `base × person_ratio`，企业缴纳 = `base × company_ratio`。
4. 入离职当月按实际在职天数比例折算（可配置按天/按月）。

---

### 3.6 个税计算引擎

> **定位**：严格遵循国家累计预扣法，支持专项附加扣除、年终奖单独/合并计税。

#### 3.6.1 功能清单

| 功能点 | 说明 | 优先级 |
|--------|------|--------|
| 累计预扣法 | 按年度累计应纳税所得额计算预扣率 | P0 |
| 专项附加扣除 | 子女教育、继续教育、大病医疗、房贷利息、住房租金、赡养老人 | P0 |
| 年终奖计税 | 支持单独计税（优惠税率）和合并计税两种方案 | P0 |
| 个税倒算 | 已知税后工资，反推税前工资和应缴个税 | P1 |
| 多主体报税 | 同一员工在多个法人主体发薪时的合并计税 | P2 |
| 外籍人员 | 非居民个人、无住所个人的特殊计税规则 | P2 |
| 税局对接 | 生成个税申报数据，支持导出到自然人电子税务局批量导入 | P1 |
| 税率表维护 | 内置最新个税税率表，政策更新时一键替换 | P0 |

#### 3.6.2 累计预扣法计算逻辑

```
累计预扣预缴应纳税所得额 =
  累计收入（应税工资项）
  - 累计免税收入
  - 累计减除费用（5000 × 月份数）
  - 累计专项扣除（社保公积金个人部分）
  - 累计专项附加扣除
  - 累计依法确定的其他扣除

当月应预扣预缴税额 =
  (累计预扣预缴应纳税所得额 × 预扣率 - 速算扣除数)
  - 累计已预缴税额
```

**年度税率表（居民个人工资薪金）**：

| 级数 | 累计预扣预缴应纳税所得额 | 预扣率 | 速算扣除数 |
|------|--------------------------|--------|------------|
| 1 | 不超过 36,000 元 | 3% | 0 |
| 2 | 超过 36,000 至 144,000 元 | 10% | 2,520 |
| 3 | 超过 144,000 至 300,000 元 | 20% | 16,920 |
| 4 | 超过 300,000 至 420,000 元 | 25% | 31,920 |
| 5 | 超过 420,000 至 660,000 元 | 30% | 52,920 |
| 6 | 超过 660,000 至 960,000 元 | 35% | 85,920 |
| 7 | 超过 960,000 元 | 45% | 181,920 |

#### 3.6.3 年终奖单独计税（优惠算法）

```
年终奖应纳税额 = 全年一次性奖金收入 × 适用税率 - 速算扣除数

适用税率和速算扣除数按「年终奖 ÷ 12」的数额对应月度税率表确定。
```

> 注：政策有效期内支持，到期后自动切换为合并计税。

---

### 3.7 薪资计算引擎（核心）

> **定位**：一键算薪，自动关联所有数据源，生成完整薪资明细，支持差异校验。

#### 3.7.1 功能清单

| 功能点 | 说明 | 优先级 |
|--------|------|--------|
| 算薪周期管理 | 创建月度算薪批次（如 2026-01），锁定/解锁算薪 | P0 |
| 一键算薪 | 自动拉取考勤、绩效、社保、个税数据，批量计算全员薪资 | P0 |
| 增量算薪 | 仅对变更数据重新计算，提升效率 | P1 |
| 算薪结果明细 | 每个员工的薪资明细表，分项展示应发、应扣、实发 | P0 |
| 异常预警 | 薪资与上月差异 > X%、社保基数超限、个税跳档、负数工资等 | P0 |
| 差异对比 | 与上月/上批次对比，高亮变动项 | P0 |
| 手动调整 | 对个别员工的某项薪酬进行手动修正，留痕审计 | P0 |
| 算薪回滚 | 发现问题后可回滚整个批次重新计算 | P1 |
| 试算模式 | 不生成正式数据，仅预览计算结果 | P1 |

#### 3.7.2 算薪流程

```
Step 1: 创建算薪批次（选择算薪月份、薪酬组）
Step 2: 数据检查（考勤完整性、异动状态、社保基数缺失）
Step 3: 自动计算（遍历员工 → 执行薪酬公式 → 计算社保 → 计算个税 → 汇总实发）
Step 4: 异常预警（异常标记 + 邮件/站内信通知 HR）
Step 5: HR 核对与手动调整（在线审批修正）
Step 6: 算薪确认（锁定批次，生成工资条）
Step 7: 导出银行报盘 / 个税申报 / 财务凭证
```

#### 3.7.3 薪资明细数据结构

```
PayrollDetail
├── id, batch_id, employee_id, period_year, period_month
├── pay_date, status (draft / confirmed / paid / locked)
├── items: [
│   { code: "base_salary", name: "基本工资", category: "fixed", direction: "addition", amount: 15000, taxable: true },
│   { code: "performance_bonus", name: "绩效奖金", category: "performance", direction: "addition", amount: 3000, taxable: true },
│   { code: "overtime_pay", name: "加班费", category: "attendance", direction: "addition", amount: 1200, taxable: true },
│   { code: "late_deduction", name: "迟到扣款", category: "deduction", direction: "deduction", amount: -200, taxable: false },
│   { code: "si_pension_person", name: "养老保险(个人)", category: "si", direction: "deduction", amount: -1200, taxable: false },
│   { code: "hf_person", name: "公积金(个人)", category: "hf", direction: "deduction", amount: -1800, taxable: false },
│   { code: "tax", name: "个人所得税", category: "tax", direction: "deduction", amount: -850, taxable: false }
│ ]
├── gross_salary: 19400          // 应发合计（加项）
├── total_deductions: -4050      // 应扣合计（减项含社保个税）
├── net_salary: 15350            // 实发工资
├── tax_amount: 850              // 个税
├── cumulative_taxable_income: 85000  // 累计应纳税所得额
├── cumulative_tax_paid: 3200    // 累计已缴个税
├── bank_account, bank_name      // 发放银行信息
├── created_at, confirmed_at, confirmed_by
```

---

### 3.8 电子工资条

> **定位**：替代纸质工资条，加密推送，支持员工确认、签名、历史查询。

#### 3.8.1 功能清单

| 功能点 | 说明 | 优先级 |
|--------|------|--------|
| 自动生成 | 算薪确认后自动按模板生成工资条 | P0 |
| 推送方式 | 站内信、邮件、钉钉/飞书机器人消息、短信（可选） | P0 |
| 加密查看 | 员工需登录验证后查看，支持水印/阅后即焚 | P1 |
| 电子签名 | 员工在线签名确认，具有法律效力 | P1 |
| 查看状态追踪 | 已发送/已查看/已确认/未查看，实时追踪 | P0 |
| 历史查询 | 员工可查看过往 12 个月/全部历史工资条 | P0 |
| 申诉通道 | 员工对工资条有异议可一键发起申诉 | P1 |
| 定时发送 | 支持预设发送时间（如每月 10 日 10:00） | P1 |
| 模板自定义 | 企业可自定义工资条展示字段和样式 | P1 |
| 多终端支持 | PC 网页、H5、微信小程序、钉钉微应用 | P0 |

#### 3.8.2 工资条模板设计

```
┌─────────────────────────────────────┐
│  XX 公司 2026 年 1 月工资条          │
│  员工：张三  工号：E10086  部门：技术部  │
├─────────────────────────────────────┤
│  收入项          │  金额    │  备注  │
│  基本工资        │ 15,000  │        │
│  岗位津贴        │  2,000  │        │
│  绩效奖金        │  3,000  │        │
│  加班费          │  1,200  │        │
│  ────────────────┼─────────┼─────── │
│  应发合计        │ 21,200  │        │
├─────────────────────────────────────┤
│  扣款项          │  金额    │  备注  │
│  养老保险(个人)   │  1,200  │        │
│  医疗保险(个人)   │    300  │        │
│  失业保险(个人)   │     60  │        │
│  公积金(个人)     │  1,800  │        │
│  个人所得税      │    850  │        │
│  迟到扣款        │    200  │        │
│  ────────────────┼─────────┼─────── │
│  应扣合计        │  5,410  │        │
├─────────────────────────────────────┤
│  实发工资        │ 15,790  │        │
│  累计已缴个税     │  3,200  │        │
├─────────────────────────────────────┤
│  [ 我已确认，签名：________ ]         │
└─────────────────────────────────────┘
```

---

### 3.9 审批与发放流程

> **定位**：确保算薪结果经过合规审批后，方可生成银行报盘和发放。

#### 3.9.1 功能清单

| 功能点 | 说明 | 优先级 |
|--------|------|--------|
| 审批流配置 | 自定义多级审批：HR 专员 → HRD → CFO → 总经理 | P0 |
| 审批通知 | 审批人收到待办通知，支持邮件/钉钉/飞书 | P0 |
| 审批留痕 | 审批意见、时间、结果全程记录 | P0 |
| 银行报盘导出 | 生成银行代发文件（支持各大银行格式） | P0 |
| 发放状态标记 | 未发放 / 发放中 / 已发放 / 发放失败 | P0 |
| 财务凭证 | 生成财务记账凭证数据，对接 ERP/财务系统 | P1 |
| 个税申报导出 | 导出自然人电子税务局批量申报文件 | P1 |
| 发放异常处理 | 银行卡异常、发放失败重试、退回记录 | P1 |

---

### 3.10 人力成本分析报表

> **定位**：多维度数据可视化，辅助管理层进行人力成本决策。

#### 3.10.1 功能清单

| 功能点 | 说明 | 优先级 |
|--------|------|--------|
| 成本总览看板 | 月度/年度人力成本总额、人均成本、成本占比 | P0 |
| 部门维度分析 | 各部门薪资总额、人均薪资、成本趋势 | P0 |
| 岗位维度分析 | 不同岗位/职级的薪酬分布、带宽分析 | P0 |
| 成本结构分析 | 工资/奖金/社保/公积金/个税各自占比 | P0 |
| 同比环比分析 | 与上月、去年同期对比，增长率、变动原因 | P0 |
| 预算管控 | 设定年度人力预算，实时监控执行率与预警 | P1 |
| 自定义报表 | 拖拽式自定义报表，支持多维度筛选和导出 | P1 |
| 数据下钻 | 从汇总报表下钻到部门 → 个人明细 | P1 |
| 图表类型 | 趋势折线图、结构饼图、分布箱线图、对比柱状图 | P0 |
| 定时推送 | 每月自动生成报表并推送给管理层 | P2 |

#### 3.10.2 核心 KPI 指标

| 指标 | 公式 | 用途 |
|------|------|------|
| 人均薪资 | 薪资总额 / 发薪人数 | 横向对比 |
| 人力成本率 | 人力成本 / 营业收入 | 经营效率 |
| 社保公积金占比 | (社保+公积金) / 薪资总额 | 福利成本分析 |
| 个税税负率 | 个税总额 / 应税收入总额 | 税负分析 |
| 调薪比例 | 本月调薪人数 / 总人数 | 激励分析 |
| 离职成本 | 离职补偿 + 招聘替换成本 | 保留分析 |

---

### 3.11 权限与数据安全

> **定位**：薪酬数据高度敏感，需严格的权限控制和安全保障。

#### 3.11.1 功能清单

| 功能点 | 说明 | 优先级 |
|--------|------|--------|
| RBAC 权限模型 | 角色-权限-资源三级控制 | P0 |
| 数据脱敏 | 非授权用户查看时身份证号、银行卡号脱敏 | P0 |
| 行级权限 | 部门经理只能查看本部门员工薪酬 | P0 |
| 列级权限 | 薪酬专员可见薪资明细，普通员工仅见自己的 | P0 |
| 操作审计日志 | 谁、何时、查看了谁的数据、做了什么修改 | P0 |
| 数据加密 | 数据库敏感字段加密（AES-256），传输 TLS | P0 |
| 备份恢复 | 每日自动备份，支持按时间点恢复 | P0 |
| 密码策略 | 强密码、定期更换、登录失败锁定 | P0 |
| 导出管控 | 敏感数据导出需审批，文件加密加水印 | P1 |
| 等保合规 | 满足等保 2.0 三级要求（可选） | P2 |

---

## 4. 数据模型设计（ER 概览）

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Organization  │     │    Employee     │     │  SalaryRecord   │
│   (组织架构)     │◄────│   (员工主数据)   │◄────│   (薪资档案)     │
└─────────────────┘     └────────┬────────┘     └─────────────────┘
                                 │
        ┌────────────────────────┼────────────────────────┐
        ▼                        ▼                        ▼
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│AttendanceRecord │     │   PayrollBatch  │     │  PayrollDetail  │
│   (考勤记录)     │     │   (算薪批次)     │     │   (薪资明细)     │
└─────────────────┘     └────────┬────────┘     └─────────────────┘
                                 │
                    ┌────────────┴────────────┐
                    ▼                         ▼
           ┌─────────────────┐      ┌─────────────────┐
           │  PayslipRecord  │      │    PayslipLog   │
           │   (工资条记录)   │      │   (查看/确认日志) │
           └─────────────────┘      └─────────────────┘

┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   SIPolicy      │     │   TaxPolicy     │     │   PayItemDef    │
│   (社保政策)     │     │   (个税政策)     │     │   (薪酬项定义)   │
└─────────────────┘     └─────────────────┘     └─────────────────┘

┌─────────────────┐     ┌─────────────────┐
│   AuditLog      │     │   ReportTemplate │
│   (审计日志)     │     │   (报表模板)      │
└─────────────────┘     └─────────────────┘
```

### 4.1 核心表结构（简化版）

```sql
-- 员工主表
CREATE TABLE employees (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  emp_no VARCHAR(32) NOT NULL UNIQUE,
  name VARCHAR(64) NOT NULL,
  id_card VARCHAR(18),
  phone VARCHAR(20),
  email VARCHAR(128),
  dept_id BIGINT,
  position VARCHAR(64),
  level VARCHAR(16),
  job_type ENUM('full_time','part_time','intern','contractor') DEFAULT 'full_time',
  entry_date DATE,
  leave_date DATE,
  status ENUM('active','probation','leave','resigned') DEFAULT 'active',
  bank_name VARCHAR(64),
  bank_account VARCHAR(32),
  si_city VARCHAR(32),
  si_base DECIMAL(12,2),
  hf_base DECIMAL(12,2),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_dept (dept_id),
  INDEX idx_status (status)
);

-- 薪资档案（历史版本）
CREATE TABLE salary_records (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  employee_id BIGINT NOT NULL,
  effective_date DATE NOT NULL,
  expire_date DATE,
  items JSON NOT NULL,  -- [{code, amount, currency}]
  change_reason VARCHAR(256),
  created_by BIGINT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 算薪批次
CREATE TABLE payroll_batches (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  batch_no VARCHAR(32) NOT NULL UNIQUE,  -- PR-202601
  period_year INT NOT NULL,
  period_month INT NOT NULL,
  group_id BIGINT,
  status ENUM('draft','calculating','pending_review','confirmed','paid','locked') DEFAULT 'draft',
  total_employees INT DEFAULT 0,
  total_gross DECIMAL(14,2) DEFAULT 0,
  total_net DECIMAL(14,2) DEFAULT 0,
  created_by BIGINT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  confirmed_at TIMESTAMP,
  confirmed_by BIGINT,
  INDEX idx_period (period_year, period_month)
);

-- 薪资明细
CREATE TABLE payroll_details (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  batch_id BIGINT NOT NULL,
  employee_id BIGINT NOT NULL,
  period_year INT NOT NULL,
  period_month INT NOT NULL,
  items JSON NOT NULL,
  gross_salary DECIMAL(12,2) DEFAULT 0,
  total_deductions DECIMAL(12,2) DEFAULT 0,
  net_salary DECIMAL(12,2) DEFAULT 0,
  tax_amount DECIMAL(12,2) DEFAULT 0,
  cumulative_taxable_income DECIMAL(14,2) DEFAULT 0,
  cumulative_tax_paid DECIMAL(12,2) DEFAULT 0,
  status ENUM('draft','confirmed','paid') DEFAULT 'draft',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_batch_emp (batch_id, employee_id),
  INDEX idx_emp_period (employee_id, period_year, period_month)
);

-- 工资条记录
CREATE TABLE payslip_records (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  detail_id BIGINT NOT NULL,
  employee_id BIGINT NOT NULL,
  period_year INT NOT NULL,
  period_month INT NOT NULL,
  content JSON NOT NULL,  -- 加密后的工资条内容
  sent_at TIMESTAMP,
  viewed_at TIMESTAMP,
  confirmed_at TIMESTAMP,
  signature_url VARCHAR(256),
  status ENUM('sent','viewed','confirmed') DEFAULT 'sent',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 审计日志
CREATE TABLE audit_logs (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id BIGINT,
  action VARCHAR(32) NOT NULL,  -- VIEW / EDIT / EXPORT / DELETE
  resource_type VARCHAR(32),  -- employee / payroll / payslip
  resource_id BIGINT,
  details JSON,
  ip_address VARCHAR(64),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user (user_id, created_at),
  INDEX idx_resource (resource_type, resource_id)
);
```

---

## 5. 接口设计（REST API 概览）

### 5.1 核心 API 分组

```
/api/v1
├── /employees          # 员工管理
├── /departments        # 组织架构
├── /salary-records     # 薪资档案
├── /pay-items          # 薪酬项定义
├── /pay-schemes        # 薪酬方案
├── /attendance         # 考勤数据
├── /si-policies        # 社保政策
├── /tax-policies       # 个税政策
├── /payroll-batches    # 算薪批次
├── /payroll-details    # 薪资明细
├── /payslips           # 工资条
├── /reports            # 报表分析
├── /audit-logs         # 审计日志
├── /auth               # 认证授权
└── /settings           # 系统配置
```

### 5.2 关键接口示例

#### 算薪批次

```
POST   /payroll-batches              # 创建算薪批次
GET    /payroll-batches/:id          # 查询批次详情
POST   /payroll-batches/:id/calculate # 一键算薪（异步）
GET    /payroll-batches/:id/progress  # 查询算薪进度
POST   /payroll-batches/:id/confirm   # 确认算薪（锁定批次）
POST   /payroll-batches/:id/rollback  # 回滚算薪
DELETE /payroll-batches/:id           # 删除草稿批次
```

#### 薪资明细

```
GET    /payroll-details?batch_id=xxx&employee_id=xxx  # 查询明细列表
GET    /payroll-details/:id                           # 查询单个明细
PATCH  /payroll-details/:id                          # 手动调整某一项
GET    /payroll-details/:id/compare?period=2025-12   # 与上月对比
```

#### 工资条

```
POST   /payslips/generate?batch_id=xxx   # 批量生成工资条
POST   /payslips/send                    # 批量发送工资条
GET    /payslips/my                      # 员工查看自己的工资条
POST   /payslips/:id/confirm             # 员工确认工资条
POST   /payslips/:id/appeal             # 员工申诉工资条
GET    /payslips/:id/status             # 查询发送/查看状态
```

#### 报表分析

```
GET    /reports/cost-overview?period=2026-01          # 成本总览
GET    /reports/department-analysis?period=2026-01   # 部门维度
GET    /reports/trend?period_from=2025-01&period_to=2026-01  # 趋势分析
GET    /reports/custom/:template_id                  # 自定义报表
POST   /reports/export                               # 导出报表
```

---

## 6. 技术架构建议

### 6.1 技术栈选型

| 层级 | 推荐方案 | 备选方案 | 说明 |
|------|----------|----------|------|
| 前端 | React 18 + Ant Design + ECharts | Vue 3 + Element Plus | 管理后台 + 数据可视化 |
| 移动端 | H5 + 钉钉/飞书 JSAPI | 微信小程序 | 员工自助查看工资条 |
| 后端 | Node.js (NestJS) / Java (Spring Boot) | Go (Gin) | 推荐 NestJS 快速迭代 |
| 数据库 | PostgreSQL 15 | MySQL 8 | JSON 字段支持公式和明细存储 |
| 缓存 | Redis 7 | - | 算薪中间结果、会话、锁 |
| 消息队列 | RabbitMQ / Apache Kafka | - | 算薪异步任务、工资条推送 |
| 搜索引擎 | Elasticsearch (可选) | - | 员工搜索、日志检索 |
| 文件存储 | MinIO / 阿里云 OSS | - | 工资条附件、审计文件 |
| 容器化 | Docker + Kubernetes | - | 生产环境部署 |

### 6.2 系统架构图

```
┌──────────────────────────────────────────────────────────────┐
│                        客户端层                               │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐    │
│  │ 管理后台  │  │ 员工H5   │  │ 钉钉微应用│  │ 飞书微应用│    │
│  │ (React)  │  │ (H5)     │  │ (JSAPI)  │  │ (JSAPI)  │    │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘    │
└───────┼────────────┼────────────┼────────────┼────────────┘
        │            │            │            │
        ▼            ▼            ▼            ▼
┌──────────────────────────────────────────────────────────────┐
│                        网关层 (Nginx / Kong)                  │
│  • 负载均衡  • HTTPS 终止  • 限流  • 认证中间件                │
└──────────────────────────────────────────────────────────────┘
        │
        ▼
┌──────────────────────────────────────────────────────────────┐
│                        应用服务层 (NestJS / Spring Boot)      │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐     │
│  │ 员工服务  │  │ 薪酬服务  │  │ 算薪引擎  │  │ 报表服务  │     │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘     │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐     │
│  │ 社保服务  │  │ 个税服务  │  │ 工资条服务│  │ 审计服务  │     │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘     │
└──────────────────────────────────────────────────────────────┘
        │
        ▼
┌──────────────────────────────────────────────────────────────┐
│                        数据层                               │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐    │
│  │ PostgreSQL│  │  Redis   │  │ RabbitMQ │  │  MinIO   │    │
│  │  (主数据) │  │  (缓存)  │  │ (消息队列)│  │ (文件存储)│   │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘    │
└──────────────────────────────────────────────────────────────┘
        │
        ▼
┌──────────────────────────────────────────────────────────────┐
│                        外部集成                               │
│  钉钉 API  │  飞书 API  │  银行报盘  │  个税电子税务局  │  企业微信 │
└──────────────────────────────────────────────────────────────┘
```

### 6.3 关键设计决策

| 决策点 | 方案 | 理由 |
|--------|------|------|
| 算薪执行方式 | 异步任务队列（Redis/RabbitMQ） | 千人规模算薪约 30-120s，避免 HTTP 超时 |
| 公式引擎 | 自研轻量级表达式解析器 | 规则相对固定，自研可控性高，无外部依赖 |
| 个税累计数据存储 | 按年度/员工维度独立表 | 累计预扣法需要跨年 persisted state |
| 工资条加密 | AES-256-GCM + 员工独立密钥 | 防止 DBA 或运维人员直接读取敏感数据 |
| 多租户 | 数据库级隔离（Schema per tenant） | 数据安全隔离，后续可支持 SaaS 化 |

---

## 7. 实现路线图（Roadmap）

### 阶段一：MVP（基础算薪，2-3 个月）
- [x] 员工主数据管理（CRUD + 导入）
- [x] 组织架构管理
- [x] 薪酬项定义 + 公式引擎（基础运算符）
- [x] 薪资档案管理
- [x] 考勤数据导入（Excel 模板）
- [x] 社保政策库（手动维护，先覆盖公司所在城市）
- [x] 个税累计预扣法计算
- [x] 一键算薪 + 薪资明细生成
- [x] 基础权限（管理员 / HR / 员工）

**目标**：替代现有智能薪酬 80% 核心功能，能跑通完整月度算薪流程。

### 阶段二：完善体验（1-2 个月）
- [x] 电子工资条（生成 + 推送 + 查看 + 确认）
- [x] 考勤数据 API 对接（钉钉/飞书）
- [x] 花名册自动同步（Webhook）
- [x] 算薪异常预警与差异对比
- [x] 审批流程（算薪确认审批）
- [x] 银行报盘导出
- [x] 人力成本基础报表（总览 + 部门维度）
- [x] 操作审计日志

**目标**：体验对齐现有智能薪酬，员工和 HR 日常无感切换。

### 阶段三：进阶能力（2-3 个月）
- [x] 绩效数据联动算薪
- [x] 年终奖单独/合并计税
- [x] 多法人/多主体管理
- [x] 自定义报表与拖拽式分析
- [x] 预算管控与预警
- [x] 个税申报数据导出（对接电子税务局）
- [x] 社保自动基数调整提醒
- [x] 数据下钻与高级分析

**目标**：超越现有智能薪酬，支持企业更复杂的薪酬管理场景。

### 阶段四：智能化（按需）
- [ ] AI 智能查错（异常模式检测）
- [ ] 自然语言查询报表（"帮我看看技术部 Q1 人力成本趋势"）
- [ ] 薪酬预测与模拟（调薪模拟、预算预测）
- [ ] 多城市社保政策自动爬虫更新
- [ ] 期权/股权激励管理模块

---

## 8. 非功能需求（NFR）

| 类别 | 要求 | 指标 |
|------|------|------|
| 性能 | 千人规模算薪响应时间 | < 3 分钟（异步） |
| 性能 | 工资条页面加载 | < 2 秒 |
| 可用性 | 系统可用性 | 99.9%（月度停机 < 43 分钟） |
| 安全 | 敏感数据加密 | 数据库字段级 AES-256 |
| 安全 | 传输加密 | 全站 HTTPS / TLS 1.3 |
| 安全 | 密码策略 | 8 位以上，含大小写+数字+特殊字符 |
| 安全 | 会话管理 | JWT + 刷新令牌，2 小时过期 |
| 合规 | 数据保留 | 薪酬数据保留 10 年 |
| 合规 | 审计要求 | 全部操作留痕，不可删除 |
| 扩展 | 并发用户 | 支持 500 人同时在线 |
| 扩展 | 员工规模 | 架构支持 10,000 人（水平扩展） |

---

## 9. 风险与应对

| 风险 | 影响 | 应对策略 |
|------|------|----------|
| 个税政策变动 | 计算错误，合规风险 | 内置税率表版本管理，政策更新时自动提醒并支持一键切换 |
| 社保基数调整 | 算薪偏差 | 每年 7 月主动提醒 HR 更新基数，支持批量调整 |
| 数据迁移不完整 | 历史数据丢失 | 保留原系统只读访问权限至少 1 年；历史数据可导出归档 |
| 算薪错误 | 员工投诉、法律风险 | 异常预警 + 差异对比 + 试算模式 + 审批流程多重校验 |
| 员工隐私泄露 | 信任危机、法律风险 | 数据加密 + 严格权限 + 操作审计 + 安全培训 |
| 系统宕机影响发薪 | 员工不满 | 算薪日提前 3 天完成计算；建立应急手工算薪预案 |

---

## 10. 附录

### 10.1 竞品功能对照表（自建 vs 钉钉智能薪酬）

| 功能模块 | 钉钉智能薪酬 | 自建系统 | 备注 |
|----------|-------------|----------|------|
| 薪酬核算 | ✅ | ✅ P0 | 核心能力 |
| 社保公积金 | ✅ 400+城市 | ✅ P0（先覆盖常用城市） | 政策库需持续维护 |
| 个税累计预扣 | ✅ | ✅ P0 | 引擎自研 |
| 年终奖计税 | ✅ | ✅ P0 | 单独/合并两种方案 |
| 工资条推送 | ✅ 钉钉通知 | ✅ P0（钉钉+邮件+站内信） | 多渠道 |
| 电子签名 | ✅ | ✅ P1 | 法律效力 |
| 成本报表 | ✅ 基础 | ✅ P0（更丰富） | 自定义维度 |
| 考勤联动 | ✅ 钉钉原生 | ✅ P0（API对接） | 需开发 |
| 绩效联动 | ✅ | ✅ P1 | 接口对接 |
| 多法人 | ✅ | ✅ P2 | 集团化需求 |
| 自定义公式 | ✅ 有限 | ✅ P0（更灵活） | 自研引擎优势 |
| 数据安全 | ❌ 第三方托管 | ✅ 自主可控 | 自建核心优势 |
| 二次开发 | ❌ 封闭 | ✅ 完全开放 | 自建核心优势 |

### 10.2 建议的 Excel 导入模板（员工信息）

| 字段 | 示例 | 必填 |
|------|------|------|
| 工号 | E10086 | 是 |
| 姓名 | 张三 | 是 |
| 身份证号 | 11010119900101xxxx | 是 |
| 部门 | 技术部 | 是 |
| 岗位 | 后端工程师 | 是 |
| 职级 | P5 | 否 |
| 入职日期 | 2023-03-15 | 是 |
| 合同类型 | 全职 | 是 |
| 发薪地 | 北京 | 是 |
| 社保参保地 | 北京 | 是 |
| 社保基数 | 12000 | 是 |
| 公积金基数 | 12000 | 是 |
| 银行卡号 | 622202xxxxxxxxxxxx | 是 |
| 开户行 | 工商银行北京分行 | 是 |
| 基本工资 | 15000 | 是 |
| 岗位津贴 | 2000 | 否 |

### 10.3 建议的 Excel 导入模板（考勤数据）

| 字段 | 示例 | 必填 |
|------|------|------|
| 工号 | E10086 | 是 |
| 姓名 | 张三 | 是 |
| 算薪年月 | 2026-01 | 是 |
| 应出勤天数 | 21 | 是 |
| 实际出勤天数 | 20 | 是 |
| 迟到次数 | 1 | 否 |
| 迟到分钟数 | 15 | 否 |
| 事假天数 | 1 | 否 |
| 病假天数 | 0 | 否 |
| 年假天数 | 0 | 否 |
| 加班时数（平日）| 5 | 否 |
| 加班时数（周末）| 0 | 否 |
| 出差天数 | 0 | 否 |

---

> **结语**：本 PRD 覆盖了自建智能薪酬系统的完整功能蓝图、数据模型、接口设计和技术架构。开发团队可按 Roadmap 分阶段推进，先以 MVP 实现核心算薪闭环，再逐步扩展工资条、审批、报表等能力，最终形成一套自主可控、可扩展的企业级薪酬管理平台。
