import type { Metadata } from 'next';
import { Suspense } from 'react';
import { PaymentResult } from '@/components/checkout/PaymentResult';

export const metadata: Metadata = { title: 'Resultado del pago', robots: { index: false } };

/** La pasarela simulada vuelve aquí con ?paymentId=... (PAYMENT_RETURN_URL del backend). */
export default function Page() {
  return (
    <Suspense>
      <PaymentResult />
    </Suspense>
  );
}
