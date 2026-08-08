export interface PayrollHomeViewProps {
  readonly authenticated: boolean;
}

const styles = {
  main: {
    boxSizing: 'border-box',
    maxWidth: 960,
    minHeight: '100vh',
    margin: '0 auto',
    padding: '64px 24px',
    color: '#172033',
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  },
  card: {
    padding: 40,
    border: '1px solid #dfe5ef',
    borderRadius: 20,
    background: '#ffffff',
    boxShadow: '0 18px 50px rgba(34, 50, 84, 0.08)',
  },
  badges: { display: 'flex', flexWrap: 'wrap', gap: 10 },
  badge: {
    display: 'inline-flex',
    padding: '5px 10px',
    borderRadius: 999,
    background: '#e9f1ff',
    color: '#1554ad',
    fontSize: 13,
    fontWeight: 700,
  },
  status: {
    display: 'inline-flex',
    padding: '5px 10px',
    borderRadius: 999,
    background: '#edf7ee',
    color: '#237a38',
    fontSize: 13,
    fontWeight: 700,
  },
  title: { margin: '28px 0 14px', fontSize: 42, lineHeight: 1.15 },
  description: { maxWidth: 720, margin: 0, color: '#526174', fontSize: 18, lineHeight: 1.8 },
  note: { margin: '26px 0 0', color: '#66758a', fontSize: 14 },
  action: {
    display: 'inline-flex',
    marginTop: 30,
    padding: '12px 20px',
    border: 0,
    borderRadius: 10,
    background: '#1554ad',
    color: '#ffffff',
    font: 'inherit',
    fontWeight: 700,
    textDecoration: 'none',
    cursor: 'pointer',
  },
} as const;

/** 渲染不依赖客户端组件运行时的算薪首屏。 */
export function PayrollHomeView({ authenticated }: PayrollHomeViewProps) {
  return (
    <main style={styles.main}>
      <section style={styles.card} aria-labelledby="payroll-home-title">
        <div style={styles.badges}>
          <span style={styles.badge}>工资唯一事实源</span>
          <span style={authenticated ? styles.status : styles.badge}>
            {authenticated ? 'GaoQ SSO 已连接' : '未登录'}
          </span>
        </div>
        <h1 id="payroll-home-title" style={styles.title}>GaoQ 专业算薪</h1>
        <p style={styles.description}>
          统一使用 GaoQ ERP 的租户、身份、组织、员工和劳动关系主数据；
          算薪系统独立负责规则、计算、工资条、薪税与发放结果。
        </p>
        {authenticated ? (
          <>
            <p style={styles.note}>短期访问令牌仅保存在服务端 HttpOnly Cookie。</p>
            <form action="/api/auth/logout" method="post">
              <button style={styles.action} type="submit">退出算薪工作台</button>
            </form>
          </>
        ) : (
          <a style={styles.action} href="/api/auth/login">使用 GaoQ ERP 登录</a>
        )}
      </section>
    </main>
  );
}
