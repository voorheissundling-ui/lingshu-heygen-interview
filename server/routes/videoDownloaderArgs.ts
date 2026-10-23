/** Pure yt-dlp command construction. Runtime proxy, browser and executable are supplied by the caller. */
export interface VideoDownloaderArgContext {
  userAgent: string;
  proxy: string;
  cookiesBrowser: string;
  nodeExecutable: string;
  youtubeEjsEnabled: boolean;
}

export function platformReferer(url: string): string {
  if (/^ytsearch\d*:/i.test(String(url || '').trim())) return 'https://www.youtube.com/';
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    if (host.includes('tiktok.com')) return 'https://www.tiktok.com/';
    if (host.includes('instagram.com')) return 'https://www.instagram.com/';
    if (host.includes('facebook.com')) return 'https://www.facebook.com/';
    if (host.includes('youtube.com') || host.includes('youtu.be')) return 'https://www.youtube.com/';
  } catch { /* ignore */ }
  return '';
}

export function buildVideoDownloaderArgs(
  extra: string[], url: string, withCookies: boolean, context: VideoDownloaderArgContext,
): string[] {
  const referer = platformReferer(url);
  const args = [
    '-m', 'yt_dlp',
    '--ignore-config',
    '--no-warnings',
    '--user-agent', context.userAgent,
    '--add-header', 'Accept-Language: en-US,en;q=0.9',
  ];
  // ytsearchN:<keyword> is a pseudo URL; use a stable origin, never the search text as a header.
  if (referer) args.push('--referer', referer);
  args.push(...extra);
  if ((/^ytsearch\d*:/i.test(url) || /youtube\.com|youtu\.be/i.test(url)) && context.youtubeEjsEnabled) {
    args.push('--js-runtimes', `node:${context.nodeExecutable}`, '--remote-components', 'ejs:github');
  }
  if (context.proxy) args.push('--proxy', context.proxy);
  if (withCookies) args.push('--cookies-from-browser', context.cookiesBrowser);
  args.push(url);
  return args;
}
