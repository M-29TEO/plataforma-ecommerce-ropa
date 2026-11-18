import { Injectable } from '@nestjs/common';
import { Database, ValidationError } from '../../../shared-kernel';
import { CatalogEntry, isTemplateCode, TEMPLATE_CATALOG } from '../domain/catalog';
import { Channel } from '../domain/channel';
import { isSupportedLocale, SUPPORTED_LOCALES } from '../domain/locale';
import { StoredTemplate, TemplateEngine, TemplateRepository } from './ports';

export interface TemplateCatalogView {
  code: string;
  description: string;
  category: CatalogEntry['category'];
  audience: CatalogEntry['audience'];
  channels: readonly Channel[];
  /** Plantillas propias del tenant (las demás usan la del sistema). */
  overrides: Pick<StoredTemplate, 'channel' | 'locale' | 'active' | 'subject' | 'body'>[];
}

export interface TemplateInput {
  subject: string | null;
  body: string;
  active: boolean;
}

/** Backoffice: plantillas del tenant por mensaje, canal e idioma. */
@Injectable()
export class TemplateAdminService {
  constructor(
    private readonly db: Database,
    private readonly templates: TemplateRepository,
    private readonly engine: TemplateEngine,
  ) {}

  async catalog(tenantId: string): Promise<{ locales: readonly string[]; templates: TemplateCatalogView[] }> {
    const own = await this.templates.listForTenant(this.db, tenantId);
    return {
      locales: SUPPORTED_LOCALES,
      templates: Object.entries(TEMPLATE_CATALOG as Record<string, CatalogEntry>).map(([code, e]) => ({
        code,
        description: e.description,
        category: e.category,
        audience: e.audience,
        channels: e.channels,
        overrides: own
          .filter((t) => t.code === code)
          .map((t) => ({ channel: t.channel, locale: t.locale, active: t.active, subject: t.subject, body: t.body })),
      })),
    };
  }

  /**
   * Crea o reemplaza la plantilla del tenant. El mensaje debe existir en el catálogo y usar uno de
   * sus canales; la categoría la impone el catálogo (no se puede volver transaccional un marketing).
   */
  async upsert(tenantId: string, code: string, channel: Channel, locale: string, input: TemplateInput): Promise<StoredTemplate> {
    if (!isTemplateCode(code)) throw new ValidationError('UNKNOWN_TEMPLATE', 'El mensaje no existe en el catálogo', { code });
    const entry: CatalogEntry = TEMPLATE_CATALOG[code];
    if (!entry.channels.includes(channel)) {
      throw new ValidationError('CHANNEL_NOT_ALLOWED', 'Ese mensaje no sale por ese canal', { code, channel, channels: entry.channels });
    }
    if (!isSupportedLocale(locale)) throw new ValidationError('UNSUPPORTED_LOCALE', 'Idioma no soportado', { locale, locales: SUPPORTED_LOCALES });
    const needsSubject = channel === 'email' || channel === 'webpush' || channel === 'ntfy';
    if (needsSubject && !input.subject?.trim()) throw new ValidationError('SUBJECT_REQUIRED', 'Ese canal necesita asunto o título', { channel });
    this.engine.validate(input.body);
    if (input.subject) this.engine.validate(input.subject);
    return this.templates.upsert(this.db, tenantId, {
      code,
      channel,
      locale,
      subject: needsSubject ? input.subject!.trim() : null,
      body: input.body,
      category: entry.category,
      active: input.active,
    });
  }
}
