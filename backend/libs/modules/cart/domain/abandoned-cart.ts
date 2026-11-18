/**
 * Recordatorios de carrito abandonado: 1 h, 24 h y 72 h sin actividad. sales.carts.reminders_sent
 * cuenta los enviados; tras el tercero no se envían más. Si el cliente vuelve a tocar el carrito,
 * reminders_sent vuelve a 0 (la cuenta se reinicia desde la nueva actividad).
 *
 * El carrito sigue 'active' después del tercero: el estado 'abandoned' lo sacaría de
 * findActiveByUser / ux_cart_user_active y el cliente perdería justo el carrito al que el
 * recordatorio lo invita a volver. Reportes cuenta los abandonados con reminders_sent > 0.
 */
export const REMINDER_STAGES = [
  { stage: 1, afterHours: 1, label: '1h' },
  { stage: 2, afterHours: 24, label: '24h' },
  { stage: 3, afterHours: 72, label: '72h' },
] as const;

export type ReminderStage = (typeof REMINDER_STAGES)[number];
export const LAST_REMINDER_STAGE = REMINDER_STAGES.length;

const HOUR_MS = 3_600_000;

/**
 * Etapa que corresponde enviar ahora, o null. Si el job estuvo detenido y el carrito ya superó
 * varias etapas, se envía SOLO la más avanzada vencida (no tres correos seguidos) y se saltan las
 * anteriores.
 */
export function dueReminder(remindersSent: number, lastActivityAt: Date, now: Date): ReminderStage | null {
  const idleHours = (now.getTime() - lastActivityAt.getTime()) / HOUR_MS;
  let due: ReminderStage | null = null;
  for (const s of REMINDER_STAGES) {
    if (s.stage > remindersSent && idleHours >= s.afterHours) due = s;
  }
  return due;
}

/** Fecha de corte de la primera etapa: los carritos con actividad posterior no son candidatos. */
export function firstReminderCutoff(now: Date): Date {
  return new Date(now.getTime() - REMINDER_STAGES[0].afterHours * HOUR_MS);
}
