import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Database } from '../database/database';
import { ConflictError, ValidationError } from '../errors/domain-error';

export interface IdempotentResponse<B = unknown> {
  status: number;
  body: B;
  /** true si es la respuesta guardada de una petición anterior con la misma clave. */
  replayed: boolean;
}

export interface IdempotencyScope {
  /** Operación (p. ej. 'checkout'). */
  scope: string;
  /** Quién la pide: 'user:<id>' o 'guest:<hash>'. Dos clientes con la misma clave no chocan. */
  userRef: string;
  key: string;
  /** Cuerpo de la petición: una misma clave con otro cuerpo es un error del cliente. */
  request: unknown;
  ttlHours?: number;
}

const KEY_RE = /^[A-Za-z0-9_\-:.]{8,100}$/;

export class IdempotencyKeyReusedError extends ValidationError {
  constructor() {
    super('IDEMPOTENCY_KEY_REUSED', 'La clave de idempotencia ya se usó con otra petición');
  }
}

export class InvalidIdempotencyKeyError extends ValidationError {
  constructor() {
    super('INVALID_IDEMPOTENCY_KEY', 'Header Idempotency-Key requerido: 8 a 100 caracteres [A-Za-z0-9_-:.]');
  }
}

class IdempotencyInProgressError extends ConflictError {
  constructor() {
    super('IDEMPOTENCY_IN_PROGRESS', 'La petición original sigue en proceso; reintenta en unos segundos');
  }
}

/**
 * Idempotencia de peticiones con platform.idempotency_keys (doble clic, reintentos de red).
 *
 * La clave se inserta en la MISMA transacción que la operación:
 *  - Primera petición: INSERT ok → ejecuta la operación → guarda status y cuerpo → COMMIT.
 *  - Petición simultánea con la misma clave: su INSERT espera en el índice único a que la
 *    primera termine. Si la primera confirmó, ve el conflicto y devuelve la respuesta guardada;
 *    si falló (ROLLBACK), su INSERT entra y ejecuta la operación desde cero.
 *  - Los errores no se guardan: se revierten con la transacción y el cliente puede reintentar.
 */
@Injectable()
export class IdempotencyStore {
  constructor(private readonly db: Database) {}

  async execute<B>(opts: IdempotencyScope, operation: () => Promise<{ status: number; body: B }>): Promise<IdempotentResponse<B>> {
    if (!KEY_RE.test(opts.key)) throw new InvalidIdempotencyKeyError();
    const hash = requestHash(opts.request);
    const ttlHours = opts.ttlHours ?? 24;

    return this.db.withTransaction(async (tx) => {
      const inserted = await tx.query(
        `INSERT INTO platform.idempotency_keys (key, scope, user_ref, request_hash, expires_at)
         VALUES ($1, $2, $3, $4, now() + make_interval(hours => $5))
         ON CONFLICT (scope, user_ref, key) DO UPDATE
           SET request_hash = EXCLUDED.request_hash, response_code = NULL, response_body = NULL,
               expires_at = EXCLUDED.expires_at
           WHERE platform.idempotency_keys.expires_at <= now()
         RETURNING key`,
        [opts.key, opts.scope, opts.userRef, hash, ttlHours],
      );

      if (inserted.rowCount === 0) {
        const { rows } = await tx.query<{ request_hash: Buffer; response_code: number | null; response_body: B }>(
          `SELECT request_hash, response_code, response_body FROM platform.idempotency_keys
            WHERE scope = $1 AND user_ref = $2 AND key = $3`,
          [opts.scope, opts.userRef, opts.key],
        );
        const saved = rows[0];
        if (!saved.request_hash.equals(hash)) throw new IdempotencyKeyReusedError();
        if (saved.response_code === null) throw new IdempotencyInProgressError();
        return { status: saved.response_code, body: saved.response_body, replayed: true };
      }

      const response = await operation();
      await tx.query(
        `UPDATE platform.idempotency_keys SET response_code = $4, response_body = $5::jsonb
          WHERE scope = $1 AND user_ref = $2 AND key = $3`,
        [opts.scope, opts.userRef, opts.key, response.status, JSON.stringify(response.body)],
      );
      return { ...response, replayed: false };
    });
  }
}

/** SHA-256 del JSON con claves ordenadas: el orden de los campos no cambia el hash. */
export function requestHash(value: unknown): Buffer {
  return createHash('sha256').update(stableStringify(value)).digest();
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}
