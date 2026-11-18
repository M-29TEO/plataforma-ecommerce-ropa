export interface RetryPolicy {
  maxAttempts: number;
  baseSeconds: number;
  maxSeconds: number;
}

export type FailureOutcome = { kind: 'retry'; attempts: number; nextAttemptAt: Date } | { kind: 'failed'; attempts: number };

/**
 * Qué hacer tras un envío fallido. Error permanente (destinatario inválido, suscripción vencida,
 * 4xx) → 'failed' de inmediato. Transitorio (SMTP caído, timeout, 5xx) → reintento con backoff
 * exponencial base × 2^(intento−1), con tope, hasta maxAttempts.
 */
export function onFailure(previousAttempts: number, permanent: boolean, policy: RetryPolicy, now: Date): FailureOutcome {
  const attempts = previousAttempts + 1;
  if (permanent || attempts >= policy.maxAttempts) return { kind: 'failed', attempts };
  const delay = Math.min(policy.maxSeconds, policy.baseSeconds * 2 ** (attempts - 1));
  return { kind: 'retry', attempts, nextAttemptAt: new Date(now.getTime() + delay * 1000) };
}
