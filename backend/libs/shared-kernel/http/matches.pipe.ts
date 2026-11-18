import { BadRequestException, PipeTransform } from '@nestjs/common';

/**
 * Valida un parámetro suelto de la ruta (@Param('code')) contra un patrón: 400 antes de llegar al
 * servicio, a la base o al log. Para objetos se usa un DTO; esto es para strings simples.
 * Ejemplo: @Param('code', new MatchesPipe(/^[a-z_]{2,40}$/, 'código de rol')) code: string
 */
export class MatchesPipe implements PipeTransform<unknown, string> {
  constructor(
    private readonly pattern: RegExp,
    private readonly label: string,
  ) {}

  transform(value: unknown): string {
    if (typeof value !== 'string' || !this.pattern.test(value)) throw new BadRequestException(`Formato inválido: ${this.label}`);
    return value;
  }
}
