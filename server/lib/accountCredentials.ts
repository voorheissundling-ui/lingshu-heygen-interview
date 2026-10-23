import { decryptSecret, encryptSecret } from './tenantPlatformApps.js';

type CredentialRecord = Record<string, unknown>;

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function sealAccountCredential(value: unknown): string {
  const plain = text(value);
  return plain ? encryptSecret(plain) : '';
}

export function openAccountCredential(value: unknown, field: string): string {
  const stored = text(value);
  if (!stored) return '';
  const plain = decryptSecret(stored);
  if (!plain) throw new Error(`${field}_credential_unavailable`);
  return plain;
}

export function socialAccessToken(record: CredentialRecord): string {
  const token = openAccountCredential(record.accessToken, 'social_access_token');
  if (!token) throw new Error('social_access_token_required');
  return token;
}

export function socialRefreshToken(record: CredentialRecord): string {
  return openAccountCredential(record.refreshToken, 'social_refresh_token');
}

export function youtubeCredentials(record: CredentialRecord): {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  accessToken?: string;
} {
  const clientId = text(record.clientId);
  const clientSecret = openAccountCredential(record.clientSecret, 'youtube_client_secret');
  const refreshToken = openAccountCredential(record.refreshToken, 'youtube_refresh_token');
  const accessToken = openAccountCredential(record.accessToken, 'youtube_access_token');
  if (!clientId || !clientSecret || (!refreshToken && !accessToken)) throw new Error('youtube_credentials_unavailable');
  return { clientId, clientSecret, refreshToken, ...(accessToken ? { accessToken } : {}) };
}

export function sealedSocialCredentialPatch(input: { accessToken: string; refreshToken?: string }): {
  accessToken: string;
  refreshToken: string;
} {
  return {
    accessToken: sealAccountCredential(input.accessToken),
    refreshToken: sealAccountCredential(input.refreshToken),
  };
}

export function sealedYouTubeCredentialPatch(input: {
  clientSecret: string;
  refreshToken: string;
  accessToken?: string;
}): { clientSecret: string; refreshToken: string; accessToken: string } {
  return {
    clientSecret: sealAccountCredential(input.clientSecret),
    refreshToken: sealAccountCredential(input.refreshToken),
    accessToken: sealAccountCredential(input.accessToken),
  };
}

export function accountCredentialNeedsMigration(value: unknown): boolean {
  const stored = text(value);
  return Boolean(stored && !stored.startsWith('v1:'));
}
