import type { Metadata } from 'next';
import { AccountShell } from '@/components/account/AccountShell';

export const metadata: Metadata = { title: 'Mi cuenta', robots: { index: false } };

export default function Layout({ children }: { children: React.ReactNode }) {
  return <AccountShell>{children}</AccountShell>;
}
