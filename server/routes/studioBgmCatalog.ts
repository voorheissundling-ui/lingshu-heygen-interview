import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { objectStorageSignedGetUrl } from '../storage/objectStorage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function materialSignedUrlTtlSeconds(): number {
  const configured = Number(process.env.MATERIAL_SIGNED_URL_TTL_SECONDS || 900);
  return Number.isFinite(configured) ? Math.max(60, Math.min(3600, configured)) : 900;
}

export const BGM_ROOT = path.join(__dirname, '../../data/bgm');
const BGM_FILE = path.join(__dirname, '../../data/bgm.json');
const BUILTIN_BGM_ROOT = path.join(__dirname, '../assets/bgm');

export interface BgmTrack {
  id: string;
  name: string;
  mood: string;
  duration: number;
  file: string;
  url: string;
  recommended?: boolean;
  builtin?: boolean;
  tenantId?: string;
  scope?: 'shared' | 'tenant';
  uploadedBy?: string;
  createdAt: string;
  objectKey?: string;
  sourceUrl?: string;
  license?: string;
}

const BUILTIN_BGM_TRACKS: BgmTrack[] = [
  {
    id: 'builtin-tech-pulse',
    name: '灵枢推荐配乐01',
    mood: '科技感 · 稳定推进',
    duration: 24,
    file: 'tech-pulse.mp3',
    url: '/bgm/shared/tech-pulse.mp3',
    recommended: true,
    builtin: true,
    scope: 'shared',
    uploadedBy: '灵枢官方曲库',
    createdAt: '2026-08-21T00:00:00.000Z',
  },
  {
    id: 'builtin-clean-corporate',
    name: '灵枢推荐配乐02',
    mood: '企业感 · 清爽克制',
    duration: 24,
    file: 'clean-corporate.mp3',
    url: '/bgm/shared/clean-corporate.mp3',
    recommended: true,
    builtin: true,
    scope: 'shared',
    uploadedBy: '灵枢官方曲库',
    createdAt: '2026-08-21T00:00:01.000Z',
  },
  {
    id: 'builtin-product-energy',
    name: '灵枢推荐配乐03',
    mood: '产品展示 · 轻快有力',
    duration: 24,
    file: 'product-energy.mp3',
    url: '/bgm/shared/product-energy.mp3',
    recommended: true,
    builtin: true,
    scope: 'shared',
    uploadedBy: '灵枢官方曲库',
    createdAt: '2026-08-21T00:00:02.000Z',
  },
  {
    id: 'builtin-mixkit-close-up',
    name: '灵枢推荐配乐04',
    mood: '科技产业 · 律动推进',
    duration: 95.14,
    file: 'mixkit-close-up.mp3',
    url: '/bgm/shared/mixkit-close-up.mp3',
    recommended: true,
    builtin: true,
    scope: 'shared',
    uploadedBy: 'Mixkit 免版税曲库',
    createdAt: '2026-08-21T00:00:03.000Z',
    sourceUrl: 'https://mixkit.co/free-stock-music/corporate-music/',
    license: 'Mixkit Free License',
  },
  {
    id: 'builtin-mixkit-its-love',
    name: '灵枢推荐配乐05',
    mood: '品牌叙事 · 轻盈积极',
    duration: 96.63,
    file: 'mixkit-its-love.mp3',
    url: '/bgm/shared/mixkit-its-love.mp3',
    recommended: true,
    builtin: true,
    scope: 'shared',
    uploadedBy: 'Mixkit 免版税曲库',
    createdAt: '2026-08-21T00:00:04.000Z',
    sourceUrl: 'https://mixkit.co/free-stock-music/corporate-music/',
    license: 'Mixkit Free License',
  },
];

function ensureBuiltinBgmFiles(): BgmTrack[] {
  const sharedDir = path.join(BGM_ROOT, 'shared');
  try { fs.mkdirSync(sharedDir, { recursive: true }); } catch { return []; }
  return BUILTIN_BGM_TRACKS.filter(track => {
    const source = path.join(BUILTIN_BGM_ROOT, track.file);
    const target = path.join(sharedDir, track.file);
    if (!fs.existsSync(source)) return false;
    try {
      if (!fs.existsSync(target) || fs.statSync(target).size !== fs.statSync(source).size) fs.copyFileSync(source, target);
      return true;
    } catch {
      return false;
    }
  });
}

export function loadBgm(): BgmTrack[] {
  let uploaded: BgmTrack[] = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(BGM_FILE, 'utf8')) as BgmTrack[];
    uploaded = Array.isArray(parsed) ? parsed.filter(track => !track.builtin) : [];
  } catch { /* first run */ }
  const builtins = ensureBuiltinBgmFiles();
  const builtinIds = new Set(builtins.map(track => track.id));
  return [...builtins, ...uploaded.filter(track => !builtinIds.has(track.id))];
}
export function persistBgm(list: BgmTrack[]): void {
  try { fs.mkdirSync(path.dirname(BGM_FILE), { recursive: true }); } catch { /* ignore */ }
  fs.writeFileSync(BGM_FILE, JSON.stringify(list.filter(track => !track.builtin), null, 2), 'utf8');
}

export function userBgms(tenantId: string): BgmTrack[] {
  // Pre-isolation uploads have no tenantId and live at data/bgm/<file>.
  // Keep those legacy tracks visible as the authenticated shared library;
  // new uploads remain strictly scoped to their owning tenant.
  return visibleBgmTracks(loadBgm(), tenantId);
}

export function visibleBgmTracks(list: BgmTrack[], tenantId: string): BgmTrack[] {
  return list.filter(track => track.builtin || track.scope === 'shared' || !track.tenantId || track.tenantId === tenantId);
}

function sortBgmTracks(list: BgmTrack[]): BgmTrack[] {
  return [...list].sort((a, b) => {
    const recommendedDelta = (b.recommended ? 1 : 0) - (a.recommended ? 1 : 0);
    if (recommendedDelta) return recommendedDelta;
    return String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || a.id.localeCompare(b.id);
  });
}

export function withRecommendedBgmNames(list: BgmTrack[]): BgmTrack[] {
  return sortBgmTracks(list).map((track, index) => ({
    ...track,
    name: `灵枢推荐配乐${String(index + 1).padStart(2, '0')}`,
    scope: track.scope || (!track.tenantId ? 'shared' : 'tenant'),
    uploadedBy: track.uploadedBy || (!track.tenantId ? '灵枢管理员上传' : '客户上传'),
  }));
}

export function automationBgmCatalog(tenantId: string) {
  return withRecommendedBgmNames(userBgms(tenantId)).map(({ id, name, mood }) => ({ id, name, mood }));
}
export async function automationBgmAudio(tenantId: string, id: string): Promise<string> {
  const track = userBgms(tenantId).find(item => item.id === id);
  if (!track) throw Error('所选配乐已不可用，请在生产现场更换');
  if (track.objectKey) return objectStorageSignedGetUrl(track.objectKey, materialSignedUrlTtlSeconds());
  const relative = track.url.replace(/^\/bgm\//, '');
  const root = path.resolve(BGM_ROOT);
  const file = path.resolve(root, relative);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) throw Error('配乐文件缺失，请在生产现场更换');
  return 'data:audio/mpeg;base64,' + fs.readFileSync(file).toString('base64');
}
