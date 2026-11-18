/** Canales del CHECK de platform.notification_templates.channel. */
export const CHANNELS = ['email', 'webpush', 'ntfy', 'whatsapp', 'sms'] as const;
export type Channel = (typeof CHANNELS)[number];

export type TemplateCategory = 'transactional' | 'marketing';

export type MarketingPurpose = 'marketing_email' | 'marketing_whatsapp' | 'marketing_sms';

/**
 * Propósito LOPDP (iam.consents) que habilita el marketing por cada canal. null = el canal NO
 * lleva marketing: Web Push y ntfy no tienen un propósito propio en el modelo, así que un mensaje
 * de marketing nunca sale por ellos.
 */
export const MARKETING_PURPOSE: Record<Channel, MarketingPurpose | null> = {
  email: 'marketing_email',
  whatsapp: 'marketing_whatsapp',
  sms: 'marketing_sms',
  webpush: null,
  ntfy: null,
};

/** Estados del CHECK de platform.notifications.status. */
export type NotificationStatus = 'queued' | 'sent' | 'delivered' | 'read' | 'failed' | 'suppressed';
