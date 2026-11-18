'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, errorMessage } from '@/lib/api/client';
import type { CustomerReturn } from '@/lib/returns';
import { ReturnsList } from './ReturnsList';

const PAGE = 10;

/** "Mis devoluciones": como Mis pedidos, una página y "ver más" si llegó completa. */
export function ReturnsPage() {
  const [returns, setReturns] = useState<CustomerReturn[]>([]);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load(offset: number) {
    setLoading(true);
    try {
      const page = await api<CustomerReturn[]>(`/me/returns?limit=${PAGE}&offset=${offset}`);
      setReturns((r) => (offset === 0 ? page : [...r, ...page]));
      setDone(page.length < PAGE);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load(0);
  }, []);

  return (
    <div>
      <h1 className="text-3xl">Mis devoluciones</h1>
      <p className="mt-1 text-sm text-ink-soft">Para devolver o cambiar un producto, abre el pedido entregado en Mis pedidos (tienes 30 días desde la entrega).</p>
      {error && (
        <p className="mt-4 text-sm text-danger" role="alert">
          {error}
        </p>
      )}
      {!loading && returns.length === 0 && !error && (
        <p className="mt-4 text-ink-soft">
          No tienes devoluciones.{' '}
          <Link href="/mi-cuenta/pedidos" className="underline">
            Ver mis pedidos
          </Link>
        </p>
      )}
      <div className="mt-6">
        <ReturnsList returns={returns} />
      </div>
      {!done && returns.length > 0 && (
        <button type="button" className="btn-ghost mt-4" disabled={loading} onClick={() => void load(returns.length)}>
          {loading ? 'Cargando…' : 'Ver más'}
        </button>
      )}
    </div>
  );
}
