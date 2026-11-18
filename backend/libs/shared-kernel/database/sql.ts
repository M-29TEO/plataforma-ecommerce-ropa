import { DatabaseError } from 'pg';

/**
 * Construye "col1 = $n, col2 = $n+1" a partir de un patch parcial. Las claves con valor
 * undefined se ignoran; null sí se escribe (para limpiar columnas opcionales).
 */
export function buildSetClause(
  patch: Record<string, unknown>,
  columns: Record<string, string>,
  firstParam: number,
): { sql: string; values: unknown[] } {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, column] of Object.entries(columns)) {
    const value = patch[key];
    if (value === undefined) continue;
    values.push(value !== null && typeof value === 'object' ? JSON.stringify(value) : value);
    sets.push(`${column} = $${firstParam + values.length - 1}`);
  }
  return { sql: sets.join(', '), values };
}

export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  return (
    error instanceof DatabaseError &&
    error.code === '23505' &&
    (constraint === undefined || error.constraint === constraint)
  );
}
