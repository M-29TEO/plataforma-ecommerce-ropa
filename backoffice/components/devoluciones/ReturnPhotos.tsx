'use client';

import { useEffect, useState } from 'react';
import { apiBlob, errorMessage } from '@/lib/api/client';
import { photoPath } from '@/lib/returns';

/** Foto de una línea (protegida): se pide con el token y se muestra como blob: (no hay URL pública). */
function ReturnPhoto({ path, alt }: { path: string; alt: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let revoked = false;
    let objectUrl: string | null = null;
    apiBlob(path)
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
  }, [path]);
  if (error) return <p className="text-xs text-danger">{error}</p>;
  if (!url) return <div className="size-28 animate-pulse rounded-md bg-sand" aria-label="Cargando foto" />;
  return (
    <a href={url} target="_blank" rel="noreferrer" title="Abrir en tamaño completo">
      {/* eslint-disable-next-line @next/next/no-img-element -- blob: local, next/image no aplica */}
      <img src={url} alt={alt} className="size-28 rounded-md border border-line bg-white object-cover" />
    </a>
  );
}

/** Fotos que el cliente adjuntó a una línea (GET /returns/:id/items/:itemId/photos/:index). */
export function ReturnPhotos({ returnId, returnItemId, count, productName }: { returnId: string; returnItemId: string; count: number; productName: string }) {
  if (count === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {Array.from({ length: count }, (_, i) => (
        <ReturnPhoto key={i} path={photoPath(returnId, returnItemId, i)} alt={`Foto ${i + 1} de ${productName}`} />
      ))}
    </div>
  );
}
