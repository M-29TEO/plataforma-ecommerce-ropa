import type { Metadata } from 'next';
import { Suspense } from 'react';
import { RegisterForm } from '@/components/account/RegisterForm';

export const metadata: Metadata = { title: 'Crear cuenta', robots: { index: false } };

export default function Page() {
  return (
    <div className="container-page max-w-lg py-14">
      <h1 className="text-3xl">Crear cuenta</h1>
      <p className="mt-2 text-sm text-ink-soft">Guarda tus direcciones, sigue tus pedidos y acumula puntos.</p>
      <Suspense>
        <RegisterForm />
      </Suspense>
    </div>
  );
}
