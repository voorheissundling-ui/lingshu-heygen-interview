import {
  createIntentEffectPlan,
  normalizeEffectPlan,
  type EffectIntentScene,
  type EffectPlanV1,
} from '../../shared/contracts/effectPlan.js';
import fs from 'node:fs';
import { inspectGeneratedVoice, type VoiceQualityReport } from '../lib/voiceQuality.js';

export function closedWorldNarrationLines(facts: string[], language = 'zh'): string[] {
  if (/^en(?:-|$)/i.test(language)) {
    const labels: Record<string, string> = {
      '产品': 'Product', '类别': 'Category', '规格': 'Specification', '净含量': 'Net content',
      '材质': 'Material', '价格范围': 'Price range', '认证': 'Certification', '特点': 'Feature', 'SKU': 'SKU', 'MOQ': 'MOQ',
    };
    const naturalFact = (fact: string | undefined, index: number): string => {
      if (!fact) return [
        'Start with the intended use and the verification standard, not a broad sales claim.',
        'Do not treat unsupported information as a purchasing conclusion.',
        'Compare the specification, conditions, and evidence item by item.',
        'Keep only conclusions supported by formal records or real verification.',
      ][index % 4]!;
      const match = fact.match(/^([^：:]{1,30})[：:]\s*(.+)$/);
      const rawLabel = match?.[1]?.trim() || '';
      const value = match?.[2]?.trim() || '';
      if (!rawLabel || !value) return `Verified detail: ${fact.replace(/[。.!！]+$/, '')}.`;
      const label = labels[rawLabel] || rawLabel;
      // The deterministic fallback cannot safely invent a translated brand,
      // category or ingredient name.  When the verified value has no stored
      // target-language alias, keep the narration executable and refer to the
      // selected/recorded field without changing the underlying product data.
      if (/[^\p{Script=Latin}\p{N}\p{P}\p{S}\p{Z}]/u.test(value) || /[^\p{Script=Latin}\p{N}\p{P}\p{S}\p{Z}]/u.test(label)) {
        return rawLabel === '产品'
          ? 'Use the selected product record.'
          : `Check the recorded ${labels[rawLabel] || 'product field'}.`;
      }
      return `${label}: ${value}.`;
    };
    return [
      naturalFact(facts[0], 0), naturalFact(facts[1], 1),
      naturalFact(facts[2], 2), naturalFact(facts[3], 3),
      facts.length ? 'Verify the formal record before use.' : 'Use only verified formal records.',
    ];
  }
  const naturalFact = (fact: string | undefined, index: number): string => {
    if (!fact) return [
      '先把使用条件和核验标准问清楚，不急着接受宽泛卖点。',
      '没有正式资料支持的信息，暂时不要当成采购结论。',
      '比较同类产品时，把规格、条件和证据逐项对应起来。',
      '最后只保留能够由正式资料或真实验证支持的判断。',
    ][index % 4]!;
    const match = fact.match(/^([^：:]{1,30})[：:]\s*(.+)$/);
    const label = match?.[1]?.trim();
    const value = match?.[2]?.trim();
    if (!label || !value) return `有一个信息值得留意：${fact.replace(/[。.!！]+$/, '')}。`;
    return [
      `先看一个具体信息：${label}是${value}。`,
      `再看${label}，资料给出的信息是${value}。`,
      `如果你正在做选型，${label}的${value}值得单独核对。`,
      `真正要落到采购判断上，别漏掉${label}：${value}。`,
    ][index % 4]!;
  };
  return [
    naturalFact(facts[0], 0), naturalFact(facts[1], 1),
    naturalFact(facts[2], 2), naturalFact(facts[3], 3),
    facts.length ? '最后再按自己的使用条件核对正式资料。' : '结论只以正式资料和真实验证为准。',
  ];
}

/** Compresses legacy deterministic fallback copy without dropping its
 * verified field/value. This is used only after measured TTS proves that a
 * four-second frozen segment cannot fit; LLM-authored or user-authored copy is
 * never silently rewritten. */
export function compactClosedWorldNarrationLine(line: string): string {
  const value = line.trim();
  if (/^Start with the selected product in the verified enterprise record\.?$/i.test(value)) return 'Use the selected product record.';
  if (/^Finally, verify the formal records against your own use conditions\.?$/i.test(value)) return 'Verify the formal record before use.';
  let match = value.match(/^Next, check (.+?)\. The confirmed record says (.+?)\.?$/i);
  if (match) return `${match[1]}: ${match[2].replace(/\.$/, '')}.`;
  match = value.match(/^For product selection, verify the recorded (.+?) in the formal product profile\.?$/i);
  if (match) return `Check the recorded ${match[1].replace(/\.$/, '')}.`;
  match = value.match(/^For product selection, verify this (.+?) separately:\s*(.+?)\.?$/i);
  if (match) return `${match[1]}: ${match[2].replace(/\.$/, '')}.`;
  match = value.match(/^For a purchasing decision, do not miss (.+?):\s*(.+?)\.?$/i);
  if (match) return `${match[1]}: ${match[2].replace(/\.$/, '')}.`;
  match = value.match(/^Start with one verified detail:\s*(.+?) is (.+?)\.?$/i);
  if (match) return `${match[1]}: ${match[2].replace(/\.$/, '')}.`;
  return value;
}

/** Missing plans on schema v3 and older are intentionally effect-free. New
 * plans are generated once and persisted so retries cannot silently change. */
export function socialVideoEffectPlan(input: {
  schemaVersion: number;
  stored?: unknown;
  scenes: EffectIntentScene[];
  seed?: number;
}): EffectPlanV1 | undefined {
  if (input.stored && typeof input.stored === 'object') return normalizeEffectPlan(input.stored, input.scenes);
  if (input.schemaVersion < 4) return undefined;
  return createIntentEffectPlan(input.scenes.map(scene => ({ ...scene, protectedVisual: false })), 2, input.seed ?? 198);
}

export async function ensureStoredVoiceQuality(input: {
  stored?: unknown;
  voicePath: string;
  expectedText: string;
  language: string;
}): Promise<VoiceQualityReport | { passed: false; failures: string[] }> {
  if (input.stored && typeof input.stored === 'object' && typeof (input.stored as { passed?: unknown }).passed === 'boolean') {
    return input.stored as VoiceQualityReport;
  }
  if (!input.voicePath || !fs.existsSync(input.voicePath)) return { passed: false, failures: ['缺少可重新质检的原始口播文件'] };
  return inspectGeneratedVoice({ filePath: input.voicePath, expectedText: input.expectedText, language: input.language });
}
