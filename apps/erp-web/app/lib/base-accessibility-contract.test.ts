import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const sources = Object.freeze({
  layout: read('../layout.tsx'),
  stylesheet: read('../globals.css'),
  login: read('../login/login-client.tsx'),
  consoleShell: read('../workspace/console-shell.tsx'),
  organization: read('../workspace/org/organization-console.tsx'),
  mobile: read('../mobile/mobile-workbench.tsx'),
});

/** 读取相对于当前契约测试的前端源文件。 */
function read(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

describe('ERP Web 基础无障碍与响应式契约', () => {
  it('固定中文语言、设备视口和可聚焦的主内容跳转目标', () => {
    expect(sources.layout).toContain('<html lang="zh-CN">');
    expect(sources.layout).toContain('width: \'device-width\'');
    expect(sources.layout).toContain('<a className="skip-link" href="#main-content">');
    expect(sources.layout).toContain('<div id="main-content" tabIndex={-1}>');
  });

  it('登录、组织与移动入口提供主地标、一级标题及加载状态语义', () => {
    expect(sources.login).toContain('<main className="login-shell" aria-busy={submitting}>');
    expect(sources.login).toContain('<Typography.Title level={1}>');
    expect(sources.organization).toContain(
      '<main aria-labelledby="org-title" aria-busy={loading}>',
    );
    expect(sources.organization).toContain(
      '<Typography.Title id="org-title" level={1}>',
    );
    expect(sources.mobile).toContain('<main className="mobile-shell">');
    expect(sources.mobile).toContain('<h1>{tabTitle(tab)}</h1>');
  });

  it('PC 与 H5 主导航具备可访问名称和当前位置语义', () => {
    expect(sources.consoleShell).toContain('aria-label="ERP 主导航"');
    expect(sources.consoleShell).toContain(
      "aria-label={collapsed ? '展开导航' : '收起导航'}",
    );
    expect(sources.mobile).toContain('aria-label="移动工作台主导航"');
    expect(sources.mobile).toContain("aria-current={tab === value ? 'page' : undefined}");
  });

  it('错误提示保留 alert 与 traceId，页面不持久化身份或业务数据', () => {
    for (const source of [sources.login, sources.organization]) {
      expect(source).toContain('role="alert"');
      expect(source).toContain('traceId');
    }
    for (const source of Object.values(sources)) {
      expect(source).not.toMatch(
        /\b(?:window\.)?(?:localStorage|sessionStorage|indexedDB)\s*(?:\.|\()/u,
      );
    }
  });

  it('全局键盘焦点、跳转链接和减少动画策略失败关闭', () => {
    expect(sources.stylesheet).toContain('.skip-link:focus-visible');
    expect(sources.stylesheet).toContain(
      ':where(a, button, input, textarea, select, [tabindex]:not([tabindex="-1"])):focus-visible',
    );
    expect(sources.stylesheet).toMatch(/outline:\s*3px\s+solid/u);
    expect(sources.stylesheet).toMatch(/outline-offset:\s*3px/u);
    expect(sources.stylesheet).toContain('@media (prefers-reduced-motion: reduce)');
    expect(sources.stylesheet).toContain('animation-duration: 0.01ms !important');
    expect(sources.stylesheet).toContain('animation-iteration-count: 1 !important');
    expect(sources.stylesheet).toContain('transition-duration: 0.01ms !important');
  });

  it('PC 收窄、标准 H5 与小屏断点均为显式契约', () => {
    expect(sources.stylesheet).toContain('@media (max-width: 820px)');
    expect(sources.stylesheet).toContain('@media (min-width: 768px)');
    expect(sources.stylesheet).toContain('@media (max-width: 520px)');
    expect(sources.stylesheet).toContain('@media (max-width: 560px)');
    expect(sources.stylesheet).toContain('.console-content { min-width: 0;');
  });

  it('权限与租户只采用服务端可信上下文，不在浏览器自行派生', () => {
    expect(sources.consoleShell).toContain('租户、角色和数据范围由服务端令牌决定');
    expect(sources.organization).toContain('当前视图已按令牌中的部门范围裁剪');
    expect(sources.login).toContain('系统不会接收客户端租户 ID');
    expect(sources.login).not.toMatch(/body:\s*JSON\.stringify\(\{[^}]*tenantId/u);
  });
});
