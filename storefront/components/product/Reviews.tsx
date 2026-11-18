'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api/client';
import type { ReviewsPage } from '@/lib/commerce-types';
import { BROWSER_API } from '@/lib/config';
import { formatDate } from '@/lib/format';
import { Stars } from '../catalog/Stars';
import { useAuth } from '../providers/AuthProvider';
import { ReviewForm } from './ReviewForm';

const PAGE = 5;
const FIT_LABEL = { small: 'Queda pequeño', true: 'Talla correcta', large: 'Queda grande' } as const;

export function Reviews({ productId, initial }: { productId: string; initial: ReviewsPage | null }) {
  const { status } = useAuth();
  const pathname = usePathname();
  const [data, setData] = useState<ReviewsPage | null>(initial);
  const [filter, setFilter] = useState<{ rating?: number; withPhotos: boolean; sort: string }>({ withPhotos: false, sort: 'recent' });
  const [offset, setOffset] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [writing, setWriting] = useState(false);
  const [sent, setSent] = useState(false);

  const query = useCallback(
    (off: number) => {
      const q = new URLSearchParams({ limit: String(PAGE), offset: String(off), sort: filter.sort });
      if (filter.rating) q.set('rating', String(filter.rating));
      if (filter.withPhotos) q.set('withPhotos', 'true');
      return api<ReviewsPage>(`/products/${productId}/reviews?${q}`);
    },
    [productId, filter],
  );

  useEffect(() => {
    if (filter.sort === 'recent' && !filter.rating && !filter.withPhotos && initial) {
      setData(initial);
      setOffset(0);
      return;
    }
    void query(0).then((d) => {
      setData(d);
      setOffset(0);
    });
  }, [filter, query, initial]);

  async function more() {
    setLoadingMore(true);
    try {
      const next = await query(offset + PAGE);
      setData((d) => (d ? { ...d, reviews: [...d.reviews, ...next.reviews] } : next));
      setOffset(offset + PAGE);
    } finally {
      setLoadingMore(false);
    }
  }

  const s = data?.summary;
  const max = s ? Math.max(1, ...Object.values(s.distribution)) : 1;
  const hasMore = !!data && data.reviews.length >= offset + PAGE && data.reviews.length < (s?.ratingCount ?? 0);

  return (
    <section id="resenas" aria-labelledby="reviews-title" className="mt-14 border-t border-line pt-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h2 id="reviews-title" className="text-2xl">
          Reseñas
        </h2>
        {status === 'authenticated' ? (
          <button type="button" className="btn-ghost" onClick={() => setWriting((w) => !w)}>
            Escribir una reseña
          </button>
        ) : (
          <Link href={`/ingresar?volver=${encodeURIComponent(pathname)}`} className="text-sm underline">
            Inicia sesión para opinar
          </Link>
        )}
      </div>

      {sent && <p className="mt-4 rounded-lg bg-ok/10 px-4 py-3 text-sm text-ok">¡Gracias! Publicaremos tu reseña cuando la revisemos.</p>}
      {writing && (
        <ReviewForm
          productId={productId}
          onDone={() => {
            setWriting(false);
            setSent(true);
          }}
        />
      )}

      {!s || s.ratingCount === 0 ? (
        <p className="mt-4 text-sm text-ink-soft">Aún no hay reseñas. ¡Sé la primera persona en opinar!</p>
      ) : (
        <div className="mt-6 grid gap-10 lg:grid-cols-[280px_1fr]">
          <div>
            <p className="font-display text-5xl">{Number(s.ratingAvg).toFixed(1)}</p>
            <Stars value={Number(s.ratingAvg)} count={s.ratingCount} />
            <ul className="mt-4 space-y-1">
              {(['5', '4', '3', '2', '1'] as const).map((r) => (
                <li key={r}>
                  <button
                    type="button"
                    className={`flex w-full items-center gap-2 text-xs ${filter.rating === Number(r) ? 'font-semibold' : ''}`}
                    onClick={() => setFilter((f) => ({ ...f, rating: f.rating === Number(r) ? undefined : Number(r) }))}
                    aria-pressed={filter.rating === Number(r)}
                  >
                    <span className="w-6">{r}★</span>
                    <span className="h-2 flex-1 overflow-hidden rounded-full bg-sand">
                      <span className="block h-full bg-accent" style={{ width: `${(s.distribution[r] / max) * 100}%` }} />
                    </span>
                    <span className="w-6 text-right text-ink-soft">{s.distribution[r]}</span>
                  </button>
                </li>
              ))}
            </ul>
            {s.fit.small + s.fit.true + s.fit.large > 0 && (
              <div className="mt-5 text-xs">
                <p className="font-semibold">¿Cómo queda la talla?</p>
                {(Object.keys(FIT_LABEL) as Array<keyof typeof FIT_LABEL>).map((k) => (
                  <p key={k} className="text-ink-soft">
                    {FIT_LABEL[k]}: {s.fit[k]}
                  </p>
                ))}
              </div>
            )}
          </div>
          <div>
            <div className="flex flex-wrap gap-3 text-sm">
              <label className="flex items-center gap-2">
                <input type="checkbox" className="accent-ink" checked={filter.withPhotos} onChange={(e) => setFilter((f) => ({ ...f, withPhotos: e.target.checked }))} />
                Con fotos ({s.withPhotos})
              </label>
              <select className="rounded-full border border-line bg-white px-3 py-1" value={filter.sort} onChange={(e) => setFilter((f) => ({ ...f, sort: e.target.value }))} aria-label="Ordenar reseñas">
                <option value="recent">Más recientes</option>
                <option value="helpful">Más útiles</option>
                <option value="rating_desc">Mejor puntuadas</option>
                <option value="rating_asc">Peor puntuadas</option>
              </select>
            </div>
            <ul className="mt-4 divide-y divide-line">
              {data!.reviews.map((r) => (
                <li key={r.id} className="py-5">
                  <div className="flex flex-wrap items-center gap-2">
                    <Stars value={r.rating} small />
                    {r.title && <p className="font-medium">{r.title}</p>}
                  </div>
                  <p className="mt-1 text-xs text-ink-soft">
                    {r.author} · {formatDate(r.createdAt)}
                    {r.verifiedPurchase && <span className="ml-2 rounded bg-ok/10 px-1.5 py-0.5 text-ok">Compra verificada</span>}
                    {r.fitFeedback && <span className="ml-2">· {FIT_LABEL[r.fitFeedback]}</span>}
                  </p>
                  {r.body && <p className="mt-2 text-sm leading-relaxed">{r.body}</p>}
                  {r.photoCount > 0 && (
                    <ul className="mt-3 flex gap-2">
                      {Array.from({ length: r.photoCount }, (_, i) => (
                        <li key={i}>
                          <a href={`${BROWSER_API}/products/${productId}/reviews/${r.id}/photos/${i}`} target="_blank" rel="noreferrer">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={`${BROWSER_API}/products/${productId}/reviews/${r.id}/photos/${i}`} alt={`Foto ${i + 1} de la reseña`} className="h-20 w-20 rounded-lg object-cover" loading="lazy" />
                          </a>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
            {hasMore && (
              <button type="button" className="btn-ghost mt-2" onClick={more} disabled={loadingMore}>
                {loadingMore ? 'Cargando…' : 'Ver más reseñas'}
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

