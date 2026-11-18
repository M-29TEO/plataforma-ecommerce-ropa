import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { Audited, Auth, AuthUser, CurrentUser, OptionalAuth, RateLimit, RequirePermission, sendStoredFile, StoredObject, TenantId } from '../../../shared-kernel';
import { PhotoFile, ReviewService } from '../application/review.service';
import { REVIEW_PHOTO_MAX_BYTES } from '../domain/review';
import { AnswerDto, AskQuestionDto, CreateReviewDto, ModerationQueueQuery, PublicPageQuery, PublicReviewsQuery, QuestionQueueQuery, RejectDto } from './dto/reviews.dto';

function customerOnly(user: AuthUser): void {
  if (user.type !== 'customer') throw new ForbiddenException('Solo para clientes');
}

function sendPhoto(res: Response, file: StoredObject, cache: string): void {
  sendStoredFile(res, file, { cache });
}

/** Lectura pública (invitado con X-Tenant-Id o cliente con sesión): reseñas aprobadas y preguntas publicadas. */
@Controller('products/:productId')
@OptionalAuth()
export class ProductReviewsController {
  constructor(private readonly reviews: ReviewService) {}

  @Get('reviews')
  list(@TenantId() tenantId: string, @Param('productId', ParseUUIDPipe) productId: string, @Query() q: PublicReviewsQuery) {
    return this.reviews.listPublic(tenantId, productId, {
      rating: q.rating,
      withPhotos: q.withPhotos === 'true',
      verifiedOnly: q.verifiedOnly === 'true',
      sort: q.sort,
      limit: q.limit,
      offset: q.offset,
    });
  }

  @Get('reviews/:reviewId/photos/:index')
  async photo(
    @TenantId() tenantId: string,
    @Param('productId', ParseUUIDPipe) productId: string,
    @Param('reviewId', ParseUUIDPipe) reviewId: string,
    @Param('index', ParseIntPipe) index: number,
    @Res() res: Response,
  ) {
    sendPhoto(res, await this.reviews.photo(tenantId, reviewId, index, { productId }), 'public, max-age=3600');
  }

  @Get('questions')
  questions(@TenantId() tenantId: string, @Param('productId', ParseUUIDPipe) productId: string, @Query() q: PublicPageQuery) {
    return this.reviews.listQuestions(tenantId, productId, q.limit, q.offset);
  }
}

/** El cliente reseña y pregunta. */
@Controller('products/:productId')
export class CustomerReviewsController {
  constructor(private readonly reviews: ReviewService) {}

  /** Queda pendiente de moderación. verifiedPurchase indica si se ligó a un pedido entregado. */
  @Post('reviews')
  @Auth()
  @RateLimit('lookup') // anti-spam: reseñas en ráfaga
  async create(@CurrentUser() user: AuthUser, @Param('productId', ParseUUIDPipe) productId: string, @Body() dto: CreateReviewDto) {
    customerOnly(user);
    const { review, verifiedPurchase } = await this.reviews.create({ tenantId: user.tenantId, userId: user.id, productId, ...dto });
    const { userId: _u, moderatedBy: _m, photos, ...rest } = review;
    return { ...rest, verifiedPurchase, photoCount: photos.length };
  }

  @Post('questions')
  @Auth()
  @RateLimit('lookup') // anti-spam: preguntas en ráfaga
  async ask(@CurrentUser() user: AuthUser, @Param('productId', ParseUUIDPipe) productId: string, @Body() dto: AskQuestionDto) {
    customerOnly(user);
    const { userId: _u, moderatedBy: _m, ...q } = await this.reviews.ask(user.tenantId, user.id, productId, dto.body);
    return q;
  }
}

@Controller('me/reviews')
export class MyReviewsController {
  constructor(private readonly reviews: ReviewService) {}

  @Get()
  @Auth()
  mine(@CurrentUser() user: AuthUser) {
    customerOnly(user);
    return this.reviews.mine(user.tenantId, user.id);
  }

  /** multipart con el campo "photo" (jpg, png o webp, hasta 5 MB). Devuelve la clave para la reseña. */
  @Post('photos')
  @Auth()
  @UseInterceptors(FileInterceptor('photo', { limits: { fileSize: REVIEW_PHOTO_MAX_BYTES + 1, files: 1 } }))
  @RateLimit('lookup') // cada foto ocupa hasta 5 MB en el almacén
  upload(@CurrentUser() user: AuthUser, @UploadedFile() file: PhotoFile | undefined) {
    customerOnly(user);
    return this.reviews.uploadPhoto(user.tenantId, user.id, file);
  }
}

/** Backoffice: cola de moderación de reseñas (con marcas automáticas) y sus fotos. */
@Controller('catalog/reviews')
export class ReviewModerationController {
  constructor(private readonly reviews: ReviewService) {}

  @Get()
  @RequirePermission('catalog.reviews.moderate')
  queue(@CurrentUser() user: AuthUser, @Query() q: ModerationQueueQuery) {
    return this.reviews.queue(user.tenantId, q.status, q.limit, q.offset);
  }

  @Get(':id/photos/:index')
  @RequirePermission('catalog.reviews.moderate')
  async photo(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('index', ParseIntPipe) index: number, @Res() res: Response) {
    sendPhoto(res, await this.reviews.photo(user.tenantId, id, index, { staff: true }), 'private, no-store');
  }

  @Post(':id/approve')
  @HttpCode(200)
  @RequirePermission('catalog.reviews.moderate')
  @Audited('catalog.review.approve', { entity: 'review' })
  approve(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.reviews.approve(user.tenantId, id, user.id);
  }

  @Post(':id/reject')
  @HttpCode(200)
  @RequirePermission('catalog.reviews.moderate')
  @Audited('catalog.review.reject', { entity: 'review' })
  reject(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RejectDto) {
    return this.reviews.reject(user.tenantId, id, user.id, dto.reason);
  }
}

/** Backoffice: preguntas pendientes, publicación y respuestas oficiales. */
@Controller('catalog/questions')
export class QuestionModerationController {
  constructor(private readonly reviews: ReviewService) {}

  @Get()
  @RequirePermission('catalog.questions.answer')
  queue(@CurrentUser() user: AuthUser, @Query() q: QuestionQueueQuery) {
    return this.reviews.questionQueue(user.tenantId, q.status, q.limit, q.offset);
  }

  @Post(':id/publish')
  @HttpCode(200)
  @RequirePermission('catalog.questions.answer')
  @Audited('catalog.question.publish', { entity: 'question' })
  publish(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.reviews.publishQuestion(user.tenantId, id, user.id);
  }

  @Post(':id/reject')
  @HttpCode(200)
  @RequirePermission('catalog.questions.answer')
  @Audited('catalog.question.reject', { entity: 'question' })
  reject(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RejectDto) {
    return this.reviews.rejectQuestion(user.tenantId, id, user.id, dto.reason);
  }

  @Post(':id/answers')
  @RequirePermission('catalog.questions.answer')
  @Audited('catalog.question.answer', { entity: 'question' })
  answer(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AnswerDto) {
    return this.reviews.answer(user.tenantId, id, user.id, dto.body);
  }
}
