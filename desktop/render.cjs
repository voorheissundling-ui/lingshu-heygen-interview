/* eslint-disable */
/**
 * 本机原生 ffmpeg 合成器（桌面端）。
 * 按服务器下发的 manifest 把「素材片段 → 拼接 → 烧录字幕 → 混入 BGM」
 * 合成一条真实 MP4。素材 / BGM 通过 manifest 里的 url 现拉到临时目录再喂给 ffmpeg。
 *
 * manifest 字段缺失时优雅退化：
 *   - 没有素材片段 → 用纯色背景兜底，仍出片
 *   - 没有 BGM     → 用静音轨
 * voiceover.url 与 bgm.url 均会下载并混入最终音轨；声明了音轨却下载失败时必须终止，
 * 避免用户拿到“字幕正常但没有声音”的静默成片。
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { layoutFilters, tempoFilters, muteIntervals } = require('./shot-composition.cjs');
const { normalizeEffectPlan, sceneEffectFilters, joinSceneFilters, audioEventFilters } = require('./effect-composition.cjs');
const { automaticSubtitleText, verifySubtitleFonts, fontsDirectory, template: subtitleTemplate } = require('./automatic-subtitles.cjs');
const { normalizeEmphasisPlan, emphasisToAssEvents, captionEmphasisTags } = require('./emphasis-composition.cjs');
const { advancedEvents, renderTransparentOverlay } = require('./remotion-overlay.cjs');

let ffmpegPath = null;
try { ffmpegPath = require('ffmpeg-static'); } catch { ffmpegPath = null; }

/** 画面比例 → 分辨率 */
function resolution(ratio) {
  switch (ratio) {
    case '1:1': return [1080, 1080];
    case '16:9': return [1920, 1080];
    case '9:16':
    default: return [1080, 1920];
  }
}

const IMAGE_RE = /\.(jpe?g|png|webp|gif|bmp|svg)(\?|$)/i;
const DATA_URL_RE = /^data:([^;,]+)?((?:;[^,]*)*),(.*)$/is;

function dataUrlParts(value) {
  const match = String(value || '').match(DATA_URL_RE);
  if (!match) return null;
  const mime = String(match[1] || 'application/octet-stream').toLowerCase();
  const metadata = String(match[2] || '');
  try {
    return {
      mime,
      bytes: /;base64/i.test(metadata)
        ? Buffer.from(match[3] || '', 'base64')
        : Buffer.from(decodeURIComponent(match[3] || ''), 'utf8'),
    };
  } catch {
    return null;
  }
}

function extensionForAsset(value, declaredType) {
  const data = dataUrlParts(value);
  const mime = data && data.mime;
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/gif') return 'gif';
  if (mime === 'video/quicktime') return 'mov';
  if (mime === 'video/webm') return 'webm';
  if (mime === 'video/mp4') return 'mp4';
  if (mime === 'audio/mpeg') return 'mp3';
  if (mime === 'audio/wav' || mime === 'audio/x-wav') return 'wav';
  let pathname = '';
  try {
    pathname = new URL(String(value || ''), 'http://local').pathname;
  } catch {
    pathname = String(value || '').split(/[?#]/)[0];
  }
  const ext = path.extname(pathname).slice(1).toLowerCase();
  if (/^[a-z0-9]{1,8}$/.test(ext)) return ext;
  if (declaredType === 'image') return 'png';
  if (declaredType === 'audio') return 'wav';
  return 'mp4';
}

function isImageAsset(value, declaredType) {
  if (declaredType === 'image') return true;
  if (declaredType === 'video') return false;
  const data = dataUrlParts(value);
  if (data) return data.mime.startsWith('image/');
  return IMAGE_RE.test(String(value || ''));
}

/** 下载远端 url 到本地文件（桌面端与本机 express 同机，localhost 直连） */
async function downloadTo(url, dest, options = {}) {
  const rawSource = String(url || '');
  const source = rawSource.startsWith('/') && options.assetOrigin
    ? new URL(rawSource, options.assetOrigin).href : rawSource;
  if (options.serverStrictAssets) {
    let parsed;
    try { parsed = new URL(source); } catch { throw new Error('invalid server render asset URL'); }
    if (!options.assetOrigin || parsed.origin !== new URL(options.assetOrigin).origin || parsed.username || parsed.password
      || !/^\/(?:media|tts|covers|bgm|studio-media|api\/overseas\/studio\/)/.test(parsed.pathname)) {
      throw new Error('server render asset source is not allowed');
    }
  }
  const data = dataUrlParts(source);
  if (data) {
    if (options.serverStrictAssets) throw new Error('data URL is not allowed for server render');
    if (!data.bytes.length) throw new Error('empty data URL');
    fs.writeFileSync(dest, data.bytes);
    return dest;
  }
  if (source.startsWith('file://')) {
    if (options.serverStrictAssets) throw new Error('file URL is not allowed for server render');
    const localPath = fileURLToPath(source);
    if (!fs.existsSync(localPath) || fs.statSync(localPath).size <= 0) throw new Error(`missing local file ${localPath}`);
    fs.copyFileSync(localPath, dest);
    return dest;
  }
  // A Windows drive path (`D:\...` / `D:/...`) looks like a URL scheme, so
  // recognize it explicitly before treating bare sources as remote URLs.
  const windowsDrivePath = /^[a-z]:[\\/]/i.test(source);
  if ((windowsDrivePath || !/^[a-z][a-z0-9+.-]*:/i.test(source)) && fs.existsSync(source)) {
    if (options.serverStrictAssets) throw new Error('local path is not allowed for server render');
    if (fs.statSync(source).size <= 0) throw new Error(`empty local file ${source}`);
    fs.copyFileSync(source, dest);
    return dest;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);
  const headers = options.assetOrigin && new URL(source).origin === new URL(options.assetOrigin).origin
    ? options.assetHeaders || {}
    : {};
  let res;
  try {
    res = await fetch(source, { headers, signal: controller.signal, redirect: options.serverStrictAssets ? 'manual' : 'follow' });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`素材读取失败（HTTP ${res.status}）`);
  if ((res.headers.get('content-type') || '').includes('application/json')) {
    if (options.serverStrictAssets) throw new Error('server render media route returned JSON instead of media');
    const payload = await res.json();
    if (typeof payload.url !== 'string' || options.resolvedMediaUrl) throw new Error('素材接口没有返回有效媒体地址');
    return downloadTo(payload.url, dest, { ...options, resolvedMediaUrl: true });
  }
  if (options.serverStrictAssets) {
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared > options.maxAssetBytes) throw new Error('render asset exceeds size limit');
    if (!res.body) throw new Error('render asset has no response body');
    let bytes = 0;
    const meter = new Transform({ transform(chunk, _encoding, done) {
      bytes += chunk.length;
      options.totalBytes.value += chunk.length;
      if (bytes > options.maxAssetBytes || options.totalBytes.value > options.maxTotalAssetBytes) done(new Error('render asset exceeds size limit'));
      else done(null, chunk);
    } });
    const streamTimer = setTimeout(() => controller.abort(), 45_000);
    try {
      await pipeline(Readable.fromWeb(res.body), meter, fs.createWriteStream(dest, { mode: 0o600 }));
    } catch (error) {
      try { fs.rmSync(dest, { force: true }); } catch { /* noop */ }
      throw error;
    } finally {
      clearTimeout(streamTimer);
    }
  } else {
    fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  }
  return dest;
}

function finiteNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function runBoundedFfmpeg(args, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => proc.kill('SIGKILL'), timeoutMs);
    proc.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4096); });
    proc.on('error', error => { clearTimeout(timer); reject(error); });
    proc.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg preprocessing failed (${code ?? signal})\n${stderr.slice(-1200)}`));
    });
  });
}

function assTime(sec) {
  const n = Math.max(0, Number(sec) || 0);
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const s = Math.floor(n % 60);
  const cs = Math.floor((n - Math.floor(n)) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function assText(value) {
  return String(value || '')
    .replace(/\r?\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[{}]/g, '')
    .trim();
}

function subtitleUnit(char) {
  if (/\s/.test(char)) return 0.35;
  if (/[ilI.,!:'`|]/.test(char)) return 0.28;
  if (/[frt()]/.test(char)) return 0.36;
  if (/[MWmw@]/.test(char)) return 0.82;
  if (/[A-Z]/.test(char)) return 0.66;
  if (/[\x00-\xff]/.test(char)) return 0.54;
  return 1;
}

function subtitleUnits(value) {
  return Array.from(String(value || '')).reduce((sum, char) => sum + subtitleUnit(char), 0);
}

/**
 * Break a subtitle into mobile-safe pages. Each page contains at most two
 * lines, and every line is constrained by visual width rather than JS string
 * length so Chinese and Latin copy behave consistently.
 */
function subtitlePages(value, maxUnitsPerLine = 12, maxLines = 2, maxUnitsPerPage = 16) {
  const source = assText(value);
  if (!source) return [];
  // Keep space-delimited words intact; CJK still permits breaks between glyphs.
  const tokens = source.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|[^\s\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu) || [];
  const join = words => words.join(' ').replace(/([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}，。！？；：、])\s+(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}，。！？；：、])/gu, '$1');
  const badEnd = /\b(a|an|the|of|to|for|with|which|your|our|is|are|not|before|while)\s*$/i;
  const wrap = words => {
    if (subtitleUnits(join(words)) <= maxUnitsPerLine || words.length === 1) return [join(words)];
    let best = null, bestCost = Infinity;
    for (let split = 1; split < words.length; split++) {
      const left = join(words.slice(0, split)), right = join(words.slice(split));
      const lw = subtitleUnits(left), rw = subtitleUnits(right);
      if (lw > maxUnitsPerLine || rw > maxUnitsPerLine) continue;
      const score = (lw - rw) ** 2 + (badEnd.test(left) ? 25 : 0)
        - (/[，。！？；：、,;:!?]$/.test(left) ? 30 : 0);
      if (score < bestCost) { bestCost = score; best = [left, right]; }
    }
    return best;
  };
  const cost = Array(tokens.length + 1).fill(Infinity), next = [], layouts = [];
  cost[tokens.length] = 0;
  const capacity = Math.max(8, Math.min(maxUnitsPerLine * maxLines, maxUnitsPerPage));
  for (let i = tokens.length - 1; i >= 0; i--) {
    for (let j = i + 1; j <= tokens.length; j++) {
      const words = tokens.slice(i, j), phrase = join(words), width = subtitleUnits(phrase);
      if (width > capacity && j > i + 1) break;
      const lines = wrap(words);
      if (!lines || lines.length > maxLines) continue;
      const dangling = j < tokens.length && badEnd.test(phrase);
      const punctuationBoundary = /[，。！？；：、,;:!?]["'”’]?$/u.test(phrase);
      const tooShort = width < 8 && j < tokens.length ? (8 - width) ** 2 * 20 : 0;
      const penalty = capacity * capacity + (capacity - width) ** 2 + (dangling ? 250 : 0) + tooShort
        - (punctuationBoundary ? capacity * capacity : 0);
      if (penalty + cost[j] < cost[i]) { cost[i] = penalty + cost[j]; next[i] = j; layouts[i] = lines; }
    }
  }
  const pages = [];
  for (let i = 0; i < tokens.length;) { const j = next[i] || i + 1; pages.push(layouts[i] || [tokens[i]]); i = j; }
  return pages;
}

function groupSpokenCues(cues, options = {}) {
  const gapLimit = finiteNumber(options.pauseThreshold, .28);
  const maxDuration = finiteNumber(options.maxPhraseDuration, 4.2);
  const groups = [];
  const seen = new Set();
  for (const cue of Array.isArray(cues) ? cues : []) {
    const text = assText(cue.text), start = Number(cue.start), end = Number(cue.end);
    if (!text || !Number.isFinite(start) || !Number.isFinite(end) || end <= start || start < 0) continue;
    const signature = `${start.toFixed(3)}:${end.toFixed(3)}:${text}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    const previous = groups.at(-1);
    const gap = previous ? start - previous.end : Infinity;
    const terminal = previous && /[.!?。！？]["'”’]?\s*$/.test(previous.text);
    const words = (Array.isArray(cue.words) ? cue.words : []).map(word => ({
      text: String(word && word.text || '').trim(),
      start: Number.isFinite(Number(word && word.startMs)) ? Number(word.startMs) / 1000 : Number(word && word.start),
      end: Number.isFinite(Number(word && word.endMs)) ? Number(word.endMs) / 1000 : Number(word && word.end),
    })).filter(word => word.text && Number.isFinite(word.start) && Number.isFinite(word.end) && word.end > word.start);
    if (previous && !terminal && gap >= 0 && gap <= gapLimit && end - previous.start <= maxDuration) {
      previous.text += (/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text) ? '' : ' ') + text;
      previous.end = end; previous.parts.push({ start, end, text, words }); previous.words.push(...words);
    } else groups.push({ start, end, text, words, parts: [{ start, end, text, words }] });
  }
  return groups;
}

function normalizeSubtitleCues(cues, options = {}) {
  const maxUnitsPerLine = Math.max(8, Math.min(12, finiteNumber(options.maxUnitsPerLine, 12)));
  const maxLines = Math.max(1, Math.min(2, Math.round(finiteNumber(options.maxLines, 2))));
  const maxUnitsPerPage = Math.max(8, Math.min(16, finiteNumber(options.maxUnitsPerPage, 16)));
  return groupSpokenCues(cues, options).flatMap(group => {
    const pages = subtitlePages(group.text, maxUnitsPerLine, maxLines, maxUnitsPerPage);
    // Preserve measured cue boundaries. A break inside one provider cue is
    // an estimate within that cue, never a new word-level alignment claim.
    const units = value => subtitleUnits(value.replace(/\s/g, ''));
    const parts = group.parts.map(part => ({ ...part, weight: units(part.text) }));
    const totalWeight = parts.reduce((sum, part) => sum + part.weight, 0);
    const at = (position, endBoundary) => {
      let offset = 0;
      for (const part of parts) {
        if (position < offset + part.weight - 1e-6 || (endBoundary && position <= offset + part.weight + 1e-6))
          return part.start + (part.end - part.start) * Math.max(0, Math.min(1, (position - offset) / Math.max(.001, part.weight)));
        offset += part.weight;
      }
      return group.end;
    };
    let offset = 0;
    return pages.map((page, index) => {
      const start = index === 0 ? group.start : at(offset, false);
      offset += units(page.join(''));
      const end = index === pages.length - 1 ? group.end : at(Math.min(totalWeight, offset), true);
      return { start, end, text: page.join('\\N'), words: group.words.filter(word => word.start < end && start < word.end) };
    });
  });
}

function wordHighlightOverlays(value, words, cueStart, cueEnd) {
  const text = String(value || '').replace(/[{}]/g, '');
  const timed = (Array.isArray(words) ? words : []).filter(word => word && word.text
    && Number.isFinite(word.start) && Number.isFinite(word.end) && word.end > word.start)
    .sort((left, right) => left.start - right.start);
  if (!timed.length) return [];
  let cursor = 0;
  return timed.flatMap(word => {
    const found = text.toLocaleLowerCase().indexOf(String(word.text).toLocaleLowerCase(), cursor);
    if (found < 0) return [];
    let end = found + String(word.text).length;
    // Closing punctuation belongs to the spoken word and never gets its own
    // color event. Preserve spaces and line breaks outside the highlighted span.
    while (end < text.length && /[.,!?;:…。，！？；：”’»)]/u.test(text[end])) end++;
    cursor = end;
    const start = Math.max(cueStart, word.start), finish = Math.min(cueEnd, word.end);
    if (!(finish > start)) return [];
    return [{
      start, end: finish,
      text: `{\\alpha&HFF&}${text.slice(0, found)}{\\alpha&H00&}${text.slice(found, end)}{\\alpha&HFF&}${text.slice(end)}`,
    }];
  });
}

function filterPath(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:')
    .replace(/,/g, '\\,');
}

// Motion graphics are an input visual layer. Burn the frozen ASS track only
// after all overlays so an opaque motion frame cannot silently hide a cue.
function appendFinalVisualLayers(filters, visualLabel, motionOverlayIdx, width, height, assFile, captureCaptionBaseline = false) {
  let composedLabel = visualLabel;
  if (motionOverlayIdx >= 0) {
    filters.push(`[${motionOverlayIdx}:v]fps=30,scale=${width}:${height},format=yuva420p,setpts=PTS-STARTPTS[vmotion]`);
    filters.push(`${composedLabel}[vmotion]overlay=0:0:format=auto:shortest=1[vbeforecaption]`);
    composedLabel = '[vbeforecaption]';
  }
  if (assFile && captureCaptionBaseline) {
    filters.push(`${composedLabel}split=2[vcaptioninput][vbaseline]`);
    filters.push(`[vcaptioninput]subtitles='${filterPath(assFile)}':fontsdir='${filterPath(fontsDirectory)}'[vout]`);
  } else if (assFile) filters.push(`${composedLabel}subtitles='${filterPath(assFile)}':fontsdir='${filterPath(fontsDirectory)}'[vout]`);
  else filters.push(`${composedLabel}null[vout]`);
}

function cuesToAss(cues, width, height, disclaimer = '', duration = 0, style = {}, emphasisPlan = null) {
  const assColor = (hex, fallback) => /^#[0-9a-f]{6}$/i.test(String(hex || '')) ? `&H00${hex.slice(5, 7)}${hex.slice(3, 5)}${hex.slice(1, 3).toUpperCase()}&`.toUpperCase() : fallback;
  const fontByChoice = { sans: subtitleTemplate.body.font, impact: subtitleTemplate.emphasis.font, rounded: subtitleTemplate.product.font };
  const font = fontByChoice[style.font] || subtitleTemplate.body.font;
  const primaryColor = assColor(style.color, '&H00FFFFFF&');
  const outlineColor = assColor(style.outlineColor, '&HAA000000&');
  // Scale from the short edge so a 1080px-wide portrait and 1080px-high
  // landscape render use the same perceived subtitle size.
  const fontSize = Math.round(Math.min(width, height) / 18 * Math.max(.7, Math.min(1.5, Number(style.fontScale) || 1.45)));
  const marginX = Math.round(width * .085);
  const rawCues = Array.isArray(cues) ? cues : [];
  const normalizedCues = [
    ...normalizeSubtitleCues(rawCues.filter(cue => cue?.kind !== 'screen'), {
      maxUnitsPerLine: Math.min(12, (width - marginX * 2) / fontSize, Math.max(8, Number(style.lineWidth) || 12)),
      maxUnitsPerPage: 16,
    }),
    ...rawCues.filter(cue => cue?.kind === 'screen'),
  ].sort((a, b) => Number(a?.start || 0) - Number(b?.start || 0));
  const valid = normalizedCues
    .map(cue => ({
      start: Math.max(0, Number(cue && cue.start) || 0),
      end: Math.max(0, Number(cue && cue.end) || 0),
      text: String(cue && cue.text || '').replace(/[{}]/g, '').trim(),
      screen: cue && cue.kind === 'screen',
      words: Array.isArray(cue && cue.words) ? cue.words : [],
    }))
    .filter(cue => cue.text && cue.end > cue.start);
  if (!valid.length && !disclaimer && !(emphasisPlan && emphasisPlan.events && emphasisPlan.events.length)) return '';

  const marginV = Math.round(height * Math.max(.08, Math.min(.35, Number(style.bottomRatio) || .24)));
  const outline = Math.max(0, Math.min(style.boxed === true ? 24 : 8,
    Number(style.outlineWidth ?? Math.round(width * .003))));
  const borderStyle = style.boxed === true ? 3 : 1;
  // The base caption owns the optional background plate. Drawing a second
  // boxed border around the active word would cover adjacent words and lines.
  const highlightOutline = Math.max(0, Math.min(4,
    Number(style.highlightOutlineWidth ?? Math.round(width * .002))));
  const events = valid.flatMap(cue => {
    const prefix = cue.screen
      ? `{\\an8\\pos(${Math.round(width / 2)},${Math.round(height * 0.12)})}`
      : '';
    const overlays = cue.screen ? [] : wordHighlightOverlays(cue.text, cue.words, cue.start, cue.end);
    // Timed-word captions keep the base sentence in the manifest color; the
    // WordHighlight layer is the only span allowed to use the accent color.
    const text = cue.screen ? cue.text : overlays.length ? cue.text : automaticSubtitleText(cue.text, style);
    const emphasis = cue.screen ? '' : captionEmphasisTags(emphasisPlan, cue.start, cue.end, width);
    return [
      `Dialogue: ${cue.screen ? 1 : 0},${assTime(cue.start)},${assTime(cue.end)},Default,,0,0,0,,${prefix}${emphasis}${text}`,
      ...overlays.map(overlay => `Dialogue: 1,${assTime(overlay.start)},${assTime(overlay.end)},WordHighlight,,0,0,0,,${overlay.text}`),
    ];
  });
  if (disclaimer && duration > 0) events.push(`Dialogue: 1,0:00:00.00,${assTime(duration)},Default,,0,0,0,,{\\an8\\pos(${Math.round(width / 2)},${Math.round(height * 0.08)})\\fs${Math.round(width * 0.035)}}${assText(disclaimer).replace(/[{}]/g, '')}`);
  if (emphasisPlan) {
    const captionBoundIds = new Set(valid.flatMap(cue => {
      if (cue.screen) return [];
      const startMs = cue.start * 1000, endMs = cue.end * 1000;
      return emphasisPlan.events.filter(event => ['hook', 'reveal'].includes(event.type) && event.source === 'transcript'
        && startMs < event.endMs && event.startMs < endMs).map(event => event.id);
    }));
    events.push(...emphasisToAssEvents({ ...emphasisPlan,
      events: emphasisPlan.events.filter(event => !captionBoundIds.has(event.id)) }, width, height));
  }
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,${font},${fontSize},${primaryColor},${primaryColor},${outlineColor},&H66000000,-1,0,0,0,100,100,0,0,${borderStyle},${outline},1,2,${marginX},${marginX},${marginV},1`,
    `Style: WordHighlight,${font},${fontSize},${assColor(style.karaokeColor || subtitleTemplate.body.color, '&H0066DFFF&')},${primaryColor},${outlineColor},&H00000000,-1,0,0,0,100,100,0,0,1,${highlightOutline},0,2,${marginX},${marginX},${marginV},1`,
    `Style: Emphasis,${subtitleTemplate.emphasis.font},${Math.round(width * .05)},&H00FFFFFF&,&H00FFFFFF&,&H00101010&,&HAA101010&,-1,0,0,0,100,100,0,0,3,2,1,8,${marginX},${marginX},${Math.round(height * .08)},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events,
    '',
  ].join('\n');
}

/**
 * 合成成片。
 * @param {object} manifest 服务器下发的渲染清单
 * @param {(pct:number)=>void} onProgress 进度回调（0-100）
 * @param {string} [outDir] 输出目录，默认 ~/Downloads/lingshu-ai-exports
 * @returns {Promise<{ok:boolean, outputPath?:string, error?:string}>}
 */
async function composite(manifest, onProgress = () => {}, outDir) {
  if (!ffmpegPath) {
    return { ok: false, error: 'ffmpeg-static binary not found（请先 npm install ffmpeg-static）' };
  }

  const spec = (manifest && manifest.spec) || {};
  const duration = Math.max(1, Number(spec.duration) || 20);
  const frameContract = manifest && manifest.frameContract;
  if (frameContract) {
    const expected = Math.round(duration * 30);
    if (frameContract.schemaVersion !== 'social-render-frame-contract.v1' || frameContract.fps !== 30 ||
        frameContract.durationSeconds !== duration || !Number.isInteger(frameContract.expectedFrames) ||
        frameContract.expectedFrames !== expected || Math.abs(duration * 1000 - Math.round(duration * 1000)) > 1e-6 ||
        duration > 45 || expected > 1350) return { ok: false, error: 'render_frame_contract_invalid' };
  }
  const [baseW, baseH] = resolution(spec.ratio);
    const scale = spec.resolution === '720p' ? 2 / 3 : 1;
    const [w, h] = [Math.round(baseW * scale / 2) * 2, Math.round(baseH * scale / 2) * 2];
  const jobId = (manifest && manifest.jobId) || `job-${Date.now()}`;
  const dir = outDir || path.join(os.homedir(), 'Downloads', 'lingshu-ai-exports');
  fs.mkdirSync(dir, { recursive: true });
  const outputPath = path.join(dir, `studio-${jobId}.mp4`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-'));
  const downloadOptions = {
    assetOrigin: String(manifest && manifest.assetOrigin || ''),
    assetHeaders: manifest && manifest.assetHeaders && typeof manifest.assetHeaders === 'object' ? manifest.assetHeaders : {},
    serverStrictAssets: Boolean(manifest && manifest.serverStrictAssets),
    maxAssetBytes: Number(manifest && manifest.maxAssetBytes) || 100 * 1024 * 1024,
    maxTotalAssetBytes: Number(manifest && manifest.maxTotalAssetBytes) || 1024 * 1024 * 1024,
    totalBytes: { value: 0 },
  };

  try {
    // 1) 拉取真实素材片段与 BGM
    const declaredTimeline = Array.isArray(manifest && manifest.timeline) ? manifest.timeline : [];
    const timeline = declaredTimeline.filter(t => t && t.url);
    if (manifest && manifest.requireVisualAssets === true && !declaredTimeline.length) {
      throw new Error('自动成片没有视觉时间线，已停止纯色画面降级');
    }
    if (manifest && manifest.requireVisualAssets === true && timeline.length !== declaredTimeline.length) {
      throw new Error('视觉时间线存在未绑定素材地址的片段，已停止渲染');
    }
    const localClips = [];
    const clipErrors = [];
    const downloadedTimelineAssets = new Map();
    for (let i = 0; i < timeline.length; i++) {
      const u = timeline[i].url;
      const ext = extensionForAsset(u, timeline[i].type);
      const dest = path.join(tmp, `clip${i}.${ext}`);
      try {
        const cacheKey = `${String(u)}\0${ext}`;
        const file = downloadedTimelineAssets.get(cacheKey) || dest;
        if (!downloadedTimelineAssets.has(cacheKey)) {
          await downloadTo(u, dest, downloadOptions);
          downloadedTimelineAssets.set(cacheKey, dest);
        }
        localClips.push({ ...timeline[i], file, image: isImageAsset(u, timeline[i].type) });
      } catch (error) {
        clipErrors.push(`片段 ${i + 1}（${String(timeline[i].name || '未命名素材')}）: ${error && error.message || error}`);
      }
    }
    if (timeline.length && !localClips.length) {
      throw new Error(`时间线素材全部读取失败，已停止纯色画面降级：${clipErrors.join('；')}`);
    }
    if (manifest && manifest.requireVisualAssets === true && clipErrors.length) {
      throw new Error(`时间线素材不完整，已停止渲染：${clipErrors.join('；')}`);
    }
    // Treat the manifest as untrusted even when it came from our server. Old
    // projects have no effectPlan and normalize to intensity=0 + hard cuts.
    const effectPlan = normalizeEffectPlan(manifest && manifest.effectPlan, localClips.map((clip, index) => ({
      sceneId: clip.sceneId || clip.clipId || String(index),
      clipId: clip.clipId,
      targetDuration: clip.targetDuration,
    })));
    const rawEmphasisPlan = manifest && (manifest.emphasisPlan || manifest.emphasis);
    const emphasisPlan = normalizeEmphasisPlan(rawEmphasisPlan, duration);
    // Motion events use the normalized caption events as their timing/layout
    // fallback, but belong to the same render contract. Preserve them here so
    // the Remotion layer can merge a single semantic motion with its event.
    // The overlay renderer validates role, timing, target confidence and
    // geometry before anything reaches Remotion.
    if (rawEmphasisPlan && Array.isArray(rawEmphasisPlan.motionEvents)) {
      emphasisPlan.motionEvents = rawEmphasisPlan.motionEvents.slice(0, 160);
    }
    let motionOverlay = { path: null, cacheHit: false, renderMs: 0 };
    if (advancedEvents(emphasisPlan).length) {
      try {
        motionOverlay = await renderTransparentOverlay({
          plan: emphasisPlan, width: Math.max(360, Math.round(w / 2)), height: Math.max(640, Math.round(h / 2)),
          durationSeconds: duration, fps: 15,
          onProgress: progress => onProgress(Math.min(18, Math.round(progress * 18))),
        });
        if (process.env.RENDER_DEBUG) console.error(`[render] remotion overlay cache=${motionOverlay.cacheHit ? 'hit' : 'miss'} ms=${motionOverlay.renderMs}`);
      } catch (error) {
        if (process.env.RENDER_DEBUG) console.error(`[render] remotion overlay fallback: ${error && error.message || error}`);
        motionOverlay = { path: null, cacheHit: false, renderMs: 0 };
      }
    }

    // Product and background layers are separate FFmpeg inputs. A declared
    // layer must download successfully; silently dropping it would change the
    // approved shot composition.
    const extraClips = [];
    for (let i = 0; i < localClips.length; i++) {
      const clip = localClips[i];
      for (const kind of ['product', 'background']) {
        if (kind === 'background' && clip.production?.backgroundMode === 'baked') continue;
        const url = clip[`${kind}Url`];
        if (!url) continue;
        const file = path.join(tmp, `layer-${i}-${kind}.${extensionForAsset(url, clip[`${kind}Type`])}`);
        await downloadTo(url, file, downloadOptions);
        clip[`${kind}Index`] = localClips.length + extraClips.length;
        extraClips.push({
          file,
          image: isImageAsset(url, clip[`${kind}Type`]),
          target: Math.max(1 / 30, finiteNumber(clip.targetDuration, duration / Math.max(1, localClips.length))),
        });
      }
    }

    let bgmFile = null;
    const bgmUrl = manifest && manifest.bgm && manifest.bgm.url;
    if (bgmUrl) {
      bgmFile = path.join(tmp, `bgm.${extensionForAsset(bgmUrl, 'audio')}`);
      try { await downloadTo(bgmUrl, bgmFile, downloadOptions); }
      catch (error) { throw new Error(`背景音乐读取失败：${error && error.message || error}`); }
    }

    let voFile = null;
    const voUrl = manifest && manifest.voiceover && manifest.voiceover.url;
    if (voUrl) {
      voFile = path.join(tmp, `vo.${extensionForAsset(voUrl, 'audio')}`);
      try { await downloadTo(voUrl, voFile, downloadOptions); }
      catch (error) { throw new Error(`口播配音读取失败：${error && error.message || error}`); }
    }

    if (process.env.RENDER_DEBUG) console.error(`[render] downloaded clips=${localClips.length} bgm=${bgmFile ? 'yes' : 'no'} voiceover=${voFile ? 'yes' : 'no'}`);

    // A single ffmpeg filter graph with dozens of independent H.264 inputs can
    // segfault in the bundled macOS binary before the first frame is emitted.
    // Normalize and concatenate large, voiceover-only timelines in bounded
    // one-input steps, then apply subtitles/BGM to the resulting owned video.
    // This preserves every frozen scene duration while keeping the final graph
    // at one visual decoder. Source-audio scenes and layered compositions stay
    // on the full graph because collapsing them would change approved audio or
    // layer semantics.
    let visualClips = localClips;
    const canPrecompose = localClips.length > 16 && extraClips.length === 0
      && !localClips.some(clip => clip.production?.sound === 'source' || clip.production?.layout);
    if (canPrecompose) {
      const normalized = [];
      for (let i = 0; i < localClips.length; i++) {
        const clip = localClips[i];
        const target = Math.max(1 / 30, finiteNumber(clip.targetDuration, duration / localClips.length));
        const trimStart = Math.max(0, finiteNumber(clip.trimStart, 0));
        const trimEnd = Math.max(trimStart + 0.1, finiteNumber(clip.trimEnd, trimStart + target));
        const speed = Math.min(4, Math.max(0.25, finiteNumber(clip.speed, 1)));
        const segment = path.join(tmp, `normalized-${String(i).padStart(3, '0')}.mp4`);
        const inputArgs = clip.image
          ? ['-loop', '1', '-t', target.toFixed(3), '-i', clip.file]
          : ['-i', clip.file];
        const source = clip.image
          ? `trim=duration=${target.toFixed(3)},setpts=PTS-STARTPTS`
          : `trim=start=${trimStart.toFixed(3)}:end=${trimEnd.toFixed(3)},setpts=(PTS-STARTPTS)/${speed.toFixed(3)},tpad=stop_mode=clone:stop_duration=${target.toFixed(3)},trim=duration=${target.toFixed(3)},setpts=PTS-STARTPTS`;
        await runBoundedFfmpeg([
          '-hide_banner', '-nostdin', '-y', ...inputArgs,
          '-vf', `${source},scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30,format=yuv420p`,
          '-an', '-t', target.toFixed(3), '-c:v', 'libx264', '-threads', '1', '-preset', 'veryfast', '-crf', '20',
          '-pix_fmt', 'yuv420p', '-r', '30', '-g', '60', '-keyint_min', '30', '-sc_threshold', '0', segment,
        ], Math.max(120000, target * 15000));
        normalized.push(segment);
      }
      const concatList = path.join(tmp, 'normalized-concat.txt');
      fs.writeFileSync(concatList, normalized.map(file => `file '${file.replace(/'/g, "'\\''")}'`).join('\n') + '\n');
      const precomposed = path.join(tmp, 'normalized-timeline.mp4');
      await runBoundedFfmpeg(['-hide_banner', '-nostdin', '-y', '-f', 'concat', '-safe', '0', '-i', concatList,
        '-c', 'copy', '-movflags', '+faststart', precomposed], Math.max(120000, duration * 5000));
      visualClips = [{ file: precomposed, image: false, targetDuration: duration, trimStart: 0, trimEnd: duration,
        targetStart: 0, cropMode: 'contain', sceneId: 'precomposed-timeline' }];
    }

    // 2) 组装 ffmpeg 参数
    const n = visualClips.length;
    // Bound filter workers: multiple 1080p xfade inputs otherwise retain large
    // frame queues per worker and can exhaust memory on a local preview host.
    const args = ['-hide_banner', '-nostdin', '-fflags', '+genpts', '-filter_complex_threads', '2']; // -nostdin：别等键盘输入，否则 spawn 的 stdin 管道会让 ffmpeg 永久挂起
    const filters = [];
    let vlabel;

    if (n > 0) {
      visualClips.forEach(c => {
        const target = Math.max(1 / 30, finiteNumber(c.targetDuration, duration / n));
        if (c.image) args.push('-loop', '1', '-t', target.toFixed(3), '-i', c.file);
        else { if (c.production?.transparent && /\.webm$/i.test(c.file)) args.push('-c:v', 'libvpx-vp9'); args.push('-i', c.file); }
      });
      extraClips.forEach(c => {
        if (c.image) args.push('-loop', '1', '-t', c.target.toFixed(3), '-i', c.file);
        else args.push('-i', c.file);
      });
      visualClips.forEach((c, i) => {
        const target = Math.max(1 / 30, finiteNumber(c.targetDuration, duration / n));
        const trimStart = Math.max(0, finiteNumber(c.trimStart, 0));
        const rawTrimEnd = finiteNumber(c.trimEnd, trimStart + target);
        const trimEnd = Math.max(trimStart + 0.1, rawTrimEnd);
        const speed = Math.min(4, Math.max(0.25, finiteNumber(c.speed, 1)));
        // Without a trusted focal anchor, preserve the entire source on top of
        // a blurred fill. Blind center-cropping is especially destructive when
        // a landscape factory/product shot is rendered to a 9:16 canvas.
        const source = c.image
          ? `[${i}:v]trim=duration=${target.toFixed(3)},setpts=PTS-STARTPTS`
          : `[${i}:v]trim=start=${trimStart.toFixed(3)}:end=${trimEnd.toFixed(3)},setpts=(PTS-STARTPTS)/${speed.toFixed(3)},tpad=stop_mode=clone:stop_duration=${target.toFixed(3)},trim=duration=${target.toFixed(3)},setpts=PTS-STARTPTS`;
        if (c.production?.layout) {
          filters.push(...layoutFilters({
            source,
            index: i,
            width: w,
            height: h,
            target,
            layout: c.production.layout,
            productIndex: c.productIndex,
            backgroundIndex: c.backgroundIndex,
            transparent: Boolean(c.production.transparent),
          }));
          return;
        }
        const focusX = Math.max(0, Math.min(1, finiteNumber(c.focusX, 0.5)));
        const focusY = Math.max(0, Math.min(1, finiteNumber(c.focusY, 0.5)));
        const trustedFocus = c.cropMode === 'cover' || (c.cropMode === 'smart' && Number.isFinite(Number(c.focusX)) && Number.isFinite(Number(c.focusY)));
        if (trustedFocus) {
          filters.push(`${source},scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}:(iw-ow)*${focusX.toFixed(4)}:(ih-oh)*${focusY.toFixed(4)},setsar=1,fps=30,settb=AVTB,setpts=N/(30*TB),format=yuv420p[v${i}]`);
        } else {
          filters.push(`${source},split=2[bg${i}raw][fg${i}raw]`);
          filters.push(`[bg${i}raw]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},boxblur=20:2[bg${i}]`);
          filters.push(`[fg${i}raw]scale=${w}:${h}:force_original_aspect_ratio=decrease[fg${i}]`);
          filters.push(`[bg${i}][fg${i}]overlay=(W-w)/2:(H-h)/2,setsar=1,fps=30,settb=AVTB,setpts=N/(30*TB),format=yuv420p[v${i}]`);
        }
      });
      const effectLabels = [];
      const targets = [];
      visualClips.forEach((clip, index) => {
        const target = Math.max(.03, finiteNumber(clip.targetDuration, duration / n));
        const output = `ve${index}`;
        filters.push(...sceneEffectFilters({
          source: `[v${index}]`, output,
          scene: canPrecompose ? null : effectPlan.scenes[index], width: w, height: h, target,
          intensity: canPrecompose ? 0 : effectPlan.intensity,
        }));
        effectLabels.push(`[${output}]`);
        targets.push(target);
      });
      const joined = joinSceneFilters({ labels: effectLabels, scenes: canPrecompose ? [] : effectPlan.scenes, targets, output: 'vcat' });
      filters.push(...joined.filters);
      vlabel = joined.output;
    } else {
      // 兜底：纯色背景
      args.push('-f', 'lavfi', '-t', String(duration), '-i', `color=c=0x141A2E:s=${w}x${h}:r=30`);
      vlabel = '[0:v]';
    }

    const visualInputCount = n > 0 ? n + extraClips.length : 1;
    const motionOverlayIdx = motionOverlay.path ? visualInputCount : -1;
    if (motionOverlay.path) args.push('-c:v', 'libvpx-vp9', '-i', motionOverlay.path);

    // 音轨输入：BGM(或静音) 固定一路，配音可选第二路。视频输入占 0..(vInputs-1)
    const vInputs = visualInputCount + (motionOverlay.path ? 1 : 0);
    const bgmIdx = vInputs;
    // Stop the looping music source at the approved timeline. An unbounded
    // input can keep loudnorm/amix feeding while video waits for its output.
    if (bgmFile) args.push('-stream_loop', '-1', '-t', String(duration), '-i', bgmFile);
    else args.push('-f', 'lavfi', '-t', String(duration), '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100');
    let voIdx = -1;
    if (voFile) { args.push('-i', voFile); voIdx = bgmIdx + 1; }

    // 3) 烧录口播字幕。每条 cue 单行显示，位置在画面下方 1/3。
    const subtitleCues = manifest && manifest.subtitles && manifest.subtitles.mode !== 'off'
      ? manifest.subtitles.cues
      : [];
    const subtitleCueSha256 = createHash('sha256').update(JSON.stringify(subtitleCues ?? null)).digest('hex');
    const assPlan = motionOverlay.path
      ? { ...emphasisPlan, events: emphasisPlan.events.filter(event => !['key_fact', 'reveal', 'cta'].includes(event.type)) }
      : emphasisPlan;
    const ass = cuesToAss(subtitleCues, w, h, manifest.disclaimer || '', duration, manifest.subtitles?.style || {}, assPlan);
    const subtitleAssSha256 = ass ? createHash('sha256').update(ass, 'utf8').digest('hex') : null;
    let assFile = null;
    if (ass) {
      verifySubtitleFonts();
      assFile = path.join(tmp, 'subtitles.ass');
      fs.writeFileSync(assFile, ass, 'utf8');
    }
    // A baseline from the same FFmpeg graph makes later pixel-level caption
    // comparison possible without rebuilding effects or trusting source text.
    // It is evidence only: it does not by itself prove subtitle visibility.
    const captureCaptionBaseline = Boolean(manifest && manifest.captureCaptionBaseline === true && assFile && duration <= 45);
    const baselineDirectory = captureCaptionBaseline ? path.join(dir, '.private-render-evidence') : null;
    const baselinePath = baselineDirectory ? path.join(baselineDirectory, `${path.basename(outputPath, '.mp4')}.caption-base.mp4`) : null;
    if (baselineDirectory) {
      fs.mkdirSync(baselineDirectory, { recursive: true, mode: 0o700 });
      const status = fs.lstatSync(baselineDirectory);
      if (!status.isDirectory() || status.isSymbolicLink()) throw new Error('字幕基底私有目录无效');
      fs.chmodSync(baselineDirectory, 0o700);
    }
    appendFinalVisualLayers(filters, vlabel, motionOverlayIdx, w, h, assFile, captureCaptionBaseline);

    // 4) 音轨混音：bgmVol 表示最终混音增益，必须与界面显示一致。
    // 默认值本身已经按“口播垫底”设置，不能在有配音时再静默减半，
    // 否则界面 18% 实际只剩 9%，音轨虽存在却几乎听不见。
    // Do not run loudnorm against looped inputs: it can keep the filter graph
    // open after the one-shot render interval. Source tracks are already
    // attenuated by the configured mix volume.
    // Catalog and tenant tracks have very different mastering levels. Always
    // normalize an actual music input before applying the Director's frozen
    // mix percentage; scene sound policy controls muting, not track loudness.
    const musicNormalize = bgmFile ? 'loudnorm=I=-16:TP=-2:LRA=11,' : '';
    const rawBgmVol = Number(spec.bgmVol);
    const rawVoiceVol = Number(spec.voiceVol);
    const vol = Math.min(1, Math.max(0, (Number.isFinite(rawBgmVol) ? rawBgmVol : 35) / 100));
    const voiceVol = Math.min(1.5, Math.max(0, (Number.isFinite(rawVoiceVol) ? rawVoiceVol : 100) / 100));
    if (voFile) {
      filters.push(`[${bgmIdx}:a]${musicNormalize}volume=${vol.toFixed(2)}${muteIntervals(localClips, 'bgm')},aresample=async=1:first_pts=0,aformat=sample_rates=44100:channel_layouts=stereo[abgm]`);
      const segmented = localClips.some(c => c.voiceAligned || c.production?.sound === 'source' || c.production?.sound === 'silent');
      const voiceClips = localClips.map((c, i) => ({ c, i }))
        .filter(({ c }) => (c.production?.sound || 'voiceover') === 'voiceover' && !(c.voiceAligned && c.voiceStart === 0 && c.voiceEnd === 0));
      if (segmented && voiceClips.length) {
        filters.push(`[${voIdx}:a]asplit=${voiceClips.length}${voiceClips.map(({ i }) => `[voiceInput${i}]`).join('')}`);
        voiceClips.forEach(({ c, i }) => {
          const start = Number(c.voiceStart ?? c.targetStart) || 0;
          const target = Math.max(1 / 30, Number(c.targetDuration) || 3);
          const end = Math.max(start + 0.1, Number(c.voiceEnd) || start + target);
          if (c.voiceAligned && (!Number.isFinite(c.voiceStart) || !Number.isFinite(c.voiceEnd) || c.voiceStart < 0 || c.voiceEnd <= c.voiceStart || c.voiceEnd - c.voiceStart > target + 0.01)) {
            throw new Error('已对齐口播时间无效或超过镜头时长，不自动加速声音');
          }
          const delay = Math.round((Number(c.targetStart) || 0) * 1000);
          filters.push(`[voiceInput${i}]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS,${c.voiceAligned ? '' : `${tempoFilters((end - start) / target)},`}apad,atrim=duration=${target},aformat=sample_rates=44100:channel_layouts=stereo,volume=${voiceVol.toFixed(2)},adelay=${delay}|${delay}[voiceSegment${i}]`);
        });
        filters.push(`${voiceClips.map(({ i }) => `[voiceSegment${i}]`).join('')}amix=inputs=${voiceClips.length}:duration=longest:normalize=0[avo]`);
      } else {
        filters.push(`[${voIdx}:a]volume=${segmented ? '0' : voiceVol.toFixed(2)},aresample=async=1:first_pts=0,aformat=sample_rates=44100:channel_layouts=stereo[avo]`);
      }
      filters.push('[abgm][avo]amix=inputs=2:duration=longest:dropout_transition=2:normalize=0[abase]');
    } else {
      filters.push(`[${bgmIdx}:a]${musicNormalize}volume=${vol.toFixed(2)}${muteIntervals(localClips, 'bgm')},aresample=async=1:first_pts=0,aformat=sample_rates=44100:channel_layouts=stereo[abase]`);
    }
    const sourceLabels = [];
    let audioCursor = 0;
    localClips.forEach((clip, i) => {
      const target = Math.max(1 / 30, finiteNumber(clip.targetDuration, duration / Math.max(1, n)));
      if (clip.production?.sound === 'source') {
        if (clip.image) throw new Error('图片没有原声音轨，请改用旁白或无声');
        const start = Math.max(0, Number(clip.trimStart) || 0);
        const end = Math.max(start + 0.1, Number(clip.trimEnd) || start + target);
        const delay = Math.round(audioCursor * 1000);
        filters.push(`[${i}:a]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS,${tempoFilters(clip.speed)},apad,atrim=duration=${target},aformat=sample_rates=44100:channel_layouts=stereo,volume=${voiceVol.toFixed(2)},adelay=${delay}|${delay}[source${i}]`);
        sourceLabels.push(`[source${i}]`);
      }
      audioCursor += target;
    });
    filters.push(sourceLabels.length
      ? `[abase]${sourceLabels.join('')}amix=inputs=${sourceLabels.length + 1}:duration=longest:normalize=0[acontent]`
      : '[abase]anull[acontent]');
    const effectAudio = audioEventFilters(effectPlan.audioEvents, '[acontent]', 'aout');
    filters.push(...effectAudio.filters);

    const filterGraph = filters.join(';');
    const filterGraphSha256 = createHash('sha256').update(filterGraph, 'utf8').digest('hex');
    args.push(
      '-filter_complex', filterGraph,
      '-map', '[vout]', '-map', '[aout]',
      '-t', String(duration),
      '-c:v', 'libx264', '-threads', '2', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-r', '30', '-g', '60', '-keyint_min', '30', '-sc_threshold', '0',
      '-c:a', 'aac', '-b:a', '128k',
      '-avoid_negative_ts', 'make_zero',
      '-movflags', '+faststart',
      '-y', outputPath,
    );
    if (baselinePath) args.push('-map', '[vbaseline]', '-an', '-t', String(duration),
      '-c:v', 'libx264', '-threads', '1', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-r', '30', '-g', '60', '-keyint_min', '30', '-sc_threshold', '0', '-y', baselinePath);

    // 5) 跑 ffmpeg
    if (process.env.RENDER_DEBUG) console.error('[render] ARGV=' + JSON.stringify(args));

    return await new Promise(resolve => {
      // stdin 忽略（双保险防挂起）、stdout 忽略、只读 stderr 解析进度
      const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      let exceededOutputLimit = false;
      const maxRenderMs = Math.max(120_000, duration * 15_000);
      const killTimer = setTimeout(() => proc.kill('SIGKILL'), maxRenderMs);
      const sizeTimer = downloadOptions.serverStrictAssets ? setInterval(() => {
        try {
          if (fs.statSync(outputPath).size > 1024 * 1024 * 1024) {
            exceededOutputLimit = true;
            proc.kill('SIGKILL');
          }
        } catch { /* output not created yet */ }
      }, 1000) : null;
      proc.stderr.on('data', chunk => {
        const s = chunk.toString();
        stderr = (stderr + s).slice(-4096);
        const m = s.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
        if (m) {
          const secs = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
          onProgress(Math.min(99, (secs / duration) * 100));
        }
      });
      proc.on('error', err => resolve({ ok: false, error: String(err) }));
      proc.on('close', async (code, signal) => {
        clearTimeout(killTimer);
        if (sizeTimer) clearInterval(sizeTimer);
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
        const finalBytes = (() => { try { return fs.statSync(outputPath).size; } catch { return 0; } })();
        if (code === 0 && (!downloadOptions.serverStrictAssets || finalBytes <= 1024 * 1024 * 1024)) {
          let outputSha256;
          try {
            const digest = createHash('sha256');
            for await (const chunk of fs.createReadStream(outputPath)) digest.update(chunk);
            outputSha256 = digest.digest('hex');
          } catch (error) {
            resolve({ ok: false, error: `成片字节摘要失败：${error && error.message || error}` });
            return;
          }
          let captionBaselineEvidence = null;
          if (baselinePath) {
            try {
              const baselineStat = fs.statSync(baselinePath);
              if (baselineStat.isFile() && baselineStat.size > 0 && baselineStat.size <= 256 * 1024 * 1024) {
                const digest = createHash('sha256');
                for await (const chunk of fs.createReadStream(baselinePath)) digest.update(chunk);
                fs.chmodSync(baselinePath, 0o600);
                captionBaselineEvidence = { schemaVersion: 'renderer-caption-baseline.v1', path: baselinePath,
                  sha256: digest.digest('hex'), byteLength: baselineStat.size, outputSha256, filterGraphSha256 };
              } else fs.rmSync(baselinePath, { force: true });
            } catch { try { fs.rmSync(baselinePath, { force: true }); } catch { /* no evidence */ } }
          }
          onProgress(100);
          resolve({ ok: true, outputPath, ...(frameContract ? { frameRenderEvidence: {
            schemaVersion: 'renderer-frame-attestation.v1', outputSha256, fps: 30,
            durationSeconds: duration, expectedFrames: frameContract.expectedFrames,
          } } : {}), subtitleRenderEvidence: {
            schemaVersion: 'renderer-subtitle-attestation.v2',
            outputSha256,
            assSha256: subtitleAssSha256,
            filterApplied: Boolean(ass),
            subtitleCueSha256,
            filterGraphSha256,
          }, subtitleAssUtf8: ass || null, captionBaselineEvidence });
        } else {
          if (baselinePath) try { fs.rmSync(baselinePath, { force: true }); } catch { /* noop */ }
          if (downloadOptions.serverStrictAssets) try { fs.rmSync(outputPath, { force: true }); } catch { /* noop */ }
          resolve({ ok: false, error: exceededOutputLimit || finalBytes > 1024 * 1024 * 1024 ? '成片文件超出 1 GiB 限制' : code === null ? `ffmpeg 被信号 ${signal || 'unknown'} 中止\n${stderr.slice(-1200)}` : `ffmpeg exited ${code}\n${stderr.slice(-1200)}` });
        }
      });
    });
  } catch (err) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
    return { ok: false, error: String(err && err.message || err) };
  }
}

module.exports = { composite, downloadTo, resolution, ffmpegPath, dataUrlParts, extensionForAsset, isImageAsset, subtitlePages, groupSpokenCues, normalizeSubtitleCues, cuesToAss, appendFinalVisualLayers };
