/**
 * Lo que otros módulos (Carrito, Checkout) necesitan saber de una variante para venderla:
 * precio vigente, código de IVA y los datos descriptivos que Pedidos guarda como snapshot.
 * Montos numeric(12,2) como string ("19.90"), precios SIN IVA.
 */
export interface SellableVariant {
  variantId: string;
  productId: string;
  sku: string;
  productName: string;
  brandId: string | null;
  brandName: string | null;
  categoryId: string;
  categoryPath: string;
  colorName: string | null;
  sizeCode: string | null;
  /** Precio de la variante o, si no tiene, el base_price del producto. */
  price: string;
  compareAtPrice: string | null;
  /** Código de porcentaje de IVA del SRI (4 = 15 %). */
  taxCode: string;
  unitCost: string | null;
  weightG: number;
  /** Dimensiones del paquete de la variante (mm), para el peso volumétrico del envío. */
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
  /** Producto activo, no borrado y variante activa. */
  purchasable: boolean;
}
