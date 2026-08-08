import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';

import { createPkce, payrollOAuthConfiguration } from '../../../lib/oauth';

/** 发起 GaoQ OAuth 2.1 Authorization Code + PKCE 登录。 */
export const GET = async (): Promise<NextResponse> => {
  const config = payrollOAuthConfiguration();
  const state = randomBytes(32).toString('base64url');
  const pkce = createPkce();
  const cookieStore = await cookies();
  const secure = process.env.NODE_ENV === 'production';
  cookieStore.set('payroll_oauth_state', state, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/api/auth/callback',
    maxAge: 600,
  });
  cookieStore.set('payroll_pkce_verifier', pkce.verifier, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/api/auth/callback',
    maxAge: 600,
  });
  const target = new URL(config.authorizationEndpoint);
  target.searchParams.set('response_type', 'code');
  target.searchParams.set('client_id', config.clientId);
  target.searchParams.set('redirect_uri', config.redirectUri);
  target.searchParams.set('scope', config.scopes.join(' '));
  target.searchParams.set('state', state);
  target.searchParams.set('code_challenge', pkce.challenge);
  target.searchParams.set('code_challenge_method', 'S256');
  target.searchParams.set('resource', config.resource);
  return NextResponse.redirect(target);
};
