/** Idiomas con plantillas por defecto. es-EC es el respaldo final. */
export const SUPPORTED_LOCALES = ['es-EC', 'en-US'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];
export const DEFAULT_LOCALE: SupportedLocale = 'es-EC';

export function isSupportedLocale(locale: string): locale is SupportedLocale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(locale);
}

/**
 * Orden de búsqueda de una plantilla: el idioma exacto del usuario (iam.users.locale), luego el
 * soportado del mismo idioma (en-GB → en-US, es-MX → es-EC) y al final es-EC. Sin duplicados.
 */
export function localeCandidates(locale: string | null | undefined): string[] {
  const out: string[] = [];
  const add = (l: string) => {
    if (!out.includes(l)) out.push(l);
  };
  const requested = locale?.trim();
  if (requested && /^[a-z]{2}(-[A-Z]{2})?$/.test(requested)) {
    add(requested);
    const lang = requested.slice(0, 2);
    const sameLanguage = SUPPORTED_LOCALES.find((l) => l.startsWith(`${lang}-`));
    if (sameLanguage) add(sameLanguage);
  }
  add(DEFAULT_LOCALE);
  return out;
}
