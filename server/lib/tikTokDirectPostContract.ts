import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ffmpegStatic from 'ffmpeg-static';

export interface TikTokDirectPostOptions {
  privacyLevel: 'PUBLIC_TO_EVERYONE' | 'MUTUAL_FOLLOW_FRIENDS' | 'FOLLOWER_OF_CREATOR' | 'SELF_ONLY';
  allowComment: boolean; allowDuet: boolean; allowStitch: boolean;
  commercial: { ownBrand: boolean; brandedContent: boolean };
  isAigc: boolean; musicUsageConfirmed: boolean; userConsent: boolean;
}
export interface TikTokCreatorInfo {
  creator_username: string; creator_nickname: string; privacy_level_options: string[];
  comment_disabled: boolean; duet_disabled: boolean; stitch_disabled: boolean; max_video_post_duration_sec: number;
}
export interface TikTokAttemptPreparedReceipt {
  version: 1; tenantId: string; accountId: string; attemptId: string; accountIdentityHash: string;
  creator: TikTokCreatorInfo; options: TikTokDirectPostOptions;
  videoSha256: string; videoSize: number; durationSeconds: number; validatedAt: string; receiptHash: string;
}
export const tikTokContractHash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function tikTokAccountIdentityHash(input: { tenantId: string; accountId: string; providerAccountId: string; accessToken: string }): string {
  return tikTokContractHash({ tenantId: input.tenantId, accountId: input.accountId, providerAccountId: input.providerAccountId, tokenHash: tikTokContractHash(input.accessToken) });
}
export function validateTikTokCreatorInfo(value: unknown): TikTokCreatorInfo {
  const info = value as TikTokCreatorInfo;
  if (!info || typeof info.creator_username !== 'string' || !info.creator_username.trim() || typeof info.creator_nickname !== 'string' || !info.creator_nickname.trim() || !Array.isArray(info.privacy_level_options) || !info.privacy_level_options.length || new Set(info.privacy_level_options).size !== info.privacy_level_options.length || !info.privacy_level_options.every(value => ['PUBLIC_TO_EVERYONE','MUTUAL_FOLLOW_FRIENDS','FOLLOWER_OF_CREATOR','SELF_ONLY'].includes(value))
    || !['comment_disabled','duet_disabled','stitch_disabled'].every(key => typeof (info as unknown as Record<string, unknown>)[key] === 'boolean')
    || !Number.isFinite(info.max_video_post_duration_sec) || info.max_video_post_duration_sec <= 0) throw Error('tiktok_creator_info_invalid');
  return { creator_username: info.creator_username, creator_nickname: info.creator_nickname, privacy_level_options: [...info.privacy_level_options], comment_disabled: info.comment_disabled, duet_disabled: info.duet_disabled, stitch_disabled: info.stitch_disabled, max_video_post_duration_sec: info.max_video_post_duration_sec };
}
export function parseTikTokDirectPostOptions(value: unknown): TikTokDirectPostOptions {
  const options = value as TikTokDirectPostOptions;
  if (!options || !['PUBLIC_TO_EVERYONE','MUTUAL_FOLLOW_FRIENDS','FOLLOWER_OF_CREATOR','SELF_ONLY'].includes(options.privacyLevel)
    || options.userConsent !== true || options.musicUsageConfirmed !== true
    || !['allowComment','allowDuet','allowStitch','isAigc'].every(key => typeof (options as unknown as Record<string, unknown>)[key] === 'boolean')
    || !options.commercial || typeof options.commercial.ownBrand !== 'boolean' || typeof options.commercial.brandedContent !== 'boolean') throw Error('tiktok_explicit_post_consent_required');
  return { privacyLevel: options.privacyLevel, allowComment: options.allowComment, allowDuet: options.allowDuet, allowStitch: options.allowStitch, commercial: { ownBrand: options.commercial.ownBrand, brandedContent: options.commercial.brandedContent }, isAigc: options.isAigc, musicUsageConfirmed: true, userConsent: true };
}
export function validateTikTokPostChoices(creator: TikTokCreatorInfo, options: TikTokDirectPostOptions): void {
  if (!creator.privacy_level_options.includes(options.privacyLevel)) throw Error('tiktok_privacy_level_mismatch');
  if ((creator.comment_disabled && options.allowComment) || (creator.duet_disabled && options.allowDuet) || (creator.stitch_disabled && options.allowStitch)) throw Error('tiktok_interaction_disabled');
  if (options.commercial.brandedContent && options.privacyLevel === 'SELF_ONLY') throw Error('tiktok_branded_content_cannot_be_private');
}
export function prepareTikTokAttemptReceipt(input: Omit<TikTokAttemptPreparedReceipt, 'version' | 'receiptHash'>): TikTokAttemptPreparedReceipt {
  const creator = validateTikTokCreatorInfo(input.creator), options = parseTikTokDirectPostOptions(input.options);
  if (!input.tenantId || !input.accountId || !input.attemptId || !/^[a-f0-9]{64}$/.test(input.accountIdentityHash) || !/^[a-f0-9]{64}$/.test(input.videoSha256)) throw Error('tiktok_attempt_identity_invalid');
  if (!options || options.userConsent !== true || options.musicUsageConfirmed !== true || !['allowComment','allowDuet','allowStitch','isAigc'].every(key => typeof (options as unknown as Record<string, unknown>)[key] === 'boolean') || !options.commercial || typeof options.commercial.ownBrand !== 'boolean' || typeof options.commercial.brandedContent !== 'boolean') throw Error('tiktok_explicit_post_consent_required');
  validateTikTokPostChoices(creator, options);
  if (!Number.isFinite(input.durationSeconds) || input.durationSeconds <= 0 || input.durationSeconds > creator.max_video_post_duration_sec) throw Error('tiktok_video_duration_invalid');
  if (!Number.isInteger(input.videoSize) || input.videoSize <= 0 || input.videoSize > 64 * 1024 * 1024) throw Error('tiktok_single_chunk_size_invalid');
  if (!Number.isFinite(Date.parse(input.validatedAt)) || Date.parse(input.validatedAt) > Date.now() + 60_000) throw Error('tiktok_validation_timestamp_invalid');
  const receipt = { version: 1 as const, ...input, creator, options: structuredClone(options) };
  return { ...receipt, receiptHash: tikTokContractHash(receipt) };
}
export function assertTikTokAttemptReceipt(receipt: TikTokAttemptPreparedReceipt, expected: { tenantId: string; accountId: string; accountIdentityHash: string; attemptId?: string }): void {
  if (!receipt || receipt.version !== 1 || receipt.tenantId !== expected.tenantId || receipt.accountId !== expected.accountId || receipt.accountIdentityHash !== expected.accountIdentityHash || (expected.attemptId && receipt.attemptId !== expected.attemptId)) throw Error('tiktok_attempt_scope_changed');
  const { receiptHash, ...content } = receipt;
  if (tikTokContractHash(content) !== receiptHash || prepareTikTokAttemptReceipt(content).receiptHash !== receiptHash) throw Error('tiktok_attempt_receipt_changed');
}
export async function probeTikTokVideoDuration(filePath: string): Promise<number> {
  if (!ffmpegStatic) throw Error('tiktok_media_probe_unavailable');
  let output = '';
  try { const result = await promisify(execFile)(String(ffmpegStatic), ['-hide_banner', '-i', filePath, '-f', 'null', '-'], { timeout: 30_000, maxBuffer: 1024 * 1024 }); output = result.stderr; }
  catch { throw Error('tiktok_media_probe_failed'); }
  const match = output.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const duration = match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : NaN;
  if (!Number.isFinite(duration) || duration <= 0 || !fs.statSync(filePath).size) throw Error('tiktok_media_duration_unverified');
  return duration;
}
