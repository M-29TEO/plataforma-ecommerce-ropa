import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsOptional, IsString, Length, Matches, Max, MaxLength, Min } from 'class-validator';
import { FIT_FEEDBACK, MAX_REVIEW_PHOTOS, QUESTION_STATUSES, QuestionStatus, REVIEW_STATUSES, ReviewStatus } from '../../domain/review';
import type { ReviewSort } from '../../application/review-ports';

const SORTS: ReviewSort[] = ['recent', 'rating_desc', 'rating_asc', 'helpful'];
const PHOTO_KEY = /^reviews\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(jpg|png|webp)$/;

export class CreateReviewDto {
  @IsInt() @Min(1) @Max(5) rating!: number;
  @IsOptional() @IsIn(FIT_FEEDBACK) fitFeedback?: (typeof FIT_FEEDBACK)[number];
  @IsOptional() @IsString() @MaxLength(120) title?: string;
  @IsOptional() @IsString() @MaxLength(2000) body?: string;
  /**
   * Claves devueltas por POST /me/reviews/photos (reviews/<tenant>/<usuario>/<uuid>.<ext>). El
   * formato se corta aquí; que el prefijo sea el del propio usuario lo verifica el servicio.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_REVIEW_PHOTOS)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  @Matches(PHOTO_KEY, { each: true, message: 'photos debe contener claves devueltas por POST /me/reviews/photos' })
  photos?: string[];
}

export class AskQuestionDto {
  @IsString() @Length(10, 500) body!: string;
}

export class AnswerDto {
  @IsString() @Length(2, 2000) body!: string;
}

export class RejectDto {
  @IsString() @Length(3, 300) reason!: string;
}

export class PublicPageQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) limit: number = 10;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(10_000) offset: number = 0;
}

export class PublicReviewsQuery extends PublicPageQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(5) rating?: number;
  @IsOptional() @IsIn(['true', 'false']) withPhotos?: string;
  @IsOptional() @IsIn(['true', 'false']) verifiedOnly?: string;
  @IsOptional() @IsIn(SORTS) sort: ReviewSort = 'recent';
}

export class ModerationQueueQuery {
  @IsOptional() @IsIn(REVIEW_STATUSES) status: ReviewStatus = 'pending';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit: number = 50;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(10_000) offset: number = 0;
}

export class QuestionQueueQuery {
  @IsOptional() @IsIn(QUESTION_STATUSES) status: QuestionStatus = 'pending';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit: number = 50;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(10_000) offset: number = 0;
}
