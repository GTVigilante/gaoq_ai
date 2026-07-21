import { createHash } from 'node:crypto';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,34}$/;
const ACCOUNT_PATTERN = /^[0-9]{8,32}$/;
const CLEARING_CODE_PATTERN = /^[0-9A-Z]{8,12}$/;
const MAX_LINES = 5_000;

export interface Pain001PaymentLine {
  readonly instructionId: string;
  readonly creditorName: string;
  readonly creditorAccount: string;
  readonly creditorAgentClearingCode: string;
  readonly amountMinor: number;
  readonly purposeCode: string;
}

export interface Pain001Input {
  readonly messageId: string;
  readonly paymentInformationId: string;
  readonly creationDateTime: string;
  readonly requestedExecutionDate: string;
  readonly debtorName: string;
  readonly debtorAccount: string;
  readonly debtorAgentClearingCode: string;
  readonly currency: 'CNY';
  readonly lines: readonly Pain001PaymentLine[];
}

export interface Pain001Document {
  readonly format: 'ISO20022_PAIN_001_001_03';
  readonly content: string;
  readonly contentHash: string;
  readonly lineCount: number;
  readonly controlSumMinor: number;
}

export class Pain001Error extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'Pain001Error';
  }
}

/** 生成确定性 UTF-8 pain.001 文件；账号仅在调用内存中出现，返回后应立即加密或发送。 */
export function generatePain001(input: Pain001Input): Pain001Document {
  validateInput(input);
  const sorted = [...input.lines].sort((left, right) =>
    left.instructionId < right.instructionId ? -1 : left.instructionId > right.instructionId ? 1 : 0);
  const total = sorted.reduce((sum, line) => sum + BigInt(line.amountMinor), 0n);
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) invalid('TREASURY_CONTROL_SUM_OVERFLOW', '代发总额溢出');
  const controlSumMinor = Number(total);
  const transactions = sorted.map((line) => [
    '<CdtTrfTxInf>',
    `<PmtId><InstrId>${xml(line.instructionId)}</InstrId><EndToEndId>${xml(line.instructionId)}</EndToEndId></PmtId>`,
    `<Amt><InstdAmt Ccy="CNY">${minorToDecimal(line.amountMinor)}</InstdAmt></Amt>`,
    `<CdtrAgt><FinInstnId><ClrSysMmbId><MmbId>${xml(line.creditorAgentClearingCode)}</MmbId></ClrSysMmbId></FinInstnId></CdtrAgt>`,
    `<Cdtr><Nm>${xml(normalizeText(line.creditorName, 140))}</Nm></Cdtr>`,
    `<CdtrAcct><Id><Othr><Id>${xml(line.creditorAccount)}</Id></Othr></Id></CdtrAcct>`,
    `<Purp><Prtry>${xml(line.purposeCode)}</Prtry></Purp>`,
    '</CdtTrfTxInf>',
  ].join('')).join('');
  const count = String(sorted.length);
  const sum = minorToDecimal(controlSumMinor);
  const content = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03"><CstmrCdtTrfInitn>',
    '<GrpHdr>',
    `<MsgId>${xml(input.messageId)}</MsgId>`,
    `<CreDtTm>${xml(input.creationDateTime)}</CreDtTm>`,
    `<NbOfTxs>${count}</NbOfTxs><CtrlSum>${sum}</CtrlSum>`,
    `<InitgPty><Nm>${xml(normalizeText(input.debtorName, 140))}</Nm></InitgPty>`,
    '</GrpHdr><PmtInf>',
    `<PmtInfId>${xml(input.paymentInformationId)}</PmtInfId>`,
    '<PmtMtd>TRF</PmtMtd><BtchBookg>true</BtchBookg>',
    `<NbOfTxs>${count}</NbOfTxs><CtrlSum>${sum}</CtrlSum>`,
    `<ReqdExctnDt>${xml(input.requestedExecutionDate)}</ReqdExctnDt>`,
    `<Dbtr><Nm>${xml(normalizeText(input.debtorName, 140))}</Nm></Dbtr>`,
    `<DbtrAcct><Id><Othr><Id>${xml(input.debtorAccount)}</Id></Othr></Id></DbtrAcct>`,
    `<DbtrAgt><FinInstnId><ClrSysMmbId><MmbId>${xml(input.debtorAgentClearingCode)}</MmbId></ClrSysMmbId></FinInstnId></DbtrAgt>`,
    '<ChrgBr>DEBT</ChrgBr>', transactions,
    '</PmtInf></CstmrCdtTrfInitn></Document>',
  ].join('');
  return Object.freeze({
    format: 'ISO20022_PAIN_001_001_03', content,
    contentHash: createHash('sha256').update(content, 'utf8').digest('base64url'),
    lineCount: sorted.length, controlSumMinor,
  });
}

function validateInput(input: Pain001Input): void {
  for (const value of [input.messageId, input.paymentInformationId]) {
    if (!ID_PATTERN.test(value)) invalid('TREASURY_MESSAGE_ID_INVALID', '代发报文标识非法');
  }
  if (
    !isCanonicalInstant(input.creationDateTime) ||
    !isCalendarDate(input.requestedExecutionDate) ||
    input.currency !== 'CNY' || !ACCOUNT_PATTERN.test(input.debtorAccount) ||
    !CLEARING_CODE_PATTERN.test(input.debtorAgentClearingCode) ||
    input.lines.length < 1 || input.lines.length > MAX_LINES
  ) invalid('TREASURY_HEADER_INVALID', '代发报文头或批量范围非法');
  normalizeText(input.debtorName, 140);
  const instructionIds = new Set<string>();
  const accounts = new Set<string>();
  for (const line of input.lines) {
    if (
      !ID_PATTERN.test(line.instructionId) || !ACCOUNT_PATTERN.test(line.creditorAccount) ||
      !CLEARING_CODE_PATTERN.test(line.creditorAgentClearingCode) ||
      !/^[A-Z][A-Z0-9_]{1,34}$/.test(line.purposeCode) ||
      !Number.isSafeInteger(line.amountMinor) || line.amountMinor <= 0
    ) invalid('TREASURY_PAYMENT_LINE_INVALID', '代发行格式非法');
    normalizeText(line.creditorName, 140);
    if (instructionIds.has(line.instructionId)) {
      invalid('TREASURY_INSTRUCTION_DUPLICATE', '代发指令标识重复');
    }
    if (accounts.has(line.creditorAccount)) {
      invalid('TREASURY_CREDITOR_ACCOUNT_DUPLICATE', '批次内收款账号重复，必须人工复核');
    }
    instructionIds.add(line.instructionId);
    accounts.add(line.creditorAccount);
  }
}

function normalizeText(value: string, maxLength: number): string {
  const normalized = value.normalize('NFKC').trim();
  if (
    normalized.length < 1 || normalized.length > maxLength ||
    /[\p{Cc}\p{Cf}]/u.test(normalized)
  ) invalid('TREASURY_TEXT_INVALID', '代发文本字段非法');
  return normalized;
}

function minorToDecimal(value: number): string {
  const minor = BigInt(value);
  return `${minor / 100n}.${String(minor % 100n).padStart(2, '0')}`;
}

function xml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function isCanonicalInstant(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function invalid(code: string, message: string): never { throw new Pain001Error(code, message); }
