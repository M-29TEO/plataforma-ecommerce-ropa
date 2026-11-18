'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { api, errorMessage, isApiError } from '@/lib/api/client';
import type { OrderDetail, OrderItem, ProductThumb } from '@/lib/commerce-types';
import {
  buildReturnBody,
  type CustomerReturn,
  type CustomerReturnDetail,
  type DraftErrors,
  emptyReturnDraft,
  exchangeSizeOptions,
  hasErrors,
  lineErrorFromApi,
  MAX_PHOTOS_PER_ITEM,
  openQuantities,
  PHOTO_REQUIRED_REASONS,
  PHOTO_TYPES,
  photoFileError,
  RESOLUTION_LABEL,
  RETURN_REASON_CODES,
  RETURN_REASON_LABEL,
  returnableQuantity,
  returnApiMessage,
  type ReturnDraft,
  type ReturnLineDraft,
  validateReturnDraft,
} from '@/lib/returns';
import type { ProductDetail } from '@/lib/types';

interface Props {
  order: OrderDetail;
  thumbs: Record<string, ProductThumb>;
  returns: CustomerReturn[];
  onCreated: (ret: CustomerReturnDetail) => void;
  onCancel: () => void;
}

/**
 * Solicitud de devolución o cambio de talla sobre un pedido entregado. Las fotos se suben una a una
 * (POST /me/returns/photos) y la solicitud lleva sus claves. Para el cambio, las tallas salen de la
 * ficha pública del producto (otras tallas del mismo color con stock).
 */
export function ReturnRequestForm({ order, thumbs, returns, onCreated, onCancel }: Props) {
  const uid = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<ReturnDraft>(() => emptyReturnDraft(order.items));
  const [errors, setErrors] = useState<DraftErrors>({ lines: {} });
  const [submitting, setSubmitting] = useState(false);
  const [uploading, setUploading] = useState<Record<string, boolean>>({});
  const [photoNames, setPhotoNames] = useState<Record<string, string>>({});
  const [products, setProducts] = useState<Record<string, ProductDetail | 'error'>>({});

  const available = useMemo(() => {
    const open = openQuantities(returns);
    return new Map(order.items.map((i) => [i.id, returnableQuantity(i, open)]));
  }, [order.items, returns]);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  // Cambio de talla: ficha del producto de cada línea elegida, para listar las tallas con stock.
  const exchangeProducts = draft.type === 'exchange' ? [...new Set(draft.lines.filter((l) => l.selected).map((l) => itemOf(order, l).productId))] : [];
  const missing = exchangeProducts.filter((id) => !products[id] && thumbs[id]).join(',');
  useEffect(() => {
    if (!missing) return;
    for (const productId of missing.split(',')) {
      api<ProductDetail>(`/catalog/products/${encodeURIComponent(thumbs[productId].slug)}`)
        .then((p) => setProducts((m) => ({ ...m, [productId]: p })))
        .catch(() => setProducts((m) => ({ ...m, [productId]: 'error' })));
    }
  }, [missing, thumbs]);

  function setLine(orderItemId: string, patch: Partial<ReturnLineDraft>) {
    setDraft((d) => ({ ...d, lines: d.lines.map((l) => (l.orderItemId === orderItemId ? { ...l, ...patch } : l)) }));
    setErrors((e) => {
      if (!e.lines[orderItemId] && !e.form) return e;
      const lines = { ...e.lines };
      delete lines[orderItemId];
      return { lines };
    });
  }

  async function addPhotos(line: ReturnLineDraft, files: FileList | null) {
    if (!files?.length) return;
    const room = MAX_PHOTOS_PER_ITEM - line.photos.length;
    const list = [...files].slice(0, Math.max(0, room));
    const fail = (msg: string) => setErrors((e) => ({ ...e, lines: { ...e.lines, [line.orderItemId]: { ...e.lines[line.orderItemId], photos: msg } } }));
    if (files.length > room) fail(`Máximo ${MAX_PHOTOS_PER_ITEM} fotos por producto.`);
    setUploading((u) => ({ ...u, [line.orderItemId]: true }));
    const keys: string[] = [];
    try {
      for (const file of list) {
        const invalid = photoFileError(file);
        if (invalid) {
          fail(`${file.name}: ${invalid}`);
          continue;
        }
        const form = new FormData();
        form.append('photo', file);
        try {
          const { key } = await api<{ key: string; contentType: string }>('/me/returns/photos', { method: 'POST', form });
          keys.push(key);
          setPhotoNames((n) => ({ ...n, [key]: file.name }));
        } catch (e) {
          fail(`${file.name}: ${errorMessage(e)}`);
        }
      }
    } finally {
      setUploading((u) => ({ ...u, [line.orderItemId]: false }));
    }
    if (keys.length) {
      setDraft((d) => ({
        ...d,
        lines: d.lines.map((l) => (l.orderItemId === line.orderItemId ? { ...l, photos: [...l.photos, ...keys].slice(0, MAX_PHOTOS_PER_ITEM) } : l)),
      }));
    }
  }

  function showErrors(next: DraftErrors) {
    setErrors(next);
    // El resumen se anuncia (role="alert") y recibe el foco para que el lector de pantalla lo lea.
    requestAnimationFrame(() => summaryRef.current?.focus());
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const found = validateReturnDraft(draft, available);
    if (hasErrors(found)) {
      showErrors({ ...found, form: found.form ?? 'Revisa los campos marcados.' });
      return;
    }
    setSubmitting(true);
    try {
      const created = await api<CustomerReturnDetail>(`/me/orders/${order.id}/returns`, { method: 'POST', body: buildReturnBody(draft) });
      onCreated(created);
    } catch (err) {
      const message = isApiError(err) ? returnApiMessage(err.code, err.message) : errorMessage(err);
      const line = isApiError(err) ? lineErrorFromApi(err.code, err.details) : null;
      showErrors(line ? { form: 'Revisa los campos marcados.', lines: { [line.orderItemId]: { [line.field]: message } } } : { form: message, lines: {} });
    } finally {
      setSubmitting(false);
    }
  }

  const busy = submitting || Object.values(uploading).some(Boolean);
  const errorCount = Object.values(errors.lines).reduce((n, e) => n + Object.keys(e).length, 0);

  return (
    <form className="card space-y-6 p-5" onSubmit={(e) => void submit(e)} noValidate aria-labelledby={`${uid}-title`}>
      <div>
        <h2 id={`${uid}-title`} ref={headingRef} tabIndex={-1} className="text-xl outline-none">
          Solicitar devolución o cambio
        </h2>
        <p className="mt-1 text-sm text-ink-soft">Elige los productos, el motivo y qué prefieres. Revisamos la solicitud y programamos el retiro.</p>
      </div>

      {(errors.form || errorCount > 0) && (
        <div ref={summaryRef} tabIndex={-1} role="alert" className="rounded-lg bg-danger/10 px-4 py-3 text-sm text-danger outline-none">
          {errors.form ?? 'Revisa los campos marcados.'}
          {errorCount > 0 && ` (${errorCount} ${errorCount === 1 ? 'campo' : 'campos'})`}
        </div>
      )}

      <fieldset>
        <legend className="label">¿Qué quieres hacer?</legend>
        <div className="mt-1 flex flex-wrap gap-4 text-sm">
          {(['return', 'exchange'] as const).map((t) => (
            <label key={t} className="flex items-center gap-2">
              <input type="radio" name={`${uid}-type`} value={t} checked={draft.type === t} onChange={() => setDraft((d) => ({ ...d, type: t }))} />
              {t === 'return' ? 'Devolver y recibir el dinero' : 'Cambiar por otra talla'}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="label">Productos</legend>
        {draft.lines.map((line) => (
          <ReturnLine
            key={line.orderItemId}
            uid={uid}
            line={line}
            item={itemOf(order, line)}
            thumb={thumbs[itemOf(order, line).productId]}
            max={available.get(line.orderItemId) ?? 0}
            exchange={draft.type === 'exchange'}
            product={products[itemOf(order, line).productId]}
            errors={errors.lines[line.orderItemId] ?? {}}
            uploading={!!uploading[line.orderItemId]}
            photoNames={photoNames}
            onChange={(patch) => setLine(line.orderItemId, patch)}
            onPhotos={(files) => void addPhotos(line, files)}
          />
        ))}
      </fieldset>

      {draft.type === 'return' && (
        <fieldset>
          <legend className="label">¿Cómo quieres el reembolso?</legend>
          <div className="mt-1 space-y-1 text-sm">
            {(['refund_original', 'store_credit'] as const).map((r) => (
              <label key={r} className="flex items-start gap-2">
                <input type="radio" className="mt-1" name={`${uid}-resolution`} value={r} checked={draft.resolution === r} onChange={() => setDraft((d) => ({ ...d, resolution: r }))} />
                <span>
                  {RESOLUTION_LABEL[r]}
                  <span className="block text-xs text-ink-soft">
                    {r === 'refund_original' ? 'Vuelve a la tarjeta o cuenta con la que pagaste.' : 'Te enviamos por email el código de una gift card para usar en la tienda.'}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      )}

      <div>
        <label className="label" htmlFor={`${uid}-notes`}>
          Comentarios (opcional)
        </label>
        <textarea
          id={`${uid}-notes`}
          className="input min-h-20"
          maxLength={1000}
          value={draft.customerNotes}
          onChange={(e) => setDraft((d) => ({ ...d, customerNotes: e.target.value }))}
        />
      </div>

      <div className="flex flex-wrap gap-2">
        <button type="submit" className="btn-primary" disabled={busy} aria-busy={submitting}>
          {submitting ? 'Enviando…' : 'Enviar solicitud'}
        </button>
        <button type="button" className="btn-ghost" onClick={onCancel} disabled={submitting}>
          Cancelar
        </button>
      </div>
    </form>
  );
}

function itemOf(order: OrderDetail, line: ReturnLineDraft): OrderItem {
  return order.items.find((i) => i.id === line.orderItemId)!;
}

interface LineProps {
  uid: string;
  line: ReturnLineDraft;
  item: OrderItem;
  thumb: ProductThumb | undefined;
  max: number;
  exchange: boolean;
  product: ProductDetail | 'error' | undefined;
  errors: Partial<Record<'quantity' | 'reasonCode' | 'exchangeVariantId' | 'photos', string>>;
  uploading: boolean;
  photoNames: Record<string, string>;
  onChange: (patch: Partial<ReturnLineDraft>) => void;
  onPhotos: (files: FileList | null) => void;
}

function ReturnLine({ uid, line, item, thumb, max, exchange, product, errors, uploading, photoNames, onChange, onPhotos }: LineProps) {
  const id = `${uid}-${item.id}`;
  const img = thumb?.images.find((m) => m.colorName === item.colorName) ?? thumb?.images[0];
  const sizes = product && product !== 'error' ? exchangeSizeOptions(product, item) : [];
  const photoRequired = !!line.reasonCode && PHOTO_REQUIRED_REASONS.has(line.reasonCode);
  const err = (field: keyof LineProps['errors']) =>
    errors[field] ? { 'aria-invalid': true as const, 'aria-describedby': `${id}-${field}-error` } : {};
  const errorText = (field: keyof LineProps['errors']) =>
    errors[field] && (
      <p id={`${id}-${field}-error`} className="mt-1 text-xs text-danger">
        {errors[field]}
      </p>
    );

  return (
    <div className={`rounded-lg border p-3 ${line.selected ? 'border-ink' : 'border-line'}`}>
      <label className="flex items-center gap-3">
        <input type="checkbox" checked={line.selected} disabled={max === 0} onChange={(e) => onChange({ selected: e.target.checked })} />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {img ? <img src={img.url} alt="" className="h-16 w-12 rounded object-cover" /> : <span className="h-16 w-12 rounded bg-sand" />}
        <span className="flex-1 text-sm">
          <span className="font-medium">{item.productName}</span>
          <span className="block text-xs text-ink-soft">
            {[item.colorName, item.sizeCode && `Talla ${item.sizeCode}`, max === 0 ? 'Ya devuelto o en una solicitud abierta' : `Puedes devolver ${max}`].filter(Boolean).join(' · ')}
          </span>
        </span>
      </label>

      {line.selected && (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor={`${id}-qty`}>
              Cantidad
            </label>
            <select id={`${id}-qty`} className="input" value={line.quantity} onChange={(e) => onChange({ quantity: Number(e.target.value) })} {...err('quantity')}>
              {Array.from({ length: Math.max(1, max) }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            {errorText('quantity')}
          </div>
          <div>
            <label className="label" htmlFor={`${id}-reason`}>
              Motivo
            </label>
            <select
              id={`${id}-reason`}
              className="input"
              value={line.reasonCode}
              required
              onChange={(e) => onChange({ reasonCode: e.target.value as ReturnLineDraft['reasonCode'] })}
              {...err('reasonCode')}
            >
              <option value="">Elige un motivo</option>
              {RETURN_REASON_CODES.map((r) => (
                <option key={r} value={r}>
                  {RETURN_REASON_LABEL[r]}
                </option>
              ))}
            </select>
            {errorText('reasonCode')}
          </div>

          {exchange && (
            <div className="sm:col-span-2">
              <label className="label" htmlFor={`${id}-size`}>
                Talla nueva
              </label>
              {product === undefined && thumb ? (
                <p className="text-sm text-ink-soft" role="status">
                  Cargando tallas…
                </p>
              ) : sizes.length === 0 ? (
                <p id={`${id}-exchangeVariantId-error`} className="text-sm text-danger">
                  {product === 'error' || !thumb ? 'No pudimos cargar las tallas de este producto.' : 'No hay otras tallas con stock: elige devolución.'}
                </p>
              ) : (
                <>
                  <select id={`${id}-size`} className="input" value={line.exchangeVariantId} required onChange={(e) => onChange({ exchangeVariantId: e.target.value })} {...err('exchangeVariantId')}>
                    <option value="">Elige la talla</option>
                    {sizes.map((s) => (
                      <option key={s.variantId} value={s.variantId}>
                        {s.size}
                        {s.stock === 'low' ? ' (últimas unidades)' : ''}
                      </option>
                    ))}
                  </select>
                  {errorText('exchangeVariantId')}
                </>
              )}
            </div>
          )}

          <div className="sm:col-span-2">
            <label className="label" htmlFor={`${id}-photos`}>
              Fotos {photoRequired ? '(obligatorias para este motivo)' : '(opcionales)'}
            </label>
            <p id={`${id}-photos-hint`} className="text-xs text-ink-soft">
              JPG, PNG o WEBP de hasta 5 MB, máximo {MAX_PHOTOS_PER_ITEM}. Si el producto llegó con fallas, muéstralas en la foto.
            </p>
            <input
              id={`${id}-photos`}
              type="file"
              accept={PHOTO_TYPES.join(',')}
              multiple
              className="mt-1 text-sm"
              disabled={uploading || line.photos.length >= MAX_PHOTOS_PER_ITEM}
              aria-describedby={[`${id}-photos-hint`, errors.photos && `${id}-photos-error`].filter(Boolean).join(' ')}
              aria-invalid={errors.photos ? true : undefined}
              onChange={(e) => {
                onPhotos(e.target.files);
                e.target.value = '';
              }}
            />
            <p role="status" className="text-xs text-ink-soft">
              {uploading ? 'Subiendo fotos…' : line.photos.length ? `${line.photos.length} ${line.photos.length === 1 ? 'foto adjunta' : 'fotos adjuntas'}` : ''}
            </p>
            {line.photos.length > 0 && (
              <ul className="mt-1 space-y-1 text-xs">
                {line.photos.map((key) => (
                  <li key={key} className="flex items-center gap-2">
                    <span className="truncate">{photoNames[key] ?? 'Foto'}</span>
                    <button
                      type="button"
                      className="underline"
                      aria-label={`Quitar ${photoNames[key] ?? 'foto'}`}
                      onClick={() => onChange({ photos: line.photos.filter((p) => p !== key) })}
                    >
                      Quitar
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {errorText('photos')}
          </div>
        </div>
      )}
    </div>
  );
}
