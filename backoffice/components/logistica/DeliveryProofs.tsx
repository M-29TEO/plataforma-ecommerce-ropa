'use client';

import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { api, apiBlob, errorMessage } from '@/lib/api/client';
import { formatDateTime } from '@/lib/format';
import { type DeliveryProof, PROOF_LABEL } from '@/lib/logistics';

/** Imagen protegida (foto o firma): se pide con el token y se muestra como blob: (no hay URL pública). */
function ProofImage({ proofId, alt }: { proofId: string; alt: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let revoked = false;
    let objectUrl: string | null = null;
    apiBlob(`/logistics/proofs/${proofId}/file`)
      .then(({ blob }) => {
        if (revoked) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch((e) => !revoked && setError(errorMessage(e)));
    return () => {
      revoked = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [proofId]);
  if (error) return <p className="text-xs text-danger">{error}</p>;
  if (!url) return <div className="h-40 animate-pulse rounded-md bg-sand" aria-label="Cargando imagen" />;
  // eslint-disable-next-line @next/next/no-img-element -- blob: local, next/image no aplica
  return <img src={url} alt={alt} className="max-h-72 w-full rounded-md border border-line bg-white object-contain" />;
}

/** Prueba de entrega que subió el motorizado: foto, firma y verificación del código OTP. */
export function DeliveryProofs({ shipmentId }: { shipmentId: string }) {
  const proofs = useQuery({
    queryKey: ['logistics', 'shipments', shipmentId, 'proofs'],
    queryFn: ({ signal }) => api<DeliveryProof[]>(`/logistics/shipments/${shipmentId}/proofs`, { signal }),
  });
  if (proofs.isPending) return <p className="text-sm text-ink-soft">Cargando…</p>;
  if (proofs.error) return <p className="text-sm text-danger">{errorMessage(proofs.error)}</p>;
  const list = proofs.data ?? [];
  if (list.length === 0) return <p className="text-sm text-ink-soft">Este envío no tiene prueba de entrega (entregas anteriores a la app del motorizado).</p>;
  const failedOtp = list.filter((p) => p.proofType === 'otp' && p.otpVerified === false).length;
  return (
    <div className="space-y-4">
      {failedOtp > 0 && <p className="text-sm text-warn">Códigos OTP incorrectos antes de la entrega: {failedOtp}</p>}
      {list
        .filter((p) => !(p.proofType === 'otp' && p.otpVerified === false))
        .map((p) => (
          <section key={p.id} className="space-y-1">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-semibold">{PROOF_LABEL[p.proofType] ?? p.proofType}</span>
              {p.proofType === 'otp' && <Badge tone={p.otpVerified ? 'ok' : 'danger'}>{p.otpVerified ? 'Código verificado' : 'Código incorrecto'}</Badge>}
              <span className="text-xs text-ink-soft">{formatDateTime(p.capturedAt)}</span>
              {p.distanceToDestinationM !== null && <span className="text-xs text-ink-soft">a {p.distanceToDestinationM} m del destino</span>}
            </div>
            {p.receiverName && <p className="text-sm">Recibió: {p.receiverName}</p>}
            {p.fileUrl !== null && (p.proofType === 'photo' || p.proofType === 'signature') && (
              <ProofImage proofId={p.id} alt={p.proofType === 'photo' ? 'Foto de la entrega' : `Firma de ${p.receiverName ?? 'quien recibió'}`} />
            )}
          </section>
        ))}
    </div>
  );
}
