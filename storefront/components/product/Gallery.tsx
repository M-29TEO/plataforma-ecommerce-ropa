'use client';

import { useEffect, useState } from 'react';
import type { Media } from '@/lib/types';
import { ProductImage } from '../catalog/ProductImage';

/** Galería: foto principal, miniaturas y vista ampliada (teclado: flechas y Escape). */
export function Gallery({ images, name }: { images: Media[]; name: string }) {
  const [index, setIndex] = useState(0);
  const [zoom, setZoom] = useState(false);
  const current = images[Math.min(index, images.length - 1)];

  useEffect(() => {
    if (!zoom) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setZoom(false);
      if (e.key === 'ArrowRight') setIndex((i) => (i + 1) % images.length);
      if (e.key === 'ArrowLeft') setIndex((i) => (i - 1 + images.length) % images.length);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoom, images.length]);

  if (images.length === 0) return <div className="aspect-[4/5] rounded-[var(--radius-card)] bg-sand" />;

  return (
    <div className="flex flex-col-reverse gap-3 sm:flex-row">
      <ul className="flex gap-2 overflow-x-auto sm:flex-col" aria-label="Fotos">
        {images.map((m, i) => (
          <li key={m.url} className="shrink-0">
            <button
              type="button"
              onClick={() => setIndex(i)}
              aria-label={`Ver foto ${i + 1}`}
              aria-current={i === index}
              className={`block w-16 overflow-hidden rounded-lg border-2 sm:w-20 ${i === index ? 'border-ink' : 'border-transparent'}`}
            >
              <ProductImage src={m.url} alt="" sizes="80px" />
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className="relative flex-1 cursor-zoom-in overflow-hidden rounded-[var(--radius-card)] bg-sand" onClick={() => setZoom(true)} aria-label="Ampliar foto">
        <ProductImage src={current.url} alt={current.alt ?? name} preload sizes="(min-width: 1024px) 50vw, 100vw" />
      </button>
      {zoom && (
        <div role="dialog" aria-modal="true" aria-label={`Fotos de ${name}`} className="fixed inset-0 z-50 flex items-center justify-center bg-ink/90 p-4" onClick={() => setZoom(false)}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={current.url} alt={current.alt ?? name} className="max-h-full max-w-full rounded-lg object-contain" onClick={(e) => e.stopPropagation()} />
          <button type="button" className="absolute right-4 top-4 text-3xl text-white" aria-label="Cerrar">
            ✕
          </button>
          {images.length > 1 && (
            <>
              <button type="button" aria-label="Anterior" className="absolute left-4 text-4xl text-white" onClick={(e) => (e.stopPropagation(), setIndex((i) => (i - 1 + images.length) % images.length))}>
                ‹
              </button>
              <button type="button" aria-label="Siguiente" className="absolute right-4 text-4xl text-white" onClick={(e) => (e.stopPropagation(), setIndex((i) => (i + 1) % images.length))}>
                ›
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
