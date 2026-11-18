import type { Metadata } from 'next';
import { Suspense } from 'react';
import { LoginForm } from '@/components/account/LoginForm';

export const metadata: Metadata = { title: 'Ingresar', robots: { index: false } };

export default function Page() {
  return (
    <div className="container-page max-w-md py-14">
      <h1 className="text-3xl">Ingresar</h1>
      <Suspense>
        <LoginForm />
      </Suspense>
    </div>
  );
}
