import { IsLatitude, IsLongitude, IsOptional, IsString, Matches, MaxLength, ValidateIf } from 'class-validator';

export class StartShiftDto {
  /** Posición actual (opcional): el despacho la usa sin esperar el siguiente POST /rider/location. */
  @IsOptional() @IsLatitude() lat?: number;
  @ValidateIf((o: StartShiftDto) => o.lat !== undefined) @IsLongitude() lng?: number;
}

/** dispatch_offers.id es bigint: viaja como string de dígitos. */
export class OfferIdParam {
  @Matches(/^[1-9]\d{0,17}$/, { message: 'id debe ser el número de la oferta' }) id!: string;
}

export class RejectOfferDto {
  @IsOptional() @IsString() @MaxLength(200) reason?: string;
}

export class EarningsQuery {
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'from debe ser AAAA-MM-DD' }) from?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'to debe ser AAAA-MM-DD' }) to?: string;
}
