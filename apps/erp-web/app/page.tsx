import Link from 'next/link';

/**
 * ERP 入口页；受认证业务统一进入工作台。
 */
export default function HomePage() {
  return (
    <main className="shell">
      <section className="hero" aria-labelledby="page-title">
        <p className="eyebrow">GaoQ-OS · Enterprise Operations</p>
        <h1 id="page-title">企业运营，从可信主数据开始</h1>
        <p className="summary">
          统一组织、审批、人才、薪酬与外部系统连接，并通过标准 MCP 为各类 AI 提供受控能力。
        </p>
        <div className="hero-actions">
          <Link className="hero-primary" href="/login">企业 SSO 登录</Link>
          <Link className="hero-secondary" href="/workspace">进入工作台</Link>
          <Link className="hero-secondary" href="/careers">加入告趣</Link>
        </div>
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
