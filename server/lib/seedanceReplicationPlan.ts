import type { DigitalHumanReferenceCue } from '../../shared/contracts/digitalHumanRequirements.js';
import { estimateSeedanceCostCny } from './seedanceBudget.js';

export type SeedanceReplicationPlan = {
  resolution: '480p' | '720p';
  cueCount: number;
  reusedCueIds: string[];
  generatedCueIds: string[];
  nonPersonCueIds: string[];
  invalidCueIds: string[];
  firstFrameCount: number;
  firstFrameEstimatedCny: number;
  videoEstimatedCny: number;
  estimatedCostCny: number;
};

/** A supplier-ready plan. Reused and non-person clips never enter paid generation. */
export function planSeedanceReplication(input: {
  cues: DigitalHumanReferenceCue[];
  reuseCueMaterialIds?: Record<string, string>;
  compositionClusterIds: string[];
  resolution: '480p' | '720p';
  firstFrameCostCny?: number;
}): SeedanceReplicationPlan {
  const reusedCueIds: string[] = [];
  const generatedCueIds: string[] = [];
  const nonPersonCueIds: string[] = [];
  const invalidCueIds: string[] = [];
  let videoEstimatedCny = 0;

  for (const cue of input.cues) {
    if (cue.personShot === false) { nonPersonCueIds.push(cue.id); continue; }
    if (input.reuseCueMaterialIds?.[cue.id]) { reusedCueIds.push(cue.id); continue; }
    const duration = Number(cue.generationDurationSeconds ?? (cue.end - cue.start));
    if (!Number.isFinite(duration) || duration < 4 - 1e-6 || duration > 15 + 1e-6) invalidCueIds.push(cue.id);
    generatedCueIds.push(cue.id);
    videoEstimatedCny += estimateSeedanceCostCny(Math.max(4, Math.ceil(duration)), input.resolution);
  }

  // The caller supplies the normalized clusters after excluding clusters whose cues are all reusable.
  const firstFrameCount = generatedCueIds.length ? new Set(input.compositionClusterIds).size : 0;
  const firstFrameEstimatedCny = firstFrameCount * (input.firstFrameCostCny && input.firstFrameCostCny > 0 ? input.firstFrameCostCny : 0.22);
  const estimatedCostCny = Math.ceil((videoEstimatedCny + firstFrameEstimatedCny) * 100) / 100;
  return { resolution: input.resolution, cueCount: input.cues.length, reusedCueIds, generatedCueIds, nonPersonCueIds, invalidCueIds, firstFrameCount, firstFrameEstimatedCny, videoEstimatedCny, estimatedCostCny };
}

export function spokenLanguageForSeedance(text: string, explicitLanguage?: string): string {
  const explicit = String(explicitLanguage || '').trim();
  if (explicit) {
    const code = explicit.toLowerCase().split(/[-_]/)[0];
    const names: Record<string, string> = { zh: 'Chinese', en: 'English', ja: 'Japanese', ko: 'Korean', ar: 'Arabic', ru: 'Russian', es: 'Spanish', fr: 'French', de: 'German', pt: 'Portuguese', it: 'Italian' };
    return names[code] || explicit;
  }
  if (/\p{Script=Hiragana}|\p{Script=Katakana}/u.test(text)) return 'Japanese';
  if (/\p{Script=Hangul}/u.test(text)) return 'Korean';
  if (/\p{Script=Arabic}/u.test(text)) return 'Arabic';
  if (/\p{Script=Cyrillic}/u.test(text)) return 'Russian';
  if (/\p{Script=Han}/u.test(text)) return 'Chinese';
  return 'English';
}

export function seedanceTalkingHeadPrompt(text: string, explicitLanguage?: string, constraints?: { action?: string; scene?: string; preserve?: string }): string {
  const language = spokenLanguageForSeedance(text, explicitLanguage);
  const action = String(constraints?.action || '').trim();
  const scene = String(constraints?.scene || '').trim();
  const preserve = String(constraints?.preserve || '').trim();
  return `Use the reference_image as the target enterprise presenter's identity, appearance, composition, and intended opening frame. Use the anonymized reference_video only for temporal motion, body performance, pacing, and camera movement; never copy identity or appearance from the video. The presenter naturally speaks in ${language} at a brisk, conversational sales pace: ${text}. Start speaking immediately, avoid opening dead air, long pauses, slow motion, time stretching, and unnaturally prolonged gestures.${action ? ` Match this action and performance contract: ${action}.` : ''}${scene ? ` Maintain this scene contract: ${scene}.` : ''}${preserve ? ` Preserve these reference-shot properties: ${preserve}.` : ''} Keep the target identity stable, with natural lip sync and motion at normal human speed. No captions, logos, UI or watermark.`;
}
