export type SocialImageProductionMode = 'single' | 'gif' | 'carousel';

export function inferSocialImageProductionMode(input: {
  imageUrls?: string[];
  imageCount?: number;
  thumbnail?: string;
  mediaUrl?: string;
  isAnimated?: boolean;
}): SocialImageProductionMode {
  const urls = [input.mediaUrl, input.thumbnail, ...(input.imageUrls || [])]
    .map(value => String(value || '').trim())
    .filter(Boolean);
  if (input.isAnimated || urls.some(url => /\.gif(?:[?#]|$)/i.test(url) || /(?:format|fm)=gif(?:[&#]|$)/i.test(url))) return 'gif';
  if (Math.max(Number(input.imageCount || 0), input.imageUrls?.length || 0) > 1) return 'carousel';
  return 'single';
}

export function imageTypeForProductionMode(mode: SocialImageProductionMode) {
  if (mode === 'gif') return 'gif_poster' as const;
  if (mode === 'carousel') return 'carousel' as const;
  return 'product_poster' as const;
}

export function productionModeFromDelivery(format?: string): SocialImageProductionMode {
  if (format === 'gif') return 'gif';
  if (format === 'carousel') return 'carousel';
  return 'single';
}
