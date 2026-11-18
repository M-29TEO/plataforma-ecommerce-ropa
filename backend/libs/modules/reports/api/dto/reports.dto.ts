import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { EXPORT_FORMATS, ExportFormat } from '../../domain/export-job';
import { GROUP_BY, REPORT_KINDS, ReportKind } from '../../domain/report';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Todas las dimensiones conocidas; que la dimensión sirva para ese reporte lo valida el dominio (422 con los permitidos). */
const ALL_GROUPS = [...new Set(Object.values(GROUP_BY).flat())];

/** Fechas AAAA-MM-DD en hora de Ecuador, ambas incluidas. Sin fechas: últimos 30 días. */
export class RangeQuery {
  @IsOptional() @Matches(DATE, { message: 'from debe tener el formato AAAA-MM-DD' }) from?: string;
  @IsOptional() @Matches(DATE, { message: 'to debe tener el formato AAAA-MM-DD' }) to?: string;
}

/** groupBy: aquí, que sea una dimensión conocida; en el dominio, que sirva para ese reporte. */
export class ReportQueryDto extends RangeQuery {
  @IsOptional() @IsString() @MaxLength(40) @IsIn(ALL_GROUPS) groupBy?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1000) limit?: number;
}

export class CreateExportDto extends RangeQuery {
  @IsIn(REPORT_KINDS) report!: ReportKind;
  @IsIn(EXPORT_FORMATS) format!: ExportFormat;
  @IsOptional() @IsString() @MaxLength(40) @IsIn(ALL_GROUPS) groupBy?: string;
}

export class ListExportsQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}
