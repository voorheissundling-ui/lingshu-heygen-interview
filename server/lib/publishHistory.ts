import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RECORDS_FILE = path.join(__dirname, '../../data/social-publish-records.json');

export type PublishPlatform = 'youtube' | 'tiktok' | 'instagram' | 'facebook' | 'linkedin';

export interface SocialPublishRecord {
  id: string;
  tenantId: string;
  platform: PublishPlatform;
  accountId: string;
  platformContentId?: string;
  projectId?: string;
  generationVersionId?: string;
  title: string;
  description: string;
  videoPath?: string;
  ratio?: string;
  language?: string;
  contentFingerprint: string;
  source: 'lingshu';
  status: 'published';
  publishedAt: string;
}

function loadAll(): SocialPublishRecord[] {
  try { return JSON.parse(fs.readFileSync(RECORDS_FILE, 'utf8')) as SocialPublishRecord[]; }
  catch { return []; }
}

function persist(list: SocialPublishRecord[]): void {
  fs.mkdirSync(path.dirname(RECORDS_FILE), { recursive: true });
  fs.writeFileSync(RECORDS_FILE, JSON.stringify(list, null, 2), 'utf8');
}

export function contentFingerprint(input: { videoPath?: string; projectId?: string; generationVersionId?: string; title?: string }): string {
  const resolved = String(input.videoPath || '').trim();
  let fileIdentity = resolved;
  try {
    const stat = fs.statSync(resolved);
    fileIdentity = `${path.resolve(resolved)}:${stat.size}:${stat.mtimeMs}`;
  } catch { /* remote or unavailable path */ }
  return createHash('sha256').update([
    fileIdentity,
    input.projectId || '',
    input.generationVersionId || '',
    String(input.title || '').trim().toLowerCase(),
  ].join('|')).digest('hex');
}

export function listPublishRecords(tenantId: string, accountId?: string): SocialPublishRecord[] {
  return loadAll()
    .filter(item => item.tenantId === tenantId && (!accountId || item.accountId === accountId))
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
}

export function recordSuccessfulPublish(input: Omit<SocialPublishRecord, 'id' | 'contentFingerprint' | 'source' | 'status' | 'publishedAt'>): SocialPublishRecord {
  const record: SocialPublishRecord = {
    ...input,
    id: randomUUID(),
    contentFingerprint: contentFingerprint(input),
    source: 'lingshu',
    status: 'published',
    publishedAt: new Date().toISOString(),
  };
  const list = loadAll();
  list.push(record);
  persist(list);
  return record;
}

function titleTokens(value: string): Set<string> {
  return new Set(String(value || '').toLowerCase().split(/[\s\p{P}\p{S}]+/u).filter(token => token.length > 1));
}

function titleSimilarity(a: string, b: string): number {
  const left = titleTokens(a); const right = titleTokens(b);
  if (!left.size || !right.size) return 0;
  const overlap = [...left].filter(token => right.has(token)).length;
  return overlap / new Set([...left, ...right]).size;
}

export function recommendPublish(input: {
  tenantId: string;
  platform: PublishPlatform;
  accountId: string;
  videoPath?: string;
  projectId?: string;
  generationVersionId?: string;
  title?: string;
  ratio?: string;
  language?: string;
}) {
  const history = listPublishRecords(input.tenantId, input.accountId).slice(0, 100);
  const fingerprint = contentFingerprint(input);
  const exact = history.find(item => item.contentFingerprint === fingerprint);
  const sameProject = input.projectId ? history.find(item => item.projectId === input.projectId) : undefined;
  const similarTitle = history.find(item => titleSimilarity(item.title, input.title || '') >= 0.72);
  const formatIssue = input.platform !== 'youtube' && input.ratio === '16:9';

  let status: 'recommended' | 'adjust' | 'not_recommended' = 'recommended';
  const reasons: string[] = [];
  const actions: string[] = [];
  if (exact) {
    status = 'not_recommended'; reasons.push(`该成片已于 ${exact.publishedAt.slice(0, 10)} 发布到此账号`); actions.push('选择其他内容方案或保留为候选');
  } else if (sameProject) {
    status = 'adjust'; reasons.push(`同一项目已有内容于 ${sameProject.publishedAt.slice(0, 10)} 发布`); actions.push('确认开场、素材顺序和核心卖点具有实质差异');
  } else if (similarTitle) {
    status = 'adjust'; reasons.push('标题与该账号近期内容较接近'); actions.push('检查内容主旨及开场是否重复');
  }
  if (formatIssue) {
    status = status === 'not_recommended' ? status : 'adjust'; reasons.push('当前为 16:9，短视频平台通常更适合 9:16'); actions.push('生成 9:16 平台适配版本');
  }
  if (input.platform === 'youtube' && sameProject && input.language && sameProject.language && input.language !== sameProject.language) {
    status = 'adjust'; reasons.push('画面相同但语言不同，YouTube 更适合合并为多语言音轨'); actions.push('合并到已有视频的多语言音轨');
  }
  if (!history.length) reasons.push('该账号暂无灵枢发布历史，当前仅按平台规格检查');
  else if (status === 'recommended') reasons.push(`已核对该账号最近 ${Math.min(history.length, 100)} 条灵枢发布记录`);

  return {
    status,
    reasons,
    actions,
    coverage: { lingshuRecords: history.length, platformSyncedRecords: 0, level: history.length ? 'medium' : 'limited' },
    checkedAt: new Date().toISOString(),
  };
}
