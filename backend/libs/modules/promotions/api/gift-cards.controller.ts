import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { Audited, Auth, AuthUser, CurrentUser, OptionalAuth, RateLimit, TenantId } from '../../../shared-kernel';
import { GiftCardService } from '../application/gift-card.service';
import { AdjustGiftCardDto, GiftCardBalanceDto, IssueGiftCardDto, ListGiftCardsQuery } from './dto/promotion.dto';

@Controller('gift-cards')
export class GiftCardsController {
  constructor(private readonly giftCards: GiftCardService) {}

  /** Responde el código completo UNA sola vez (la base guarda solo su hash). */
  @Post()
  @Auth('giftcards.write')
  @Audited('promotions.giftcard.issue', { entity: 'gift_card' })
  issue(@CurrentUser() user: AuthUser, @Body() dto: IssueGiftCardDto) {
    return this.giftCards.issue({
      tenantId: user.tenantId,
      amount: dto.amount,
      recipientEmail: dto.recipientEmail,
      purchaserId: dto.purchaserId,
      expiresAt: dto.expiresAt,
      status: dto.pending ? 'pending' : 'active',
    });
  }

  /**
   * Consulta de saldo para clientes e invitados (checkout). POST para que el código no quede
   * en logs de acceso ni en el historial del navegador. Código mal formado o inexistente: 404.
   */
  @Post('balance')
  @HttpCode(200)
  @OptionalAuth()
  @RateLimit('lookup')
  balance(@TenantId() tenantId: string, @Body() dto: GiftCardBalanceDto) {
    return this.giftCards.balance(tenantId, dto.code);
  }

  @Get()
  @Auth('giftcards.read')
  list(@CurrentUser() user: AuthUser, @Query() q: ListGiftCardsQuery) {
    return this.giftCards.list(user.tenantId, q);
  }

  /** Incluye el libro de movimientos. */
  @Get(':id')
  @Auth('giftcards.read')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.giftCards.get(user.tenantId, id);
  }

  @Post(':id/adjust')
  @HttpCode(200)
  @Auth('giftcards.write')
  @Audited('promotions.giftcard.adjust', { entity: 'gift_card' })
  adjust(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AdjustGiftCardDto) {
    return this.giftCards.adjust(user.tenantId, id, dto.delta);
  }

  @Post(':id/block')
  @HttpCode(200)
  @Auth('giftcards.write')
  @Audited('promotions.giftcard.block', { entity: 'gift_card' })
  block(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.giftCards.block(user.tenantId, id);
  }

  @Post(':id/activate')
  @HttpCode(200)
  @Auth('giftcards.write')
  @Audited('promotions.giftcard.activate', { entity: 'gift_card' })
  activate(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.giftCards.activate(user.tenantId, id);
  }
}
