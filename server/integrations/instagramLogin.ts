import axios from 'axios';

const INSTAGRAM_GRAPH = 'https://graph.instagram.com';

export interface MetaInstagramAccount {
  id: string;
  userId?: string;
  username: string;
  profilePictureUrl?: string;
  followersCount?: number;
  mediaCount?: number;
}

export interface InstagramLoginTokens {
  accessToken: string;
  userId: string;
  permissions: string[];
  expiresIn: number;
}

export async function exchangeInstagramLoginCode(input: {
  appId: string;
  appSecret: string;
  code: string;
  redirectUri: string;
}): Promise<InstagramLoginTokens> {
  const form = new URLSearchParams({
    client_id: input.appId,
    client_secret: input.appSecret,
    grant_type: 'authorization_code',
    redirect_uri: input.redirectUri,
    code: input.code,
  });
  const short = await axios.post('https://api.instagram.com/oauth/access_token', form.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  const shortToken = String(short.data?.access_token || '');
  const userId = String(short.data?.user_id || '');
  if (!shortToken || !userId) throw new Error('Instagram 未返回账号授权令牌');
  const long = await axios.get(`${INSTAGRAM_GRAPH}/access_token`, {
    params: {
      grant_type: 'ig_exchange_token',
      client_secret: input.appSecret,
      access_token: shortToken,
    },
  });
  const accessToken = String(long.data?.access_token || '');
  const expiresIn = Number(long.data?.expires_in || 0);
  if (!accessToken || !Number.isFinite(expiresIn) || expiresIn <= 0) throw new Error('Instagram 未返回有效的长期授权令牌');
  return {
    accessToken,
    userId,
    permissions: Array.isArray(short.data?.permissions)
      ? short.data.permissions.map(String)
      : typeof short.data?.permissions === 'string'
        ? short.data.permissions.split(',').map((scope: string) => scope.trim()).filter(Boolean)
        : [],
    expiresIn,
  };
}

export async function getInstagramLoginAccount(accessToken: string, graphVersion: string): Promise<MetaInstagramAccount> {
  const response = await axios.get(`${INSTAGRAM_GRAPH}/${graphVersion}/me`, {
    params: {
      fields: 'id,user_id,username,profile_picture_url,followers_count,media_count',
      access_token: accessToken,
    },
  });
  const account = response.data;
  if (!account?.id) throw new Error('Instagram token 无法读取专业账号信息');
  return {
    id: String(account.id),
    userId: account.user_id ? String(account.user_id) : undefined,
    username: String(account.username || 'Instagram'),
    profilePictureUrl: account.profile_picture_url,
    followersCount: Number(account.followers_count || 0),
    mediaCount: Number(account.media_count || 0),
  };
}

/** Meta permits refreshing an unexpired long-lived IG User token after its first 24 hours. */
export async function refreshInstagramLoginToken(accessToken: string): Promise<{ accessToken: string; expiresIn: number }> {
  const response = await axios.get(`${INSTAGRAM_GRAPH}/refresh_access_token`, {
    params: { grant_type: 'ig_refresh_token', access_token: accessToken },
  });
  const nextToken = String(response.data?.access_token || '');
  const expiresIn = Number(response.data?.expires_in || 0);
  if (!nextToken || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error('Instagram 未返回有效的续期令牌');
  }
  return { accessToken: nextToken, expiresIn };
}
