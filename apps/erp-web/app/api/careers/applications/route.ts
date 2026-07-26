import { NextResponse, type NextRequest } from 'next/server';

import type { CareerApplicationResponse } from '../../../careers/career-types';
import {
  isRecruitmentPortalConfigured,
  RecruitmentPortalApiError,
  recruitmentPortalFetch,
} from '../../../lib/recruitment-portal-api';

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const E164 = /^\+[1-9][0-9]{7,14}$/u;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,189}$/u;
const rateWindows = new Map<string, readonly number[]>();

interface ApplicationInput {
  readonly submissionId: string;
  readonly positionId: string;
  readonly name: string;
  readonly phone?: string;
  readonly email?: string;
  readonly submittedAt: string;
  readonly consentAccepted: boolean;
  readonly website?: string;
}

export const dynamic = 'force-dynamic';

/** 将公开投递收敛为 ERP 门户申请，不接收租户、渠道或授权期限。 */
export async function POST(request: NextRequest): Promise<NextResponse<
  CareerApplicationResponse | { readonly code: string; readonly message: string }
>> {
  if (!sameOrigin(request)) return error('CAREERS_ORIGIN_DENIED', '请求来源无效', 403);
  if (!consumeRateLimit(clientAddress(request))) {
    return error('CAREERS_RATE_LIMITED', '提交过于频繁，请稍后再试', 429);
  }
  const raw = await request.json().catch(() => null) as unknown;
  const input = parseInput(raw);
  if (input === null) return error('CAREERS_APPLICATION_INVALID', '请检查申请信息后重试', 400);
  if (input.website !== undefined && input.website.length > 0) {
    return error('CAREERS_APPLICATION_INVALID', '请检查申请信息后重试', 400);
  }
  if (!isRecruitmentPortalConfigured() && process.env.NODE_ENV !== 'production') {
    return NextResponse.json({
      applicationId: input.positionId,
      preview: true,
    }, { status: 201 });
  }
  const capturedAt = new Date(input.submittedAt);
  const expiresAt = new Date(capturedAt);
  expiresAt.setUTCFullYear(expiresAt.getUTCFullYear() + 1);
  const retentionExpiresAt = new Date(capturedAt);
  retentionExpiresAt.setUTCFullYear(retentionExpiresAt.getUTCFullYear() + 2);
  try {
    const result = await recruitmentPortalFetch<{
      readonly application: { readonly id: string };
    }>('/api/recruitment/applications', 'erp:recruitment:application:create', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': `portal:${input.submissionId}`,
      },
      body: JSON.stringify({
        positionId: input.positionId,
        sourceChannel: 'portal',
        candidate: {
          name: input.name,
          ...(input.phone === undefined ? {} : { phone: input.phone }),
          ...(input.email === undefined ? {} : { email: input.email }),
        },
        consent: {
          version: 'candidate-privacy-2026-01',
          purpose: '招聘甄选、候选人沟通及人才库管理',
          source: 'portal',
          expiresAt: expiresAt.toISOString(),
          retentionExpiresAt: retentionExpiresAt.toISOString(),
        },
      }),
    });
    return NextResponse.json({
      applicationId: result.application.id,
      preview: false,
    }, { status: 201 });
  } catch (caught) {
    const conflict = caught instanceof RecruitmentPortalApiError &&
      caught.code === 'RECRUITMENT_UNIQUE_CONFLICT';
    return error(
      conflict ? 'CAREERS_APPLICATION_CONFLICT' : 'CAREERS_APPLICATION_FAILED',
      conflict ? '该职位已有相关申请，请等待招聘同事联系' : '申请暂未提交成功，请稍后再试',
      conflict ? 409 : 503,
    );
  }
}

function parseInput(value: unknown): ApplicationInput | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.some((key) => ![
    'submissionId', 'positionId', 'name', 'phone', 'email',
    'submittedAt', 'consentAccepted', 'website',
  ].includes(key))) return null;
  const phone = typeof record.phone === 'string' && record.phone.length > 0
    ? record.phone
    : undefined;
  const email = typeof record.email === 'string' && record.email.length > 0
    ? record.email.toLowerCase()
    : undefined;
  const submittedAt = typeof record.submittedAt === 'string'
    ? new Date(record.submittedAt)
    : new Date(Number.NaN);
  if (
    typeof record.submissionId !== 'string' || !UUID.test(record.submissionId) ||
    typeof record.positionId !== 'string' || !ULID.test(record.positionId) ||
    typeof record.name !== 'string' ||
    record.name.trim().length < 1 || record.name.trim().length > 128 ||
    (phone === undefined && email === undefined) ||
    (phone !== undefined && !E164.test(phone)) ||
    (email !== undefined && !EMAIL.test(email)) ||
    !Number.isFinite(submittedAt.getTime()) ||
    Math.abs(Date.now() - submittedAt.getTime()) > 10 * 60_000 ||
    record.consentAccepted !== true ||
    (record.website !== undefined && typeof record.website !== 'string')
  ) return null;
  return {
    submissionId: record.submissionId,
    positionId: record.positionId,
    name: record.name.trim(),
    ...(phone === undefined ? {} : { phone }),
    ...(email === undefined ? {} : { email }),
    submittedAt: submittedAt.toISOString(),
    consentAccepted: true,
    ...(typeof record.website === 'string' ? { website: record.website } : {}),
  };
}

function sameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get('origin');
  if (origin === null) return process.env.NODE_ENV !== 'production';
  try {
    return new URL(origin).host === request.nextUrl.host;
  } catch {
    return false;
  }
}

function clientAddress(request: NextRequest): string {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return forwarded !== undefined && /^[0-9A-Fa-f:.]{3,64}$/u.test(forwarded)
    ? forwarded
    : 'unknown';
}

function consumeRateLimit(subject: string): boolean {
  const now = Date.now();
  const recent = (rateWindows.get(subject) ?? []).filter((value) => now - value < 10 * 60_000);
  if (rateWindows.size > 10_000) rateWindows.clear();
  if (recent.length >= 5) {
    rateWindows.set(subject, recent);
    return false;
  }
  rateWindows.set(subject, [...recent, now]);
  return true;
}

function error(
  code: string,
  message: string,
  status: number,
): NextResponse<{ readonly code: string; readonly message: string }> {
  return NextResponse.json({ code, message }, { status });
}
