'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { errorMessage } from '@/lib/api/client';
import { useAuth } from '../providers/AuthProvider';
import { useToast } from '../providers/ToastProvider';
import { useWishlist } from '../providers/WishlistProvider';

export function WishlistButton({ productId, compact = false }: { productId: string; compact?: boolean }) {
  const { has, toggle } = useWishlist();
  // Mientras se restaura la sesión no se sabe si hay cliente: el clic esperaría o mandaría a /ingresar.
  const { status } = useAuth();
  const toast = useToast();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const saved = has(productId);

  async function onClick(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setBusy(true);
    try {
      const ok = await toggle(productId);
      if (!ok) {
        toast('Inicia sesión para guardar tus favoritos');
        router.push(`/ingresar?volver=${encodeURIComponent(window.location.pathname)}`);
        return;
      }
      toast(saved ? 'Quitado de favoritos' : 'Guardado en favoritos. Te avisamos si baja de precio.', 'ok');
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy || status === 'loading'}
      aria-pressed={saved}
      aria-label={saved ? 'Quitar de favoritos' : 'Guardar en favoritos'}
      className={
        compact
          ? 'flex h-9 w-9 items-center justify-center rounded-full bg-white/90 shadow-sm hover:bg-white'
          : 'btn-ghost'
      }
    >
      <svg viewBox="0 0 24 24" className={`h-5 w-5 ${saved ? 'fill-accent stroke-accent' : 'fill-none stroke-ink'}`} strokeWidth="1.8" aria-hidden>
        <path d="M12 20s-7-4.4-9.2-8.6C1.3 8.5 3 5 6.4 5c2 0 3.3 1.1 4.1 2.3h3C14.3 6.1 15.6 5 17.6 5 21 5 22.7 8.5 21.2 11.4 19 15.6 12 20 12 20z" />
      </svg>
      {!compact && (saved ? 'En favoritos' : 'Favoritos')}
    </button>
  );
}
