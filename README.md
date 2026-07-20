# GaoQ AI

告趣ERP系统（代号：GaoQ-OS）产品需求、企业架构规范与开发跟踪仓库。

## 简介

告趣（GaoQ）是小红书头部MCN机构，管理约300人，业务涵盖MCN、广告、招商团长、电商返利、PE（浦积资本）、CVC（星媒控股）。

本仓库为告趣ERP系统的产品需求文档（PRD）和开发跟踪仓库，技术栈为 NestJS + MongoDB + React/Next.js，核心目标：
- 替代氚云（审批）、智能薪酬（薪酬+人事）、招聘门户
- 自建MCP服务层，支持员工和外部人员通过AI接入
- 钉钉/飞书SSO单点登录
- 一站式企业运营平台

## 文档

- [PRD-告趣ERP系统-v1.0.md](PRD-告趣ERP系统-v1.0.md) — 完整产品需求文档
- [Phase 0 规范包](./docs/phase-0/) — 架构、数据、集成、MCP、安全、切换与GitHub治理基线

## 阶段规划

| 阶段 | 参考时间 | 目标 | 状态 |
|------|------|------|------|
| Phase 0 | 4-6周 | 架构、数据、安全、MCP、集成契约与Backlog冻结 | 执行中 |
| Phase 1 | 8-10周 | 多租户底座、身份、组织主数据、双平台连接、MCP Core | 规划中 |
| Phase 2 | 8-10周 | 审批工作流、PC/H5及审批MCP能力 | 规划中 |
| Phase 3 | 10-12周 | 招聘、e签宝、入职、知识培训、关怀及MCP能力 | 规划中 |
| Phase 4 | 10-12周 | 考勤、薪酬、薪税文件、发放对账及MCP能力 | 规划中 |
| Phase 5 | 8-10周 | OP桥接、移动端、分析、生产加固和迁移工具 | 规划中 |
| Phase 6 | 6-8周 | 三次迁移演练、统一大切换与Hypercare | 规划中 |

详细范围、责任和退出门禁以[项目章程](./docs/phase-0/00-program-charter.md)为准。

## 技术栈

- **后端**: NestJS + MongoDB Replica Set + Redis + BullMQ
- **前端**: React + Next.js App Router + Ant Design
- **移动端**: React + Ant Design Mobile (H5/小程序)
- **AI接口**: MCP当前稳定规范（Streamable HTTP / stdio）+ OAuth 2.1
- **部署**: 中国境内云私有VPC + Docker + Nginx/API Gateway + 对象存储 + KMS

## 开发门禁

- 所有代码、接口、事件和MCP能力必须带可信租户上下文、服务端权限校验、幂等与审计。
- ERP是员工、部门、岗位和职级的唯一主数据源；钉钉、飞书和OP通过适配器同步。
- Web、REST、MCP、Webhook和后台任务必须复用同一应用服务，禁止重复实现业务规则。
- 禁止提交密钥、个人敏感数据、WordPress备份、构建产物和本地环境文件。
