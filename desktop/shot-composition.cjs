/** Pure FFmpeg filter builders shared by native and server-local rendering. */
function layoutFilters({ source, index, width, height, target, layout = 'full', productIndex, backgroundIndex, transparent = false }) {
  const filters = [];
  const normalize = (input, label, w, h, contain = false) => filters.push(`${input},scale=${w}:${h}:force_original_aspect_ratio=${contain ? 'decrease' : 'increase'},${contain ? `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black@0` : `crop=${w}:${h}`},setsar=1,fps=30,format=rgba[${label}]`);
  const aux = (input, label, w, h) => normalize(`[${input}:v]trim=duration=${target.toFixed(3)},setpts=PTS-STARTPTS`, label, w, h, true);
  const personLayer = (w, h, contain = false) => {
    normalize(source, `person${index}`, w, h, contain);
    if (!Number.isInteger(backgroundIndex)) return `person${index}`;
    if (!transparent) throw new Error('独立背景需要透明人物层');
    aux(backgroundIndex, `background${index}`, w, h);
    filters.push(`[background${index}][person${index}]overlay=0:0:shortest=1[personbg${index}]`);
    return `personbg${index}`;
  };
  if (layout === 'split' || layout === 'pip') {
    if (!Number.isInteger(productIndex)) throw new Error('分屏/画中画缺少产品图层');
    if (layout === 'split') {
      const half = Math.floor(width / 4) * 2;
      const person = personLayer(half, height);
      aux(productIndex, `product${index}`, width - half, height);
      filters.push(`[${person}][product${index}]hstack=inputs=2,format=yuv420p[v${index}]`);
    } else {
      const sw = Math.floor(width * 0.36 / 2) * 2, sh = Math.floor(height * 0.36 / 2) * 2;
      const person = personLayer(sw, sh, transparent);
      aux(productIndex, `product${index}`, width, height);
      filters.push(`[product${index}][${person}]overlay=W-w-24:H-h-24:shortest=1,format=yuv420p[v${index}]`);
    }
  } else if (Number.isInteger(backgroundIndex)) {
    if (!transparent) throw new Error('独立背景需要透明人物层');
    normalize(source, `person${index}`, width, height, true);
    aux(backgroundIndex, `background${index}`, width, height);
    filters.push(`[background${index}][person${index}]overlay=0:0:shortest=1,format=yuv420p[v${index}]`);
  } else {
    normalize(source, `person${index}`, width, height);
    filters.push(`[person${index}]format=yuv420p[v${index}]`);
  }
  return filters;
}
function tempoFilters(speed) {
  let value = Math.max(0.25, Math.min(4, Number(speed) || 1)); const filters = [];
  while (value < 0.5) { filters.push('atempo=0.5'); value /= 0.5; }
  while (value > 2) { filters.push('atempo=2'); value /= 2; }
  filters.push(`atempo=${value.toFixed(5)}`); return filters.join(',');
}
function muteIntervals(clips, mode) {
  let cursor = 0; const ranges = [];
  for (const clip of clips) {
    const end = cursor + Number(clip.targetDuration || 0);
    const sound = clip.production?.sound || 'voiceover';
    if (sound === 'silent' || (mode === 'voiceover' && sound === 'source')) ranges.push(`between(t,${cursor.toFixed(3)},${end.toFixed(3)})`);
    cursor = end;
  }
  return ranges.length ? `,volume=0:enable='${ranges.join('+')}'` : '';
}
module.exports = { layoutFilters, tempoFilters, muteIntervals };
