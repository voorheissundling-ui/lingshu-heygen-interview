import fs from 'node:fs';
import path from 'node:path';

export function normalizePosterBrief(raw: any) {
  const categories = Array.isArray(raw?.categories) ? raw.categories : [];
  return {
    // Empty model fields stay empty. Filling them with generic supplier claims
    // would turn a parse omission into an unverified business promise.
    headline: String(raw?.headline || '').slice(0, 120),
    subheadline: String(raw?.subheadline || '').slice(0, 140),
    originBadge: String(raw?.originBadge || '').slice(0, 80),
    trustBadges: Array.isArray(raw?.trustBadges) ? raw.trustBadges.map(String).slice(0, 8) : [],
    sellingPoints: Array.isArray(raw?.sellingPoints) ? raw.sellingPoints.map(String).slice(0, 8) : [],
    process: Array.isArray(raw?.process) ? raw.process.map(String).slice(0, 8) : [],
    categories: categories.slice(0, 8).map((item: any) => ({
      name: String(item?.name || item || '').slice(0, 80),
      description: String(item?.description || '').slice(0, 140),
    })).filter((item: { name: string }) => item.name),
    bottomBar: Array.isArray(raw?.bottomBar) ? raw.bottomBar.map(String).slice(0, 8) : [],
    cta: String(raw?.cta || '').slice(0, 120),
  };
}

export function mimeFromFile(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/png';
}

export function materialLocalFile(
  material: { type?: string; file?: string; poster?: string }, mediaDir: string, generatedMediaDir: string,
): string | null {
  const raw = material.type === 'image'
    ? material.file
    : material.poster ? material.poster.replace(/^\/media\//, '').split('?')[0] : '';
  if (!raw) return null;
  if (raw.includes('/')) return path.join(mediaDir, raw);
  const generatedCandidate = path.join(generatedMediaDir, raw);
  if (fs.existsSync(generatedCandidate)) return generatedCandidate;
  return path.join(mediaDir, raw);
}
