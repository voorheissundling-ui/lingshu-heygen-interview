import type { SocialContentArtifact } from '../../shared/contracts/socialContentWorkflow.js';
import {
  socialArtifactMediaFamily,
  type SocialArtifactMediaDescriptor,
} from './socialArtifactMedia.js';
import { SocialContentWorkflowError, socialObject, socialText } from './socialContentValidation.js';

export interface SocialDeliveryManifest {
  schemaVersion: 'social-content.delivery.v1';
  taskId: string;
  packageId: string;
  artifacts: SocialContentArtifact[];
  media: SocialArtifactMediaDescriptor[];
}

export interface SocialDeliveryArchiveEntry {
  name: string;
  bytes: Buffer;
}

const ZIP_UTF8_FLAG = 0x0800;
const ZIP_MINIMUM_DATE = 0x0021;
const MAX_ARCHIVE_ENTRIES = 512;
const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024;

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  }
  return value >>> 0;
});

function crc32(bytes: Buffer): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function safeSegment(value: string, fallback: string): string {
  const parsed = value.normalize('NFKC').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return (parsed || fallback).slice(0, 100);
}

export function socialDeliveryArtifactDirectory(artifact: Pick<SocialContentArtifact, 'kind' | 'artifactId'>, index: number): string {
  return `artifacts/${String(index + 1).padStart(3, '0')}-${safeSegment(artifact.kind, 'artifact')}-${safeSegment(artifact.artifactId, 'item')}`;
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function contentText(content: Record<string, unknown>): string | null {
  const keys = ['title', 'headline', 'body', 'caption', 'script', 'description', 'callToAction'];
  const parts: string[] = [];
  for (const key of keys) {
    const value = content[key];
    if (typeof value === 'string' && value.trim()) parts.push(`${key}\n${value.trim()}`);
  }
  const hashtags = content.hashtags;
  if (Array.isArray(hashtags) && hashtags.every(value => typeof value === 'string')) {
    parts.push(`hashtags\n${hashtags.join(' ')}`);
  }
  return parts.length ? `${parts.join('\n\n')}\n` : null;
}

export function socialDeliveryArchiveEntries(manifest: SocialDeliveryManifest): SocialDeliveryArchiveEntry[] {
  const references = manifest.artifacts
    .filter(artifact => artifact.resourceRef && !artifact.resourceRef.startsWith('socialfile:'))
    .map(artifact => `${artifact.artifactId}\t${artifact.resourceRef}`);
  const readme = [
    '灵枢社媒内容交付包',
    '',
    `任务：${manifest.taskId}`,
    `交付包：${manifest.packageId}`,
    `成果数量：${manifest.artifacts.length}`,
    '',
    '使用说明',
    '1. 在 artifacts 目录中查看每项已确认成果。',
    '2. content.txt 为可直接复制的文案；content.json 保留完整结构化内容。',
    '3. 每项视频或图片成品的 media 目录内包含已归档媒体文件。',
    '4. RESOURCE-REFERENCES.txt 仅列出其他外部参考链接。',
    '5. 发布后请回到灵枢登记发布链接或平台内容编号，以便回收数据。',
    '',
  ].join('\n');
  const entries: SocialDeliveryArchiveEntry[] = [
    { name: 'README.txt', bytes: Buffer.from(readme, 'utf8') },
    { name: 'manifest.json', bytes: jsonBytes(manifest) },
  ];

  manifest.artifacts.forEach((artifact, index) => {
    const directory = socialDeliveryArtifactDirectory(artifact, index);
    const { content, ...metadata } = artifact;
    entries.push({ name: `${directory}/metadata.json`, bytes: jsonBytes(metadata) });
    if (content) {
      entries.push({ name: `${directory}/content.json`, bytes: jsonBytes(content) });
      const readable = contentText(content);
      if (readable) entries.push({ name: `${directory}/content.txt`, bytes: Buffer.from(readable, 'utf8') });
    }
  });
  if (references.length) {
    entries.push({
      name: 'RESOURCE-REFERENCES.txt',
      bytes: Buffer.from(`${references.join('\n')}\n`, 'utf8'),
    });
  }
  return entries;
}

/** Build a deterministic, uncompressed ZIP so the manifest and text assets remain directly inspectable. */
export function buildSocialDeliveryArchive(manifest: SocialDeliveryManifest): Buffer {
  if (manifest.media.length) {
    throw new SocialContentWorkflowError('social_delivery_archive_media_stream_required', 503);
  }
  const entries = socialDeliveryArchiveEntries(manifest);
  if (!entries.length || entries.length > MAX_ARCHIVE_ENTRIES) {
    throw new SocialContentWorkflowError('social_delivery_archive_limit_exceeded', 503);
  }
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    if (!name.length || name.length > 65_535 || entry.bytes.length > 0xffffffff) {
      throw new SocialContentWorkflowError('social_delivery_archive_limit_exceeded', 503);
    }
    const checksum = crc32(entry.bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(ZIP_UTF8_FLAG, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(ZIP_MINIMUM_DATE, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(entry.bytes.length, 18);
    local.writeUInt32LE(entry.bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, entry.bytes);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(ZIP_UTF8_FLAG, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(ZIP_MINIMUM_DATE, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(entry.bytes.length, 20);
    central.writeUInt32LE(entry.bytes.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + entry.bytes.length;
  }
  const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  const result = Buffer.concat([...localParts, ...centralParts, end]);
  if (result.length > MAX_ARCHIVE_BYTES) {
    throw new SocialContentWorkflowError('social_delivery_archive_limit_exceeded', 503);
  }
  return result;
}

export function parseSocialDeliveryManifest(value: unknown, expected: {
  taskId: string;
  packageId: string;
  artifactIds: string[];
}): SocialDeliveryManifest {
  const manifest = socialObject(value);
  const artifacts = manifest?.artifacts;
  const mediaValue = manifest?.media;
  if (manifest?.schemaVersion !== 'social-content.delivery.v1'
    || socialText(manifest.taskId) !== expected.taskId
    || socialText(manifest.packageId) !== expected.packageId
    || !Array.isArray(artifacts)
    || artifacts.length !== expected.artifactIds.length
    || (mediaValue !== undefined && !Array.isArray(mediaValue))) {
    throw new SocialContentWorkflowError('social_delivery_package_integrity_violation', 503);
  }
  const parsed = artifacts as SocialContentArtifact[];
  if (parsed.some((artifact, index) => !socialObject(artifact)
    || artifact.artifactId !== expected.artifactIds[index]
    || artifact.taskId !== expected.taskId
    || artifact.status !== 'approved')) {
    throw new SocialContentWorkflowError('social_delivery_package_integrity_violation', 503);
  }
  const media = (Array.isArray(mediaValue) ? mediaValue : []) as SocialArtifactMediaDescriptor[];
  const mediaIds = new Set<string>();
  if (media.some(item => {
    if (!socialObject(item)
      || !expected.artifactIds.includes(socialText(item.artifactId))
      || !/^socialfile:socialfile_[a-f0-9]{24}$/.test(socialText(item.fileRef))
      || !socialText(item.name)
      || !['video/mp4', 'video/quicktime', 'video/webm', 'image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(socialText(item.mimeType))
      || !Number.isSafeInteger(Number(item.size)) || Number(item.size) < 1
      || !/^[a-f0-9]{64}$/.test(socialText(item.sha256))
      || mediaIds.has(socialText(item.artifactId))) return true;
    mediaIds.add(socialText(item.artifactId));
    return false;
  })) {
    throw new SocialContentWorkflowError('social_delivery_package_integrity_violation', 503);
  }
  if (parsed.some(artifact => socialArtifactMediaFamily(artifact.kind, artifact.content) && !mediaIds.has(artifact.artifactId))) {
    throw new SocialContentWorkflowError('social_delivery_package_integrity_violation', 503);
  }
  return { ...(manifest as unknown as SocialDeliveryManifest), media };
}
