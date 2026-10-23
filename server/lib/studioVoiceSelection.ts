/** Verified against MiniMax's official system voice catalog. */
export const MINIMAX_ENGLISH_PRESETS = {
  v1: { voiceId: 'English_Graceful_Lady', gender: 'female' },
  v2: { voiceId: 'English_Trustworthy_Man', gender: 'male' },
  v3: { voiceId: 'Serene_Woman', gender: 'female' },
} as const;
/** MiniMax already applies speed during synthesis. Other providers here use
 * audio post-processing; never speed up MiniMax a second time. */
export function ttsPostProcessingSpeed(provider: string, requestedSpeed: number) {
  return provider === 'minimax' ? 1 : Math.max(.75, Math.min(1.35, requestedSpeed || 1));
}
