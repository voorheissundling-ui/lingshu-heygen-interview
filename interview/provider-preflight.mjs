/** Read-only provider preflight. No video generation, uploads, or billing changes. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';

const API_BASE = 'https://api.heygen.com';
const STORYBOARD_FILE = 'assets/storyboard.json';
const MAX_CATALOG_PAGES = 20;
const LANGUAGE_NAMES = {
  english: 'en',
  chinese: 'zh',
  spanish: 'es',
  french: 'fr',
  german: 'de',
  japanese: 'ja',
  korean: 'ko',
  portuguese: 'pt',
  italian: 'it',
  arabic: 'ar',
  hindi: 'hi',
  russian: 'ru',
};

function languageCode(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  return LANGUAGE_NAMES[raw] ?? raw.split(/[-_]/)[0];
}

async function main() {
  const keyFile = process.env.HEYGEN_KEY_FILE;
  if (!keyFile) throw Error('missing_HEYGEN_KEY_FILE');
  const key = (await fs.readFile(path.resolve(keyFile), 'utf8')).trim();
  if (!key || /\s/.test(key)) throw Error('key_file_must_contain_only_the_API_key');

  async function get(route) {
    const response = await fetch(API_BASE + route, {
      method: 'GET',
      redirect: 'error',
      headers: {'x-api-key': key},
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw Error('heygen_read_http_' + response.status);
    const value = await response.json();
    if (value.error || value.data == null) throw Error('heygen_read_invalid_response');
    return value;
  }

  async function readCatalog(kind) {
    const items = [];
    const pages = [];
    let token = '';
    let complete = false;
    for (let page = 0; page < MAX_CATALOG_PAGES; page += 1) {
      const prefix = kind === 'avatars'
        ? '/v3/avatars/looks?ownership=public'
        : '/v3/voices?type=public';
      const route = `${prefix}&limit=50${token ? `&token=${encodeURIComponent(token)}` : ''}`;
      const value = await get(route);
      if (!Array.isArray(value.data)) throw Error('heygen_catalog_shape_unverified');
      const hasMore = value.has_more === true || value.has_more === 'true';
      items.push(...value.data);
      pages.push({count: value.data.length, hasMore});
      if (!hasMore) {
        complete = true;
        break;
      }
      const next = String(value.next_token ?? value.token ?? '');
      if (!next || next === token) break;
      token = next;
    }
    return {items, pages, complete};
  }

  const [account, avatars, voices] = await Promise.all([
    get('/v3/users/me'),
    readCatalog('avatars'),
    readCatalog('voices'),
  ]);

  const publicAvatars = [...new Map((avatars.items || []).map(value => [value.id, value])).values()]
    .map(value => ({
      id: value.id,
      status: value.status ?? null,
      avatarType: value.avatar_type ?? null,
      supportedEngines: Array.isArray(value.supported_api_engines) ? value.supported_api_engines : [],
    }))
    .filter(value => typeof value.id === 'string' && value.id);
  const publicVoices = [...new Map((voices.items || []).map(value => [value.voice_id, value])).values()]
    .map(value => ({
      id: value.voice_id,
      language: value.language ?? null,
      status: value.status ?? null,
      engines: Array.isArray(value.available_engines) ? value.available_engines : [],
    }))
    .filter(value => typeof value.id === 'string' && value.id);

  let storyboard = null;
  let storyboardError = null;
  try {
    storyboard = JSON.parse(await fs.readFile(STORYBOARD_FILE, 'utf8'));
  } catch {
    storyboardError = 'storyboard_unreadable';
  }
  const presenter = storyboard?.presenter || {};
  const language = String(presenter.language ?? storyboard?.language ?? '').toLowerCase();
  const avatarId = typeof presenter.avatarId === 'string' ? presenter.avatarId : '';
  const voiceId = typeof presenter.voiceId === 'string' ? presenter.voiceId : '';
  const avatar = publicAvatars.find(value => value.id === avatarId);
  const voice = publicVoices.find(value => value.id === voiceId);
  const avatarCriteriaMet = Boolean(avatar
    && avatar.status === 'completed'
    && avatar.avatarType === 'photo_avatar'
    && avatar.supportedEngines.includes('avatar_iv'));
  const voiceLanguageMatches = Boolean(voice && language
    && languageCode(voice.language) && languageCode(voice.language) === languageCode(language));
  const voiceCriteriaMet = Boolean(voice && voiceLanguageMatches);
  const catalogComplete = avatars.complete && voices.complete;
  // The IDs above are positive evidence. Catalog completeness only guards
  // against a false "not found"; it is not required once both records matched.
  const storyboardPresenterVerified = Boolean(avatarId && voiceId && avatarCriteriaMet && voiceCriteriaMet);

  const catalog = {avatars: publicAvatars, voices: publicVoices};
  const catalogSha256 = createHash('sha256').update(JSON.stringify(catalog)).digest('hex');
  const wallet = account.data.wallet;
  const billingType = account.data.billing_type ?? null;
  const currency = wallet?.currency ?? null;
  const remainingBalance = wallet?.remaining_balance ?? null;
  const autoReloadEnabled = wallet?.auto_reload?.enabled ?? null;
  const balanceNumber = Number(remainingBalance);
  const walletChecks = {
    billingTypeWallet: billingType === 'wallet',
    currencyUsd: String(currency || '').toUpperCase() === 'USD',
    nonNegativeBalance: Number.isFinite(balanceNumber) && balanceNumber >= 0,
    autoReloadDisabled: autoReloadEnabled === false,
  };
  const walletSafe = Object.values(walletChecks).every(Boolean);
  const preflightOk = walletSafe && storyboardPresenterVerified;

  const report = {
    checkedAt: new Date().toISOString(),
    mode: 'read_only_no_generation',
    billingType,
    wallet: {
      currency,
      remainingBalance,
      autoReloadEnabled,
    },
    walletChecks,
    catalog: {
      complete: catalogComplete,
      warning: catalogComplete ? null : `catalog_truncated_after_${MAX_CATALOG_PAGES}_pages`,
      paginated: avatars.pages.length > 1 || voices.pages.length > 1,
      avatarPages: avatars.pages.length,
      voicePages: voices.pages.length,
      publicAvatarCount: publicAvatars.length,
      publicVoiceCount: publicVoices.length,
      sha256: catalogSha256,
    },
    publicAvatars,
    publicVoices,
    storyboard: {
      path: STORYBOARD_FILE,
      language,
      avatarId,
      voiceId,
      avatarFound: Boolean(avatar),
      avatarCriteriaMet,
      voiceFound: Boolean(voice),
      voiceLanguageMatches,
      voiceCriteriaMet,
      verified: storyboardPresenterVerified,
      ...(storyboardError ? {error: storyboardError} : {}),
    },
    paidGenerationVerified: false,
    accountSpendingCapConfigured: false,
    preflightOk,
  };

  await fs.mkdir('.interview-data', {recursive: true});
  await fs.writeFile('.interview-data/provider-preflight.json', JSON.stringify(report, null, 2), {mode: 0o600});
  console.log(JSON.stringify({
    preflight: preflightOk ? 'READ_ONLY_COMPLETE' : 'READ_ONLY_INCOMPLETE',
    billingType,
    walletCurrency: currency,
    walletRemainingBalance: remainingBalance,
    autoReloadEnabled,
    catalogComplete,
    catalogWarning: catalogComplete ? null : `catalog_truncated_after_${MAX_CATALOG_PAGES}_pages`,
    catalogPages: {avatars: avatars.pages.length, voices: voices.pages.length},
    publicAvatarCount: publicAvatars.length,
    publicVoiceCount: publicVoices.length,
    storyboardPresenterVerified,
    paidGenerationVerified: false,
    report: '.interview-data/provider-preflight.json',
  }));
  if (!preflightOk) process.exitCode = 1;
}

main().catch(error => {
  console.error(error?.code === 'ENOENT'
    ? 'key_file_not_found'
    : String(error?.message ?? 'preflight_failed').replace(/https?:\/\/\S+/g, '[redacted-url]'));
  process.exitCode = 1;
});
