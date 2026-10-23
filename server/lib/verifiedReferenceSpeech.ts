export interface VerifiedSpeechLine {
  text: string;
  start: number;
  end: number;
  visibility: 'on_camera' | 'voiceover';
  speakerId?: string;
}

export interface VerifiedReferenceSpeech {
  schemaVersion: 1;
  analysisRunId: string;
  sourceSha256: string;
  lines: VerifiedSpeechLine[];
  coverageConfirmed: boolean;
  reviewerId: string;
  verifiedAt: string;
}

/** A manual verification is tied to one exact source and analysis run. */
export function validateVerifiedSpeechLines(value: unknown, duration: number): VerifiedSpeechLine[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 500) throw new Error('需要提交 1～500 条逐句口播');
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('视频时长无效');
  let previousEnd = 0;
  return value.map((raw, index) => {
    if (!raw || typeof raw !== 'object') throw new Error(`第 ${index + 1} 句无效`);
    const line = raw as Record<string, unknown>;
    const text = typeof line.text === 'string' ? line.text.trim() : '';
    const start = line.start;
    const end = line.end;
    if (!text || text.length > 1000) throw new Error(`第 ${index + 1} 句缺少有效口播`);
    if (typeof start !== 'number' || typeof end !== 'number' || !Number.isFinite(start) || !Number.isFinite(end)
      || start < 0 || end <= start || end > duration + 0.05 || start < previousEnd - 0.02) {
      throw new Error(`第 ${index + 1} 句时间码无效或与上一句重叠`);
    }
    if (line.visibility !== 'on_camera' && line.visibility !== 'voiceover') throw new Error(`第 ${index + 1} 句需确认画内口播或画外音`);
    if (line.speakerId !== undefined && (typeof line.speakerId !== 'string' || line.speakerId.length > 100)) throw new Error(`第 ${index + 1} 句说话人无效`);
    previousEnd = end;
    return { text, start, end, visibility: line.visibility, ...(line.speakerId ? { speakerId: line.speakerId } : {}) };
  });
}

export function currentVerifiedSpeech(value: unknown, analysisRunId: string, sourceSha256: string): VerifiedReferenceSpeech | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Partial<VerifiedReferenceSpeech>;
  return item.schemaVersion === 1 && item.analysisRunId === analysisRunId && item.sourceSha256 === sourceSha256
    && Array.isArray(item.lines) && typeof item.coverageConfirmed === 'boolean'
    && typeof item.reviewerId === 'string' && typeof item.verifiedAt === 'string'
    ? item as VerifiedReferenceSpeech : null;
}

export function verifiedSpeechStatus(value: VerifiedReferenceSpeech | null): 'needs_review' | 'partial_review' | 'verified' {
  if (!value) return 'needs_review';
  return value.coverageConfirmed ? 'verified' : 'partial_review';
}
