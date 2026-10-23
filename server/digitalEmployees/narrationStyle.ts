export interface NarrationStyleProfile {
  sampleCount: number;
  hookMechanism: 'question' | 'direct_observation' | 'contrast' | 'instruction' | 'statement';
  cadence: 'tight' | 'natural' | 'measured';
  person: 'second_person' | 'first_person' | 'neutral';
  questionRate: number;
  averageUnitsPerLine: number;
  connectorStyle: 'conversational' | 'enumerated' | 'minimal';
  ctaStyle: 'question' | 'invitation' | 'direct_action' | 'none';
}

const clean = (value: unknown): string => String(value || '').replace(/\s+/g, ' ').trim();
const units = (value: string): number => /[\u3400-\u9fff]/.test(value)
  ? [...value].filter(char => /[\u3400-\u9fff]/.test(char)).length
  : value.split(/\s+/).filter(Boolean).length;

/** Extracts reusable delivery grammar without retaining or exposing source copy. */
export function deriveNarrationStyleProfile(shots: Array<Record<string, unknown>>): NarrationStyleProfile | null {
  const lines = shots.map(shot => clean(shot.dialogue || shot.voiceover || shot.spokenText)).filter(Boolean);
  if (!lines.length) return null;
  const first = lines[0]!.toLowerCase();
  const last = lines.at(-1)!.toLowerCase();
  const questionCount = lines.filter(line => /[?？]|^(?:why|how|what|which|do you|have you|你|为什么|怎么|如何)/i.test(line)).length;
  const hookMechanism: NarrationStyleProfile['hookMechanism'] = /[?？]/.test(first) ? 'question'
    : /但是|却|反而|不是.+而是|but|instead|however/.test(first) ? 'contrast'
      : /先看|注意|看看|记住|look|watch|notice|remember/.test(first) ? 'instruction'
        : /这里|这个|画面|细节|here|this|detail/.test(first) ? 'direct_observation' : 'statement';
  const averageUnitsPerLine = lines.reduce((sum, line) => sum + units(line), 0) / lines.length;
  const cadence: NarrationStyleProfile['cadence'] = averageUnitsPerLine <= 12 ? 'tight' : averageUnitsPerLine >= 25 ? 'measured' : 'natural';
  const secondPerson = lines.filter(line => /你|您|your?|buyers?|客户/.test(line.toLowerCase())).length;
  const firstPerson = lines.filter(line => /我|我们|our|we\b|i\b/.test(line.toLowerCase())).length;
  const person: NarrationStyleProfile['person'] = secondPerson >= firstPerson && secondPerson > 0 ? 'second_person'
    : firstPerson > 0 ? 'first_person' : 'neutral';
  const enumerated = lines.filter(line => /第一|第二|首先|其次|一是|二是|first|second|1[.、]|2[.、]/i.test(line)).length;
  const conversational = lines.filter(line => /其实|所以|你会发现|关键是|说白了|now|so|here's|you'll/i.test(line)).length;
  const connectorStyle: NarrationStyleProfile['connectorStyle'] = enumerated > conversational ? 'enumerated'
    : conversational > 0 ? 'conversational' : 'minimal';
  const ctaStyle: NarrationStyleProfile['ctaStyle'] = /[?？]/.test(last) ? 'question'
    : /聊聊|告诉我|私信|欢迎|一起|discuss|tell us|message|contact|let's/.test(last) ? 'invitation'
      : /点击|查看|关注|立即|click|follow|learn more|download/.test(last) ? 'direct_action' : 'none';
  return {
    sampleCount: lines.length,
    hookMechanism,
    cadence,
    person,
    questionRate: Number((questionCount / lines.length).toFixed(2)),
    averageUnitsPerLine: Number(averageUnitsPerLine.toFixed(1)),
    connectorStyle,
    ctaStyle,
  };
}

export function aggregateNarrationStyleProfiles(profiles: Array<NarrationStyleProfile | null>): NarrationStyleProfile | null {
  const valid = profiles.filter((profile): profile is NarrationStyleProfile => Boolean(profile));
  // A single historic video is a reference, not a reusable house style. Only
  // learn a tenant-level pattern after independent samples agree often enough
  // to avoid copying one creator's quirks or a low-quality outlier.
  if (valid.length < 2) return null;
  const pick = <K extends keyof NarrationStyleProfile>(key: K): NarrationStyleProfile[K] => {
    const counts = new Map<string, number>();
    for (const profile of valid) counts.set(String(profile[key]), (counts.get(String(profile[key])) || 0) + profile.sampleCount);
    return [...counts].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]![0] as NarrationStyleProfile[K];
  };
  const samples = valid.reduce((sum, profile) => sum + profile.sampleCount, 0);
  const weighted = (key: 'questionRate' | 'averageUnitsPerLine') => valid.reduce((sum, profile) => sum + profile[key] * profile.sampleCount, 0) / samples;
  return {
    sampleCount: samples,
    hookMechanism: pick('hookMechanism'),
    cadence: pick('cadence'),
    person: pick('person'),
    questionRate: Number(weighted('questionRate').toFixed(2)),
    averageUnitsPerLine: Number(weighted('averageUnitsPerLine').toFixed(1)),
    connectorStyle: pick('connectorStyle'),
    ctaStyle: pick('ctaStyle'),
  };
}

export function narrationStyleInstruction(profile: NarrationStyleProfile | null): string {
  if (!profile) return '';
  return `只模仿抽象口播节奏，不复用原句：开场=${profile.hookMechanism}；节奏=${profile.cadence}；人称=${profile.person}；问句比例约${profile.questionRate}；平均每句${profile.averageUnitsPerLine}字词；衔接=${profile.connectorStyle}；收尾=${profile.ctaStyle}`;
}
