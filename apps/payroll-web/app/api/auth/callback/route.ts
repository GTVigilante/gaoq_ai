import { timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { exchangeAuthorizationCode } from '../../../lib/oauth';

const safeEqual = (left: string, right: string): boolean => {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
};

/** 校验 state、消费一次性 code，并将短期令牌只写入 HttpOnly Cookie。 */
export const GET = async (request: NextRequest): Promise<NextResponse> => {
  const code = request.nextUrl.searchParams.get('code');
  const state = request.nextUrl.searchParams.get('state');
  const error = request.nextUrl.searchParams.get('error');
  const cookieStore = await cookies();
  const expectedState = cookieStore.get('payroll_oauth_state')?.value;
  const verifier = cookieStore.get('payroll_pkce_verifier')?.value;
  cookieStore.delete({ name: 'payroll_oauth_state', path: '/payroll/api/auth/callback' });
  cookieStore.delete({ name: 'payroll_pkce_verifier', path: '/payroll/api/auth/callback' });
  if (
    error !== null ||
    code === null ||
    state === null ||
    expectedState === undefined ||
    verifier === undefined ||
    !safeEqual(state, expectedState)
  ) {
    return NextResponse.redirect(new URL('/payroll?auth_error=oauth_callback_invalid', request.url));
  }
  try {
    const token = await exchangeAuthorizationCode(code, verifier);
    cookieStore.set('payroll_access_token', token.access_token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/payroll',
      maxAge: token.expires_in,
    });
    return NextResponse.redirect(new URL('/payroll', request.url));
  } catch {
    return NextResponse.redirect(new URL('/payroll?auth_error=token_exchange_failed', request.url));
  }
};
