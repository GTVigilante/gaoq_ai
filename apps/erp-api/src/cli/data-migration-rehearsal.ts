import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';

import { z } from 'zod';

import {
  canonicalJson,
  digest,
  EMPTY_MIGRATION_CHECKSUM,
  roll,
} from '../modules/data-migration/data-migration-checksum.js';

const HASH = /^[A-Za-z0-9_-]{43}$/;
const RUN_ID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_EVIDENCE_LINE_BYTES = 1024 * 1024;

const countsSchema = z.object({
  applied: z.number().int().min(0),
  duplicate: z.number().int().min(0),
  rejected: z.number().int().min(0),
}).strict();

const reportSchema = z.object({
  runId: z.string().regex(RUN_ID),
  sourceSystem: z.string().regex(SOURCE_ID),
  mode: z.enum(['full', 'incremental']),
  scope: z.string().regex(SOURCE_ID),
  status: z.enum(['running', 'completed', 'failed']),
  expectedSourceCount: z.number().int().min(0),
  checkpoint: z.number().int().min(0),
  counts: countsSchema,
  sourceChecksum: z.string().regex(HASH),
  expectedSourceChecksum: z.string().regex(HASH),
  targetChecksum: z.string().regex(HASH),
  associationCount: z.number().int().min(0),
  unresolvedAssociationCount: z.number().int().min(0),
  attachmentCount: z.number().int().min(0),
  pendingAttachmentCount: z.number().int().min(0),
  differences: z.array(z.object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]{1,95}$/),
    severity: z.enum(['critical', 'high']),
    count: z.number().int().min(1),
  }).strict()).max(100),
  phaseSixEligible: z.boolean(),
}).strict();

const evidenceLineSchema = z.discriminatedUnion('recordType', [
  z.object({
    formatVersion: z.literal(1),
    recordType: z.literal('items'),
    data: z.object({
      sequence: z.number().int().min(1),
      status: z.enum(['applied', 'duplicate', 'rejected']),
      sourceFactHash: z.string().regex(HASH),
      targetHash: z.string().regex(HASH).nullable(),
    }).passthrough(),
  }).strict(),
  z.object({
    formatVersion: z.literal(1),
    recordType: z.literal('associations'),
    data: z.object({
      sequence: z.number().int().min(1),
      status: z.enum(['resolved', 'missing']),
    }).passthrough(),
  }).strict(),
  z.object({
    formatVersion: z.literal(1),
    recordType: z.literal('attachments'),
    data: z.object({
      sequence: z.number().int().min(1),
      status: z.enum(['pending', 'processing', 'verified', 'rejected']),
      targetEvidenceId: z.string().min(1).max(256).nullable(),
    }).passthrough(),
  }).strict(),
]);

const sealSchema = z.object({
  formatVersion: z.literal(1),
  recordType: z.literal('seal'),
  runId: z.string().regex(RUN_ID),
  recordCount: z.number().int().min(1),
  counts: z.object({
    items: z.number().int().min(0),
    associations: z.number().int().min(0),
    attachments: z.number().int().min(0),
  }).strict(),
  artifactChecksum: z.string().regex(HASH),
}).strict();

type MigrationReport = z.infer<typeof reportSchema>;
type EvidenceSeal = z.infer<typeof sealSchema>;

export interface VerifiedMigrationEvidence {
  readonly path: string;
  readonly report: MigrationReport;
  readonly seal: EvidenceSeal;
  readonly evidenceQualified: boolean;
  readonly observed: {
    readonly itemCounts: Readonly<Record<'applied' | 'duplicate' | 'rejected', number>>;
    readonly sourceChecksum: string;
    readonly targetChecksum: string;
  };
}

export interface MigrationRehearsalComparison {
  readonly qualified: true;
  readonly rehearsalCount: 3;
  readonly sourceSystem: string;
  readonly scope: string;
  readonly expectedSourceCount: number;
  readonly sourceChecksum: string;
  readonly targetChecksum: string;
  readonly associationCount: number;
  readonly attachmentCount: number;
  readonly runs: readonly {
    readonly runId: string;
    readonly artifactChecksum: string;
  }[];
  readonly comparisonChecksum: string;
}

/** 验证单份迁移证据的行序、控制总量与滚动封印。 */
export async function verifyMigrationEvidenceArtifact(
  artifactPath: string,
): Promise<VerifiedMigrationEvidence> {
  const path = await realpath(artifactPath);
  if (!(await stat(path)).isFile()) throw rehearsalError('ARTIFACT_NOT_FILE');
  let report: MigrationReport | null = null;
  let seal: EvidenceSeal | null = null;
  let checksum = EMPTY_MIGRATION_CHECKSUM;
  let recordCount = 0;
  let lastEvidenceOrder = 0;
  let evidenceQualified = true;
  let sourceChecksum = EMPTY_MIGRATION_CHECKSUM;
  let targetChecksum = EMPTY_MIGRATION_CHECKSUM;
  const counts = { items: 0, associations: 0, attachments: 0 };
  const itemCounts = { applied: 0, duplicate: 0, rejected: 0 };

  for await (const raw of readArtifactLines(path)) {
    if (seal !== null) throw rehearsalError('SEAL_NOT_FINAL');
    if (report === null) {
      const envelope = z.object({
        formatVersion: z.literal(1), recordType: z.literal('report'), data: reportSchema,
      })
        .strict().safeParse(raw);
      if (!envelope.success) throw rehearsalError('REPORT_INVALID');
      report = envelope.data.data;
      recordCount += 1;
      checksum = roll(checksum, recordCount, digest(canonicalJson(raw)));
      continue;
    }
    const parsedSeal = sealSchema.safeParse(raw);
    if (parsedSeal.success) {
      seal = parsedSeal.data;
      continue;
    }
    const evidence = evidenceLineSchema.safeParse(raw);
    if (!evidence.success) throw rehearsalError('EVIDENCE_LINE_INVALID');
    const order = evidenceOrder(evidence.data.recordType);
    if (order < lastEvidenceOrder) throw rehearsalError('EVIDENCE_ORDER_INVALID');
    lastEvidenceOrder = order;
    counts[evidence.data.recordType] += 1;
    const sequence = evidence.data.data.sequence;
    if (sequence > report.expectedSourceCount ||
      (evidence.data.recordType === 'items' && sequence !== counts.items)) {
      throw rehearsalError('EVIDENCE_SEQUENCE_INVALID');
    }
    if (evidence.data.recordType === 'items') {
      itemCounts[evidence.data.data.status] += 1;
      sourceChecksum = roll(sourceChecksum, sequence, evidence.data.data.sourceFactHash);
      if (evidence.data.data.targetHash !== null) {
        targetChecksum = roll(targetChecksum, sequence, evidence.data.data.targetHash);
      }
    }
    evidenceQualified &&= evidenceRecordQualified(evidence.data);
    recordCount += 1;
    checksum = roll(checksum, recordCount, digest(canonicalJson(raw)));
  }

  if (report === null || seal === null) throw rehearsalError('ARTIFACT_INCOMPLETE');
  if (seal.runId !== report.runId || seal.recordCount !== recordCount ||
    seal.artifactChecksum !== checksum ||
    Object.entries(counts).some(([kind, count]) =>
      seal?.counts[kind as keyof typeof counts] !== count)) {
    throw rehearsalError('SEAL_INVALID');
  }
  return Object.freeze({
    path, report, seal, evidenceQualified,
    observed: Object.freeze({
      itemCounts: Object.freeze({ ...itemCounts }), sourceChecksum, targetChecksum,
    }),
  });
}

/** 三次全量演练必须分别验封，并对业务控制量和目标结果达成一致。 */
export async function compareMigrationRehearsals(
  artifactPaths: readonly [string, string, string],
): Promise<MigrationRehearsalComparison> {
  const artifacts = await Promise.all(artifactPaths.map(verifyMigrationEvidenceArtifact));
  if (new Set(artifacts.map((artifact) => artifact.path)).size !== 3 ||
    new Set(artifacts.map((artifact) => artifact.report.runId)).size !== 3) {
    throw rehearsalError('ARTIFACTS_NOT_DISTINCT');
  }
  for (const artifact of artifacts) assertQualified(artifact);
  const [baseline, ...others] = artifacts;
  if (baseline === undefined || others.some((artifact) =>
    !sameControls(baseline.report, artifact.report))) {
    throw rehearsalError('CONTROL_TOTAL_MISMATCH');
  }
  const body = Object.freeze({
    qualified: true as const,
    rehearsalCount: 3 as const,
    sourceSystem: baseline.report.sourceSystem,
    scope: baseline.report.scope,
    expectedSourceCount: baseline.report.expectedSourceCount,
    sourceChecksum: baseline.report.sourceChecksum,
    targetChecksum: baseline.report.targetChecksum,
    associationCount: baseline.report.associationCount,
    attachmentCount: baseline.report.attachmentCount,
    runs: Object.freeze(artifacts.map((artifact) => Object.freeze({
      runId: artifact.report.runId,
      artifactChecksum: artifact.seal.artifactChecksum,
    }))),
  });
  return Object.freeze({ ...body, comparisonChecksum: digest(canonicalJson(body)) });
}

async function* readArtifactLines(path: string): AsyncGenerator<unknown> {
  const lines = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  for await (const line of lines) {
    if (Buffer.byteLength(line, 'utf8') > MAX_EVIDENCE_LINE_BYTES) {
      throw rehearsalError('LINE_TOO_LARGE');
    }
    if (line.trim().length === 0) throw rehearsalError('EMPTY_LINE');
    try {
      yield JSON.parse(line) as unknown;
    } catch {
      throw rehearsalError('JSON_INVALID');
    }
  }
}

function evidenceOrder(kind: 'items' | 'associations' | 'attachments'): number {
  return { items: 1, associations: 2, attachments: 3 }[kind];
}

function evidenceRecordQualified(record: z.infer<typeof evidenceLineSchema>): boolean {
  if (record.recordType === 'items') {
    return ['applied', 'duplicate'].includes(record.data.status) &&
      record.data.targetHash !== null;
  }
  if (record.recordType === 'associations') return record.data.status === 'resolved';
  return record.data.status === 'verified' && record.data.targetEvidenceId !== null;
}

function assertQualified(artifact: VerifiedMigrationEvidence): void {
  const { report, seal } = artifact;
  if (!artifact.evidenceQualified || report.mode !== 'full' || report.status !== 'completed' ||
    report.phaseSixEligible !== true || report.differences.length !== 0 ||
    report.expectedSourceCount === 0 || report.checkpoint !== report.expectedSourceCount ||
    report.sourceChecksum !== report.expectedSourceChecksum || report.counts.rejected !== 0 ||
    report.unresolvedAssociationCount !== 0 || report.pendingAttachmentCount !== 0 ||
    Object.entries(report.counts).some(([status, count]) =>
      artifact.observed.itemCounts[status as keyof typeof report.counts] !== count) ||
    artifact.observed.sourceChecksum !== report.sourceChecksum ||
    artifact.observed.targetChecksum !== report.targetChecksum ||
    seal.counts.items !== report.expectedSourceCount ||
    seal.counts.associations !== report.associationCount ||
    seal.counts.attachments !== report.attachmentCount) {
    throw rehearsalError('RUN_NOT_QUALIFIED');
  }
}

function sameControls(baseline: MigrationReport, candidate: MigrationReport): boolean {
  return baseline.sourceSystem === candidate.sourceSystem &&
    baseline.scope === candidate.scope &&
    baseline.expectedSourceCount === candidate.expectedSourceCount &&
    baseline.expectedSourceChecksum === candidate.expectedSourceChecksum &&
    baseline.sourceChecksum === candidate.sourceChecksum &&
    baseline.targetChecksum === candidate.targetChecksum &&
    baseline.associationCount === candidate.associationCount &&
    baseline.attachmentCount === candidate.attachmentCount;
}

function rehearsalError(code: string): Error {
  return new Error(`DATA_MIGRATION_PACKAGE_REHEARSAL_${code}`);
}
