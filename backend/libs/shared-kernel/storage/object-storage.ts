/**
 * Almacenamiento de archivos (comprobantes de transferencia, XML y RIDE del SRI...). Puerto
 * compartido: cada módulo lo registra con su propio token de inyección (VoucherStorage en Pagos,
 * DocumentStorage en Facturación) y usa claves con su prefijo, así no se pisan.
 */
export interface StoredObject {
  content: Buffer;
  contentType: string;
}

/**
 * Clave de objeto segura: segmentos [A-Za-z0-9._-] separados por "/", sin "." ni ".." como
 * segmento y sin "%", "?", "#" ni "\\". El filer arma la URL con la clave: sin esto, una clave
 * como "reviews/<t>/<u>/../../payments/..." (o con %2e%2e) leería objetos de otro módulo o tenant.
 */
const SAFE_SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;

export class UnsafeStorageKeyError extends Error {
  constructor(key: string) {
    super(`Clave de almacenamiento inválida: ${JSON.stringify(key.slice(0, 120))}`);
  }
}

export function isSafeStorageKey(key: string): boolean {
  if (key.length === 0 || key.length > 512) return false;
  return key.split('/').every((seg) => SAFE_SEGMENT.test(seg) && seg !== '.' && seg !== '..');
}

export function assertSafeStorageKey(key: string): void {
  if (!isSafeStorageKey(key)) throw new UnsafeStorageKeyError(key);
}

/**
 * Tipo real del archivo por sus primeros bytes (magic numbers). El Content-Type del multipart lo
 * elige el cliente: un HTML subido como "image/png" se guardaría y se serviría tal cual.
 */
export function sniffFileType(buf: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf' | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length >= 5 && buf.toString('latin1', 0, 5) === '%PDF-') return 'application/pdf';
  return null;
}

export abstract class ObjectStorage {
  abstract put(key: string, content: Buffer, contentType: string): Promise<void>;
  /** null si no existe. */
  abstract get(key: string): Promise<StoredObject | null>;
}

/**
 * SeaweedFS mediante su filer HTTP (puerto 8888 de `weed server`): PUT/GET simples, sin SDK.
 * El tipo de contenido lo guarda el filer como Content-Type del archivo.
 */
export class SeaweedFilerStorage extends ObjectStorage {
  constructor(private readonly filerUrl: string) {
    super();
  }

  /** Cada segmento va codificado aunque ya sea seguro: defensa en profundidad. */
  private url(key: string): string {
    assertSafeStorageKey(key);
    return `${this.filerUrl}/${key.split('/').map(encodeURIComponent).join('/')}`;
  }

  async put(key: string, content: Buffer, contentType: string): Promise<void> {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(content)], { type: contentType }), key.split('/').pop());
    const res = await fetch(this.url(key), { method: 'POST', body: form, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`SeaweedFS respondió ${res.status} al guardar ${key}`);
  }

  async get(key: string): Promise<StoredObject | null> {
    const res = await fetch(this.url(key), { signal: AbortSignal.timeout(10_000) });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`SeaweedFS respondió ${res.status} al leer ${key}`);
    return {
      content: Buffer.from(await res.arrayBuffer()),
      contentType: res.headers.get('content-type') ?? 'application/octet-stream',
    };
  }
}

/** En memoria: tests y desarrollo sin SeaweedFS. Se pierde al reiniciar. */
export class InMemoryStorage extends ObjectStorage {
  private readonly files = new Map<string, StoredObject>();

  async put(key: string, content: Buffer, contentType: string): Promise<void> {
    assertSafeStorageKey(key);
    this.files.set(key, { content: Buffer.from(content), contentType });
  }

  async get(key: string): Promise<StoredObject | null> {
    assertSafeStorageKey(key);
    return this.files.get(key) ?? null;
  }
}

export function createObjectStorage(driver: 'seaweedfs' | 'memory', seaweedFilerUrl: string): ObjectStorage {
  return driver === 'memory' ? new InMemoryStorage() : new SeaweedFilerStorage(seaweedFilerUrl);
}
