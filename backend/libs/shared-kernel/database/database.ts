import { AsyncLocalStorage } from 'node:async_hooks';
import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient, QueryResult, QueryResultRow, types } from 'pg';

// `date` (OID 1082) se devuelve como texto "AAAA-MM-DD": convertirlo a Date lo interpreta a
// medianoche local y puede correr el día al mostrarlo en America/Guayaquil.
types.setTypeParser(1082, (value: string) => value);

export const PG_POOL = Symbol('PG_POOL');

/**
 * Lo mínimo que necesita un repositorio: el Pool o un cliente dentro de una transacción.
 * Los repositorios reciben siempre un Queryable para poder participar en la transacción
 * del caso de uso.
 */
export interface Queryable {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mismo default que pg (filas sin tipar)
  query<R extends QueryResultRow = any>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
}

interface TransactionContext {
  client: PoolClient;
  savepoints: number;
}

@Injectable()
export class Database implements OnModuleDestroy {
  /**
   * Transacción "ambiental": mientras corre withTransaction, todo lo que se ejecute en el mismo
   * flujo asíncrono (aunque venga de otro módulo, por su fachada pública) usa la MISMA conexión.
   * Así un orquestador como Checkout compone casos de uso de varios módulos en una sola
   * transacción sin que esos módulos cambien su código ni se conozcan entre sí.
   */
  private readonly context = new AsyncLocalStorage<TransactionContext>();

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** Dentro de una transacción en curso usa su conexión (ve lo que la transacción ya escribió). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mismo default que pg (filas sin tipar)
  query<R extends QueryResultRow = any>(text: string, values?: unknown[]): Promise<QueryResult<R>> {
    const current = this.context.getStore();
    return current ? current.client.query<R>(text, values) : this.pool.query<R>(text, values);
  }

  /**
   * Ejecuta fn dentro de BEGIN/COMMIT en una sola conexión. Cualquier excepción provoca
   * ROLLBACK, así que un caso de uso es "todo o nada" (incluidos los eventos del outbox).
   *
   * Si ya hay una transacción en curso, fn corre dentro de un SAVEPOINT de esa transacción:
   * un error revierte solo lo de fn (quien lo atrape puede seguir, como con un unique violation
   * esperado) y el COMMIT real lo hace la transacción de afuera. Las transacciones anidadas se
   * ejecutan una a la vez (no en paralelo con Promise.all): comparten la conexión.
   */
  async withTransaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    const current = this.context.getStore();
    if (current) return this.withSavepoint(current, fn);

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await this.context.run({ client, savepoints: 0 }, () => fn(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** true si el llamador corre dentro de withTransaction. */
  inTransaction(): boolean {
    return this.context.getStore() !== undefined;
  }

  private async withSavepoint<T>(current: TransactionContext, fn: (tx: Queryable) => Promise<T>): Promise<T> {
    const name = `sp_${++current.savepoints}`;
    await current.client.query(`SAVEPOINT ${name}`);
    try {
      const result = await fn(current.client);
      await current.client.query(`RELEASE SAVEPOINT ${name}`);
      return result;
    } catch (error) {
      await current.client.query(`ROLLBACK TO SAVEPOINT ${name}`).catch(() => undefined);
      throw error;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
