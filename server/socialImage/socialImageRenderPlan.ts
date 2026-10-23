import type { SocialImageContentType } from '../../shared/contracts/socialImageCreation.js';
import { socialImageUnitPoster } from './socialImageFirstDraft.js';

export type SocialImageRenderUnit = {
  index: number;
  count: number;
  label: string;
  role: 'single' | 'carousel_page' | 'gif_plate';
  poster: Record<string, unknown>;
  idempotencyKey: string;
};

/** A bounded deterministic unit plan; every paid output has its own receipt key. */
export function planSocialImageRenderUnits(input: {
  imageType: SocialImageContentType;
  poster: Record<string, unknown>;
  idempotencyKey: string;
  requestedCount?: number;
}): SocialImageRenderUnit[] {
  const multi = input.imageType === 'carousel' || input.imageType === 'gif_poster';
  const count = multi ? Math.max(2, Math.min(4, Math.floor(Number(input.requestedCount) || 4))) : 1;
  return Array.from({ length: count }, (_, index) => ({
    index,
    count,
    label: input.imageType === 'carousel' ? `轮播第 ${index + 1} 张` : input.imageType === 'gif_poster' ? `GIF 画面 ${index + 1}` : '主视觉',
    role: input.imageType === 'carousel' ? 'carousel_page' : input.imageType === 'gif_poster' ? 'gif_plate' : 'single',
    poster: socialImageUnitPoster(input.poster, input.imageType, index, count),
    idempotencyKey: count === 1 ? input.idempotencyKey : `${input.idempotencyKey}:unit:${index + 1}`,
  }));
}

