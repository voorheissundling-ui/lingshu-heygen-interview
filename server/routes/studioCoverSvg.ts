function coverResolution(ratio: string): [number, number] {
  if (ratio === '1:1') return [1080, 1080];
  if (ratio === '16:9') return [1920, 1080];
  return [1080, 1920];
}

function xmlEscape(s: string): string {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c] as string));
}

/** 按每行字符预算把标题贪心折成 ≤3 行 */
function wrapTitle(title: string, perLine: number): string[] {
  const words = String(title).trim().split(/\s+/);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if (cur && (cur.length + 1 + w.length) > perLine) { lines.push(cur); cur = w; }
    else cur = cur ? `${cur} ${w}` : w;
    if (lines.length === 2 && cur.length > perLine) break;
  }
  if (cur) lines.push(cur);
  return lines.slice(0, 3);
}

type CoverFont = 'sans' | 'impact' | 'serif' | 'rounded' | 'mono';
export interface CoverStyle {
  color: string;
  size: 'S' | 'M' | 'L';
  position: 'top' | 'center' | 'bottom';
  verticalPosition?: number;
  align: 'left' | 'center';
  font: CoverFont;
  weight?: 'regular' | 'bold' | 'heavy';
  artPreset?: 'clean' | 'outline' | 'highlight' | 'magazine' | 'neon' | 'sticker';
}

// 字体栈用系统字体（SVG 经 <img> 加载无法用网页字体），均带 CJK 回退
const COVER_FONT_STACK: Record<CoverFont, string> = {
  sans:    `'Arial Unicode MS','PingFang SC','Microsoft YaHei',sans-serif`,
  impact:  `'Arial Black','Impact','Heiti SC','Microsoft YaHei',sans-serif`,
  serif:   `'Songti SC','SimSun','Times New Roman',serif`,
  rounded: `'Arial Rounded MT Bold','PingFang SC','Microsoft YaHei',sans-serif`,
  mono:    `'Menlo','Consolas','DejaVu Sans Mono',monospace`,
};

export function buildCoverSvg(opts: { title: string; ratio: string; accent: string; bgImageUrl?: string } & Partial<CoverStyle>): string {
  const [w, h] = coverResolution(opts.ratio);
  const requestedColor = String(opts.color || '');
  const color = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(requestedColor)
    ? requestedColor : '#ffffff';
  const size = opts.size || 'M';
  const position = opts.position || 'bottom';
  const align = opts.align || 'left';
  const fontStack = COVER_FONT_STACK[opts.font || 'sans'] || COVER_FONT_STACK.sans;
  const weight = opts.weight === 'regular' ? 600 : opts.weight === 'heavy' ? 900 : opts.font === 'serif' ? 700 : 800;
  const artPreset = opts.artPreset || 'clean';

  const scale = size === 'S' ? 0.062 : size === 'L' ? 0.098 : 0.078;
  const fontSize = Math.round(w * scale);
  const lineH = Math.round(fontSize * 1.18);
  const pad = Math.round(w * 0.045);
  const displayTitle = artPreset === 'magazine' ? String(opts.title || '').toUpperCase() : opts.title || '';
  const lines = wrapTitle(displayTitle, Math.floor(w / (fontSize * 0.6)));
  const totalH = (lines.length - 1) * lineH;

  const requestedVerticalPosition = Number(opts.verticalPosition);
  const verticalPosition = Number.isFinite(requestedVerticalPosition)
    ? Math.max(8, Math.min(92, requestedVerticalPosition))
    : position === 'top' ? 14 : position === 'center' ? 50 : 86;
  const firstBaseline = Math.round(h * verticalPosition / 100 - (fontSize + totalH) / 2 + fontSize * 0.8);

  const anchor = align === 'center' ? 'middle' : 'start';
  const tx = align === 'center' ? Math.round(w / 2) : pad;

  const bg = opts.bgImageUrl
    ? `<image href="${xmlEscape(opts.bgImageUrl)}" x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="xMidYMid slice"/>`
    : `<rect width="${w}" height="${h}" fill="#111827"/>`;

  const half = Math.round(h * 0.5);
  const scrim =
    position === 'top' ? `<rect x="0" y="0" width="${w}" height="${half}" fill="url(#scrimT)"/>`
    : position === 'center' ? `<rect width="${w}" height="${h}" fill="#000" fill-opacity="0.3"/>`
    : `<rect x="0" y="${half}" width="${w}" height="${half}" fill="url(#scrimB)"/>`;

  const texts = lines.map((ln, i) => {
    const y = firstBaseline + i * lineH;
    const escaped = xmlEscape(ln);
    const estimatedWidth = Math.min(w - pad * 2, Math.max(fontSize * 1.4, ln.length * fontSize * 0.58));
    const rectX = align === 'center' ? Math.round((w - estimatedWidth) / 2) : pad;
    if (artPreset === 'highlight') {
      return `<rect x="${rectX - Math.round(fontSize * 0.12)}" y="${y - Math.round(fontSize * 0.9)}" width="${Math.round(estimatedWidth + fontSize * 0.24)}" height="${Math.round(fontSize * 1.08)}" rx="${Math.round(fontSize * 0.1)}" fill="#facc15"/><text x="${tx}" y="${y}" text-anchor="${anchor}" font-family="${fontStack}" font-size="${fontSize}" font-weight="${weight}" fill="#111827">${escaped}</text>`;
    }
    if (artPreset === 'sticker') {
      return `<text x="${tx + Math.round(fontSize * 0.1)}" y="${y + Math.round(fontSize * 0.1)}" text-anchor="${anchor}" font-family="${fontStack}" font-size="${fontSize}" font-weight="${weight}" fill="#16a34a" stroke="#16a34a" stroke-width="${Math.round(fontSize * 0.15)}" paint-order="stroke fill">${escaped}</text><text x="${tx}" y="${y}" text-anchor="${anchor}" font-family="${fontStack}" font-size="${fontSize}" font-weight="${weight}" fill="#111827" stroke="#fff" stroke-width="${Math.round(fontSize * 0.16)}" paint-order="stroke fill">${escaped}</text>`;
    }
    const strokeWidth = artPreset === 'outline' ? Math.round(fontSize * 0.12) : Math.round(fontSize * 0.04);
    const strokeOpacity = artPreset === 'outline' ? 0.95 : 0.25;
    const filter = artPreset === 'neon' ? ' filter="url(#neonGlow)"' : '';
    const italic = artPreset === 'magazine' ? ' font-style="italic"' : '';
    return `<text x="${tx}" y="${y}" text-anchor="${anchor}" font-family="${fontStack}" font-size="${fontSize}" font-weight="${weight}" fill="${color}" paint-order="stroke" stroke="#000" stroke-opacity="${strokeOpacity}" stroke-width="${strokeWidth}"${filter}${italic}>${escaped}</text>`;
  }).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">
<defs>
  <linearGradient id="scrimB" x1="0" y1="0" x2="0" y2="1"><stop offset="0.45" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.7"/></linearGradient>
  <linearGradient id="scrimT" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0.7"/><stop offset="0.55" stop-color="#000" stop-opacity="0"/></linearGradient>
  <filter id="neonGlow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="10" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
</defs>
${bg}
${scrim}
${texts}
</svg>`;
}
