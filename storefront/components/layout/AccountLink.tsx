'use client';

import Link from 'next/link';
import { useAuth } from '../providers/AuthProvider';

export function AccountLink() {
  const { status, user } = useAuth();
  const href = status === 'authenticated' ? '/mi-cuenta' : '/ingresar';
  const label = status === 'authenticated' ? `Mi cuenta (${user?.firstName ?? user?.email})` : 'Ingresar';
  return (
    <Link href={href} className="flex h-10 items-center gap-2 rounded-full px-2 hover:bg-sand sm:px-3" aria-label={label}>
      <svg viewBox="0 0 24 24" className="h-5 w-5 fill-none stroke-current" strokeWidth="1.8" aria-hidden>
        <circle cx="12" cy="8" r="4" />
        <path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" />
      </svg>
      <span className="hidden text-sm md:inline">{status === 'authenticated' ? (user?.firstName ?? 'Mi cuenta') : 'Ingresar'}</span>
    </Link>
  );
}
