'use client';

import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { Fragment, useState } from 'react';
import { productKey, useLookups, useUnsavedChangesWarning } from '@/components/catalogo/hooks';
import { MoneyCell, VariantPriceRows, type VariantRowInfo, variantLabel } from '@/components/catalogo/PriceCells';
import { useToast } from '@/components/providers/ToastProvider';
import { StatusBadge } from '@/components/ui/Badge';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { EmptyState, QueryState } from '@/components/ui/States';
import { api, errorMessage, isApiError } from '@/lib/api/client';
import {
  type AdminProductDetail,
  type AdminProductListItem,
  applyPriceTool,
  type InheritedPriceConflict,
  inheritedPriceConflict,
  buildPriceBatches,
  type BulkPricesResult,
  categoryOptions,
  draftError,
  MAX_PRICE_ROWS,
  normalizeMoney,
  parseMoney,
  type PriceDraft,
  type PricePair,
  type PriceTool,
  PRODUCT_STATUS,
  type ProductPriceDraft,
  samePair,
} from '@/lib/catalog';
import { formatInt, formatMoney } from '@/lib/format';
import { useDebounced } from '@/lib/hooks';
import type { Page } from '@/lib/types';

const LIMIT = 50;
const COLS = 5;

type ToolKind = 'set' | 'up' | 'down' | 'discount' | 'setCompareAt' | 'clearCompareAt';
const TOOL_LABEL: Record<ToolKind, string> = {
  set: 'Fijar precio',
  up: 'Subir %',
  down: 'Bajar %',
  discount: 'Rebaja % (el precio actual pasa a tachado)',
  setCompareAt: 'Poner precio tachado',
  clearCompareAt: 'Quitar precio tachado',
};

/** Producto seleccionado: lo necesario para aplicarle una herramienta aunque cambie la página. */
interface ProductRowInfo {
  id: string;
  label: string;
  original: PricePair;
}

function productInfo(p: AdminProductListItem): ProductRowInfo {
  return { id: p.id, label: p.name, original: { price: normalizeMoney(p.basePrice), compareAtPrice: normalizeMoney(p.compareAtPrice) } };
}

/**
 * Precios masivos: edición en línea de precio base/tachado de productos y de cada variante,
 * herramienta "aplicar a seleccionados", vista previa y guardado con PATCH /catalog/admin/prices
 * en lotes de ≤ 200 filas (todo o nada por lote).
 */
export default function PricesPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const lookups = useLookups();
  const [search, setSearch] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [offset, setOffset] = useState(0);
  const q = useDebounced(search.trim(), 350);

  const [drafts, setDrafts] = useState<Record<string, PriceDraft>>({});
  const [selProducts, setSelProducts] = useState<Record<string, ProductRowInfo>>({});
  const [selVariants, setSelVariants] = useState<Record<string, VariantRowInfo>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [tool, setTool] = useState<ToolKind>('discount');
  const [toolValue, setToolValue] = useState('');
  const [preview, setPreview] = useState(false);
  const [saving, setSaving] = useState<{ done: number; total: number } | null>(null);
  const [saveReport, setSaveReport] = useState<string | null>(null);
  /** Último 422 por variantes que heredan con rebaja falsa (para marcarlas y ofrecer el arreglo). */
  const [conflict, setConflict] = useState<(InheritedPriceConflict & { productLabel: string }) | null>(null);
  const [fixing, setFixing] = useState(false);

  const query = { q: q || undefined, categoryId, limit: LIMIT, offset };
  const products = useQuery({
    queryKey: ['catalog', 'products', query],
    queryFn: ({ signal }) => api<Page<AdminProductListItem>>('/catalog/admin/products', { query, signal }),
    placeholderData: keepPreviousData,
  });

  const draftList = Object.values(drafts);
  const productDrafts = new Map(draftList.filter((d): d is ProductPriceDraft => d.kind === 'product').map((d) => [d.id, d]));
  const errors = new Map(draftList.map((d) => [d.id, draftError(d, productDrafts)] as const).filter(([, e]) => e !== null) as [string, string][]);
  const pending = draftList.length;
  const selectedCount = Object.keys(selProducts).length + Object.keys(selVariants).length;

  useUnsavedChangesWarning(pending > 0);

  // ── Cambios ──
  const productCurrent = (info: ProductRowInfo): PricePair => drafts[info.id]?.after ?? info.original;
  const variantCurrent = (info: VariantRowInfo): PricePair => drafts[info.id]?.after ?? info.original;
  const inheritedFor = (productId: string, fallback: string): string => productDrafts.get(productId)?.after.price ?? fallback;

  function setProductDraft(next: Record<string, PriceDraft>, info: ProductRowInfo, after: PricePair) {
    const before = next[info.id]?.before ?? info.original;
    if (samePair(before, after)) delete next[info.id];
    else next[info.id] = { kind: 'product', id: info.id, label: info.label, before, after };
  }
  function setVariantDraft(next: Record<string, PriceDraft>, info: VariantRowInfo, after: PricePair) {
    const prev = next[info.id];
    const before = prev?.before ?? info.original;
    if (samePair(before, after)) delete next[info.id];
    else
      next[info.id] = {
        kind: 'variant',
        id: info.id,
        productId: info.productId,
        label: info.label,
        productBasePrice: prev?.kind === 'variant' ? prev.productBasePrice : info.productBasePrice,
        before,
        after,
      };
  }

  const changeProduct = (info: ProductRowInfo, after: PricePair) =>
    setDrafts((d) => {
      const next = { ...d };
      setProductDraft(next, info, after);
      return next;
    });
  const changeVariant = (info: VariantRowInfo, after: PricePair) =>
    setDrafts((d) => {
      const next = { ...d };
      setVariantDraft(next, info, after);
      return next;
    });

  // ── Herramienta ──
  const needsMoney = tool === 'set' || tool === 'setCompareAt';
  const needsPercent = tool === 'up' || tool === 'down' || tool === 'discount';
  const pct = Number(toolValue.replace(',', '.'));
  const toolInvalid = needsMoney ? parseMoney(toolValue) === null : needsPercent ? !(pct > 0 && pct < (tool === 'up' ? 1000 : 100)) : false;

  function buildTool(): PriceTool {
    if (tool === 'set') return { kind: 'set', value: toolValue };
    if (tool === 'setCompareAt') return { kind: 'setCompareAt', value: toolValue };
    if (tool === 'clearCompareAt') return { kind: 'clearCompareAt' };
    if (tool === 'discount') return { kind: 'discount', percent: pct };
    return { kind: 'percent', percent: tool === 'up' ? pct : -pct };
  }

  function applyTool() {
    const t = buildTool();
    setDrafts((d) => {
      const next = { ...d };
      for (const info of Object.values(selProducts)) setProductDraft(next, info, applyPriceTool(next[info.id]?.after ?? info.original, t));
      // Las variantes se calculan después: si heredan, usan el precio NUEVO del producto.
      for (const info of Object.values(selVariants)) {
        const inherited = (next[info.productId]?.after.price ?? null) || info.productBasePrice;
        setVariantDraft(next, info, applyPriceTool(next[info.id]?.after ?? info.original, t, inherited));
      }
      return next;
    });
    toast.info(`${TOOL_LABEL[tool]} aplicado a ${selectedCount} fila(s). Revisa la vista previa antes de guardar.`);
  }

  // ── Guardado ──
  async function saveAll(list: PriceDraft[] = draftList) {
    const batches = buildPriceBatches(list);
    if (batches.length === 0) return;
    const byId = new Map(list.map((d) => [d.id, d]));
    setSaveReport(null);
    setConflict(null);
    setSaving({ done: 0, total: batches.length });
    let savedRows = 0;
    let changed = 0;
    for (const [i, b] of batches.entries()) {
      try {
        const res = await api<BulkPricesResult>('/catalog/admin/prices', { method: 'PATCH', body: b.body });
        savedRows += b.ids.length;
        changed += res.products.length + res.variants.length;
        setDrafts((d) => {
          const next = { ...d };
          for (const id of b.ids) delete next[id];
          return next;
        });
        setSaving({ done: i + 1, total: batches.length });
      } catch (e) {
        const heirs = isApiError(e, 'INVALID_PRICE') ? inheritedPriceConflict(e.details) : null;
        const badId = heirs?.productId || (isApiError(e) ? String(e.details.id ?? '') : '');
        const bad = badId ? byId.get(badId)?.label : undefined;
        const reason = heirs
          ? `${heirs.variantIds.length} variante(s) que heredan el precio nuevo (${formatMoney(heirs.basePrice)}) quedarían con el tachado igual o menor (rebaja falsa).`
          : errorMessage(e);
        const report =
          (i > 0 ? `Se guardaron los lotes 1 a ${i} (${formatInt(savedRows)} filas). ` : 'No se guardó ningún cambio. ') +
          `Falló el lote ${i + 1} de ${batches.length}${bad ? ` en "${bad}"` : ''}: ${reason} Los cambios de ese lote y los siguientes siguen pendientes.`;
        if (heirs) {
          setConflict({ ...heirs, productLabel: bad ?? '' });
          setExpanded((s) => new Set(s).add(heirs.productId));
        }
        setSaveReport(report);
        toast.error(report);
        break;
      }
    }
    setSaving(null);
    if (savedRows > 0) {
      await qc.invalidateQueries({ queryKey: ['catalog'] });
      if (savedRows === list.length) {
        toast.ok(`Precios guardados (${formatInt(changed)} con cambios reales)`);
        setPreview(false);
        setSelProducts({});
        setSelVariants({});
      }
    }
  }

  /**
   * Arreglo del 422 con details.variantIds: agrega esas variantes al lote con compareAtPrice null
   * (viajan junto a su producto, así el API las valida con el precio nuevo) y reintenta.
   */
  async function clearHeirsCompareAtAndRetry() {
    if (!conflict) return;
    setFixing(true);
    try {
      const detail = await qc.fetchQuery({
        queryKey: productKey(conflict.productId),
        queryFn: ({ signal }) => api<AdminProductDetail>(`/catalog/admin/products/${conflict.productId}`, { signal }),
        staleTime: 0,
      });
      const next = { ...drafts };
      const base = normalizeMoney(detail.basePrice) ?? '0.00';
      for (const v of detail.variants.filter((x) => conflict.variantIds.includes(x.id))) {
        const info: VariantRowInfo = {
          id: v.id,
          productId: detail.id,
          label: variantLabel(detail.name, v),
          productBasePrice: base,
          original: { price: normalizeMoney(v.price), compareAtPrice: normalizeMoney(v.compareAtPrice) },
        };
        setVariantDraft(next, info, { ...(next[v.id]?.after ?? info.original), compareAtPrice: null });
      }
      setDrafts(next);
      await saveAll(Object.values(next));
    } catch (e) {
      toast.error(e);
    } finally {
      setFixing(false);
    }
  }

  const conflictIds = new Set(conflict?.variantIds ?? []);
  const conflictBox = conflict && (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-sm" role="alert">
      <p>
        {conflict.productLabel ? <span className="font-medium">{conflict.productLabel}: </span> : null}
        {formatInt(conflict.variantIds.length)} variante(s) heredan el precio {formatMoney(conflict.basePrice)} y tienen un tachado igual o menor. Están marcadas en la tabla.
      </p>
      <button className="btn-danger btn-sm" onClick={() => void clearHeirsCompareAtAndRetry()} disabled={fixing || !!saving}>
        {fixing ? 'Corrigiendo…' : 'Quitar el tachado de esas variantes y reintentar'}
      </button>
    </div>
  );
  const batchesCount = buildPriceBatches(draftList).length;

  return (
    <div>
      <PageHeader
        title="Precios"
        description="Precio base y tachado por producto o variante, con cambios en lote"
        back={{ href: '/catalogo/productos', label: 'Productos' }}
        actions={
          <>
            {pending > 0 && (
              <button className="btn-ghost" onClick={() => setDrafts({})} disabled={!!saving}>
                Descartar
              </button>
            )}
            <button className="btn-primary" onClick={() => setPreview(true)} disabled={pending === 0}>
              Revisar y guardar{pending > 0 && ` (${formatInt(pending)})`}
            </button>
          </>
        }
      />

      <div className="card mb-4 grid gap-3 p-3 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="pr-q">Buscar</label>
          <input
            id="pr-q"
            type="search"
            className="input"
            placeholder="Nombre, slug, SKU o código de barras"
            maxLength={100}
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setOffset(0);
            }}
          />
        </div>
        <div>
          <label className="label" htmlFor="pr-cat">Categoría</label>
          <select
            id="pr-cat"
            className="input"
            value={categoryId}
            onChange={(e) => {
              setCategoryId(e.target.value);
              setOffset(0);
            }}
          >
            <option value="">Todas</option>
            {categoryOptions(lookups.data?.categories ?? []).map((c) => (
              <option key={c.id} value={c.id}>{c.label}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="card mb-4 flex flex-wrap items-end gap-3 p-3">
        <div className="text-sm">
          <span className="font-semibold">{formatInt(selectedCount)}</span> seleccionada(s)
          {selectedCount > 0 && (
            <button
              className="ml-2 text-xs text-ink-soft underline"
              onClick={() => {
                setSelProducts({});
                setSelVariants({});
              }}
            >
              limpiar
            </button>
          )}
          <p className="text-xs text-ink-soft">Despliega un producto para elegir variantes.</p>
        </div>
        <div className="min-w-56">
          <label className="label" htmlFor="pr-tool">Aplicar a seleccionados</label>
          <select id="pr-tool" className="input" value={tool} onChange={(e) => setTool(e.target.value as ToolKind)}>
            {(Object.keys(TOOL_LABEL) as ToolKind[]).map((k) => (
              <option key={k} value={k}>{TOOL_LABEL[k]}</option>
            ))}
          </select>
        </div>
        {(needsMoney || needsPercent) && (
          <div className="w-32">
            <label className="label" htmlFor="pr-val">{needsMoney ? 'Monto (USD)' : 'Porcentaje'}</label>
            <input id="pr-val" className="input num" inputMode="decimal" placeholder={needsMoney ? '0.00' : '20'} value={toolValue} onChange={(e) => setToolValue(e.target.value)} />
          </div>
        )}
        <button className="btn-accent" onClick={applyTool} disabled={selectedCount === 0 || toolInvalid}>
          Aplicar
        </button>
        <p className="w-full text-xs text-ink-soft">
          Los montos se redondean a 2 decimales. Una variante que hereda recibe precio propio al subir o bajar %. La rebaja conserva el tachado si ya tenía uno.
        </p>
      </div>

      {pending > 0 && (
        <p className="mb-3 rounded-md border border-warn/30 bg-warn/10 px-3 py-2 text-sm" role="status">
          {formatInt(pending)} cambio(s) sin guardar{errors.size > 0 && <span className="text-danger"> · {formatInt(errors.size)} con error</span>}.
        </p>
      )}

      {!preview && conflictBox}

      <QueryState query={products} loading="Cargando productos…">
        {(page) =>
          page.items.length === 0 ? (
            <EmptyState title="No hay productos con esos filtros" />
          ) : (
            <>
              <div className={`card overflow-x-auto ${products.isPlaceholderData ? 'opacity-60' : ''}`}>
                <table className="table-base min-w-[640px]">
                  <thead>
                    <tr>
                      <th className="w-8">
                        <input
                          type="checkbox"
                          aria-label="Seleccionar los productos de esta página"
                          checked={page.items.every((p) => selProducts[p.id])}
                          onChange={(e) =>
                            setSelProducts((s) => {
                              const next = { ...s };
                              for (const p of page.items) {
                                if (e.target.checked) next[p.id] = productInfo(p);
                                else delete next[p.id];
                              }
                              return next;
                            })
                          }
                        />
                      </th>
                      <th>Producto</th>
                      <th className="num">Precio base</th>
                      <th className="num">Tachado</th>
                      <th className="num">Variantes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {page.items.map((p) => {
                      const info = productInfo(p);
                      const cur = productCurrent(info);
                      const open = expanded.has(p.id);
                      const err = errors.get(p.id);
                      return (
                        <Fragment key={p.id}>
                          <tr>
                            <td>
                              <input
                                type="checkbox"
                                aria-label={`Seleccionar ${p.name}`}
                                checked={!!selProducts[p.id]}
                                onChange={(e) =>
                                  setSelProducts((s) => {
                                    const next = { ...s };
                                    if (e.target.checked) next[p.id] = info;
                                    else delete next[p.id];
                                    return next;
                                  })
                                }
                              />
                            </td>
                            <td>
                              <button
                                type="button"
                                className="mr-1.5 inline-block w-4 text-ink-soft"
                                aria-expanded={open}
                                aria-label={open ? 'Ocultar variantes' : 'Ver variantes'}
                                onClick={() =>
                                  setExpanded((s) => {
                                    const next = new Set(s);
                                    if (open) next.delete(p.id);
                                    else next.add(p.id);
                                    return next;
                                  })
                                }
                              >
                                {open ? '▾' : '▸'}
                              </button>
                              <Link href={`/catalogo/productos/${p.id}`} prefetch={false} className="font-medium hover:text-accent">{p.name}</Link>{' '}
                              <StatusBadge status={p.status} map={PRODUCT_STATUS} />
                              <div className="pl-6 text-xs text-ink-soft">{p.category.name}</div>
                              {err && <p className="pl-6 text-xs text-danger">{err}</p>}
                            </td>
                            <td className="num">
                              <MoneyCell
                                key={`p:${cur.price}`}
                                label={`Precio base de ${p.name}`}
                                value={cur.price}
                                allowEmpty={false}
                                changed={cur.price !== info.original.price}
                                onCommit={(price) => changeProduct(info, { ...cur, price })}
                              />
                            </td>
                            <td className="num">
                              <MoneyCell
                                key={`c:${cur.compareAtPrice}`}
                                label={`Tachado de ${p.name}`}
                                value={cur.compareAtPrice}
                                placeholder="—"
                                changed={cur.compareAtPrice !== info.original.compareAtPrice}
                                onCommit={(compareAtPrice) => changeProduct(info, { ...cur, compareAtPrice })}
                              />
                            </td>
                            <td className="num">{formatInt(p.variantCount)}</td>
                          </tr>
                          {open && (
                            <VariantPriceRows
                              productId={p.id}
                              productName={p.name}
                              inheritedPrice={inheritedFor(p.id, info.original.price ?? '0.00')}
                              colSpan={COLS}
                              current={variantCurrent}
                              isSelected={(id) => !!selVariants[id]}
                              onToggle={(vi, on) =>
                                setSelVariants((s) => {
                                  const next = { ...s };
                                  if (on) next[vi.id] = vi;
                                  else delete next[vi.id];
                                  return next;
                                })
                              }
                              onToggleAll={(infos, on) =>
                                setSelVariants((s) => {
                                  const next = { ...s };
                                  for (const vi of infos) {
                                    if (on) next[vi.id] = vi;
                                    else delete next[vi.id];
                                  }
                                  return next;
                                })
                              }
                              onChange={changeVariant}
                              errorOf={(id) =>
                                errors.get(id) ??
                                (conflictIds.has(id) && drafts[id]?.after.compareAtPrice !== null
                                  ? 'Hereda el precio nuevo y su tachado quedaría igual o menor (rebaja falsa)'
                                  : null)
                              }
                            />
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <Pagination total={page.total} limit={LIMIT} offset={offset} onChange={setOffset} />
            </>
          )
        }
      </QueryState>

      <Modal
        open={preview}
        onClose={() => !saving && setPreview(false)}
        title={`Vista previa: ${formatInt(pending)} cambio(s)`}
        size="xl"
        footer={
          <>
            <button className="btn-ghost" onClick={() => setPreview(false)} disabled={!!saving}>
              Seguir editando
            </button>
            <button className="btn-primary" onClick={() => void saveAll()} disabled={!!saving || pending === 0 || errors.size > 0}>
              {saving ? `Guardando lote ${saving.done + 1}/${saving.total}…` : 'Guardar precios'}
            </button>
          </>
        }
      >
        {errors.size > 0 && (
          <p className="mb-3 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger" role="alert">
            Corrige las {formatInt(errors.size)} fila(s) con error antes de guardar (el precio tachado debe ser mayor que el precio de venta).
          </p>
        )}
        {saveReport && (
          <p className="mb-3 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm" role="alert">{saveReport}</p>
        )}
        {conflictBox}
        {batchesCount > 1 && (
          <p className="mb-3 text-xs text-ink-soft">
            Se guardará en {batchesCount} lotes de hasta {MAX_PRICE_ROWS} filas; cada lote es todo o nada.
          </p>
        )}
        {pending === 0 ? (
          <p className="text-sm text-ink-soft">No hay cambios pendientes.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead>
                <tr>
                  <th>Fila</th>
                  <th className="num">Precio</th>
                  <th className="num">Tachado</th>
                </tr>
              </thead>
              <tbody>
                {draftList.map((d) => {
                  const err = errors.get(d.id);
                  const inherit = d.kind === 'variant' ? `hereda (${formatMoney(inheritedFor(d.productId, d.productBasePrice))})` : '—';
                  return (
                    <tr key={d.id} className={err ? 'bg-danger/5' : ''}>
                      <td>
                        <span className="text-xs text-ink-soft">{d.kind === 'product' ? 'Producto' : 'Variante'}</span>
                        <div className="font-medium">{d.label}</div>
                        {err && <p className="text-xs text-danger">{err}</p>}
                      </td>
                      <td className="num whitespace-nowrap">
                        <Change before={d.before.price} after={d.after.price} empty={inherit} />
                      </td>
                      <td className="num whitespace-nowrap">
                        <Change before={d.before.compareAtPrice} after={d.after.compareAtPrice} empty="—" />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Modal>
    </div>
  );
}

/** "antes → después" (o solo el valor si no cambió). */
function Change({ before, after, empty }: { before: string | null; after: string | null; empty: string }) {
  const fmt = (v: string | null) => (v === null ? empty : formatMoney(v));
  if (before === after) return <span className="text-ink-soft">{fmt(after)}</span>;
  return (
    <span>
      <span className="text-ink-soft line-through">{fmt(before)}</span> → <span className="font-semibold">{fmt(after)}</span>
    </span>
  );
}
