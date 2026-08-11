import type { Metadata } from 'next';

import { ContactsConsole } from './contacts-console';

export const metadata: Metadata = { title: '企业通讯录 · GaoQ-OS' };

export default function ContactsPage() {
  return <ContactsConsole />;
}
