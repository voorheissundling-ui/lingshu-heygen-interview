import type { DataStore } from '../storage/datastore.js';
import { parseJsonRecord } from '../routes/videoCrawlerNormalization.js';

/** CDN links may expire, so preserve the collected media before analysis. */
export function createImagePostMediaPersistence(input: {
  store: DataStore;
  collection: string;
  cacheThumbnail(recordId: string, url: string): Promise<string | null>;
  fetchImage(url: string): Promise<{ base64: string; mimeType: string } | null>;
  uploadObject(recordId: string, role: string, body: Buffer, mimeType: string): Promise<string>;
}) {
  async function persistThumbnail(recordId: string, url: string): Promise<string> {
    if (!/^https?:\/\//i.test(url)) return url;
    const local = await input.cacheThumbnail(recordId, url);
    if (!local) return url;
    await input.store.update(input.collection, recordId, { thumbnailUrl: local });
    return local;
  }

  async function persistImages(recordId: string, urls: string[]): Promise<string[]> {
    const unique = [...new Set(urls.filter(Boolean))].slice(0, 10);
    const stored: string[] = [];
    const objectKeys: string[] = [];
    for (let index = 0; index < unique.length; index += 1) {
      const url = unique[index]!;
      if (!/^https?:\/\//i.test(url)) { stored.push(url); continue; }
      const image = await input.fetchImage(url);
      if (!image) continue;
      const key = await input.uploadObject(recordId, `image-${index + 1}`, Buffer.from(image.base64, 'base64'), image.mimeType);
      objectKeys.push(key);
      stored.push(`/api/overseas/videos/${recordId}/image/${objectKeys.length - 1}`);
    }
    const record = await input.store.getById<Record<string, unknown>>(input.collection, recordId);
    const analysis = parseJsonRecord<Record<string, unknown>>(record?.aiAnalysis, {});
    if (!await input.store.update(input.collection, recordId, {
      aiAnalysis: JSON.stringify({ ...analysis, imageStorage: 'cos', imageObjectKeys: objectKeys }),
    })) throw Error('image_post_source_persistence_failed');
    return stored;
  }
  return { persistThumbnail, persistImages };
}
