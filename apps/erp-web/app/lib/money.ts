/** 将整数分字符串无损格式化为元，禁止通过 Number 或浮点数中转。 */
export function minorToYuan(value: string): string {
  if (!/^\d{1,18}$/u.test(value)) throw new Error('金额格式无效');
  const normalized = value.replace(/^0+(?=\d)/u, '').padStart(3, '0');
  return `${normalized.slice(0, -2)}.${normalized.slice(-2)}`;
}

/** 将最多两位小数的元字符串无损转换为整数分字符串。 */
export function yuanToMinor(value: string): string {
  const matched = /^(0|[1-9]\d{0,12})(?:\.(\d{1,2}))?$/u.exec(value);
  if (matched === null) throw new Error('金额必须是最多两位小数的非负金额');
  const whole = matched[1]!;
  const fraction = (matched[2] ?? '').padEnd(2, '0');
  return `${whole}${fraction}`.replace(/^0+(?=\d)/u, '');
}

/** 无损增加千分位并保留两位小数。 */
export function formatCnyMinor(value: string): string {
  const [whole, fraction] = minorToYuan(value).split('.');
  return `${whole!.replace(/\B(?=(\d{3})+(?!\d))/gu, ',')}.${fraction!}`;
}
