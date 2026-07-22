import type { ReactNode } from 'react';

import { ConsoleShell } from './console-shell';

export default function WorkspaceLayout({ children }: { readonly children: ReactNode }) {
  return <ConsoleShell>{children}</ConsoleShell>;
}
