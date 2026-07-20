/**
 * Phase 1平台状态页，后续由受认证的工作台替换。
 */
export default function HomePage() {
  return (
    <main className="shell">
      <section className="hero" aria-labelledby="page-title">
        <p className="eyebrow">GaoQ-OS · Phase 1</p>
        <h1 id="page-title">企业运营底座正在构建</h1>
        <p className="summary">
          多租户、组织主数据、外部系统集成和标准MCP服务将作为所有业务模块的共同基础。
        </p>
        <dl className="status-grid">
          <div>
            <dt>租户策略</dt>
            <dd>服务端可信上下文</dd>
          </div>
          <div>
            <dt>主数据</dt>
            <dd>ERP统一管理</dd>
          </div>
          <div>
            <dt>AI接口</dt>
            <dd>MCP标准接入</dd>
          </div>
        </dl>
      </section>
    </main>
  );
}
