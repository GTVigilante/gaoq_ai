import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';

import { PayrollHomeView } from './payroll-home-view';

describe('算薪首页服务端渲染', () => {
  it('未登录时提供 GaoQ ERP 登录入口', () => {
    const html = renderToStaticMarkup(createElement(PayrollHomeView, { authenticated: false }));

    expect(html).toContain('GaoQ 专业算薪');
    expect(html).toContain('href="/api/auth/login"');
    expect(html).not.toContain('action="/api/auth/logout"');
  });

  it('已登录时只提供服务端退出表单', () => {
    const html = renderToStaticMarkup(createElement(PayrollHomeView, { authenticated: true }));

    expect(html).toContain('GaoQ SSO 已连接');
    expect(html).toContain('action="/api/auth/logout"');
    expect(html).not.toContain('href="/api/auth/login"');
  });
});
