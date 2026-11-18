/**
 * Resumen comercial de un producto para otros módulos (wishlist del CRM): nombre, si se puede
 * vender y sus variantes con precio vigente. Montos sin IVA, como string ("19.90").
 */
export interface ProductOffer {
  productId: string;
  name: string;
  slug: string;
  taxCode: string;
  /** Producto activo y no borrado. */
  purchasable: boolean;
  variants: Array<{ variantId: string; price: string; purchasable: boolean }>;
}
