import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';

/** payload.firma en base64url (ver signTicketAccess); un enlace real ronda los 200 caracteres. */
const TICKET_TOKEN = /^[A-Za-z0-9_-]{1,512}\.[A-Za-z0-9_-]{1,86}$/;
const MAX_LENGTH = 600;

/**
 * Rechaza con 400 lo que no tiene forma de enlace de ticket antes de calcular HMAC o decodificar
 * JSON: rutas públicas sin sesión, así que no se le regala trabajo (ni logs enormes) a quien sondea.
 */
@Injectable()
export class TicketTokenPipe implements PipeTransform<unknown, string> {
  transform(value: unknown): string {
    if (typeof value !== 'string' || value.length > MAX_LENGTH || !TICKET_TOKEN.test(value)) {
      throw new BadRequestException('Enlace de ticket con formato inválido');
    }
    return value;
  }
}
