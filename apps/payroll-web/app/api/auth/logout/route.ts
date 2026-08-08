import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/** 清除算薪 BFF 的短期访问令牌；GaoQ 统一会话保持独立。 */
export const POST = async (request: NextRequest): Promise<NextResponse> => {
  const cookieStore = await cookies();
  cookieStore.delete('payroll_access_token');
  return NextResponse.redirect(new URL('/', request.url), 303);
};
