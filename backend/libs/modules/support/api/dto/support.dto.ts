import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {
  BODY_MAX,
  CSAT_COMMENT_MAX,
  REPLY_STATUSES,
  SUBJECT_MAX,
  TICKET_CATEGORIES,
  TICKET_CHANNELS,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
} from '../../domain/ticket';

/** "a,b" o a=x&a=y → string[] */
const csv = ({ value }: { value: unknown }) =>
  value === undefined ? undefined : (Array.isArray(value) ? value : String(value).split(',')).map((s) => String(s).trim()).filter(Boolean);

export class CreateTicketDto {
  @IsIn(TICKET_CATEGORIES) category!: (typeof TICKET_CATEGORIES)[number];
  @IsString() @Length(3, SUBJECT_MAX) subject!: string;
  @IsString() @Length(1, BODY_MAX) body!: string;
  @IsOptional() @IsUUID() orderId?: string;
  @IsOptional() @IsUUID() shipmentId?: string;
}

export class GuestTicketDto {
  /** Número del pedido (el del email de confirmación). */
  @IsString() @Matches(/^\d{1,18}$/) orderNumber!: string;
  /** El email con el que se hizo la compra. */
  @IsEmail() @MaxLength(254) email!: string;
  @IsOptional() @IsString() @MaxLength(120) name?: string;
  @IsOptional() @IsString() @MaxLength(20) phone?: string;
  @IsOptional() @IsUUID() shipmentId?: string;
  @IsIn(TICKET_CATEGORIES) category!: (typeof TICKET_CATEGORIES)[number];
  @IsString() @Length(3, SUBJECT_MAX) subject!: string;
  @IsString() @Length(1, BODY_MAX) body!: string;
}

export class ContactDto {
  @IsOptional() @IsString() @MaxLength(120) name?: string;
  @IsOptional() @IsEmail() @MaxLength(254) email?: string;
  @IsOptional() @IsString() @MaxLength(20) phone?: string;
}

export class StaffCreateTicketDto {
  @IsOptional() @IsUUID() requesterId?: string;
  @IsOptional() @ValidateNested() @Type(() => ContactDto) requesterContact?: ContactDto;
  @IsOptional() @IsUUID() orderId?: string;
  @IsOptional() @IsUUID() shipmentId?: string;
  @IsIn(TICKET_CHANNELS) channel!: (typeof TICKET_CHANNELS)[number];
  @IsIn(TICKET_CATEGORIES) category!: (typeof TICKET_CATEGORIES)[number];
  @IsOptional() @IsIn(TICKET_PRIORITIES) priority?: (typeof TICKET_PRIORITIES)[number];
  @IsString() @Length(3, SUBJECT_MAX) subject!: string;
  @IsString() @Length(1, BODY_MAX) body!: string;
  @IsOptional() @IsBoolean() assignToMe?: boolean;
}

export class MessageDto {
  @IsString() @Length(1, BODY_MAX) body!: string;
}

export class StaffReplyDto {
  @IsString() @Length(1, BODY_MAX) body!: string;
  /** Estado en que queda el ticket; por defecto pending_customer (esperando al cliente). */
  @IsOptional() @IsIn(REPLY_STATUSES) status?: (typeof REPLY_STATUSES)[number];
  @IsOptional() @IsInt() @Min(1) expectedVersion?: number;
}

export class AssignTicketDto {
  /** null desasigna. */
  @ValidateIf((_o, v) => v !== null) @IsUUID() agentId!: string | null;
  @IsOptional() @IsInt() @Min(1) expectedVersion?: number;
}

export class VersionDto {
  @IsOptional() @IsInt() @Min(1) expectedVersion?: number;
}

export class UpdateTicketDto {
  @IsOptional() @IsIn(TICKET_STATUSES) status?: (typeof TICKET_STATUSES)[number];
  @IsOptional() @IsIn(TICKET_PRIORITIES) priority?: (typeof TICKET_PRIORITIES)[number];
  @IsOptional() @IsIn(TICKET_CATEGORIES) category?: (typeof TICKET_CATEGORIES)[number];
  @IsOptional() @IsInt() @Min(1) expectedVersion?: number;
}

export class CsatDto {
  @IsInt() @Min(1) @Max(5) score!: number;
  @IsOptional() @IsString() @MaxLength(CSAT_COMMENT_MAX) comment?: string;
}

export class MyTicketsQuery {
  @IsOptional() @Transform(csv) @IsArray() @ArrayMaxSize(TICKET_STATUSES.length) @IsIn(TICKET_STATUSES, { each: true })
  status?: (typeof TICKET_STATUSES)[number][];
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit: number = 20;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(10_000) offset: number = 0;
}

export class TicketQueueQuery extends MyTicketsQuery {
  @IsOptional() @Transform(csv) @IsArray() @ArrayMaxSize(TICKET_PRIORITIES.length) @IsIn(TICKET_PRIORITIES, { each: true })
  priority?: (typeof TICKET_PRIORITIES)[number][];
  @IsOptional() @Transform(csv) @IsArray() @ArrayMaxSize(TICKET_CATEGORIES.length) @IsIn(TICKET_CATEGORIES, { each: true })
  category?: (typeof TICKET_CATEGORIES)[number][];
  /** uuid del agente, "me" (yo) o "none" (sin asignar). */
  @IsOptional() @IsString() @Matches(/^(me|none|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i) assignedTo?: string;
  @IsOptional() @IsUUID() orderId?: string;
  @IsOptional() @IsUUID() requesterId?: string;
  @IsOptional() @Matches(/^\d{1,18}$/) number?: string;
  /** true: SLA vencido y sin resolver. */
  @IsOptional() @Transform(({ value }) => (value === undefined ? undefined : value === 'true' || value === true)) @IsBoolean() overdue?: boolean;
}
