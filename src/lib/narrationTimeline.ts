import { mapNarrationCues, speechText, spokenText, type SpeechCue } from './narrationAlignment';

export interface NarrationTimelineShot {
  targetDuration: number;
  trimStart?: number;
  trimEnd?: number;
  speed?: number;
  targetStart?: number;
  targetEnd?: number;
  voiceStart?: number;
  voiceEnd?: number;
  voiceAligned?: boolean;
  narration?: string;
  lockedSourceVoice?: boolean;
  lockedDuration?: number;
  sourceCues?: SpeechCue[];
}

interface ParagraphOwner {
  text: string;
  firstShotIndex: number;
  endShotIndex: number;
  source: 'avatar' | 'mixed' | 'ai';
}

export interface NarrationTimelineResult<T extends NarrationTimelineShot> {
  timeline: T[];
  cues: SpeechCue[];
  duration: number;
  warnings: string[];
  paragraphs: Array<{ text: string; firstShot: number; lastShot: number; start: number; end: number; source: 'avatar' | 'mixed' | 'ai' }>;
}

/** Source-video cues are local to the generated clip, never to the AI voiceover. */
export function sourceCuesForShot(cues: SpeechCue[] | undefined, duration: number): SpeechCue[] {
  if (!Array.isArray(cues) || !Number.isFinite(duration) || duration <= 0) return [];
  const valid = cues.map(cue => ({ ...cue, text: String(cue.text || '').trim(), start: Number(cue.start), end: Number(cue.end) }))
    .filter(cue => cue.text && Number.isFinite(cue.start) && Number.isFinite(cue.end)
      && cue.start >= 0 && cue.end > cue.start && cue.end <= duration + 0.05)
    .sort((a, b) => a.start - b.start);
  if (valid.length !== cues.length || valid.some((cue, index) => index > 0 && cue.start < valid[index - 1]!.end - 0.02)) return [];
  return valid.map(cue => ({ ...cue, end: Math.min(duration, cue.end) }));
}

/** Generated narration already supplies caption text; this fallback is shot-level, not measured word timing. */
export function generatedShotCaptionCues(cues: SpeechCue[] | undefined, duration: number, script: string, generated: boolean): SpeechCue[] {
  const measured = sourceCuesForShot(cues, duration);
  if (measured.length) return measured;
  const text = script.trim();
  return generated && text && Number.isFinite(duration) && duration > 0
    ? [{ text, start: 0, end: duration }] : [];
}

/** A measured transcript belongs only to the source file from which it was derived. */
export function sourceCaptionCacheMatchesContent(provenance: string | undefined, sourceHash: string | undefined, contentHash: string | undefined): boolean {
  if (!['heygen:source_video_srt', 'qwen_filetrans:source_material'].includes(provenance || '')) return false;
  if (provenance !== 'qwen_filetrans:source_material') return true;
  const current = String(contentHash || '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(current)) return false;
  return String(sourceHash || '').toLowerCase() === current;
}

export function shotsMissingSourceCues(shots: NarrationTimelineShot[]): number[] {
  return shots.flatMap((shot, index) => shot.lockedSourceVoice
    && !sourceCuesForShot(shot.sourceCues, Number(shot.lockedDuration || shot.targetDuration)).length ? [index + 1] : []);
}

/** With no separate voiceover, captions for source-audio shots must come from those clips. */
export function sourceCuesWithoutVoiceover(shots: NarrationTimelineShot[]): SpeechCue[] {
  let cursor = 0;
  return shots.flatMap(shot => {
    const start = shot.targetStart ?? cursor;
    cursor = start + shot.targetDuration;
    if (!shot.lockedSourceVoice) return [];
    return sourceCuesForShot(shot.sourceCues, Number(shot.lockedDuration || shot.targetDuration))
      .filter(cue => cue.start < shot.targetDuration)
      .map(cue => ({ ...cue, start: start + cue.start, end: start + Math.min(cue.end, shot.targetDuration) }));
  });
}

function paragraphOwners(shots: NarrationTimelineShot[], lines: string[], referenceLines?: string[]): ParagraphOwner[] {
  if (!shots.length || !lines.length) throw new Error('缺少分镜或口播段落，无法校准时间轴');
  if (referenceLines && referenceLines.length !== lines.length) throw new Error('译文口播段落数量与原分镜不一致，请逐段确认译文');
  const owners: number[] = [];
  let searchFrom = 0;
  for (const [lineIndex, line] of lines.entries()) {
    const expected = speechText(referenceLines?.[lineIndex] || line);
    const owner = shots.findIndex((shot, index) => index >= searchFrom && speechText(spokenText(shot.narration || '')) === expected);
    if (owner < 0) throw new Error(`口播段落未关联到分镜：${line.slice(0, 36)}`);
    owners.push(owner);
    searchFrom = owner + 1;
  }
  if (owners[0] !== 0) throw new Error('首段口播未从第 1 个分镜开始，请确认段落归属');
  return lines.map((line, index) => {
    const firstShotIndex = index === 0 ? 0 : owners[index]!;
    const endShotIndex = owners[index + 1] ?? shots.length;
    const group = shots.slice(firstShotIndex, endShotIndex);
    const sourceShots = group.filter(shot => shot.lockedSourceVoice);
    const source = sourceShots.length ? group.length === 1 ? 'avatar' as const : 'mixed' as const : 'ai' as const;
    return { text: line, firstShotIndex, endShotIndex, source };
  });
}

/** Already-generated source speech must not be synthesized a second time. */
export function narrationForUnfixedShots(
  shots: NarrationTimelineShot[], narrationLines: string[], referenceLines?: string[],
): string[] {
  const lines = narrationLines.map(spokenText).filter(Boolean);
  return paragraphOwners(shots, lines, referenceLines)
    .filter(owner => owner.source === 'ai').map(owner => owner.text);
}

/** Audio generated for an older source/voiceover split must never be reused. */
export function voiceoverMatchesNarrationSources(
  shots: NarrationTimelineShot[], narrationLines: string[], audioText: string, referenceLines?: string[],
): boolean {
  if (!speechText(audioText)) return false;
  try {
    return speechText(narrationForUnfixedShots(shots, narrationLines, referenceLines).join(' ')) === speechText(audioText);
  } catch { return false; }
}

export function durationForUnfixedNarration(
  shots: NarrationTimelineShot[], narrationLines: string[], referenceLines?: string[],
): number {
  const lines = narrationLines.map(spokenText).filter(Boolean);
  return paragraphOwners(shots, lines, referenceLines)
    .filter(owner => owner.source === 'ai')
    .reduce((duration, owner) => duration + shots.slice(owner.firstShotIndex, owner.endShotIndex)
      .reduce((sum, shot) => sum + Math.max(0, Number(shot.targetDuration) || 0), 0), 0);
}

/** Keep generated avatar clip lengths while moving their starts with the
 * measured narration and preceding shots. */
export function arrangeShotsWithinNarration<T extends NarrationTimelineShot>(
  shots: T[], narrationLines: string[], measuredCues: SpeechCue[], audioDuration: number,
  alignmentSource: string, referenceLines?: string[],
): NarrationTimelineResult<T> {
  const lines = narrationLines.map(spokenText).filter(Boolean);
  const owners = paragraphOwners(shots, lines, referenceLines);
  const aiOwners = owners.filter(owner => owner.source === 'ai');
  if (!aiOwners.length) throw new Error('全部口播均来自数字人原声，无需生成非数字人配音');
  const measured = mapNarrationCues(aiOwners.map(owner => owner.text), measuredCues, audioDuration, alignmentSource);
  const audioBoundaries = [0, ...measured.slice(0, -1).map((paragraph, index) =>
    (paragraph!.end + measured[index + 1]!.start) / 2), audioDuration];
  const aiAudio = new Map<ParagraphOwner, { start: number; end: number; cues: SpeechCue[] }>();
  aiOwners.forEach((owner, index) => aiAudio.set(owner, {
    start: audioBoundaries[index]!, end: audioBoundaries[index + 1]!, cues: measured[index]!.cues,
  }));

  const timeline: T[] = [];
  const outputCues: SpeechCue[] = [];
  const warnings: string[] = [];
  const arrangedParagraphs: NarrationTimelineResult<T>['paragraphs'] = [];
  let cursor = 0;
  let index = 0;
  const precision = (value: number) => +value.toFixed(3);

  while (index < owners.length) {
    const owner = owners[index]!;
    if (owner.source === 'mixed') {
      const group = shots.slice(owner.firstShotIndex, owner.endShotIndex);
      const start = cursor;
      const silentShots: number[] = [];
      for (const [offset, shot] of group.entries()) {
        const shotIndex = owner.firstShotIndex + offset;
        const fixed = Boolean(shot.lockedSourceVoice);
        const shotStart = cursor;
        const shotEnd = shotStart + Number(fixed ? shot.lockedDuration || shot.targetDuration : shot.targetDuration);
        if (!Number.isFinite(shotStart) || !Number.isFinite(shotEnd) || shotEnd <= shotStart)
          throw new Error(`分镜 ${shotIndex + 1} 缺少有效的镜头时间`);
        timeline.push({ ...shot, targetStart: precision(shotStart), targetEnd: precision(shotEnd),
          targetDuration: precision(shotEnd - shotStart), speed: fixed ? 1 : shot.speed,
          // A mixed paragraph is excluded from AI synthesis. Mark adjacent B-roll
          // explicitly silent so the renderer cannot accidentally reuse another
          // paragraph's audio at the same video timestamp.
          voiceStart: fixed ? undefined : 0, voiceEnd: fixed ? undefined : 0,
          voiceAligned: !fixed } as T);
        if (fixed) {
          const sourceCues = sourceCuesForShot(shot.sourceCues, shotEnd - shotStart);
          if (!sourceCues.length) warnings.push(`分镜 ${shotIndex + 1} 的数字人原声缺少有效的独立字幕时间码`);
          outputCues.push(...sourceCues.map(cue => ({ ...cue, start: precision(shotStart + cue.start), end: precision(shotStart + cue.end) })));
        } else silentShots.push(shotIndex + 1);
        cursor = shotEnd;
      }
      if (silentShots.length) warnings.push(`第 ${index + 1} 段仅在数字人镜头播放原声；分镜 ${silentShots.join('、')} 没有口播音轨。若需连续口播，请为这些镜头安排独立台词并重新生成配音`);
      arrangedParagraphs.push({ text: owner.text, firstShot: owner.firstShotIndex + 1, lastShot: owner.endShotIndex,
        start: precision(start), end: precision(cursor), source: 'mixed' });
      index++;
      continue;
    }
    if (owner.source === 'avatar') {
      const shot = shots[owner.firstShotIndex]!;
      const start = cursor;
      const targetDuration = Number(shot.lockedDuration || shot.targetDuration);
      const end = start + targetDuration;
      if (!Number.isFinite(end) || targetDuration <= 0) throw new Error(`分镜 ${owner.firstShotIndex + 1} 缺少数字人有效时长`);
      const sourceDuration = Number(shot.trimEnd) - Number(shot.trimStart || 0);
      if (Number.isFinite(sourceDuration) && sourceDuration > 0 && Math.abs(sourceDuration - targetDuration) > 0.15)
        warnings.push(`分镜 ${owner.firstShotIndex + 1} 的素材时长与锁定时长相差 ${Math.abs(sourceDuration - targetDuration).toFixed(2)} 秒，请试听原声确认结尾`);
      timeline.push({ ...shot, targetStart: precision(start), targetEnd: precision(end), targetDuration: precision(targetDuration), speed: 1,
        voiceStart: undefined, voiceEnd: undefined, voiceAligned: false } as T);
      arrangedParagraphs.push({ text: owner.text, firstShot: owner.firstShotIndex + 1, lastShot: owner.endShotIndex,
        start: precision(start), end: precision(end), source: 'avatar' });
      const sourceCues = sourceCuesForShot(shot.sourceCues, targetDuration);
      if (!sourceCues.length) warnings.push(`分镜 ${owner.firstShotIndex + 1} 的数字人原声缺少有效的独立字幕时间码`);
      outputCues.push(...sourceCues.map(cue => ({ ...cue, start: precision(start + cue.start), end: precision(start + cue.end) })));
      cursor = end;
      index++;
      continue;
    }

    const runStart = index;
    while (index < owners.length && owners[index]!.source === 'ai') index++;
    const run = owners.slice(runStart, index);
    for (const [runIndex, item] of run.entries()) {
      const group = shots.slice(item.firstShotIndex, item.endShotIndex);
      const audio = aiAudio.get(item)!;
      const speechDuration = audio.end - audio.start;
      const paragraphDuration = speechDuration;
      if (paragraphDuration <= 0) throw new Error(`第 ${runStart + runIndex + 1} 段口播缺少有效时长`);
      const paragraphStart = cursor;
      const weights = group.map(shot => Math.max(0.1, Number(shot.targetDuration) || 0.1));
      const totalWeight = weights.reduce((sum, value) => sum + value, 0);
      let speechCursor = 0;
      for (const [groupIndex, shot] of group.entries()) {
        const nextSpeech = groupIndex === group.length - 1 ? speechDuration
          : speechCursor + speechDuration * weights[groupIndex]! / totalWeight;
        const targetDuration = nextSpeech - speechCursor;
        if (targetDuration <= 0) throw new Error(`分镜 ${item.firstShotIndex + groupIndex + 1} 缺少有效时长`);
        if (targetDuration < 0.5) warnings.push(`分镜 ${item.firstShotIndex + groupIndex + 1} 仅 ${targetDuration.toFixed(2)} 秒，请预览快切效果`);
        const sourceClipDuration = Math.max(0, Number(shot.trimEnd || 0) - Number(shot.trimStart || 0));
        if (sourceClipDuration > 0 && sourceClipDuration / targetDuration < 0.5) warnings.push(`分镜 ${item.firstShotIndex + groupIndex + 1} 的素材需明显放慢或定格`);
        timeline.push({ ...shot, targetStart: precision(cursor), targetEnd: precision(cursor + targetDuration), targetDuration: precision(targetDuration),
          speed: sourceClipDuration > 0 ? Math.max(0.25, Math.min(4, sourceClipDuration / targetDuration)) : shot.speed,
          voiceStart: precision(audio.start + speechCursor), voiceEnd: precision(audio.start + nextSpeech), voiceAligned: true } as T);
        cursor += targetDuration;
        speechCursor = nextSpeech;
      }
      arrangedParagraphs.push({ text: item.text, firstShot: item.firstShotIndex + 1, lastShot: item.endShotIndex,
        start: precision(paragraphStart), end: precision(cursor), source: 'ai' });
      outputCues.push(...audio.cues.map(cue => ({ ...cue, start: precision(paragraphStart + cue.start - audio.start), end: precision(paragraphStart + cue.end - audio.start) })));
    }
  }
  return { timeline, cues: outputCues, duration: precision(cursor), warnings, paragraphs: arrangedParagraphs };
}
