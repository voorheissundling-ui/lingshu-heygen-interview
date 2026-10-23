import { hasDateRange } from './videoCrawlerNormalization.js';
import { tiktokUsername, tiktokVideoId } from './videoCrawlerSourceUrls.js';

/** Pure, bounded Actor request projection shared by legacy and paid transports. */
export function buildApifyTikTokInput(keyword: string, limit: number, dateFrom = '', dateTo = ''): Record<string, unknown> {
  const raw = keyword.trim();
  const account = tiktokUsername(raw);
  const videoId = tiktokVideoId(raw);
  const cleanKeyword = raw.replace(/^#/, '').trim();
  const input: Record<string, unknown> = {
    resultsPerPage: Math.min(100, Math.max(1, limit)),
    shouldDownloadVideos: false,
    shouldDownloadCovers: false,
    shouldDownloadSubtitles: false,
    shouldDownloadSlideshowImages: false,
    shouldDownloadAvatars: false,
    shouldDownloadMusicCovers: false,
    shouldDownloadMusic: false,
  };
  if (videoId) {
    input.postURLs = [raw];
  } else if (account) {
    input.profiles = [account];
  } else if (/^#[\p{L}\p{N}_-]+$/u.test(raw) || (/^[\p{L}\p{N}_-]+$/u.test(raw) && !/^(?:https?:|@)/i.test(raw))) {
    input.hashtags = [cleanKeyword];
  } else {
    input.searchQueries = [raw];
    input.searchSection = '/video';
  }
  if (hasDateRange(dateFrom, dateTo)) {
    input.oldestPostDateUnified = dateFrom || undefined;
    input.newestPostDate = dateTo || undefined;
    const windowDays = Math.abs(Date.parse(`${dateTo}T00:00:00Z`) - Date.parse(`${dateFrom}T00:00:00Z`)) / 86_400_000;
    if (Number.isFinite(windowDays) && windowDays <= 7) input.videoSearchDateFilter = 'PAST_WEEK';
  }
  return input;
}
