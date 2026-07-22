const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);

const document = JSON.parse(Buffer.concat(chunks).toString('utf8'));
if (typeof document !== 'object' || document === null || Array.isArray(document)) {
  throw new Error('PHASE5_SECURITY_LICENSE_REPORT_INVALID');
}

const deniedLicense = /(?<![A-Z])(?:AGPL|GPL)-3\.0(?:-only|-or-later)?(?![A-Z])/u;
const unresolvedLicenses = new Set(['', 'UNKNOWN', 'UNLICENSED', 'SEE LICENSE IN LICENSE']);
const violations = [];
let packageCount = 0;

for (const [licenseGroup, packages] of Object.entries(document)) {
  if (!Array.isArray(packages)) throw new Error('PHASE5_SECURITY_LICENSE_REPORT_INVALID');
  for (const dependency of packages) {
    if (typeof dependency !== 'object' || dependency === null ||
      typeof dependency.name !== 'string' || typeof dependency.license !== 'string') {
      throw new Error('PHASE5_SECURITY_LICENSE_REPORT_INVALID');
    }
    packageCount += 1;
    const license = dependency.license.trim().toUpperCase();
    if (unresolvedLicenses.has(license) || deniedLicense.test(license)) {
      violations.push(`${dependency.name}@${dependency.versions?.join(',') ?? '未知版本'}：${licenseGroup}`);
    }
  }
}

if (packageCount === 0) throw new Error('PHASE5_SECURITY_LICENSE_REPORT_EMPTY');
if (violations.length > 0) {
  throw new Error(`PHASE5_SECURITY_LICENSE_POLICY_VIOLATION\n${violations.join('\n')}`);
}

process.stdout.write(`生产依赖许可证门禁通过，共检查 ${packageCount} 个依赖。\n`);
