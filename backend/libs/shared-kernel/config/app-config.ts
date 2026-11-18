import { createHmac } from 'node:crypto';

/**
 * Configuración leída de variables de entorno. Un único lugar para defaults y validación.
 */
export interface AppConfig {
  databaseUrl: string;
  databasePoolMax: number;
  valkeyUrl: string;
  jwtSecret: string;
  port: number;
  /** Tiempo de vida de una reserva de stock si el llamador no indica otro. */
  reservationTtlSeconds: number;
  /** Días que vive el carrito de invitado (y su cookie) sin actividad. */
  guestCartTtlDays: number;
  /** Cookie del carrito con atributo Secure (solo HTTPS). Por defecto, true salvo NODE_ENV=development|test. */
  secureCookies: boolean;
  /** Cada cuánto corre el cron de recordatorios de carrito abandonado. */
  cartReminderEveryMs: number;
  payments: PaymentsConfig;
  logistics: LogisticsConfig;
  billing: BillingConfig;
  aftersales: AftersalesConfig;
  notifications: NotificationsConfig;
  crm: CrmConfig;
  catalog: CatalogConfig;
  support: SupportConfig;
  reports: ReportsConfig;
  iam: IamConfig;
  security: SecurityConfig;
  realtime: RealtimeConfig;
}

/** Tiempo real (ADR-07): gateway Socket.IO con adaptador Valkey. */
export interface RealtimeConfig {
  /** valkey: publica por el adaptador de Socket.IO; memory: solo tests. */
  transport: 'valkey' | 'memory';
  /** Puerto del proceso realtime (Caddy enruta /ws/* aquí). */
  port: number;
  /** Ruta del handshake de Socket.IO (detrás de Caddy, bajo /ws). */
  path: string;
}

/** Borde HTTP (helmet, CORS, proxy), rate limiting y cifrado de campos *_enc. Ver docs/07-seguridad.md. */
export interface SecurityConfig {
  /** Orígenes permitidos por CORS (CORS_ORIGINS, separados por coma). Vacío = ningún origen cruzado. */
  corsOrigins: string[];
  /** Valor de `trust proxy` de Express: qué saltos se aceptan en X-Forwarded-For para req.ip. */
  trustProxy: string;
  /** Tope del cuerpo JSON/urlencoded (las subidas multipart tienen sus propios límites). */
  bodyLimit: string;
  rateLimit: {
    enabled: boolean;
    /** valkey: contadores compartidos entre réplicas de la API. memory: un solo proceso (desarrollo). */
    storage: 'valkey' | 'memory';
  };
  /** Clave de 32 bytes de crypto_secretbox para los campos *_enc (DATA_ENCRYPTION_KEY en base64). */
  dataEncryptionKey: Buffer;
  /** Clave anterior (rotación): se usa solo para descifrar lo que aún no se recifró. */
  dataEncryptionKeyPrevious: Buffer | null;
  /** true si la clave se derivó de JWT_SECRET porque faltaba DATA_ENCRYPTION_KEY (solo desarrollo). */
  dataEncryptionKeyDerived: boolean;
}

/** IAM: sesiones (refresh tokens), 2FA TOTP y versión de las políticas LOPDP. */
export interface IamConfig {
  /** Vigencia de cada refresh token (se renueva al rotar). */
  refreshTtlDays: number;
  /** Path de la cookie refresh_token tal como la ve el navegador (detrás de Caddy: /api/v1/auth). */
  refreshCookiePath: string;
  /** HMAC del mfaToken (paso intermedio del login). Por defecto se deriva de JWT_SECRET. */
  mfaChallengeSecret: string;
  /** Clave de 32 bytes de crypto_secretbox para mfa_secret_enc (MFA_ENCRYPTION_KEY en base64). */
  mfaEncryptionKey: Buffer;
  /** true si la clave se derivó de JWT_SECRET porque faltaba MFA_ENCRYPTION_KEY (solo desarrollo). */
  mfaEncryptionKeyDerived: boolean;
  /** Emisor que muestra la app autenticadora (Google Authenticator, Aegis, FreeOTP...). */
  mfaIssuer: string;
  /** Versión vigente de los términos y la política de privacidad (se guarda en iam.consents). */
  policyVersion: string;
}

/** Reportes: refresco de las vistas materializadas y exportes Excel/PDF asíncronos. */
export interface ReportsConfig {
  /** Cada cuánto el worker refresca las vistas (REFRESH ... CONCURRENTLY). 15 min por defecto. */
  refreshEveryMs: number;
  /** Cada cuánto el worker busca exportes pendientes. */
  exportEveryMs: number;
  /** Archivos exportados: SeaweedFS (filer HTTP) o memoria (tests y desarrollo sin S3). */
  exportStorage: 'seaweedfs' | 'memory';
  seaweedFilerUrl: string;
  /** Días que el archivo queda disponible para descargar. */
  exportTtlDays: number;
  /** Tope de filas por exporte (protege la memoria del worker). */
  exportMaxRows: number;
}

/** Soporte: SLA por prioridad, cierre automático y enlaces firmados de los emails. */
export interface SupportConfig {
  /** Horas para resolver según la prioridad (horas corridas). */
  slaHours: { urgent: number; high: number; normal: number; low: number };
  /** Un ticket resuelto sin respuesta del cliente se cierra (y se envía la encuesta) tras estos días. */
  autoCloseDays: number;
  /** Vigencia del enlace al ticket que llevan los emails (ver, responder, encuesta). */
  linkTtlDays: number;
  /** HMAC de los enlaces. Por defecto se deriva de JWT_SECRET. */
  linkSecret: string;
  /** Cada cuánto el job revisa SLA vencidos y cierres automáticos. */
  sweepEveryMs: number;
}

/** Clientes y fidelización: direcciones (Nominatim), wishlist, puntos y referidos. */
export interface CrmConfig {
  /** Nominatim propio (perfil maps). null = sin geocodificación: el cliente marca el pin. */
  nominatimUrl: string | null;
  nominatimTimeoutMs: number;
  /** User-Agent que exige la política de uso de Nominatim. */
  nominatimUserAgent: string;
  /** Puntos por cada USD de mercadería (IVA incluido, sin envío), antes del multiplicador del nivel. */
  pointsPerUsd: number;
  /** Canje por gift card: puntos por USD (100 = 1 USD por cada 100 puntos) y mínimo por canje. */
  redeemPointsPerUsd: number;
  redeemMinPoints: number;
  /** Cada cuánto el job acredita los puntos que pasaron el plazo de devolución y paga referidos. */
  loyaltyMatureEveryMs: number;
  /** Cada cuánto el job revisa precio y stock de las wishlists. */
  wishlistScanEveryMs: number;
  /** Baja mínima para avisar, en puntos básicos (5 % = 500). */
  wishlistMinDropBp: number;
  wishlistAlertCooldownHours: number;
  /** Recompensa al referente (cupón de monto fijo) y monto mínimo del primer pedido del referido, en centavos. */
  referralRewardCents: number;
  referralMinOrderCents: number;
}

/** Catálogo: reseñas con fotos y preguntas. */
export interface CatalogConfig {
  /** Fotos de las reseñas: SeaweedFS (filer HTTP) o memoria. Por defecto, igual que RETURN_PHOTO_STORAGE. */
  reviewPhotoStorage: 'seaweedfs' | 'memory';
  seaweedFilerUrl: string;
  /**
   * Base pública de las fotos de producto (product_media.storage_key relativo). Por defecto '/media':
   * detrás de Caddy, el storefront sirve las imágenes de demo en /media y las demás van a SeaweedFS.
   */
  mediaBaseUrl: string;
}

/** Notificaciones multicanal (ChannelPort): email, Web Push, ntfy, WhatsApp y SMS simulados. */
export interface NotificationsConfig {
  /**
   * 'live': SMTP (Mailpit), Web Push (VAPID) y ntfy reales. 'memory': todos los canales en memoria
   * (tests). WhatsApp y SMS son siempre simulados (log).
   */
  transport: 'live' | 'memory';
  smtpUrl: string;
  mailFrom: string;
  /** Nombre de la tienda en las plantillas. */
  brandName: string;
  /** Base de los enlaces de las plantillas (pedido, seguimiento, carrito). */
  storefrontUrl: string;
  /** Claves VAPID (npm run vapid:keys). Sin ellas, Web Push queda deshabilitado. */
  vapidPublicKey: string | null;
  vapidPrivateKey: string | null;
  /** mailto: o https: de contacto que exige el protocolo VAPID. */
  vapidSubject: string;
  ntfyUrl: string;
  ntfyToken: string | null;
  /** Tópico de alertas del backoffice (facturas rechazadas por el SRI). Debe ser difícil de adivinar. */
  ntfyStaffTopic: string;
  /** Hosts de servicios push aceptados como endpoint de una suscripción (anti SSRF). */
  webPushAllowedHosts: string[];
  /** Cada cuánto el despachador envía lo que está en cola. */
  dispatchEveryMs: number;
  /** Tras estos intentos fallidos una notificación queda 'failed'. */
  maxAttempts: number;
  retryBaseSeconds: number;
  retryMaxSeconds: number;
  /** Timeout de cada envío (SMTP, push, ntfy). */
  sendTimeoutMs: number;
}

/** Devoluciones y cambios (orquestador de posventa). */
export interface AftersalesConfig {
  /** Días desde la entrega para pedir una devolución o un cambio. */
  returnWindowDays: number;
  /** Fotos de las devoluciones: SeaweedFS (filer HTTP) o memoria (tests y desarrollo sin S3). */
  photoStorage: 'seaweedfs' | 'memory';
  seaweedFilerUrl: string;
  /** Email con el código de la gift card de un reembolso en saldo a favor. */
  mailTransport: 'smtp' | 'memory';
  smtpUrl: string;
  mailFrom: string;
}

/** Datos del contribuyente que emite (infoTributaria / infoFactura de la ficha técnica del SRI). */
export interface EmitterConfig {
  ruc: string;
  razonSocial: string;
  nombreComercial: string | null;
  dirMatriz: string;
  obligadoContabilidad: boolean;
  /** Número de resolución, solo si el SRI lo calificó como contribuyente especial. */
  contribuyenteEspecial: string | null;
  /** Leyenda "CONTRIBUYENTE RÉGIMEN RIMPE" (o "CONTRIBUYENTE NEGOCIO POPULAR - RÉGIMEN RIMPE"), si aplica. */
  contribuyenteRimpe: string | null;
}

export interface BillingConfig {
  /** A qué SRI se envían los comprobantes: el simulador (ADR-10) o los ambientes reales. */
  sriMode: 'simulator' | 'pruebas' | 'produccion';
  /** Base de los web services offline (sin /comprobantes-electronicos-ws/...). */
  sriUrl: string;
  sriTimeoutMs: number;
  /** Certificado (X.509) y clave privada RSA en PEM: los genera scripts/generate-sri-cert.sh. */
  certPath: string;
  keyPath: string;
  emitter: EmitterConfig;
  /** Punto de emisión que usa la tienda en línea (billing.emission_points). */
  establishment: string;
  emissionPoint: string;
  /** Máximo de una factura a consumidor final, en centavos. 0 = sin límite. */
  consumerFinalMaxCents: number;
  /** Backoff de reintentos: base × 2^intentos, con tope. */
  retryBaseSeconds: number;
  retryMaxSeconds: number;
  /** Espera antes de consultar la autorización de un comprobante RECIBIDO. */
  authPollSeconds: number;
  /** Cada cuánto corre el job que procesa los comprobantes pendientes. */
  processEveryMs: number;
  /** XML y RIDE: SeaweedFS (filer HTTP) o memoria (tests y desarrollo sin S3). */
  storage: 'seaweedfs' | 'memory';
  seaweedFilerUrl: string;
  /** Envío del RIDE y el XML al comprador: SMTP (Mailpit en desarrollo) o memoria (tests). */
  mailTransport: 'smtp' | 'memory';
  smtpUrl: string;
  mailFrom: string;
}

const SRI_URLS: Record<BillingConfig['sriMode'], string> = {
  simulator: 'http://localhost:8083',
  pruebas: 'https://celcer.sri.gob.ec',
  produccion: 'https://cel.sri.gob.ec',
};

export interface LogisticsConfig {
  /** OSRM (distancia real por calle). null = sin OSRM: se usa la distancia en línea recta. */
  osrmUrl: string | null;
  osrmTimeoutMs: number;
  /** Adaptadores de CourierPort habilitados (COURIER_ADAPTERS, separados por coma). */
  courierAdapters: string[];
  courierSimulatorUrl: string;
  courierSimulatorApiKey: string;
  /** Cada courier tiene este tiempo para cotizar; después se usa courier_rate_cards. */
  courierQuoteTimeoutMs: number;
  /** Vigencia de una cotización de envío entregada al checkout. */
  quoteTtlMinutes: number;
  /** HMAC de las opciones de envío firmadas. Por defecto se deriva de JWT_SECRET. */
  quoteSecret: string;
  /** Días hacia adelante para los que se generan franjas desde las plantillas. */
  slotDaysAhead: number;
  /** Anticipación mínima: una franja cierra esta cantidad de minutos antes de empezar. */
  slotLeadMinutes: number;
  /** Cron (America/Guayaquil) del job de liquidaciones semanales de motorizados. */
  settlementCron: string;
  /** Segundos que tiene el motorizado para aceptar una oferta del despacho automático. */
  dispatchOfferTtlSeconds: number;
  /** Cada cuánto el worker vence ofertas y vuelve a ofrecer los envíos sin motorizado. */
  dispatchSweepEveryMs: number;
  /** Duración de un turno a demanda (el motorizado lo inicia sin turno programado). */
  riderShiftDefaultHours: number;
  /** HMAC del código de entrega (OTP). Obligatorio en producción; en desarrollo se deriva de JWT_SECRET. */
  deliveryOtpSecret: string;
  /** Fotos y firmas de las entregas: SeaweedFS (filer HTTP) o memoria. Por defecto, igual que RETURN_PHOTO_STORAGE. */
  proofStorage: 'seaweedfs' | 'memory';
  seaweedFilerUrl: string;
  /** Avisos de ofertas al motorizado: ntfy real (live) o en memoria (tests). Por defecto, NOTIFICATION_TRANSPORT. */
  offerTransport: 'live' | 'memory';
  /** ntfy al que publica la API (red interna de Docker) y el que usa el TELÉFONO para suscribirse. */
  ntfyUrl: string;
  ntfyPublicUrl: string;
  ntfyToken: string | null;
}

export interface PaymentsConfig {
  /** Adaptador de PaymentGatewayPort. Por ahora solo 'simulator' (ADR-10). */
  gateway: 'simulator';
  /** Secreto HMAC compartido con la pasarela simulada (firma del pedido de pago y de los webhooks). */
  simulatorSecret: string;
  /** URL de la pasarela simulada que abre el NAVEGADOR del cliente (no la red interna de Docker). */
  simulatorPublicUrl: string;
  /** A dónde vuelve el cliente desde la pasarela (página de resultado del storefront). */
  returnUrl: string;
  /** Minutos para completar un pago en línea antes de que venza y se libere el stock. */
  onlineTtlMinutes: number;
  /** Horas para transferir y subir el comprobante (y para que el backoffice lo verifique). */
  transferTtlHours: number;
  /**
   * Minutos para pagar un pedido asistido del backoffice (enlace de pago con tarjeta que el vendedor
   * envía por WhatsApp; la transferencia asistida usa el mayor entre este plazo y transferTtlHours).
   * Entre 15 y 4320 (PAYMENT_TTL_MAX_MINUTES): la reserva de stock dura este plazo más un margen.
   */
  assistedLinkTtlMinutes: number;
  /** Datos de la cuenta que se muestran para transferir. */
  transferAccount: string;
  /** URL de la pasarela simulada para llamadas servidor a servidor (reversos), en la red interna. */
  simulatorApiUrl: string;
  refundTimeoutMs: number;
  /** Un reembolso por ENCIMA de este monto (centavos) exige dos aprobaciones de personas distintas. */
  refundDualApprovalAboveCents: number;
  /** Tolerancia de la marca de tiempo de un webhook (anti replay). */
  webhookToleranceSeconds: number;
  /** Dónde se guardan los comprobantes: 'seaweedfs' (filer HTTP) o 'memory' (tests y desarrollo sin S3). */
  voucherStorage: 'seaweedfs' | 'memory';
  seaweedFilerUrl: string;
}

export const APP_CONFIG = Symbol('APP_CONFIG');

function required(name: string, env: NodeJS.ProcessEnv): string {
  const value = env[name];
  if (!value) throw new Error(`Falta la variable de entorno ${name}`);
  return value;
}

function int(name: string, fallback: number, env: NodeJS.ProcessEnv): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} debe ser un entero positivo`);
  return value;
}

/** Tope del plazo de cualquier pago (72 h): Checkout reserva el stock hasta este plazo más un margen. */
export const PAYMENT_TTL_MAX_MINUTES = 72 * 60;

function intBetween(name: string, fallback: number, min: number, max: number, env: NodeJS.ProcessEnv): number {
  const value = int(name, fallback, env);
  if (value < min || value > max) throw new Error(`${name} debe estar entre ${min} y ${max}`);
  return value;
}

function bool(name: string, fallback: boolean, env: NodeJS.ProcessEnv): boolean {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (raw !== 'true' && raw !== 'false') throw new Error(`${name} debe ser true o false`);
  return raw === 'true';
}

function oneOf<T extends string>(name: string, allowed: readonly T[], fallback: T, env: NodeJS.ProcessEnv): T {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!(allowed as readonly string[]).includes(raw)) throw new Error(`${name} debe ser uno de: ${allowed.join(', ')}`);
  return raw as T;
}

/** Monto en USD ("50", "50.00") a centavos; admite 0. */
function cents(name: string, fallback: number, env: NodeJS.ProcessEnv): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d{1,8}(\.\d{1,2})?$/.test(raw)) throw new Error(`${name} debe ser un monto en USD (por ejemplo 50.00)`);
  const [units, decimals = ''] = raw.split('.');
  return Number(units) * 100 + Number(decimals.padEnd(2, '0'));
}

function billingConfig(env: NodeJS.ProcessEnv): BillingConfig {
  const sriMode = oneOf('SRI_MODE', ['simulator', 'pruebas', 'produccion'] as const, 'simulator', env);
  const ruc = env.SRI_RUC || '1790000000001';
  if (!/^\d{10}00\d$/.test(ruc)) throw new Error('SRI_RUC debe tener 13 dígitos y terminar en 001 (o 00n)');
  const code3 = (name: string, fallback: string) => {
    const value = env[name] || fallback;
    if (!/^\d{3}$/.test(value)) throw new Error(`${name} debe tener 3 dígitos`);
    return value;
  };
  return {
    sriMode,
    sriUrl: (env.SRI_URL || SRI_URLS[sriMode]).replace(/\/+$/, ''),
    sriTimeoutMs: int('SRI_TIMEOUT_MS', 10_000, env),
    certPath: env.SRI_CERT_PATH || 'secrets/sri/firma.crt.pem',
    keyPath: env.SRI_KEY_PATH || 'secrets/sri/firma.key.pem',
    emitter: {
      ruc,
      razonSocial: env.SRI_RAZON_SOCIAL || 'MODA DEMO S.A.',
      nombreComercial: env.SRI_NOMBRE_COMERCIAL === undefined ? 'Moda Demo' : env.SRI_NOMBRE_COMERCIAL || null,
      dirMatriz: env.SRI_DIR_MATRIZ || 'Av. Amazonas N34-120 y Av. de la Prensa, Quito',
      obligadoContabilidad: bool('SRI_OBLIGADO_CONTABILIDAD', true, env),
      contribuyenteEspecial: env.SRI_CONTRIBUYENTE_ESPECIAL || null,
      contribuyenteRimpe: env.SRI_CONTRIBUYENTE_RIMPE || null,
    },
    establishment: code3('SRI_ESTABLECIMIENTO', '001'),
    emissionPoint: code3('SRI_PUNTO_EMISION', '001'),
    consumerFinalMaxCents: cents('SRI_CONSUMIDOR_FINAL_MAX', 50_00, env),
    retryBaseSeconds: int('SRI_RETRY_BASE_SECONDS', 30, env),
    retryMaxSeconds: int('SRI_RETRY_MAX_SECONDS', 3600, env),
    authPollSeconds: int('SRI_AUTH_POLL_SECONDS', 5, env),
    processEveryMs: int('SRI_PROCESS_EVERY_MS', 15_000, env),
    storage: oneOf('DOCUMENT_STORAGE', ['seaweedfs', 'memory'] as const, 'seaweedfs', env),
    seaweedFilerUrl: (env.SEAWEEDFS_FILER_URL ?? 'http://localhost:8888').replace(/\/+$/, ''),
    mailTransport: oneOf('MAIL_TRANSPORT', ['smtp', 'memory'] as const, 'smtp', env),
    smtpUrl: env.SMTP_URL || 'smtp://localhost:1025',
    mailFrom: env.MAIL_FROM || 'Moda Demo - Facturación <facturacion@moda-demo.test>',
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const jwtSecret = required('JWT_SECRET', env);
  // HS256 con un secreto corto se rompe por fuerza bruta offline a partir de un solo token, y de
  // JWT_SECRET se derivan otros HMAC (cotizaciones, enlaces de soporte, 2FA) si no tienen el suyo.
  if (env.NODE_ENV === 'production' && Buffer.byteLength(jwtSecret) < 32) {
    throw new Error('JWT_SECRET debe tener al menos 32 caracteres aleatorios en producción (openssl rand -base64 48)');
  }
  return {
    databaseUrl: required('DATABASE_URL', env),
    databasePoolMax: int('DATABASE_POOL_MAX', 20, env),
    valkeyUrl: env.VALKEY_URL ?? 'redis://localhost:6379',
    jwtSecret,
    port: int('PORT', 3000, env),
    reservationTtlSeconds: int('STOCK_RESERVATION_TTL_SECONDS', 15 * 60, env),
    guestCartTtlDays: int('GUEST_CART_TTL_DAYS', 30, env),
    secureCookies: bool('SECURE_COOKIES', !['development', 'test'].includes(env.NODE_ENV ?? ''), env),
    cartReminderEveryMs: int('CART_REMINDER_EVERY_MS', 5 * 60_000, env),
    payments: {
      gateway: oneOf('PAYMENT_GATEWAY', ['simulator'] as const, 'simulator', env),
      simulatorSecret: required('PAYSIM_SECRET', env),
      simulatorPublicUrl: (env.PAYSIM_PUBLIC_URL ?? 'http://localhost:8081').replace(/\/+$/, ''),
      returnUrl: env.PAYMENT_RETURN_URL ?? 'http://localhost/checkout/resultado',
      // Topes de 72 h: la reserva de stock (que dura el plazo del pago más un margen) no puede quedarse corta.
      onlineTtlMinutes: intBetween('PAYMENT_ONLINE_TTL_MINUTES', 15, 1, PAYMENT_TTL_MAX_MINUTES, env),
      transferTtlHours: intBetween('PAYMENT_TRANSFER_TTL_HOURS', 12, 1, PAYMENT_TTL_MAX_MINUTES / 60, env),
      assistedLinkTtlMinutes: intBetween('ASSISTED_PAYMENT_LINK_TTL_MINUTES', 24 * 60, 15, PAYMENT_TTL_MAX_MINUTES, env),
      transferAccount:
        env.PAYMENT_TRANSFER_ACCOUNT ?? 'Banco Pichincha · Cuenta corriente 2100000000 · Moda Demo S.A. · RUC 1790000000001',
      simulatorApiUrl: (env.PAYSIM_API_URL ?? env.PAYSIM_PUBLIC_URL ?? 'http://localhost:8081').replace(/\/+$/, ''),
      refundTimeoutMs: int('PAYMENT_REFUND_TIMEOUT_MS', 10_000, env),
      refundDualApprovalAboveCents: cents('REFUND_DUAL_APPROVAL_ABOVE', 100_00, env),
      webhookToleranceSeconds: int('PAYMENT_WEBHOOK_TOLERANCE_SECONDS', 300, env),
      voucherStorage: oneOf('VOUCHER_STORAGE', ['seaweedfs', 'memory'] as const, 'seaweedfs', env),
      seaweedFilerUrl: (env.SEAWEEDFS_FILER_URL ?? 'http://localhost:8888').replace(/\/+$/, ''),
    },
    logistics: {
      osrmUrl: env.OSRM_URL ? env.OSRM_URL.replace(/\/+$/, '') : null,
      osrmTimeoutMs: int('OSRM_TIMEOUT_MS', 1500, env),
      courierAdapters: (env.COURIER_ADAPTERS ?? 'simulator')
        .split(',')
        .map((a) => a.trim())
        .filter(Boolean),
      courierSimulatorUrl: (env.COURIERSIM_URL ?? 'http://localhost:8082').replace(/\/+$/, ''),
      courierSimulatorApiKey: env.COURIERSIM_API_KEY ?? '',
      courierQuoteTimeoutMs: int('COURIER_QUOTE_TIMEOUT_MS', 3000, env),
      quoteTtlMinutes: int('DELIVERY_QUOTE_TTL_MINUTES', 15, env),
      quoteSecret: env.DELIVERY_QUOTE_SECRET || createHmac('sha256', jwtSecret).update('logistics.delivery-quote').digest('hex'),
      slotDaysAhead: int('DELIVERY_SLOT_DAYS_AHEAD', 7, env),
      slotLeadMinutes: int('DELIVERY_SLOT_LEAD_MINUTES', 120, env),
      settlementCron: env.RIDER_SETTLEMENT_CRON || '0 3 * * 1',
      ...riderAppConfig(jwtSecret, env),
    },
    billing: billingConfig(env),
    aftersales: {
      returnWindowDays: int('RETURN_WINDOW_DAYS', 30, env),
      photoStorage: oneOf('RETURN_PHOTO_STORAGE', ['seaweedfs', 'memory'] as const, 'seaweedfs', env),
      seaweedFilerUrl: (env.SEAWEEDFS_FILER_URL ?? 'http://localhost:8888').replace(/\/+$/, ''),
      mailTransport: oneOf('MAIL_TRANSPORT', ['smtp', 'memory'] as const, 'smtp', env),
      smtpUrl: env.SMTP_URL || 'smtp://localhost:1025',
      mailFrom: env.AFTERSALES_MAIL_FROM || 'Moda Demo - Devoluciones <devoluciones@moda-demo.test>',
    },
    notifications: {
      transport: oneOf('NOTIFICATION_TRANSPORT', ['live', 'memory'] as const, 'live', env),
      smtpUrl: env.SMTP_URL || 'smtp://localhost:1025',
      mailFrom: env.NOTIFICATIONS_MAIL_FROM || 'Moda Demo <hola@moda-demo.test>',
      brandName: env.NOTIFICATIONS_BRAND || 'Moda Demo',
      storefrontUrl: (env.STOREFRONT_URL || 'http://localhost').replace(/\/+$/, ''),
      vapidPublicKey: env.VAPID_PUBLIC_KEY || null,
      vapidPrivateKey: env.VAPID_PRIVATE_KEY || null,
      vapidSubject: env.VAPID_SUBJECT || 'mailto:soporte@moda-demo.test',
      ntfyUrl: (env.NTFY_URL || 'http://localhost:8090').replace(/\/+$/, ''),
      ntfyToken: env.NTFY_TOKEN || null,
      ntfyStaffTopic: env.NTFY_STAFF_TOPIC || 'moda-demo-backoffice',
      webPushAllowedHosts: (env.WEBPUSH_ALLOWED_HOSTS || 'fcm.googleapis.com,*.push.services.mozilla.com,web.push.apple.com,*.push.apple.com,*.notify.windows.com')
        .split(',')
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean),
      dispatchEveryMs: int('NOTIFICATION_DISPATCH_EVERY_MS', 5_000, env),
      maxAttempts: int('NOTIFICATION_MAX_ATTEMPTS', 6, env),
      retryBaseSeconds: int('NOTIFICATION_RETRY_BASE_SECONDS', 30, env),
      retryMaxSeconds: int('NOTIFICATION_RETRY_MAX_SECONDS', 3600, env),
      sendTimeoutMs: int('NOTIFICATION_SEND_TIMEOUT_MS', 10_000, env),
    },
    crm: {
      nominatimUrl: env.NOMINATIM_URL ? env.NOMINATIM_URL.replace(/\/+$/, '') : null,
      nominatimTimeoutMs: int('NOMINATIM_TIMEOUT_MS', 3000, env),
      nominatimUserAgent: env.NOMINATIM_USER_AGENT || 'moda-ecommerce/0.1 (trabajo universitario)',
      pointsPerUsd: int('LOYALTY_POINTS_PER_USD', 1, env),
      redeemPointsPerUsd: int('LOYALTY_REDEEM_POINTS_PER_USD', 100, env),
      redeemMinPoints: int('LOYALTY_REDEEM_MIN_POINTS', 500, env),
      loyaltyMatureEveryMs: int('LOYALTY_MATURE_EVERY_MS', 60 * 60_000, env),
      wishlistScanEveryMs: int('WISHLIST_SCAN_EVERY_MS', 30 * 60_000, env),
      wishlistMinDropBp: int('WISHLIST_PRICE_DROP_MIN_PERCENT', 5, env) * 100,
      wishlistAlertCooldownHours: int('WISHLIST_ALERT_COOLDOWN_HOURS', 24, env),
      referralRewardCents: cents('REFERRAL_REWARD', 10_00, env),
      referralMinOrderCents: cents('REFERRAL_MIN_ORDER', 30_00, env),
    },
    catalog: {
      reviewPhotoStorage: oneOf(
        'REVIEW_PHOTO_STORAGE',
        ['seaweedfs', 'memory'] as const,
        env.RETURN_PHOTO_STORAGE === 'memory' ? 'memory' : 'seaweedfs',
        env,
      ),
      seaweedFilerUrl: (env.SEAWEEDFS_FILER_URL ?? 'http://localhost:8888').replace(/\/+$/, ''),
      mediaBaseUrl: (env.CATALOG_MEDIA_BASE_URL || '/media').replace(/\/+$/, ''),
    },
    support: {
      slaHours: {
        urgent: int('SUPPORT_SLA_URGENT_HOURS', 4, env),
        high: int('SUPPORT_SLA_HIGH_HOURS', 8, env),
        normal: int('SUPPORT_SLA_NORMAL_HOURS', 24, env),
        low: int('SUPPORT_SLA_LOW_HOURS', 72, env),
      },
      autoCloseDays: int('SUPPORT_AUTO_CLOSE_DAYS', 3, env),
      linkTtlDays: int('SUPPORT_LINK_TTL_DAYS', 30, env),
      linkSecret: env.SUPPORT_LINK_SECRET || createHmac('sha256', jwtSecret).update('support.ticket-link').digest('hex'),
      sweepEveryMs: int('SUPPORT_SWEEP_EVERY_MS', 5 * 60_000, env),
    },
    reports: {
      refreshEveryMs: int('REPORTS_REFRESH_EVERY_MS', 15 * 60_000, env),
      exportEveryMs: int('REPORTS_EXPORT_EVERY_MS', 5_000, env),
      exportStorage: oneOf('REPORT_EXPORT_STORAGE', ['seaweedfs', 'memory'] as const, 'seaweedfs', env),
      seaweedFilerUrl: (env.SEAWEEDFS_FILER_URL ?? 'http://localhost:8888').replace(/\/+$/, ''),
      exportTtlDays: int('REPORTS_EXPORT_TTL_DAYS', 7, env),
      exportMaxRows: int('REPORTS_EXPORT_MAX_ROWS', 20_000, env),
    },
    iam: iamConfig(jwtSecret, env),
    security: securityConfig(jwtSecret, env),
    realtime: {
      transport: oneOf('REALTIME_TRANSPORT', ['valkey', 'memory'] as const, 'valkey', env),
      port: int('REALTIME_PORT', 3002, env),
      path: env.REALTIME_PATH || '/ws/socket.io',
    },
  };
}

/** Secreto del código de entrega: DELIVERY_OTP_SECRET o, fuera de producción, derivado de JWT_SECRET (lo usa también sim:rider). */
export function deliveryOtpSecretFrom(jwtSecret: string, env: NodeJS.ProcessEnv = process.env): string {
  return env.DELIVERY_OTP_SECRET || createHmac('sha256', jwtSecret).update('logistics.delivery-otp').digest('hex');
}

/** App del motorizado: despacho automático, turnos, código de entrega, pruebas y avisos por ntfy. */
function riderAppConfig(jwtSecret: string, env: NodeJS.ProcessEnv) {
  const otpSecret = env.DELIVERY_OTP_SECRET;
  // Con el secreto se calcula el código de cualquier envío: en producción no puede derivarse de otro.
  if (!otpSecret && env.NODE_ENV === 'production') throw new Error('Falta la variable de entorno DELIVERY_OTP_SECRET');
  if (otpSecret && env.NODE_ENV === 'production' && Buffer.byteLength(otpSecret) < 32) {
    throw new Error('DELIVERY_OTP_SECRET debe tener al menos 32 caracteres aleatorios en producción');
  }
  const ntfyUrl = (env.NTFY_URL || 'http://localhost:8090').replace(/\/+$/, '');
  return {
    dispatchOfferTtlSeconds: intBetween('DISPATCH_OFFER_TTL_SECONDS', 45, 10, 600, env),
    dispatchSweepEveryMs: int('DISPATCH_SWEEP_EVERY_MS', 15_000, env),
    riderShiftDefaultHours: intBetween('RIDER_SHIFT_DEFAULT_HOURS', 8, 1, 24, env),
    deliveryOtpSecret: deliveryOtpSecretFrom(jwtSecret, env),
    proofStorage: oneOf('DELIVERY_PROOF_STORAGE', ['seaweedfs', 'memory'] as const, env.RETURN_PHOTO_STORAGE === 'memory' ? 'memory' : 'seaweedfs', env),
    seaweedFilerUrl: (env.SEAWEEDFS_FILER_URL ?? 'http://localhost:8888').replace(/\/+$/, ''),
    offerTransport: oneOf('RIDER_OFFER_TRANSPORT', ['live', 'memory'] as const, env.NOTIFICATION_TRANSPORT === 'memory' ? 'memory' : 'live', env),
    ntfyUrl,
    ntfyPublicUrl: (env.NTFY_PUBLIC_URL || ntfyUrl).replace(/\/+$/, ''),
    ntfyToken: env.NTFY_TOKEN || null,
  };
}

function key32(name: string, env: NodeJS.ProcessEnv): Buffer | null {
  const raw = env[name];
  if (!raw) return null;
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error(`${name} debe ser de 32 bytes en base64 (openssl rand -base64 32)`);
  return key;
}

function securityConfig(jwtSecret: string, env: NodeJS.ProcessEnv): SecurityConfig {
  const own = key32('DATA_ENCRYPTION_KEY', env);
  // Sin clave propia, rotar JWT_SECRET dejaría ilegibles los campos cifrados: en producción es obligatoria.
  if (!own && env.NODE_ENV === 'production') throw new Error('Falta la variable de entorno DATA_ENCRYPTION_KEY');
  const corsOrigins = (env.CORS_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  for (const origin of corsOrigins) {
    if (origin === '*' || !/^https?:\/\/[^/\s]+$/.test(origin)) {
      throw new Error(`CORS_ORIGINS: "${origin}" no es un origen válido (esquema://host[:puerto], sin comodines)`);
    }
  }
  const bodyLimit = env.HTTP_BODY_LIMIT || '100kb';
  if (!/^\d+(kb|mb)$/.test(bodyLimit)) throw new Error('HTTP_BODY_LIMIT debe ser como 100kb o 1mb');
  return {
    corsOrigins,
    trustProxy: env.TRUST_PROXY || 'loopback, linklocal, uniquelocal',
    bodyLimit,
    rateLimit: {
      enabled: bool('RATE_LIMIT_ENABLED', true, env),
      storage: oneOf('RATE_LIMIT_STORAGE', ['valkey', 'memory'] as const, 'valkey', env),
    },
    dataEncryptionKey: own ?? createHmac('sha256', jwtSecret).update('platform.data-encryption-key').digest(),
    dataEncryptionKeyPrevious: key32('DATA_ENCRYPTION_KEY_PREVIOUS', env),
    dataEncryptionKeyDerived: !own,
  };
}

function iamConfig(jwtSecret: string, env: NodeJS.ProcessEnv): IamConfig {
  const rawKey = env.MFA_ENCRYPTION_KEY;
  let mfaEncryptionKey: Buffer;
  if (rawKey) {
    mfaEncryptionKey = Buffer.from(rawKey, 'base64');
    if (mfaEncryptionKey.length !== 32) throw new Error('MFA_ENCRYPTION_KEY debe ser de 32 bytes en base64 (openssl rand -base64 32)');
  } else {
    // Sin clave propia, cambiar JWT_SECRET dejaría ilegibles los secretos TOTP: en producción es obligatoria.
    if (env.NODE_ENV === 'production') throw new Error('Falta la variable de entorno MFA_ENCRYPTION_KEY');
    mfaEncryptionKey = createHmac('sha256', jwtSecret).update('iam.mfa-encryption-key').digest();
  }
  return {
    refreshTtlDays: int('REFRESH_TOKEN_TTL_DAYS', 14, env),
    refreshCookiePath: env.REFRESH_COOKIE_PATH || '/v1/auth',
    mfaChallengeSecret: env.MFA_CHALLENGE_SECRET || createHmac('sha256', jwtSecret).update('iam.mfa-challenge').digest('hex'),
    mfaEncryptionKey,
    mfaEncryptionKeyDerived: !rawKey,
    mfaIssuer: env.MFA_ISSUER || 'Moda Demo',
    policyVersion: env.POLICY_VERSION || '2026-10',
  };
}
