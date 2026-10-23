type ScopeEnvironment = Record<string, string | undefined>;

function enabled(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on', 'enabled'].includes(String(value || '').trim().toLowerCase());
}

export function tikTokDirectPostApproved(env: ScopeEnvironment = process.env): boolean {
  return String(env.TIKTOK_DIRECT_POST_RELEASE_MODE || '').trim().toLowerCase() === 'approved';
}

export function tikTokOAuthScopes(env: ScopeEnvironment = process.env): string[] {
  const scopes = ['user.info.basic'];
  if (enabled(env.TIKTOK_READ_FEATURES_ENABLED)) {
    scopes.push('user.info.profile', 'user.info.stats', 'video.list');
  }
  if (tikTokDirectPostApproved(env)) scopes.push('video.publish');
  return scopes;
}

export function metaOAuthScopes(
  platform: 'facebook' | 'instagram' | 'combined' | 'messenger',
  env: ScopeEnvironment = process.env,
): string[] {
  const scopes = new Set(['pages_show_list', 'pages_read_engagement']);
  if (platform === 'messenger') return [...scopes, 'pages_messaging', 'pages_manage_metadata'];
  if (platform === 'facebook' || platform === 'combined') {
    scopes.add('pages_manage_posts');
    scopes.add('pages_messaging');
    scopes.add('pages_manage_metadata');
  }
  if (platform === 'instagram' || platform === 'combined') {
    scopes.add('instagram_basic');
    scopes.add('instagram_content_publish');
  }
  if (enabled(env.META_INSTAGRAM_MESSAGING_FEATURES_ENABLED)) {
    scopes.add('instagram_basic');
    scopes.add('instagram_manage_messages');
    scopes.add('pages_manage_metadata');
  }
  if (enabled(env.META_COMMENTS_FEATURES_ENABLED)) {
    scopes.add('pages_read_user_content');
    scopes.add('instagram_manage_comments');
  }
  if (enabled(env.META_INSIGHTS_FEATURES_ENABLED)) {
    scopes.add('read_insights');
    scopes.add('instagram_manage_insights');
  }
  if (enabled(env.META_WEBHOOK_FEATURES_ENABLED)) scopes.add('pages_manage_metadata');
  if (enabled(env.META_BUSINESS_ASSET_FEATURES_ENABLED)) scopes.add('business_management');
  return Array.from(scopes);
}

/** Instagram Login grants IG User tokens independently of a Facebook Page. */
export function instagramLoginOAuthScopes(env: ScopeEnvironment = process.env): string[] {
  const scopes = [
    'instagram_business_basic',
    'instagram_business_manage_messages',
  ];
  if (enabled(env.INSTAGRAM_CONTENT_PUBLISH_ENABLED)) scopes.push('instagram_business_content_publish');
  if (enabled(env.INSTAGRAM_COMMENTS_FEATURES_ENABLED)) scopes.push('instagram_business_manage_comments');
  return scopes;
}

export function youtubeOAuthScopes(env: ScopeEnvironment = process.env): string[] {
  const scopes = [
    'https://www.googleapis.com/auth/youtube.upload',
    'https://www.googleapis.com/auth/youtube.readonly',
  ];
  if (enabled(env.YOUTUBE_COMMENT_FEATURES_ENABLED)) {
    scopes.push('https://www.googleapis.com/auth/youtube.force-ssl');
  }
  if (enabled(env.YOUTUBE_ANALYTICS_FEATURES_ENABLED)) {
    scopes.push('https://www.googleapis.com/auth/yt-analytics.readonly');
  }
  return scopes;
}
