import fs from 'node:fs';
import path from 'node:path';
import { analyzeImagePostEvidenceWithGemini } from '../agents/gemini.js';
import { analyzeImagePostEvidenceWithQwen } from '../agents/qwen.js';
import type { ImagePostEvidenceAnalysis } from '../agents/qwenContracts.js';
import type { Platform, VideoAiAnalysis } from '../types/index.js';
import type { DataStore } from '../storage/datastore.js';
import { tagsFromKeyword } from '../routes/videoCrawlerNormalization.js';

export interface CrawledImagePost {
  platform: Platform;
  title: string;
  sourceUrl: string;
  thumbnailUrl: string;
  caption?: string;
  imageUrls?: string[];
  views: string;
  tags: string[];
  uploadedAt?: string;
  author?: string;
  likes?: string;
  comments?: string;
  shares?: string;
  plays?: string;
  followers?: number;
  isAd?: boolean;
  isPaidPartnership?: boolean;
  source?: string;
}

type ImageBytes = { base64: string; mimeType: string };
type EvidenceResult = { status: 'analyzed' | 'failed'; analysis?: ImagePostEvidenceAnalysis; error?: string;
  provider?: 'qwen' | 'gemini'; providerAttempted?: boolean };

/** Crawler-owned public image retrieval and existing primary/fallback selection. */
export function createImagePostEvidenceAnalyzer(input: {
  store: DataStore;
  collection: string;
  mediaDir: string;
  normalizeThumbnailUrl(url: string): string;
  fetcher?: typeof fetch;
  analyzeQwen?: typeof analyzeImagePostEvidenceWithQwen;
  analyzeGemini?: typeof analyzeImagePostEvidenceWithGemini;
}) {
  async function fetchImageForAnalysis(url: string): Promise<ImageBytes | null> {
    const normalized = input.normalizeThumbnailUrl(url);
    if (!normalized) return null;
    try {
      let filePath = '';
      if (normalized.startsWith('/media/')) filePath = path.join(input.mediaDir, path.basename(normalized));
      if (filePath && fs.existsSync(filePath)) {
        return { base64: fs.readFileSync(filePath).toString('base64'), mimeType: mimeFromImagePath(filePath) };
      }
      const resp = await (input.fetcher || fetch)(normalized, {
        signal: AbortSignal.timeout(20_000),
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/125 Safari/537.36',
          'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        },
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const mimeType = resp.headers.get('content-type') || 'image/jpeg';
      if (!mimeType.startsWith('image/')) return null;
      const buf = Buffer.from(await resp.arrayBuffer());
      if (!buf.length || buf.length > 8 * 1024 * 1024) return null;
      return { base64: buf.toString('base64'), mimeType };
    } catch {
      return null;
    }
  }

  async function analyzeImagePostBestEffort(item: CrawledImagePost, keyword: string, _fallback?: VideoAiAnalysis): Promise<EvidenceResult> {
    const urls = [...new Set((item.imageUrls?.length ? item.imageUrls : [item.thumbnailUrl]).filter(Boolean))].slice(0, 10);
    const images = (await Promise.all(urls.map(async (url, index) => {
      const image = await fetchImageForAnalysis(url);
      return image ? { ...image, imageIndex: index + 1 } : null;
    }))).filter((image): image is ImageBytes & { imageIndex: number } => Boolean(image));
    if (!images.length) return { status: 'failed', error: '公开图片下载失败，未执行视觉分析' };
    const evidenceInput = {
      images, title: item.title, caption: item.caption, platform: item.platform,
      tags: [...new Set([...item.tags, ...tagsFromKeyword(keyword, item.platform)])],
    };
    try {
      const analysis = await (input.analyzeQwen || analyzeImagePostEvidenceWithQwen)(evidenceInput);
      return { status: 'analyzed', analysis, provider: 'qwen' };
    } catch (qwenError) {
      console.warn('[videos] Qwen image post analysis failed, trying Gemini:', qwenError instanceof Error ? qwenError.message : qwenError);
      try {
        const analysis = await (input.analyzeGemini || analyzeImagePostEvidenceWithGemini)({
          images, title: item.title, caption: item.caption, platform: item.platform,
          tags: [...new Set([...item.tags, ...tagsFromKeyword(keyword, item.platform)])],
        });
        return { status: 'analyzed', analysis, provider: 'gemini' };
      } catch (geminiError) {
        console.warn('[videos] Gemini image post analysis failed:', geminiError instanceof Error ? geminiError.message : geminiError);
        const qwenMessage = qwenError instanceof Error ? qwenError.message : String(qwenError);
        const geminiMessage = geminiError instanceof Error ? geminiError.message : String(geminiError);
        return { status: 'failed', error: `Qwen: ${qwenMessage}; Gemini: ${geminiMessage}`.slice(0, 900), providerAttempted: true };
      }
    }
  }

  return { fetchImageForAnalysis, analyzeImagePostBestEffort };
}

function mimeFromImagePath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/jpeg';
}
