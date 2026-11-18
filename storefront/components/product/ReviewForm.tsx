'use client';

import { useState } from 'react';
import { api, errorMessage } from '@/lib/api/client';
import { useToast } from '../providers/ToastProvider';

const MAX_PHOTOS = 5;
const MAX_BYTES = 5 * 1024 * 1024;

/** Reseña con estrellas, calce de la talla y hasta 5 fotos (se suben antes y se envían sus claves). */
export function ReviewForm({ productId, onDone }: { productId: string; onDone: () => void }) {
  const toast = useToast();
  const [rating, setRating] = useState(0);
  const [fit, setFit] = useState<'' | 'small' | 'true' | 'large'>('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [photos, setPhotos] = useState<Array<{ key: string; preview: string }>>([]);
  const [uploading, setUploading] = useState(false);
  const [sending, setSending] = useState(false);

  async function upload(files: FileList | null) {
    if (!files) return;
    const list = [...files].slice(0, MAX_PHOTOS - photos.length);
    setUploading(true);
    try {
      for (const file of list) {
        if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
          toast(`${file.name}: solo JPG, PNG o WEBP`, 'error');
          continue;
        }
        if (file.size > MAX_BYTES) {
          toast(`${file.name}: máximo 5 MB`, 'error');
          continue;
        }
        const form = new FormData();
        form.append('photo', file);
        const res = await api<{ key: string }>('/me/reviews/photos', { method: 'POST', form });
        setPhotos((p) => [...p, { key: res.key, preview: URL.createObjectURL(file) }]);
      }
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      setUploading(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (rating === 0) {
      toast('Elige de 1 a 5 estrellas', 'error');
      return;
    }
    setSending(true);
    try {
      await api(`/products/${productId}/reviews`, {
        method: 'POST',
        body: {
          rating,
          ...(fit ? { fitFeedback: fit } : {}),
          ...(title.trim() ? { title: title.trim() } : {}),
          ...(body.trim() ? { body: body.trim() } : {}),
          ...(photos.length ? { photos: photos.map((p) => p.key) } : {}),
        },
      });
      onDone();
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      setSending(false);
    }
  }

  return (
    <form onSubmit={submit} className="card mt-6 space-y-4 p-5">
      <fieldset>
        <legend className="label">Tu calificación</legend>
        <div className="flex gap-1" role="radiogroup" aria-label="Estrellas">
          {[1, 2, 3, 4, 5].map((n) => (
            <button key={n} type="button" role="radio" aria-checked={rating === n} aria-label={`${n} estrellas`} onClick={() => setRating(n)} className={`text-3xl ${n <= rating ? 'text-accent' : 'text-line'}`}>
              ★
            </button>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend className="label">¿Cómo te quedó la talla?</legend>
        <div className="flex flex-wrap gap-2 text-sm">
          {(
            [
              ['small', 'Pequeña'],
              ['true', 'Justa'],
              ['large', 'Grande'],
            ] as const
          ).map(([v, l]) => (
            <label key={v} className={`chip cursor-pointer ${fit === v ? 'border-ink bg-ink text-paper' : ''}`}>
              <input type="radio" name="fit" className="sr-only" checked={fit === v} onChange={() => setFit(v)} />
              {l}
            </label>
          ))}
        </div>
      </fieldset>
      <div>
        <label className="label" htmlFor="rv-title">
          Título (opcional)
        </label>
        <input id="rv-title" className="input" maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div>
        <label className="label" htmlFor="rv-body">
          Tu opinión
        </label>
        <textarea id="rv-body" className="input min-h-28" maxLength={2000} value={body} onChange={(e) => setBody(e.target.value)} />
      </div>
      <div>
        <p className="label">Fotos (hasta {MAX_PHOTOS})</p>
        <div className="flex flex-wrap items-center gap-2">
          {photos.map((p) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={p.key} src={p.preview} alt="Foto adjunta" className="h-16 w-16 rounded-lg object-cover" />
          ))}
          {photos.length < MAX_PHOTOS && (
            <label className="btn-ghost cursor-pointer">
              {uploading ? 'Subiendo…' : 'Agregar fotos'}
              <input type="file" accept="image/jpeg,image/png,image/webp" multiple className="sr-only" disabled={uploading} onChange={(e) => void upload(e.target.files)} />
            </label>
          )}
        </div>
      </div>
      <button className="btn-primary" disabled={sending || uploading}>
        {sending ? 'Enviando…' : 'Publicar reseña'}
      </button>
      <p className="text-xs text-ink-soft">Las reseñas se revisan antes de publicarse. Si compraste el producto, se marca como compra verificada.</p>
    </form>
  );
}
