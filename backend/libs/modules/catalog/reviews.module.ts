import { Module } from '@nestjs/common';
import { APP_CONFIG, AppConfig, createObjectStorage } from '../../shared-kernel';
import { IamModule } from '../iam';
import { OrdersModule } from '../orders';
import {
  CustomerReviewsController,
  MyReviewsController,
  ProductReviewsController,
  QuestionModerationController,
  ReviewModerationController,
} from './api/reviews.controller';
import { QuestionRepository, ReviewPhotoStorage, ReviewRepository } from './application/review-ports';
import { ReviewService } from './application/review.service';
import { CatalogPersonalDataContributor } from './infrastructure/personal-data.contributor';
import { PgQuestionRepository } from './infrastructure/pg-question.repository';
import { PgReviewRepository } from './infrastructure/pg-review.repository';

/**
 * Reseñas con fotos y preguntas y respuestas (schema catalog). Va en un módulo aparte de
 * CatalogModule porque necesita Pedidos (compra verificada) e IAM (nombre del autor), y
 * CatalogModule lo importan Carrito, Checkout y Posventa: así no se arma un ciclo si algún día
 * Pedidos necesita el catálogo.
 */
@Module({
  imports: [OrdersModule, IamModule],
  controllers: [ProductReviewsController, CustomerReviewsController, MyReviewsController, ReviewModerationController, QuestionModerationController],
  providers: [
    { provide: ReviewRepository, useClass: PgReviewRepository },
    { provide: QuestionRepository, useClass: PgQuestionRepository },
    {
      provide: ReviewPhotoStorage,
      inject: [APP_CONFIG],
      useFactory: (c: AppConfig) => createObjectStorage(c.catalog.reviewPhotoStorage, c.catalog.seaweedFilerUrl),
    },
    ReviewService,
    CatalogPersonalDataContributor,
  ],
})
export class CatalogReviewsModule {}
