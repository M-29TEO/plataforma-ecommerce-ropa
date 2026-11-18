import type { Media, ProductDetail, StockLevel, Variant } from './types';

/** Fotos del color elegido (y las que no tienen color, comunes a todos); si no hay, todas. */
export function imagesForColor(media: Media[], color: string | null): Media[] {
  if (!color) return media;
  const own = media.filter((m) => m.colorName === color || m.colorName === null);
  return own.length > 0 ? own : media;
}

export function findVariant(p: Pick<ProductDetail, 'variants'>, color: string | null, size: string | null): Variant | undefined {
  return p.variants.find((v) => (v.color?.name ?? null) === color && (v.size ?? null) === size);
}

/** Stock de cada talla para el color elegido (las que no existen en ese color no aparecen). */
export function sizeAvailability(p: Pick<ProductDetail, 'variants' | 'sizes'>, color: string | null): Array<{ size: string; stock: StockLevel | null }> {
  return p.sizes.map((size) => ({ size, stock: findVariant(p, color, size)?.stock ?? null }));
}

/** Color inicial: el primero que tenga alguna talla con stock. */
export function initialColor(p: Pick<ProductDetail, 'variants' | 'colors'>): string | null {
  if (p.colors.length === 0) return null;
  const withStock = p.colors.find((c) => p.variants.some((v) => v.color?.name === c.name && v.stock !== 'out_of_stock'));
  return (withStock ?? p.colors[0]).name;
}

/** Consejo de talla según las reseñas: "suele quedar pequeño, pide una talla más". */
export function fitAdvice(fit: { small: number; true: number; large: number } | null): string | null {
  if (!fit) return null;
  const total = fit.small + fit.true + fit.large;
  if (total < 3) return null;
  const pct = (n: number) => Math.round((n / total) * 100);
  if (fit.small / total >= 0.5) return `El ${pct(fit.small)} % dice que queda pequeño: considera una talla más.`;
  if (fit.large / total >= 0.5) return `El ${pct(fit.large)} % dice que queda grande: considera una talla menos.`;
  return `El ${pct(fit.true)} % dice que la talla es la correcta.`;
}
