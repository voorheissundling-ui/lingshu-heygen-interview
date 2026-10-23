/* One built-in template, shared by desktop and server video exports. */
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const template = require('./subtitle-template.json');
const fontsDirectory = path.join(__dirname, 'fonts');
let fontsVerified = false;

function verifySubtitleFonts() {
  if (fontsVerified) return;
  for (const role of ['body', 'emphasis', 'product']) {
    const font = template[role];
    const file = path.join(fontsDirectory, font.file);
    if (!fs.existsSync(file) || createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== font.sha256)
      throw new Error(`字幕模板字体缺失或损坏：${font.file}`);
  }
  fontsVerified = true;
}

function tag(role) {
  const style = template[role];
  const rgb = style.color.slice(1);
  const bgr = rgb.slice(4, 6) + rgb.slice(2, 4) + rgb.slice(0, 2);
  // Smiley Sans has a real oblique face; the other fonts have regular faces.
  // Never synthesize bold/italic or enlarge a span beyond the wrapped width.
  return `{\\fn${style.font}\\c&H${bgr}&\\b0\\i0}`;
}

function productRange(text, names) {
  // Map through wrapping whitespace so a product spanning two lines retains
  // its styling without changing any subtitle text or measured timestamps.
  let compact = '';
  const positions = [];
  for (let i = 0; i < text.length; i++) {
    if (text.slice(i, i + 2) === '\\N') { i++; continue; }
    if (/\s/.test(text[i])) continue;
    compact += text[i]; positions.push(i);
  }
  const candidates = (Array.isArray(names) ? names : []).filter(name => typeof name === 'string')
    .map(name => name.replace(/\s/g, '')).filter(name => name.length >= 2 && name.length <= 32)
    .sort((a, b) => b.length - a.length);
  for (const name of candidates) {
    const index = compact.toLowerCase().indexOf(name.toLowerCase());
    if (index < 0) continue;
    // Do not highlight an English product name inside an unrelated word.
    if (/^[\x00-\x7f]+$/.test(name)
      && ((index > 0 && /[a-z0-9]/i.test(compact[index - 1]) && positions[index] === positions[index - 1] + 1)
        || (index + name.length < compact.length && /[a-z0-9]/i.test(compact[index + name.length])
          && positions[index + name.length] === positions[index + name.length - 1] + 1))) continue;
    return { start: positions[index], end: positions[index + name.length - 1] + 1 };
  }
  return null;
}

function automaticSubtitleText(value, options = {}) {
  // Preserve generated line breaks, but never accept ASS commands from copy.
  const text = String(value || '').split('\\N').map(line => line.replace(/[{}\\]/g, '')).join('\\N');
  const body = tag('body');
  if (options.autoEmphasis === false) return body + text;
  const product = productRange(text, options.productNames);
  if (product) return body + text.slice(0, product.start) + tag('product') + text.slice(product.start, product.end) + body + text.slice(product.end);
  // A single numeric parameter per page keeps emphasis sparse. Match CJK
  // numerals only alongside a unit, rather than guessing marketing claims.
  const parameter = /(?:\d+(?:[.,]\d+)?|[一二三四五六七八九十百千万两]+)\s*(?:%|％|小时|分钟|秒|毫升|升|公斤|千克|毫米|厘米|年|天|次|倍|件|hours?\b|minutes?\b|seconds?\b|ml\b|kg\b|mm\b|cm\b|watts?\b)/iu;
  const match = parameter.exec(text);
  if (!match) return body + text;
  return body + text.slice(0, match.index) + tag('emphasis') + match[0] + body + text.slice(match.index + match[0].length);
}

module.exports = { automaticSubtitleText, verifySubtitleFonts, fontsDirectory, template };
