/** RIFF chunks are variable length: ffmpeg can place LIST/JUNK before fmt. */
export function wavDurationFromBytes(bytes: Buffer): number {
  if (bytes.length < 12 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') return 0;
  let byteRate = 0, dataBytes = 0;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const kind = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (kind === 'fmt ' && size >= 16 && start + 16 <= bytes.length) byteRate = bytes.readUInt32LE(start + 8);
    if (kind === 'data') dataBytes += Math.min(size, bytes.length - start);
    const next = start + size + (size % 2);
    if (next <= offset || next > bytes.length) break;
    offset = next;
  }
  return byteRate > 0 ? dataBytes / byteRate : 0;
}
