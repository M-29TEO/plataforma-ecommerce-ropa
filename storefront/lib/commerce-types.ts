/** Tipos de carrito, checkout, cuenta y pedidos (contratos del backend). */

export interface UserProfile {
  id: string;
  tenantId: string;
  type: 'customer' | 'staff' | 'rider';
  email: string;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  locale: string;
  status: string;
  emailVerified: boolean;
  mfaEnabled: boolean;
  createdAt: string;
}

export interface MfaChallenge {
  mfaRequired?: true;
  mfaSetupRequired?: true;
  mfaToken: string;
  expiresIn: number;
}

export type LineIssue =
  | { code: 'UNAVAILABLE'; message: string }
  | { code: 'OUT_OF_STOCK'; message: string }
  | { code: 'INSUFFICIENT_STOCK'; message: string; available: number }
  | { code: 'PRICE_CHANGED'; message: string; previousPrice: string; currentPrice: string; direction: 'up' | 'down' };

export interface CartLine {
  variantId: string;
  productId: string | null;
  sku: string | null;
  productName: string | null;
  brandName: string | null;
  categoryPath: string | null;
  colorName: string | null;
  sizeCode: string | null;
  quantity: number;
  availableQuantity: number;
  unitPrice: string | null;
  priceAtAdd: string;
  compareAtPrice: string | null;
  subtotal: string | null;
  discount: string | null;
  taxRate: string | null;
  taxAmount: string | null;
  total: string | null;
  billable: boolean;
  issues: LineIssue[];
}

export interface CartView {
  id: string | null;
  guest: boolean;
  currency: string;
  contactEmail: string | null;
  items: CartLine[];
  coupons: Array<{ code: string; applied: boolean; discount: string | null; reason: string | null; message: string | null }>;
  promotions: Array<{ promotionId: string; name: string; type: string; couponCode: string | null; discount: string; freeShipping: boolean; shippingDiscount: string }>;
  hints: Array<{ promotionId: string; name: string; type: string; missing: string }>;
  totals: { itemCount: number; subtotal: string; discountTotal: string; taxableBase: string; taxTotal: string; total: string };
  freeShipping: boolean;
  shippingDiscount: string;
  hasPriceChanges: boolean;
  canCheckout: boolean;
}

export interface ProductThumb {
  id: string;
  slug: string;
  name: string;
  images: Array<{ url: string; alt: string | null; colorName: string | null }>;
}

export interface DeliverySlot {
  slotId: string;
  date: string;
  startsAt: string;
  endsAt: string;
  available: number;
  surcharge: string;
  price: string;
}

export interface DeliveryOption {
  quoteId: string;
  type: 'rider' | 'courier';
  price: string;
  label: string;
  source: string;
  etaHours: number | null;
  courier?: { code: string; name: string };
  service?: { code: string; name: string };
  distanceKm?: number;
  slots?: DeliverySlot[];
}

export interface DeliveryQuote {
  fulfillmentType: 'rider' | 'courier';
  reason: string | null;
  zone: { id: string; name: string; city: string; deliveryMode: string } | null;
  validUntil: string;
  options: DeliveryOption[];
}

export type PaymentMethod = 'card' | 'deuna' | 'pichincha' | 'qr' | 'transfer' | 'cod';

export type NextAction =
  | { type: 'redirect'; url: string }
  | { type: 'bank_transfer'; account: string; reference: string; expiresAt: string | null }
  | { type: 'cash_on_delivery' }
  | { type: 'none' };

export interface PublicPayment {
  id: string;
  orderId: string;
  method: string;
  status: 'pending' | 'requires_action' | 'authorized' | 'captured' | 'failed' | 'cancelled' | 'expired' | 'refunded' | 'partially_refunded';
  amount: string;
  currency: string;
  expiresAt: string | null;
  capturedAt: string | null;
  cardBrand: string | null;
  cardLast4: string | null;
  failureCode: string | null;
  failureMessage: string | null;
}

export interface PaymentCreated {
  payment: PublicPayment;
  clientSecret: string;
  nextAction: NextAction;
}

export interface CheckoutResult {
  orderId: string;
  orderNumber: string;
  status: string;
  paymentStatus: string;
  totals: { subtotal: string; discountTotal: string; taxTotal: string; shippingTotal: string; giftCardTotal: string; total: string };
  delivery: { fulfillmentType: string; shipmentId: string | null; trackingToken: string | null; zoneId: string | null; deliverySlotId: string | null };
  payment: PaymentCreated;
}

export interface Address {
  id: string;
  label: string | null;
  recipientName: string;
  recipientPhone: string;
  province: string;
  city: string;
  parish: string | null;
  neighborhood: string | null;
  mainStreet: string;
  crossStreet: string | null;
  houseNumber: string | null;
  reference: string | null;
  location: { lat: number; lng: number } | null;
  geocodeAccuracy: string | null;
  isDefault: boolean;
  needsPin: boolean;
  pinRecommended: boolean;
}

export interface GeocodeCandidate {
  lat: number;
  lng: number;
  accuracy: string;
  displayName: string;
}

export interface WishlistItem {
  productId: string;
  variantId: string | null;
  productName: string | null;
  slug: string | null;
  price: string | null;
  priceWithTax: string | null;
  inStock: boolean;
  available: boolean;
  notifyBackInStock: boolean;
  notifyPriceDrop: boolean;
  addedAt: string;
}

export type OrderStatus = 'created' | 'paid' | 'preparing' | 'shipped' | 'in_transit' | 'delivered' | 'cancelled' | 'partially_returned' | 'returned';

export interface OrderItem {
  id: string;
  variantId: string;
  productId: string;
  sku: string;
  productName: string;
  brandName: string | null;
  colorName: string | null;
  sizeCode: string | null;
  quantity: number;
  unitPrice: string;
  discount: string;
  taxAmount: string;
  lineTotal: string;
  /** Unidades ya devueltas (se registran al inspeccionar la devolución). */
  qtyReturned?: number;
}

export interface OrderSummary {
  id: string;
  orderNumber: string | null;
  status: OrderStatus;
  paymentStatus: string;
  paymentMethod: string;
  fulfillmentType: string;
  total: string;
  placedAt: string;
  itemCount: number;
  version: number;
}

export interface OrderDetail extends OrderSummary {
  customer: { name: string; email: string; phone?: string };
  shippingAddress: Record<string, unknown> | null;
  subtotal: string;
  discountTotal: string;
  shippingTotal: string;
  taxTotal: string;
  giftCardTotal: string;
  items: OrderItem[];
  history: Array<{ id: string; fromStatus: OrderStatus | null; toStatus: OrderStatus; actorType: string; reason: string | null; createdAt: string }>;
  deliveredAt: string | null;
  cancelReason: string | null;
}

export interface OrderShipment {
  id: string;
  direction: string;
  carrierType: string;
  status: string;
  trackingToken: string;
  deliveredAt: string | null;
}

export interface Review {
  id: string;
  rating: number;
  fitFeedback: 'small' | 'true' | 'large' | null;
  title: string | null;
  body: string | null;
  author: string;
  verifiedPurchase: boolean;
  photoCount: number;
  helpfulCount: number;
  createdAt: string;
}

export interface ReviewsPage {
  summary: {
    ratingAvg: string;
    ratingCount: number;
    distribution: Record<'1' | '2' | '3' | '4' | '5', number>;
    fit: { small: number; true: number; large: number };
    withPhotos: number;
    verified: number;
  };
  reviews: Review[];
}

export interface Question {
  id: string;
  body: string;
  createdAt: string;
  answers: Array<{ id: string; body: string; isOfficial: boolean; author: string; createdAt: string }>;
}

export interface Tracking {
  orderNumber: string | null;
  status: string;
  carrierType: string;
  direction: string;
  destination: { label: string; location: { lat: number; lng: number } | null };
  origin: { name: string; location: { lat: number; lng: number } } | null;
  slot: { startsAt: string; endsAt: string } | null;
  eta: string | null;
  deliveredAt: string | null;
  rider: { vehicleType: string; plate: string | null; ratingAvg: string; ratingCount: number } | null;
  riderPosition: { lat: number; lng: number; heading: number | null; speedKmh: number | null; recordedAt: string } | null;
  /** Código de 4 dígitos para recibir (solo mientras el motorizado lleva el paquete). */
  deliveryCode?: string | null;
  events: Array<{ status: string; description: string | null; occurredAt: string }>;
}
