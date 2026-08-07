import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

const requiredFields = Object.freeze([
  'OP_API_BASE_URL',
  'OP_SSO_CLIENT_ID',
  'OP_SSO_CLIENT_SECRET',
  'OP_SSO_REDIRECT_URI',
  'PAYROLL_WEB_ORIGIN',
  'PAYROLL_TAX_WORM_ARCHIVE_ENDPOINT',
  'PAYROLL_TAX_WORM_ARCHIVE_BEARER_TOKEN',
  'PAYROLL_TAX_GATEWAY_ENDPOINT',
  'PAYROLL_TAX_GATEWAY_BEARER_TOKEN',
  'TREASURY_WORM_ARCHIVE_ENDPOINT',
  'TREASURY_WORM_ARCHIVE_BEARER_TOKEN',
  'TREASURY_BANK_SUBMISSION_ENDPOINT',
  'TREASURY_BANK_SUBMISSION_BEARER_TOKEN',
  'TREASURY_BANK_RETURN_INBOX_ENDPOINT',
  'TREASURY_BANK_RETURN_INBOX_BEARER_TOKEN',
  'ESIGN_API_BASE_URL',
  'ESIGN_MALWARE_SCAN_ENDPOINT',
  'ESIGN_MALWARE_SCAN_BEARER_TOKEN',
  'ESIGN_WORM_ARCHIVE_ENDPOINT',
  'ESIGN_WORM_ARCHIVE_BEARER_TOKEN',
  'AUDIT_WORM_ENDPOINT',
  'AUDIT_WORM_BEARER_TOKEN',
  'AUDIT_ANCHOR_SIGNING_PRIVATE_KEY_BASE64',
  'AUDIT_ANCHOR_SIGNING_KEY_ID',
]);

const [filePath, mode] = process.argv.slice(2);
if (filePath === undefined || !isAbsolute(filePath)) {
  throw new Error('PRODUCTION_INPUT_PATH_MUST_BE_ABSOLUTE');
}
if (mode !== undefined && mode !== '--allow-incomplete') {
  throw new Error('PRODUCTION_INPUT_VALIDATION_MODE_INVALID');
}

const stats = await lstat(filePath);
if (!stats.isFile() || stats.isSymbolicLink()) throw new Error('PRODUCTION_INPUT_FILE_INVALID');
if ((stats.mode & 0o077) !== 0) throw new Error('PRODUCTION_INPUT_FILE_PERMISSIONS_INVALID');

const values = parseEnvironment(await readFile(filePath, 'utf8'));
const unexpected = [...values.keys()].filter((name) => !requiredFields.includes(name));
if (unexpected.length > 0) {
  throw new Error(`PRODUCTION_INPUT_FIELDS_UNEXPECTED:${unexpected.sort().join(',')}`);
}
const missing = requiredFields.filter((name) => (values.get(name) ?? '') === '');
if (missing.length > 0) {
  const message = `生产输入尚缺 ${missing.length} 项：${missing.join(',')}`;
  if (mode === '--allow-incomplete') {
    process.stdout.write(`${message}\n`);
    process.exit(0);
  }
  throw new Error(message);
}

validateValues(values);
process.stdout.write('生产输入文件权限、字段完整性和非敏感约束校验通过。\n');

/** 解析受限 dotenv，不执行变量展开或 shell 语法。 */
function parseEnvironment(source) {
  const result = new Map();
  for (const [index, rawLine] of source.split(/\r?\n/u).entries()) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) throw new Error(`PRODUCTION_INPUT_LINE_INVALID:${index + 1}`);
    const name = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (!/^[A-Z][A-Z0-9_]+$/u.test(name) || /[\r\n]/u.test(value)) {
      throw new Error(`PRODUCTION_INPUT_LINE_INVALID:${index + 1}`);
    }
    if (result.has(name)) throw new Error(`PRODUCTION_INPUT_FIELD_DUPLICATED:${name}`);
    result.set(name, value);
  }
  return result;
}

/** 校验可以在不访问外部系统的情况下确定的生产输入约束。 */
function validateValues(values) {
  const urlFields = requiredFields.filter((name) =>
    name.endsWith('_ENDPOINT') || name.endsWith('_ORIGIN') || name.endsWith('_BASE_URL') ||
    name.endsWith('_REDIRECT_URI'));
  for (const name of urlFields) {
    const parsed = new URL(values.get(name));
    if (
      parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '' ||
      parsed.search !== '' || parsed.hash !== '' || (parsed.port !== '' && parsed.port !== '443')
    ) throw new Error(`PRODUCTION_INPUT_URL_INVALID:${name}`);
  }
  if (values.get('OP_SSO_REDIRECT_URI') !==
    'https://aio.gaoq.com/api/auth/sso/op/callback') {
    throw new Error('PRODUCTION_INPUT_OP_REDIRECT_INVALID');
  }
  if (values.get('ESIGN_API_BASE_URL') !== 'https://openapi.esign.cn') {
    throw new Error('PRODUCTION_INPUT_ESIGN_ORIGIN_INVALID');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(values.get('OP_SSO_CLIENT_ID'))) {
    throw new Error('PRODUCTION_INPUT_OP_CLIENT_ID_INVALID');
  }
  const tokenFields = requiredFields.filter((name) =>
    name.endsWith('_BEARER_TOKEN') || name === 'OP_SSO_CLIENT_SECRET');
  for (const name of tokenFields) {
    const value = values.get(name);
    if (value.length < 32 || value.length > 2_048 || !/^[\x21-\x7e]+$/u.test(value)) {
      throw new Error(`PRODUCTION_INPUT_SECRET_FORMAT_INVALID:${name}`);
    }
  }
  const anchorKey = values.get('AUDIT_ANCHOR_SIGNING_PRIVATE_KEY_BASE64');
  if (anchorKey.length < 64 || anchorKey.length > 8_192) {
    throw new Error('PRODUCTION_INPUT_AUDIT_KEY_INVALID');
  }
  if (!/^[A-Za-z0-9._-]{8,128}$/u.test(values.get('AUDIT_ANCHOR_SIGNING_KEY_ID'))) {
    throw new Error('PRODUCTION_INPUT_AUDIT_KEY_ID_INVALID');
  }
}
