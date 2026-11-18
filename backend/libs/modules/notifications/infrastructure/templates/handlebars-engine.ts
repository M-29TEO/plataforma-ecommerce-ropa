import { Inject, Injectable } from '@nestjs/common';
import Handlebars from 'handlebars';
import { APP_CONFIG, AppConfig, Queryable, ValidationError } from '../../../../shared-kernel';
import { RenderedContent, ResolvedTemplate, TemplateEngine, TemplateRepository } from '../../application/ports';
import { Channel } from '../../domain/channel';
import { isTemplateCode } from '../../domain/catalog';
import { DEFAULT_LOCALE, isSupportedLocale, localeCandidates } from '../../domain/locale';
import { DEFAULT_TEMPLATES } from './defaults';

const TIME_ZONE = 'America/Guayaquil';
const MAX_CACHED = 500;

/** Líneas del pedido o del carrito (parcial {{> items}} de los emails). */
const ITEMS_PARTIAL = `{{#if items.length}}<table role="presentation" style="width:100%;border-collapse:collapse;margin:12px 0">
{{#each items}}<tr><td style="padding:6px 0;border-bottom:1px solid #eee">{{quantity}} × {{name}}{{#if variant}} <span style="color:#666">({{variant}})</span>{{/if}}</td><td style="padding:6px 0;border-bottom:1px solid #eee;text-align:right">{{money amount}}</td></tr>
{{/each}}</table>{{/if}}`;

const LAYOUT = `<!doctype html>
<html lang="{{lang}}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>{{subject}}</title></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif;color:#18181b">
<div style="max-width:560px;margin:0 auto;padding:24px 16px">
<div style="font-size:20px;font-weight:bold;letter-spacing:.5px;margin-bottom:16px">{{brand}}</div>
<div style="background:#ffffff;border-radius:8px;padding:24px;line-height:1.5;font-size:15px">{{{content}}}</div>
<div style="color:#71717a;font-size:12px;margin-top:16px;line-height:1.5">
{{#if marketing}}{{#if (eq lang "en")}}You receive this email because you agreed to receive offers from {{brand}}. <a href="{{privacyUrl}}" style="color:#71717a">Manage your preferences</a>.{{else}}Recibes este correo porque aceptaste recibir novedades de {{brand}}. <a href="{{privacyUrl}}" style="color:#71717a">Gestiona tus preferencias</a>.{{/if}}{{else}}{{#if (eq lang "en")}}This is a message about your purchase at {{brand}}.{{else}}Este es un mensaje sobre tu compra en {{brand}}.{{/if}}{{/if}}
</div></div></body></html>`;

function rootLocale(options: Handlebars.HelperOptions | undefined): string {
  const locale = (options?.data?.root as { locale?: unknown } | undefined)?.locale;
  return typeof locale === 'string' && locale ? locale : DEFAULT_LOCALE;
}

function formatMoney(value: unknown, locale: string): string {
  if (value === null || value === undefined || value === '') return '';
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return String(value);
  return new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD' }).format(n);
}

function formatDate(value: unknown, locale: string): string {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(d.getTime())) return String(value);
  return new Intl.DateTimeFormat(locale, { timeZone: TIME_ZONE, dateStyle: 'long', timeStyle: 'short' }).format(d);
}

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#x27;': "'", '&#39;': "'", '&#x3D;': '=', '&#x60;': '`', '&nbsp;': ' ' };

/** Versión de texto del email (multipart/alternative): enlaces como "texto (url)", sin etiquetas. */
export function htmlToText(html: string): string {
  return html
    .replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, label: string) => `${label.replace(/<[^>]+>/g, '').trim()} (${href})`)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|h[1-6]|li|table)>/gi, '\n')
    .replace(/<\/td>\s*<td[^>]*>/gi, '  ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(amp|lt|gt|quot|nbsp|#x27|#39|#x3D|#x60);/g, (e) => ENTITIES[e] ?? e)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Motor de plantillas con Handlebars. Busca primero la plantilla del tenant
 * (platform.notification_templates) y luego la del sistema (defaults.ts), probando los idiomas de
 * localeCandidates. Una fila del tenant con active = false APAGA ese mensaje por ese canal en ese
 * idioma (por ejemplo, un tenant que no quiere SMS).
 *
 * Seguridad: en el email Handlebars escapa las variables ({{x}}); los textos planos (WhatsApp,
 * SMS, push, ntfy) se compilan sin escape porque no son HTML. Handlebars ≥ 4.6 bloquea el acceso
 * a prototipos, así que una plantilla del tenant no puede salir de los datos que recibe.
 */
@Injectable()
export class HandlebarsTemplateEngine extends TemplateEngine {
  private readonly hb = Handlebars.create();
  private readonly cache = new Map<string, Handlebars.TemplateDelegate>();

  constructor(
    private readonly templates: TemplateRepository,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    super();
    this.hb.registerHelper('money', (value: unknown, options: Handlebars.HelperOptions) => formatMoney(value, rootLocale(options)));
    this.hb.registerHelper('fecha', (value: unknown, options: Handlebars.HelperOptions) => formatDate(value, rootLocale(options)));
    this.hb.registerHelper('eq', (a: unknown, b: unknown) => a === b);
    this.hb.registerPartial('items', ITEMS_PARTIAL);
  }

  async resolve(q: Queryable, tenantId: string, code: string, channel: Channel, locale: string | null): Promise<ResolvedTemplate | null> {
    for (const candidate of localeCandidates(locale)) {
      const own = await this.templates.find(q, tenantId, code, channel, candidate);
      if (own) return own.active ? { code, channel, locale: candidate, subject: own.subject, body: own.body, source: 'tenant' } : null;
      const builtIn = isSupportedLocale(candidate) && isTemplateCode(code) ? DEFAULT_TEMPLATES[candidate][code]?.[channel] : undefined;
      if (builtIn) return { code, channel, locale: candidate, subject: builtIn.subject ?? null, body: builtIn.body, source: 'default' };
    }
    return null;
  }

  render(t: ResolvedTemplate, data: Record<string, unknown>, opts: { marketing: boolean }): RenderedContent {
    const context = { ...data, locale: t.locale };
    const subject = t.subject ? this.compile(t.subject, false)(context).trim() : null;
    if (t.channel !== 'email') {
      return { subject, text: this.compile(t.body, false)(context).trim(), html: null };
    }
    const content = this.compile(t.body, true)(context);
    const html = this.compile(LAYOUT, true)({
      ...context,
      subject,
      content,
      marketing: opts.marketing,
      lang: t.locale.slice(0, 2),
      privacyUrl: `${this.config.notifications.storefrontUrl}/mi-cuenta/privacidad`,
    });
    return { subject, html, text: htmlToText(content) };
  }

  validate(source: string): void {
    // {{{x}}} y {{&x}} insertan el dato SIN escapar: con el nombre o la dirección que escribió un
    // cliente, una plantilla del tenant inyectaría HTML (phishing) en un email legítimo de la tienda.
    if (/\{\{~?\s*[{&]/.test(source)) {
      throw new ValidationError('UNESCAPED_TEMPLATE', 'La plantilla no puede usar {{{ }}} ni {{& }}: los datos se insertan siempre escapados');
    }
    try {
      this.hb.precompile(source);
    } catch (error) {
      throw new ValidationError('INVALID_TEMPLATE', 'La plantilla no es Handlebars válido', {
        reason: error instanceof Error ? error.message.split('\n')[0] : String(error),
      });
    }
  }

  private compile(source: string, escape: boolean): Handlebars.TemplateDelegate {
    const key = `${escape ? 'h' : 't'}:${source}`;
    let fn = this.cache.get(key);
    if (!fn) {
      if (this.cache.size >= MAX_CACHED) this.cache.clear();
      fn = this.hb.compile(source, { noEscape: !escape });
      this.cache.set(key, fn);
    }
    return fn;
  }
}
