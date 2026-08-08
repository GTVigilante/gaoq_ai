import { cookies } from 'next/headers';

import { PayrollHomeView } from './payroll-home-view';

export default async function HomePage() {
  const authenticated = (await cookies()).has('payroll_access_token');
  return <PayrollHomeView authenticated={authenticated} />;
}
