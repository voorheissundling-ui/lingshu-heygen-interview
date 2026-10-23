import fs from 'fs';
import path from 'path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'url';
import type { Platform } from '../types/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ALERTS_FILE = path.join(__dirname, '../../data/video-admin-alerts.json');

export interface VideoAdminAlert {
  id: string;
  type: 'video_analysis_manual_required';
  severity: 'warning';
  statusLabel: string;
  recordId: string;
  tenantId: string;
  platform: Platform;
  title: string;
  sourceUrl: string;
  reason: string;
  error: string;
  occurrences: number;
  manualUploadStatus?: 'queued' | 'analyzing' | 'analyzed' | 'failed';
  manualUploadedAt?: string;
  manualUploadRecordId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface VideoFailureRecord {
  id?: unknown;
  tenantId?: unknown;
  platform?: unknown;
  title?: unknown;
  sourceUrl?: unknown;
  status?: unknown;
  aiAnalysis?: unknown;
  updated?: unknown;
  updatedAt?: unknown;
}

function readAlerts(): VideoAdminAlert[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(ALERTS_FILE, 'utf8')) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isVideoAdminAlert) : [];
  } catch {
    return [];
  }
}

function writeAlerts(alerts: VideoAdminAlert[]): void {
  fs.mkdirSync(path.dirname(ALERTS_FILE), { recursive: true });
  fs.writeFileSync(ALERTS_FILE, JSON.stringify(alerts, null, 2), 'utf8');
}

function isVideoAdminAlert(value: unknown): value is VideoAdminAlert {
  if (!value || typeof value !== 'object') return false;
  const alert = value as Partial<VideoAdminAlert>;
  return alert.type === 'video_analysis_manual_required'
    && typeof alert.id === 'string'
    && typeof alert.recordId === 'string';
}

function redactSensitiveText(input: string): string {
  return input
    .replace(/(token=)[^&\s]+/gi, '$1***')
    .replace(/(api[_-]?key=)[^&\s]+/gi, '$1***')
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/g, 'Bearer ***')
    .replace(/\/\/([^:\s/@]+):([^@\s]+)@/g, '//***:***@')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1200);
}

type VideoAdminAlertInput = {
  recordId: string;
  tenantId: string;
  platform: Platform;
  title: string;
  sourceUrl: string;
  reason: string;
  error: string;
};

function upsertVideoAdminAlert(input: VideoAdminAlertInput, incrementOccurrences: boolean): void {
  if (!input.recordId || !input.tenantId) return;

  const now = new Date().toISOString();
  const alerts = readAlerts();
  const existingIndex = alerts.findIndex(alert =>
    alert.type === 'video_analysis_manual_required'
    && alert.recordId === input.recordId
  );
  const patch = {
    severity: 'warning' as const,
    statusLabel: '视频级失败/需人工处理',
    tenantId: input.tenantId,
    platform: input.platform,
    title: input.title.slice(0, 160),
    sourceUrl: input.sourceUrl,
    reason: input.reason,
    error: redactSensitiveText(input.error),
    updatedAt: now,
  };

  if (existingIndex >= 0) {
    const existing = alerts[existingIndex];
    alerts[existingIndex] = {
      ...existing,
      ...patch,
      occurrences: incrementOccurrences ? (existing.occurrences || 1) + 1 : existing.occurrences || 1,
      manualUploadStatus: existing.manualUploadStatus === 'analyzed' ? undefined : existing.manualUploadStatus,
    };
  } else {
    alerts.unshift({
      id: randomUUID(),
      type: 'video_analysis_manual_required',
      recordId: input.recordId,
      occurrences: 1,
      createdAt: now,
      ...patch,
    });
  }

  writeAlerts(alerts
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, 500));
}

export function recordVideoAdminAlert(input: VideoAdminAlertInput): void {
  upsertVideoAdminAlert(input, true);
}

export function ensureVideoAdminAlert(input: VideoAdminAlertInput): void {
  upsertVideoAdminAlert(input, false);
}

function analysisRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function videoFailureFromRecord(record: VideoFailureRecord): VideoAdminAlertInput | null {
  const recordId = text(record.id);
  const tenantId = text(record.tenantId);
  const platform = text(record.platform) as Platform;
  if (!recordId || !tenantId || !platform) return null;

  const analysis = analysisRecord(record.aiAnalysis);
  if (analysis.analysisQuality === 'video' || analysis.manualVideoUploadStatus === 'analyzed') return null;

  const status = text(record.status);
  const terminalReason =
    text(analysis.manualRequiredReason) ||
    text(analysis.videoLevelFailureStatus) ||
    text((analysis.adminOnlyVideoFailure as Record<string, unknown> | undefined)?.reason) ||
    (analysis.crawlerOpsStatus === 'needs_manual' ? text(analysis.crawlerOpsReason) || 'crawler_needs_manual' : '') ||
    (analysis.crawlerOpsStatus === 'failed' ? text(analysis.crawlerOpsReason) || 'crawler_failed' : '') ||
    (analysis.videoFetchStatus === 'ops_failed' ? 'crawler_ops_failed' : '') ||
    (analysis.videoFetchStatus === 'manual_required' ? 'manual_video_required' : '') ||
    (analysis.downloadStatus === 'manual_required' ? 'manual_video_required' : '') ||
    (analysis.downloadStatus === 'manual_upload_analyze_failed' ? 'manual_upload_analysis_failed' : '') ||
    (analysis.geminiStatus === 'video_failed' ? 'video_analysis_failed' : '') ||
    (status === 'failed' ? 'video_pipeline_failed' : '');
  if (!terminalReason) return null;

  return {
    recordId,
    tenantId,
    platform,
    title: text(record.title) || `${platform}-video`,
    sourceUrl: text(record.sourceUrl),
    reason: terminalReason,
    error:
      text(analysis.analysisError) ||
      text(analysis.downloadError) ||
      text(analysis.crawlerOpsLastError) ||
      text((analysis.adminOnlyVideoFailure as Record<string, unknown> | undefined)?.error) ||
      terminalReason,
  };
}

function videoRecordIsResolved(record: VideoFailureRecord): boolean {
  const analysis = analysisRecord(record.aiAnalysis);
  return analysis.analysisQuality === 'video' || analysis.manualVideoUploadStatus === 'analyzed';
}

export function syncVideoAdminAlertsFromRecords(records: VideoFailureRecord[]): number {
  const alerts = readAlerts();
  const alertIndexByRecordId = new Map(alerts.map((alert, index) => [alert.recordId, index]));
  const now = new Date().toISOString();
  let changed = false;
  let synced = 0;

  for (const record of records) {
    const failure = videoFailureFromRecord(record);
    const recordId = text(record.id);
    const existingIndex = recordId ? alertIndexByRecordId.get(recordId) : undefined;

    if (failure) {
      const patch = {
        severity: 'warning' as const,
        statusLabel: '视频级失败/需人工处理',
        tenantId: failure.tenantId,
        platform: failure.platform,
        title: failure.title.slice(0, 160),
        sourceUrl: failure.sourceUrl,
        reason: failure.reason,
        error: redactSensitiveText(failure.error),
        updatedAt: text(record.updated) || text(record.updatedAt) || now,
      };
      if (existingIndex === undefined) {
        const nextIndex = alerts.length;
        alerts.push({
          id: randomUUID(),
          type: 'video_analysis_manual_required',
          recordId: failure.recordId,
          occurrences: 1,
          createdAt: patch.updatedAt,
          ...patch,
        });
        alertIndexByRecordId.set(failure.recordId, nextIndex);
      } else {
        const existing = alerts[existingIndex];
        alerts[existingIndex] = {
          ...existing,
          ...patch,
          manualUploadStatus: existing.manualUploadStatus === 'analyzed' ? undefined : existing.manualUploadStatus,
        };
      }
      changed = true;
      synced += 1;
      continue;
    }

    if (existingIndex !== undefined && videoRecordIsResolved(record)) {
      const existing = alerts[existingIndex];
      if (existing.manualUploadStatus !== 'analyzed') {
        alerts[existingIndex] = {
          ...existing,
          statusLabel: '已修复',
          manualUploadStatus: 'analyzed',
          error: '视频已完成视频级分析。',
          updatedAt: text(record.updated) || text(record.updatedAt) || now,
        };
        changed = true;
      }
    }
  }

  if (changed) {
    writeAlerts(alerts
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .slice(0, 500));
  }

  return synced;
}

export function listVideoAdminAlerts(limit = 50, includeResolved = false): VideoAdminAlert[] {
  return readAlerts()
    .filter(alert => includeResolved || alert.manualUploadStatus !== 'analyzed')
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, Math.max(1, Math.min(200, limit)));
}

export function getVideoAdminAlert(id: string): VideoAdminAlert | null {
  return readAlerts().find(alert => alert.id === id) ?? null;
}

export function updateVideoAdminAlert(id: string, patch: Partial<VideoAdminAlert>): VideoAdminAlert | null {
  const alerts = readAlerts();
  const index = alerts.findIndex(alert => alert.id === id);
  if (index < 0) return null;
  const next = {
    ...alerts[index],
    ...patch,
    updatedAt: patch.updatedAt || new Date().toISOString(),
  };
  alerts[index] = next;
  writeAlerts(alerts.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, 500));
  return next;
}

export function updateVideoAdminAlertByRecordId(recordId: string, patch: Partial<VideoAdminAlert>): VideoAdminAlert | null {
  const alerts = readAlerts();
  const match = alerts.find(alert => alert.recordId === recordId);
  if (!match) return null;
  return updateVideoAdminAlert(match.id, patch);
}
