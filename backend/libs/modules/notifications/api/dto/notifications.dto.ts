import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Channel, CHANNELS, NotificationStatus } from '../../domain/channel';

const STATUSES: NotificationStatus[] = ['queued', 'sent', 'delivered', 'read', 'failed', 'suppressed'];
/** Claves de la suscripción en base64url (como las entrega PushSubscription.toJSON()). */
const BASE64URL = /^[A-Za-z0-9_-]+={0,2}$/;
/** Código de plantilla del catálogo ('order.placed', 'shipment.failed_attempt'...). */
const TEMPLATE_CODE = /^[a-z0-9_.]{1,60}$/;
/** BCP 47 corto: idioma-PAÍS ('es-EC', 'en-US'). */
const LOCALE = /^[a-z]{2}-[A-Z]{2}$/;

export class PushKeysDto {
  @IsString() @Length(16, 200) @Matches(BASE64URL) p256dh!: string;
  @IsString() @Length(8, 100) @Matches(BASE64URL) auth!: string;
}

/** Cuerpo de PushSubscription.toJSON() en el navegador. */
export class PushSubscriptionDto {
  @IsUrl({ protocols: ['https'], require_protocol: true, require_tld: false }) @MaxLength(1000) endpoint!: string;
  @ValidateNested() @Type(() => PushKeysDto) keys!: PushKeysDto;
}

export class PushUnsubscribeDto {
  @IsUrl({ protocols: ['https'], require_protocol: true, require_tld: false }) @MaxLength(1000) endpoint!: string;
}

export class PageQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit: number = 20;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(10_000) offset: number = 0;
}

export class ListNotificationsQuery extends PageQuery {
  /** "failed,suppressed" o status=failed&status=suppressed. */
  @IsOptional()
  @Transform(({ value }) =>
    value === undefined ? undefined : (Array.isArray(value) ? value : String(value).split(',')).map((s) => String(s).trim()).filter(Boolean),
  )
  @IsArray()
  @ArrayMaxSize(STATUSES.length)
  @IsIn(STATUSES, { each: true })
  status?: NotificationStatus[];

  @IsOptional() @IsIn(CHANNELS) channel?: Channel;
  @IsOptional() @IsString() @Matches(TEMPLATE_CODE) templateCode?: string;
  @IsOptional() @IsString() @Matches(/^[0-9a-f-]{36}$/i) userId?: string;
}

export class TemplateParams {
  @IsString() @Matches(TEMPLATE_CODE, { message: 'code debe ser un código de plantilla (minúsculas, dígitos, punto y guion bajo)' }) code!: string;
  @IsIn(CHANNELS) channel!: Channel;
  @IsString() @Matches(LOCALE, { message: 'locale debe tener el formato es-EC' }) locale!: string;
}

export class UpsertTemplateDto {
  @IsOptional() @IsString() @MaxLength(200) subject?: string | null;
  @IsString() @Length(1, 20_000) body!: string;
  @IsOptional() @IsBoolean() active: boolean = true;
}
