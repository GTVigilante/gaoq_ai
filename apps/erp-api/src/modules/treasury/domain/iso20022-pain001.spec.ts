import { describe, expect, it } from 'vitest';

import { generatePain001, type Pain001Input } from './iso20022-pain001.js';

const input: Pain001Input = {
  messageId: 'BATCH-202607-001', paymentInformationId: 'PAY-202607-001',
  creationDateTime: '2026-07-31T10:00:00.000Z', requestedExecutionDate: '2026-08-01',
  debtorName: '高企科技 & 服务', debtorAccount: '6222000000000001',
  debtorAgentClearingCode: 'CNAPS001', currency: 'CNY',
  lines: [
    {
      instructionId: 'LINE-002', creditorName: '李四', creditorAccount: '6222000000000003',
      creditorAgentClearingCode: 'CNAPS003', amountMinor: 839_501, purposeCode: 'PAYROLL',
    },
    {
      instructionId: 'LINE-001', creditorName: '张三 <测试>', creditorAccount: '6222000000000002',
      creditorAgentClearingCode: 'CNAPS002', amountMinor: 1_000_099, purposeCode: 'PAYROLL',
    },
  ],
};

describe('ISO 20022 pain.001 代发生成器', () => {
  it('使用整数分形成确定性控制总额并按指令排序', () => {
    const document = generatePain001(input);
    expect(document).toMatchObject({ lineCount: 2, controlSumMinor: 1_839_600 });
    expect(document.content).toContain('<CtrlSum>18396.00</CtrlSum>');
    expect(document.content.indexOf('LINE-001')).toBeLessThan(document.content.indexOf('LINE-002'));
    expect(generatePain001({ ...input, lines: [...input.lines].reverse() }).contentHash)
      .toBe(document.contentHash);
  });

  it('XML 转义姓名且不产生公式或标签注入', () => {
    const document = generatePain001({
      ...input,
      lines: [{ ...input.lines[0]!, creditorName: `李四 & < > " '` }, input.lines[1]!],
    });
    expect(document.content).toContain('高企科技 &amp; 服务');
    expect(document.content).toContain('张三 &lt;测试&gt;');
    expect(document.content).toContain('李四 &amp; &lt; &gt; &quot; &apos;');
    expect(document.content).not.toContain('<测试>');
  });

  it('拒绝 XML 1.0 不允许的控制字符、孤立代理项和格式控制字符', () => {
    for (const creditorName of ['李\u0000四', '李\uD800四', '李\uFFFF四', '李\u200B四']) {
      expect(() => generatePain001({
        ...input, lines: [{ ...input.lines[0]!, creditorName }],
      })).toThrow(/代发文本字段非法/u);
    }
  });

  it('拒绝重复收款账号、重复指令、零金额和非法账号', () => {
    expect(() => generatePain001({
      ...input, lines: [{ ...input.lines[0]!, creditorAccount: input.lines[1]!.creditorAccount }, input.lines[1]!],
    })).toThrow(/收款账号重复/u);
    expect(() => generatePain001({
      ...input, lines: [{ ...input.lines[0]!, instructionId: input.lines[1]!.instructionId }, input.lines[1]!],
    })).toThrow(/指令标识重复/u);
    expect(() => generatePain001({
      ...input, lines: [{ ...input.lines[0]!, amountMinor: 0 }],
    })).toThrow(/代发行格式非法/u);
  });

  it.each([
    ['报文标识', { messageId: '<invalid>' }],
    ['付款标识', { paymentInformationId: '' }],
    ['非规范时间', { creationDateTime: '2026-07-31T10:00:00Z' }],
    ['不存在日期', { requestedExecutionDate: '2026-02-30' }],
    ['付款账号', { debtorAccount: 'ABC' }],
    ['清算行号', { debtorAgentClearingCode: 'lowercase' }],
    ['空批次', { lines: [] }],
  ])('拒绝非法%s', (_label, changes) => {
    expect(() => generatePain001({ ...input, ...changes }))
      .toThrow(/报文标识非法|报文头或批量范围非法/u);
  });

  it.each([
    ['指令标识', { instructionId: '<invalid>' }],
    ['收款账号', { creditorAccount: 'ABC' }],
    ['清算行号', { creditorAgentClearingCode: 'short' }],
    ['用途码', { purposeCode: 'x' }],
    ['非整数金额', { amountMinor: 1.5 }],
  ])('拒绝非法行%s', (_label, changes) => {
    expect(() => generatePain001({
      ...input, lines: [{ ...input.lines[0]!, ...changes }],
    })).toThrow(/代发行格式非法/u);
  });

  it('拒绝空白或超长名称、超量批次与控制总额溢出', () => {
    expect(() => generatePain001({ ...input, debtorName: '   ' })).toThrow(/文本字段非法/u);
    expect(() => generatePain001({
      ...input, lines: [{ ...input.lines[0]!, creditorName: '名'.repeat(141) }],
    })).toThrow(/文本字段非法/u);
    const template = input.lines[0]!;
    const tooMany = Array.from({ length: 5_001 }, (_, index) => ({
      ...template,
      instructionId: `L${String(index).padStart(4, '0')}`,
      creditorAccount: String(10_000_000 + index),
    }));
    expect(() => generatePain001({ ...input, lines: tooMany })).toThrow(/批量范围非法/u);
    expect(() => generatePain001({
      ...input,
      lines: [
        { ...template, amountMinor: Number.MAX_SAFE_INTEGER },
        { ...input.lines[1]!, amountMinor: 1 },
      ],
    })).toThrow(/总额溢出/u);
  });
});
