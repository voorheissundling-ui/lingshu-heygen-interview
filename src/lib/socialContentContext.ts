import type {WeeklyContentNavigation} from '../../shared/contracts/weeklyContentNavigation';
import {parseWeeklyContentNavigation} from './weeklyContentNavigationApi';
import { inferSocialImageProductionMode } from './socialImageProductionMode.js';
const ACTIVE_SOCIAL_CONTENT_TASK_KEY = 'lingshu_active_social_content_task';
export const SOCIAL_CONTENT_NAVIGATION_EVENT = 'lingshu:social-content-navigation';

export interface SocialContentNavigationState {
  socialContentTaskId: string;
  socialContentPage: string;
  weeklyContentTarget?: WeeklyContentNavigation;
}

export interface SocialContentNavigationEventDetail {
  taskId: string;
  page: string;
}

export function openSocialImageReplication(video: {
  sourceUrl?: string; thumbnail?: string; title?: string; platform?: string; videoUrl?: string;
  aiAnalysis?: { caption?: string; imageUrls?: string[]; imageCount?: number };
}): void {
  const referenceUrl = String(video.sourceUrl || '').trim(), referenceImage = String(video.thumbnail || '').trim();
  const referenceImageUrls = (video.aiAnalysis?.imageUrls || []).map(String).filter(Boolean);
  const referenceImageMode = inferSocialImageProductionMode({
    thumbnail: referenceImage, mediaUrl: referenceImage, imageUrls: referenceImageUrls,
    imageCount: video.aiAnalysis?.imageCount, isAnimated: Boolean(video.videoUrl),
  });
  window.dispatchEvent(new CustomEvent('lingshu:navigate', { detail: {
    page: 'smartAssets', view: 'create', directStudio: false,
    contentCreationRequest: {
      requestId: Date.now(), themeId: 'product_value', mode: 'instant', creationPath: 'viral_replication',
      materialInput: referenceImage ? 'ready' : 'limited', managedMode: 'one_click_managed',
      prefill: { title: `${video.title || '图文作品'} · 爆款复刻`, topic: video.title || '', referenceLinks: referenceUrl ? [referenceUrl] : [], platforms: video.platform ? [video.platform] : undefined },
      sourceContext: {
        originLabel: '来自灵感中心', referenceTitle: video.title || '已选对标图文',
        referenceThumbnail: referenceImage || undefined, referenceMediaUrl: referenceImage || undefined,
        referenceContentType: 'image', referenceImageMode, referenceImageUrls, referenceCaption: video.aiAnalysis?.caption || '',
      },
    },
  } }));
}

const SOCIAL_CONTENT_CONTEXT_PAGES = new Set([
  'enterprise',
  'socialInspiration',
  'scriptLibrary',
  'smartAssets',
  'traffic',
  'accountManagement',
]);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function taskIdFrom(value: unknown, page: string): string | null {
  const candidate = record(value);
  if (candidate.socialContentPage !== page || typeof candidate.socialContentTaskId !== 'string') return null;
  const taskId = candidate.socialContentTaskId.trim();
  return /^[a-z0-9:_-]{1,200}$/i.test(taskId) ? taskId : null;
}

/** Reads the task handoff for the page being opened without accepting state from another page. */
export function readSocialContentNavigationTaskId(page: string, historyState: unknown): string | null {
  const state = record(historyState);
  return taskIdFrom(state.productionDetail, page) || taskIdFrom(state, page);
}

/** Accepts an explicit deep link only for the exact task-aware page in the URL. */
export function readSocialContentNavigationQueryTaskId(page: string, search: string): string | null {
  if (!SOCIAL_CONTENT_CONTEXT_PAGES.has(page)) return null;
  const params = new URLSearchParams(search);
  if (params.get('page') !== page) return null;
  const taskId = String(params.get('taskId') || '').trim();
  return /^[a-z0-9:_-]{1,200}$/i.test(taskId) ? taskId : null;
}

export function hasWeeklyContentNavigationTarget(historyState:unknown):boolean {const state=record(historyState),detail=record(state.productionDetail);return Object.prototype.hasOwnProperty.call(detail,'weeklyContentTarget')||Object.prototype.hasOwnProperty.call(state,'weeklyContentTarget');}

export function readWeeklyContentNavigationTarget(historyState: unknown): WeeklyContentNavigation | null {
  const state = record(historyState), detail = record(state.productionDetail);
  const value = Object.prototype.hasOwnProperty.call(detail,'weeklyContentTarget') ? detail.weeklyContentTarget : state.weeklyContentTarget;
  if (!value) return null;
  const scope = record(record(value).scope);
  if (!['tenantId','programId','packageId','executionTaskId'].every(key => typeof scope[key] === 'string' && String(scope[key]).trim()) || typeof scope.packageVersion !== 'number') return null;
  try {
    const target = parseWeeklyContentNavigation(value, {tenantId: String(scope.tenantId), programId: String(scope.programId), packageId: String(scope.packageId), packageVersion: scope.packageVersion, executionTaskId: String(scope.executionTaskId)});
    const publishing=detail.page==='traffic'&&detail.view==='publish';
    if (readSocialContentNavigationTaskId(publishing?'traffic':'smartAssets', historyState) !== target.contentTaskId) return null;
    return target;
  } catch { return null; }
}

/** Adds a server-verifiable task handoff only for the exact professional page currently open. */
export function socialContentTaskRequestHeaders(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  const page = new URLSearchParams(window.location.search).get('page') || '';
  if (!SOCIAL_CONTENT_CONTEXT_PAGES.has(page)) return {};
  const taskId = readSocialContentNavigationTaskId(page, window.history.state)
    || readSocialContentNavigationQueryTaskId(page, window.location.search);
  return taskId ? {
    'X-Lingshu-Social-Task-Id': taskId,
    'X-Lingshu-Social-Page': page,
  } : {};
}

export function readActiveSocialContentTaskId(): string | null {
  try {
    const value = localStorage.getItem(ACTIVE_SOCIAL_CONTENT_TASK_KEY)?.trim();
    return value || null;
  } catch {
    return null;
  }
}

export function setActiveSocialContentTaskId(taskId: string | null): void {
  try {
    if (taskId) localStorage.setItem(ACTIVE_SOCIAL_CONTENT_TASK_KEY, taskId);
    else localStorage.removeItem(ACTIVE_SOCIAL_CONTENT_TASK_KEY);
  } catch {
    // The in-memory workspace remains authoritative when storage is unavailable.
  }
}

export function attachSocialContentNavigationState(taskId: string, page: string, weeklyContentTarget?: WeeklyContentNavigation): void {
  if(weeklyContentTarget){const validated=parseWeeklyContentNavigation(weeklyContentTarget,weeklyContentTarget.scope);if(page!=='smartAssets'||validated.contentTaskId!==taskId)throw Error('周任务生产目标与页面或内容身份不一致。');}
  setActiveSocialContentTaskId(taskId);
  const current = window.history.state && typeof window.history.state === 'object' ? window.history.state : {};
  const currentDetail = current.productionDetail && typeof current.productionDetail === 'object'
    ? current.productionDetail
    : {};
  const {weeklyContentTarget: previousTarget, ...cleanCurrent} = current;
  const {weeklyContentTarget: previousDetailTarget, ...cleanDetail} = currentDetail;
  void previousTarget; void previousDetailTarget;
  window.history.replaceState({
    ...cleanCurrent,
    socialContentTaskId: taskId,
    socialContentPage: page,
    productionDetail: {
      ...cleanDetail,
      socialContentTaskId: taskId,
      socialContentPage: page,
      ...(weeklyContentTarget ? {weeklyContentTarget} : {}),
    },
  }, '');
  window.dispatchEvent(new CustomEvent<SocialContentNavigationEventDetail>(
    SOCIAL_CONTENT_NAVIGATION_EVENT,
    { detail: { taskId, page } },
  ));
}
