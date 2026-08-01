import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const stylesheet = readFileSync(new URL('../globals.css', import.meta.url), 'utf8');

function declaration(selector: string, property: string): string {
  const ruleStart = stylesheet.indexOf(`${selector} {`);
  expect(ruleStart, `缺少移动端样式规则：${selector}`).toBeGreaterThanOrEqual(0);
  const bodyStart = stylesheet.indexOf('{', ruleStart) + 1;
  const bodyEnd = stylesheet.indexOf('}', bodyStart);
  const body = stylesheet.slice(bodyStart, bodyEnd);
  const match = new RegExp(`${property}:\\s*([^;]+);`, 'u').exec(body);
  expect(match, `样式规则 ${selector} 缺少 ${property}`).not.toBeNull();
  return match?.[1]?.trim() ?? '';
}

function pixelValue(selector: string, property: string): number {
  const value = declaration(selector, property);
  const match = /^(\d+)px(?:$|\s)/u.exec(value);
  expect(match, `${selector} 的 ${property} 必须以 px 明确定义`).not.toBeNull();
  return Number.parseInt(match?.[1] ?? '0', 10);
}

describe('移动工作台无障碍样式契约', () => {
  it.each([
    '.mobile-card-action',
    '.mobile-detail-sheet > header button',
    '.mobile-delegation-list article button',
    '.mobile-tabs button',
  ])('%s 的交互热区不小于 48px', (selector) => {
    expect(pixelValue(selector, 'min-height')).toBeGreaterThanOrEqual(48);
  });

  it('为键盘焦点提供高可见轮廓', () => {
    const selector = '.mobile-shell :where(button, a, input, textarea, select):focus-visible';
    expect(pixelValue(selector, 'outline')).toBeGreaterThanOrEqual(3);
    expect(pixelValue(selector, 'outline-offset')).toBeGreaterThanOrEqual(2);
  });
});
