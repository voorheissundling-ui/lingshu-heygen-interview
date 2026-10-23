type ReferenceContentEvidence = {
  id?: unknown;
  aiAnalysis?: unknown;
  duration?: unknown;
  sourceUrl?: unknown;
  videoUrl?: unknown;
  url?: unknown;
  videoFileId?: unknown;
  sha256?: unknown;
  contentHash?: unknown;
  mediaSha256?: unknown;
  fileSha256?: unknown;
};

export type ReferenceContentIdentity = {
  recordId: string;
  fileHash: string;
  sourceKey: string;
  transcriptKey: string;
  semanticKey: string;
  durationSeconds: number | null;
};

function object(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try { return object(JSON.parse(value)); } catch { return {}; }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function string(value: unknown, limit = 20_000): string {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

const SMALL_NUMBERS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

function englishNumberValue(value: string): number | null {
  const words = value.toLowerCase().split(/[\s-]+/).filter(Boolean);
  if (!words.length || words.some(word => !(word in SMALL_NUMBERS) && !['hundred', 'thousand', 'million', 'and'].includes(word))) return null;
  let total = 0;
  let current = 0;
  for (const word of words) {
    if (word === 'and') continue;
    if (word in SMALL_NUMBERS) current += SMALL_NUMBERS[word]!;
    else if (word === 'hundred') current = Math.max(1, current) * 100;
    else {
      const scale = word === 'thousand' ? 1_000 : 1_000_000;
      total += Math.max(1, current) * scale;
      current = 0;
    }
  }
  return total + current;
}

function normalizeNumbers(value: string): string {
  const compactDigits = value.replace(/(\d)[,，\s](?=\d{3}\b)/g, '$1');
  return compactDigits.replace(
    /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[\s-]+(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|and)){0,7}\b/gi,
    phrase => String(englishNumberValue(phrase.trim()) ?? phrase),
  );
}

function fingerprint(value: unknown): string {
  return normalizeNumbers(string(value).normalize('NFKC').toLowerCase())
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function canonicalSource(value: unknown): string {
  const raw = string(value, 2_000);
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    url.hash = '';
    url.search = '';
    return `${url.protocol}//${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return '';
  }
}

function transcriptText(analysis: Record<string, unknown>): string {
  const gemini = object(analysis.gemini);
  const transcript = object(gemini.audioTranscript || analysis.audioTranscript);
  const direct = [transcript.rawText, transcript.fullText, transcript.transcript, gemini.transcript, analysis.transcript]
    .map(value => string(value))
    .find(Boolean);
  if (direct) return direct;
  const segments = Array.isArray(transcript.segments) ? transcript.segments : [];
  const segmentText = segments.map(item => string(object(item).text)).filter(Boolean).join(' ');
  if (segmentText) return segmentText;
  const shots = Array.isArray(gemini.scriptDetails15s) ? gemini.scriptDetails15s : [];
  const shotDialogues = shots.map(item => {
    const row = object(item);
    return string(row.dialogue || row.spokenText || row.voiceover);
  }).filter(Boolean);
  // Some legacy exact analyses copied the full-video transcript into every
  // shot. Repeating it must not create a different identity from a newer
  // record that stores the same speech once in `audioTranscript.rawText`.
  return [...new Set(shotDialogues)].join(' ');
}

function entityText(value: unknown, depth = 0): string[] {
  if (depth > 3) return [];
  if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
  if (Array.isArray(value)) return value.flatMap(item => entityText(item, depth + 1));
  return Object.values(object(value)).flatMap(item => entityText(item, depth + 1));
}

/**
 * Stable content identity for a stored viral-video record. It intentionally
 * combines strong media/source signals with normalized speech and semantic
 * evidence so differently encoded copies of the same video remain one item.
 */
export function referenceContentIdentity(record: ReferenceContentEvidence): ReferenceContentIdentity {
  const analysis = object(record.aiAnalysis);
  const gemini = object(analysis.gemini);
  const duration = Number(record.duration);
  const fileHash = [record.sha256, record.mediaSha256, record.fileSha256, record.contentHash,
    analysis.sha256, analysis.mediaSha256, analysis.fileSha256, analysis.contentHash]
    .map(value => string(value, 128).toLowerCase())
    .find(value => /^[a-f0-9]{64}$/.test(value)) || '';
  const hooks = Array.isArray(gemini.hooks) ? gemini.hooks.map(item => string(item)).filter(Boolean) : [];
  const entity = entityText(gemini.identityEntities || analysis.identityEntities).join(' ');
  const themeKey = fingerprint(gemini.theme || analysis.theme);
  const hookKey = fingerprint(hooks[0] || gemini.hook || analysis.hook);
  const entityKey = fingerprint(entity);
  const semanticKey = themeKey && hookKey && `${themeKey}${hookKey}${entityKey}`.length >= 24
    ? `${themeKey}|${hookKey}|${entityKey}`
    : '';
  const transcriptKey = fingerprint(transcriptText(analysis));
  return {
    recordId: string(record.id, 200),
    fileHash,
    sourceKey: [record.sourceUrl, record.videoUrl, record.url, analysis.sourceUrl, analysis.videoUrl]
      .map(canonicalSource).find(Boolean) || '',
    transcriptKey: transcriptKey.length >= 40 ? transcriptKey : '',
    semanticKey,
    durationSeconds: Number.isFinite(duration) && duration > 0 ? duration : null,
  };
}

function closeDuration(left: ReferenceContentIdentity, right: ReferenceContentIdentity): boolean {
  return left.durationSeconds !== null && right.durationSeconds !== null
    && Math.abs(left.durationSeconds - right.durationSeconds) <= 1.25;
}

export function sameReferenceContent(
  left: ReferenceContentIdentity,
  right: ReferenceContentIdentity,
): boolean {
  if (left.recordId && left.recordId === right.recordId) return true;
  if (left.fileHash && left.fileHash === right.fileHash) return true;
  if (left.sourceKey && left.sourceKey === right.sourceKey) return true;
  if (left.transcriptKey && left.transcriptKey === right.transcriptKey && closeDuration(left, right)) return true;
  return Boolean(left.semanticKey && left.semanticKey === right.semanticKey && closeDuration(left, right));
}

export function uniqueReferenceContent<T extends ReferenceContentEvidence>(records: T[]): T[] {
  const identities: ReferenceContentIdentity[] = [];
  return records.filter(record => {
    const identity = referenceContentIdentity(record);
    if (identities.some(existing => sameReferenceContent(existing, identity))) return false;
    identities.push(identity);
    return true;
  });
}
