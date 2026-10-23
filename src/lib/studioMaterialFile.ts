export type StudioMaterialFileKind = 'video' | 'image' | 'audio';

type FileIdentity = Pick<File, 'name' | 'type'>;

const MATERIAL_FILE_BY_EXTENSION: Record<string, { kind: StudioMaterialFileKind; mimeType: string }> = {
  mp4: { kind: 'video', mimeType: 'video/mp4' },
  mov: { kind: 'video', mimeType: 'video/quicktime' },
  webm: { kind: 'video', mimeType: 'video/webm' },
  jpg: { kind: 'image', mimeType: 'image/jpeg' },
  jpeg: { kind: 'image', mimeType: 'image/jpeg' },
  png: { kind: 'image', mimeType: 'image/png' },
  webp: { kind: 'image', mimeType: 'image/webp' },
  gif: { kind: 'image', mimeType: 'image/gif' },
  mp3: { kind: 'audio', mimeType: 'audio/mpeg' },
  wav: { kind: 'audio', mimeType: 'audio/wav' },
  m4a: { kind: 'audio', mimeType: 'audio/mp4' },
};

export const STUDIO_MATERIAL_VIDEO_ACCEPT = [
  '.mp4',
  '.mov',
  '.webm',
  'video/*',
].join(',');

export const STUDIO_MATERIAL_FILE_ACCEPT = [
  STUDIO_MATERIAL_VIDEO_ACCEPT,
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif',
  '.mp3',
  '.wav',
  '.m4a',
  'image/*',
  'audio/*',
].join(',');

function extensionOf(name: string): string {
  return String(name || '').trim().toLowerCase().split('.').at(-1) || '';
}

function kindFromMimeType(value: string): StudioMaterialFileKind | null {
  const topLevel = String(value || '').trim().toLowerCase().split('/', 1)[0];
  return topLevel === 'video' || topLevel === 'image' || topLevel === 'audio' ? topLevel : null;
}

/**
 * Safari and Finder can expose a valid local MOV/MP4 with an empty MIME type.
 * Prefer a browser-provided media MIME, then fall back to the selected file's
 * extension instead of silently treating every unknown file as an image.
 */
export function studioMaterialFileKind(file: FileIdentity): StudioMaterialFileKind | null {
  return kindFromMimeType(file.type) || MATERIAL_FILE_BY_EXTENSION[extensionOf(file.name)]?.kind || null;
}

export function studioMaterialFileMimeType(
  file: FileIdentity,
  expectedKind: StudioMaterialFileKind,
): string | null {
  const browserMime = String(file.type || '').trim().toLowerCase().split(';', 1)[0];
  if (kindFromMimeType(browserMime) === expectedKind) return browserMime;
  const inferred = MATERIAL_FILE_BY_EXTENSION[extensionOf(file.name)];
  return inferred?.kind === expectedKind ? inferred.mimeType : null;
}
