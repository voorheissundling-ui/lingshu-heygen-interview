import { voiceoverLineNeedsLanguageRepair } from '../routes/studio.js';
import { spokenLanguageMatches } from '../../shared/contracts/videoCreationPlan.js';
import { storyboardSceneRanges } from '../lib/studioScriptQualityV2.js';
import { callVideoModel } from './videoModel.js';

const text = (value: unknown, max = 1_000): string => String(value ?? '').trim().slice(0, max);
const json = <T>(value: unknown, fallback: T): T => {
  if (value && typeof value === 'object') return value as T;
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
};

export function voiceoverText(script: string): string {
  return storyboardVoiceLines(script).join(' ');
}

export function storyboardVoiceLines(script: string): string[] {
  return script.split('\n').flatMap(line => {
    const match = line.trim().match(/^(?:台词|口播|voiceover|vo)[：:]\s*(.+)$/i);
    return match?.[1] && match[1] !== '无' ? [match[1]] : [];
  });
}

export function storyboardVoiceLanguageMatches(script: string, language: string): boolean {
  const lines = storyboardVoiceLines(script);
  return lines.length > 0
    && spokenLanguageMatches(lines.join(' '), language)
    && lines.every(line => !voiceoverLineNeedsLanguageRepair(line, language));
}

function parseModelJson(value: string): Record<string, unknown> {
  const raw = value.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw Error('多语言模型未返回有效 JSON');
  return JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
}

export async function translateStoryboardFromMaster(
  masterScript: string,
  sourceLanguage: string,
  targetLanguage: string,
  invoke: typeof callVideoModel = callVideoModel,
  guidance = '',
): Promise<{ script: string; bindings: Array<{ sceneId: string; sourceText: string; translatedText: string }> }> {
  const sourceLines = storyboardVoiceLines(masterScript);
  if (!sourceLines.length || storyboardSceneRanges(masterScript).length !== sourceLines.length) throw Error('主语言分镜与口播数量不一致');
  const response = await invoke(`将以下短视频逐镜口播从 ${sourceLanguage} 翻译为 ${targetLanguage}。保持 sceneId、顺序、事实、CTA 和语气，不增删信息，不合并或拆分句子。${guidance ? `额外制作反馈：${guidance}。在语义等价前提下使用更紧凑、自然的表达。` : ''}只返回 JSON：{"scenes":[{"sceneId":"scene-1","text":"译文"}]}。\n${JSON.stringify(sourceLines.map((sourceText, index) => ({ sceneId: `scene-${index + 1}`, sourceText })))}`, { timeoutMs: 60_000 });
  const parsed = parseModelJson(response.text);
  const scenes = Array.isArray(parsed.scenes) ? parsed.scenes as Array<Record<string, unknown>> : [];
  const translated = sourceLines.map((_, index) => {
    const expectedId = `scene-${index + 1}`;
    const item = scenes[index];
    if (text(item?.sceneId) !== expectedId || !text(item?.text, 1_000)) throw Error(`多语言翻译缺少 ${expectedId}`);
    return text(item.text, 1_000);
  });
  if (!storyboardVoiceLanguageMatches(freezeStoryboardNarration(masterScript, translated), targetLanguage)) throw Error('翻译结果与目标语言不符');
  const review = await invoke(`核对逐镜翻译是否逐条语义等价。不得接受新增、删减、调换事实、产品结论、CTA 或 sceneId。只返回 JSON：{"passed":true,"issues":[]}。\n${JSON.stringify(sourceLines.map((sourceText, index) => ({ sceneId: `scene-${index + 1}`, sourceText, translatedText: translated[index] })))}`, { timeoutMs: 60_000 });
  const reviewed = parseModelJson(review.text);
  if (reviewed.passed !== true || (Array.isArray(reviewed.issues) && reviewed.issues.length)) {
    const details = Array.isArray(reviewed.issues) ? reviewed.issues.map(issue => {
      if (issue && typeof issue === 'object') {
        const row = issue as Record<string, unknown>;
        return [text(row.sceneId, 40), text(row.issue || row.reason || row.message, 360)].filter(Boolean).join('：') || JSON.stringify(row).slice(0, 400);
      }
      return text(issue, 400);
    }).filter(Boolean).slice(0, 5).join('；') : '';
    throw Error(`多语言逐镜语义审核未通过${details ? `：${details}` : ''}`);
  }
  const bindings = sourceLines.map((sourceText, index) => ({ sceneId: `scene-${index + 1}`, sourceText, translatedText: translated[index]! }));
  return { script: freezeStoryboardNarration(masterScript, translated), bindings };
}

export function splitSubtitleUnits(value: string, maxChars = 36): string[] {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return [];
  const tokens = /[\u3400-\u9fff\u3040-\u30ff]/.test(normalized) ? [...normalized] : normalized.match(/\S+\s*/g) || [];
  const units: string[] = []; let current = '';
  for (const token of tokens) {
    if (current && current.length + token.trimEnd().length > maxChars) { units.push(current.trim()); current = ''; }
    current += token;
    if (/[。！？!?]\s*$/.test(token)) { units.push(current.trim()); current = ''; }
  }
  if (current.trim()) units.push(current.trim());
  return units;
}

export function freezeStoryboardNarration(script: string, lines: string[]): string {
  const voices = script.match(/^(?:台词|口播|voiceover|vo)[：:].*$/gim) || [];
  const captions = script.match(/^字幕[：:].*$/gm) || [];
  if (voices.length !== lines.length || captions.length !== lines.length) throw Error('分镜数量与完整口播不一致，请重新生成');
  let voiceIndex = 0, captionIndex = 0;
  return script.replace(/^(?:台词|口播|voiceover|vo)[：:].*$/gim, () => `台词：${lines[voiceIndex++]}`)
    .replace(/^字幕[：:].*$/gm, () => `字幕：${lines[captionIndex++]}`);
}

export function bindVoiceCuesToScenes(lines: string[], cues: Array<{ start: number; end: number; text: string }>): Array<{ start: number; end: number; text: string }> | null {
  const normalized = (value: string) => value.normalize('NFKC').toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu)?.join('') || '';
  const groups: Array<{ start: number; end: number; text: string }> = [];
  let cueIndex = 0;
  for (const line of lines) {
    const first = cues[cueIndex];
    if (!first) return null;
    let joined = '', end = first.end;
    while (cueIndex < cues.length && normalized(joined) !== normalized(line)) {
      joined += cues[cueIndex]!.text;
      end = cues[cueIndex]!.end;
      cueIndex += 1;
      if (normalized(joined).length > normalized(line).length) return null;
    }
    if (normalized(joined) !== normalized(line)) return null;
    groups.push({ start: first.start, end, text: line });
  }
  return cueIndex === cues.length ? groups : null;
}

export function proportionalCues(value: string, duration: number) {
  const parts = splitSubtitleUnits(value);
  const total = parts.reduce((sum, item) => sum + item.length, 0) || 1;
  let cursor = 0;
  return parts.map((part, index) => {
    const start = cursor;
    const end = index === parts.length - 1 ? duration : cursor + duration * part.length / total;
    cursor = end;
    return { start: Number(start.toFixed(2)), end: Number(end.toFixed(2)), text: part };
  });
}

export function productionTiming(spec: { duration?: unknown; voiceoverDur?: unknown; lang?: unknown; sceneVoiceCuesByLang?: unknown }, ranges: Array<{ start: number; end: number }>) {
  const positive = (value: unknown) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0;
  const duration = Math.max(positive(spec.duration) || 20, positive(spec.voiceoverDur));
  const language = text(spec.lang, 20);
  const cuesByLanguage = json<Record<string, unknown>>(spec.sceneVoiceCuesByLang, {});
  const cues = Array.isArray(cuesByLanguage[language]) ? cuesByLanguage[language] as Array<Record<string, unknown>> : [];
  if (cues.length === ranges.length && cues.length > 0) {
    const boundaries = [0, ...cues.slice(1).map(cue => Number(cue.start)), duration];
    if (boundaries.every((value, index) => Number.isFinite(value) && value >= 0 && (index === 0 || value > boundaries[index - 1]))) return { duration, sceneDurations: boundaries.slice(1).map((end, index) => end - boundaries[index]) };
  }
  const weights = ranges.map(range => range.end - range.start);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (!weights.length || weights.some(weight => !Number.isFinite(weight) || weight <= 0)) throw new Error('invalid_scene_timing');
  return { duration, sceneDurations: weights.map(weight => duration * weight / total) };
}

export function languageSceneAlignmentIssues(spec: Record<string, unknown>): string[] {
  const script = text(spec.script, 30_000);
  const lines = storyboardVoiceLines(script);
  const ranges = storyboardSceneRanges(script);
  const language = text(spec.lang, 20);
  const bindings = Array.isArray(spec.languageSceneBindings) ? spec.languageSceneBindings as Array<Record<string, unknown>> : [];
  const rawCues = json<Record<string, unknown>>(spec.sceneVoiceCuesByLang, {})[language];
  const sceneCues = Array.isArray(rawCues) ? rawCues as Array<Record<string, unknown>> : [];
  const issues: string[] = [];
  if (!lines.length || ranges.length !== lines.length) issues.push('分镜与口播数量不一致');
  if (bindings.length !== lines.length) issues.push('逐镜多语言绑定缺失');
  if (sceneCues.length !== lines.length) issues.push('逐镜真实语音边界缺失');
  for (let index = 0; index < lines.length; index += 1) {
    const sceneId = `scene-${index + 1}`;
    if (text(bindings[index]?.sceneId) !== sceneId) issues.push(`${sceneId} 顺序或标识错误`);
    if (text(bindings[index]?.translatedText, 1_000) !== lines[index]) issues.push(`${sceneId} 译文与口播不一致`);
    if (text(sceneCues[index]?.text, 1_000) !== lines[index]) issues.push(`${sceneId} 音频与口播不一致`);
  }
  return [...new Set(issues)];
}
