import { createHash } from 'node:crypto';
import { buildBenchmarkAnalysis, recordOf, type BenchmarkAnalysis } from '../../shared/benchmarkAnalysis.js';

/** Rebuild on every read so reruns and manual shot edits cannot leave a stale summary. */
export function benchmarkAnalysisForRecord(record: Record<string, unknown>, analysis: Record<string, unknown>): BenchmarkAnalysis {
  let gemini = recordOf(analysis.gemini);
  if (typeof analysis.gemini === 'string') {
    try { gemini = recordOf(JSON.parse(analysis.gemini)); } catch { /* Keep unavailable evidence empty. */ }
  }
  const evidenceRevision = createHash('sha256').update(JSON.stringify({
    schemaVersion: 1, videoId: record.id, duration: record.duration,
    analysisRunId: analysis.analysisRunId, analyzedAt: analysis.analyzedAt,
    correction: analysis.correction, analysisMode: analysis.analysisMode,
    analysisQuality: analysis.analysisQuality, geminiStatus: analysis.geminiStatus,
    analysisReviewReasons: analysis.analysisReviewReasons,
    requestedAnalysisMode: analysis.requestedAnalysisMode, analysisError: analysis.analysisError,
    shots: gemini.scriptDetails15s, speech: gemini.audioTranscript,
  })).digest('hex');
  return buildBenchmarkAnalysis({ analysis: { ...analysis, gemini }, videoId: String(record.id || ''), duration: Number(record.duration || 0), evidenceRevision });
}
