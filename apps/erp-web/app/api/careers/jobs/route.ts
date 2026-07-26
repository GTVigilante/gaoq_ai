import { NextResponse } from 'next/server';

import type {
  CareerPosition,
  CareerPositionsResponse,
} from '../../../careers/career-types';
import {
  isRecruitmentPortalConfigured,
  recruitmentPortalFetch,
} from '../../../lib/recruitment-portal-api';

const PREVIEW_POSITIONS: readonly CareerPosition[] = Object.freeze([
  {
    id: '01J8ZQK7V0A2M4N6P8R0T2W4Y8',
    title: '内容策略经理',
    department: '内容商业化中心',
    location: '上海',
    headcount: 2,
    publishedAt: '2026-07-24T08:00:00.000Z',
  },
  {
    id: '01J8ZQK7V0A2M4N6P8R0T2W4Y7',
    title: '品牌客户成功',
    department: '整合营销事业部',
    location: '上海',
    headcount: 3,
    publishedAt: '2026-07-23T08:00:00.000Z',
  },
  {
    id: '01J8ZQK7V0A2M4N6P8R0T2W4Y6',
    title: '高级后端工程师',
    department: '产品技术中心',
    location: '上海 / 杭州',
    headcount: 2,
    publishedAt: '2026-07-22T08:00:00.000Z',
  },
  {
    id: '01J8ZQK7V0A2M4N6P8R0T2W4Y5',
    title: '财务 BP',
    department: '财务与经营管理部',
    location: '上海',
    headcount: 1,
    publishedAt: '2026-07-21T08:00:00.000Z',
  },
]);

export const dynamic = 'force-dynamic';

/** 返回 ERP 已开放职位；仅开发环境可使用明确标记的预览数据。 */
export async function GET(): Promise<NextResponse<CareerPositionsResponse | {
  readonly code: string;
  readonly message: string;
}>> {
  if (!isRecruitmentPortalConfigured() && process.env.NODE_ENV !== 'production') {
    return NextResponse.json({ positions: PREVIEW_POSITIONS, source: 'preview' });
  }
  try {
    const result = await recruitmentPortalFetch<{ readonly positions: readonly CareerPosition[] }>(
      '/api/recruitment/portal/positions',
      'erp:recruitment:portal:read',
    );
    return NextResponse.json({ positions: result.positions, source: 'erp' });
  } catch {
    return NextResponse.json({
      code: 'CAREERS_UNAVAILABLE',
      message: '职位服务暂时不可用，请稍后再试',
    }, { status: 503 });
  }
}
