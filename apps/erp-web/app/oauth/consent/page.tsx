import { OAuthConsentClient } from './oauth-consent-client';

interface ConsentPageProps {
  readonly searchParams: Promise<{ readonly request_id?: string }>;
}

/** OAuth 同意页只接收不可猜测 request_id，授权事实由 API 的 HttpOnly 会话判定。 */
export default async function OAuthConsentPage({ searchParams }: ConsentPageProps) {
  const requestId = (await searchParams).request_id ?? '';
  return <OAuthConsentClient requestId={requestId} />;
}
