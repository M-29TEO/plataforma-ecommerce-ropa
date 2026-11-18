import { BadRequestException, Controller, Headers, HttpCode, Param, Post, RawBodyRequest, Req, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { MatchesPipe, Public } from '../../../shared-kernel';
import { WebhookService } from '../application/webhook.service';

/** Nombre de pasarela en la URL: se acota antes de usarlo en consultas o en el log. */
const PROVIDER_RE = /^[a-z0-9-]{1,30}$/;

/**
 * Webhooks de las pasarelas. Sin autenticación de usuario: la autenticidad la da la firma HMAC
 * del cuerpo CRUDO (req.rawBody, requiere NestFactory.create(..., { rawBody: true })).
 *
 * 200 = recibido (procesado, duplicado o sin efecto): la pasarela no debe reintentar.
 * 401 = firma inválida (no se guarda nada; queda una línea en el log). 5xx = error nuestro: reintentar.
 */
@Controller('webhooks/payments')
@Public()
export class PaymentWebhooksController {
  constructor(private readonly webhooks: WebhookService) {}

  @Post(':provider')
  @HttpCode(200)
  async receive(@Param('provider', new MatchesPipe(PROVIDER_RE, 'pasarela')) provider: string, @Req() req: RawBodyRequest<Request>, @Headers() headers: Record<string, string>) {
    if (!req.rawBody?.length) throw new BadRequestException('Cuerpo vacío');
    const result = await this.webhooks.receive(provider, req.rawBody, headers);
    if (result.outcome === 'invalid_signature') throw new UnauthorizedException('Firma del webhook inválida');
    return { received: true, ...result };
  }
}
