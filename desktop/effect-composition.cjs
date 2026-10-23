/* eslint-disable */
/**
 * Renderer implementation for EffectPlanV1.
 *
 * This module never evaluates user supplied FFmpeg snippets. Every emitted
 * filter is selected from the constants below after strict allow-list
 * normalization. Keep this file CommonJS so Electron and node regression tests
 * use the exact same implementation.
 */

const PRESETS = new Set(['natural', 'dynamic', 'tech', 'cinematic']);
const MOTIONS = new Set(['none', 'push_in', 'pull_out', 'pan_left', 'pan_right', 'handheld']);
const COLORS = new Set(['original', 'clean', 'warm', 'cool', 'cinematic']);
const TRANSITIONS = new Set(['cut', 'dissolve', 'fade', 'wipe_left', 'wipe_right']);
const OVERLAYS = new Set(['petal_bloom', 'sparkle', 'heart', 'energy_ring', 'dust', 'fact_card', 'cta']);
const LAYERS = new Set(['background', 'around_subject', 'foreground']);
const AUDIO_EVENTS = new Set(['whoosh', 'pop', 'click', 'impact', 'sparkle']);

const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, min, max, fallback) => Math.max(min, Math.min(max, finite(value, fallback)));
const pick = (value, allowed, fallback) => allowed.has(String(value)) ? String(value) : fallback;
const record = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const sceneId = (value, fallback) => String(value || '').trim().replace(/[^a-zA-Z0-9_.:-]/g, '').slice(0, 96) || fallback;
const safeText = value => String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);

function normalizeEffectPlan(input, timeline = []) {
  const raw = record(input);
  const intensity = Math.round(clamp(raw.intensity, 0, 3, 0));
  const rawScenes = Array.isArray(raw.scenes) ? raw.scenes : [];
  const byId = new Map(rawScenes.map((value, index) => {
    const item = record(value);
    return [sceneId(item.sceneId, String(index)), item];
  }));
  const sceneInputs = timeline.length ? timeline : [...byId.keys()].map(id => ({ sceneId: id, targetDuration: 3 }));
  const scenes = sceneInputs.slice(0, 120).map((timelineScene, index) => {
    const id = sceneId(timelineScene.sceneId || timelineScene.clipId, String(index));
    const source = byId.get(id) || record(rawScenes[index]);
    const target = clamp(timelineScene.targetDuration, .5, 300, 3);
    const transition = record(source.transitionOut);
    const transitionType = pick(transition.type, TRANSITIONS, 'cut');
    const maxTransition = Math.max(0, Math.min(1.2, target * .35));
    const overlays = (Array.isArray(source.overlays) ? source.overlays : []).slice(0, 12).flatMap(value => {
      const overlay = record(value);
      const presetId = pick(overlay.presetId, OVERLAYS, '');
      if (!presetId) return [];
      const start = clamp(overlay.start, 0, target, 0);
      const end = clamp(overlay.end, start, target, Math.min(target, start + 1.5));
      const text = presetId === 'fact_card' || presetId === 'cta' ? safeText(overlay.text) : '';
      if (end - start < .05 || ((presetId === 'fact_card' || presetId === 'cta') && !text)) return [];
      const anchor = record(overlay.anchor);
      return [{
        presetId,
        layer: pick(overlay.layer, LAYERS, 'foreground'),
        start: Number(start.toFixed(3)), end: Number(end.toFixed(3)),
        ...(text ? { text } : {}),
        anchor: { x: clamp(anchor.x, .05, .95, .5), y: clamp(anchor.y, .05, .95, .5) },
        scale: clamp(overlay.scale, .5, 2, 1), opacity: clamp(overlay.opacity, .05, 1, .75),
      }];
    });
    return {
      sceneId: id,
      enabled: source.enabled !== false && intensity > 0,
      motion: pick(source.motion, MOTIONS, 'none'),
      color: pick(source.color, COLORS, 'original'),
      transitionOut: {
        type: transitionType,
        duration: transitionType === 'cut' ? 0 : Number(clamp(transition.duration, .1, maxTransition, Math.min(.35, maxTransition)).toFixed(3)),
      },
      overlays,
    };
  });
  const total = timeline.reduce((sum, item) => sum + clamp(item.targetDuration, 0, 300, 0), 0) || 3600;
  const audioEvents = (Array.isArray(raw.audioEvents) ? raw.audioEvents : []).slice(0, 64).flatMap(value => {
    const event = record(value);
    const presetId = pick(event.presetId, AUDIO_EVENTS, '');
    if (!presetId) return [];
    return [{ presetId, at: clamp(event.at, 0, total, 0), volume: clamp(event.volume, 0, 1, .5) }];
  });
  return {
    schemaVersion: 1,
    presetId: pick(raw.presetId, PRESETS, 'natural'),
    intensity,
    beatSync: raw.beatSync === true,
    seed: Math.round(clamp(raw.seed, 0, 2147483647, 1)),
    scenes,
    audioEvents,
  };
}

const colorFilter = color => ({
  original: 'null',
  clean: 'eq=contrast=1.035:saturation=1.06:brightness=0.008',
  warm: 'eq=contrast=1.025:saturation=1.08:brightness=0.008,colorbalance=rs=.035:gs=.012:bs=-.025',
  cool: 'eq=contrast=1.04:saturation=1.03,colorbalance=rs=-.025:gs=.008:bs=.04',
  cinematic: 'eq=contrast=1.09:saturation=.88:brightness=-.012,colorbalance=rs=.02:bs=.025',
}[color] || 'null');

function motionFilter(motion, width, height, target, intensity) {
  const frames = Math.max(15, Math.round(target * 30));
  const amount = (.012 + intensity * .012).toFixed(4);
  const maxZoom = (1.02 + intensity * .022).toFixed(4);
  switch (motion) {
    case 'push_in': return `zoompan=z='min(max(zoom\,1)+${amount}\,${maxZoom})':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:s=${width}x${height}:fps=30`;
    case 'pull_out': return `zoompan=z='if(eq(on\,1)\,${maxZoom}\,max(1\,zoom-${amount}))':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:s=${width}x${height}:fps=30`;
    case 'pan_left': return `zoompan=z=1.055:x='(iw-iw/zoom)*(1-min(1\,on/${frames}))':y='ih/2-ih/zoom/2':d=1:s=${width}x${height}:fps=30`;
    case 'pan_right': return `zoompan=z=1.055:x='(iw-iw/zoom)*min(1\,on/${frames})':y='ih/2-ih/zoom/2':d=1:s=${width}x${height}:fps=30`;
    case 'handheld': return `zoompan=z=1.035:x='iw/2-iw/zoom/2+sin(on*.17)*${Math.max(2, Math.round(width * .003))}':y='ih/2-ih/zoom/2+cos(on*.13)*${Math.max(2, Math.round(height * .003))}':d=1:s=${width}x${height}:fps=30`;
    default: return 'null';
  }
}

function ffText(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:')
    .replace(/%/g, '\\%')
    .replace(/,/g, '\\,');
}

function between(start, end) { return `between(t\\,${start.toFixed(3)}\\,${end.toFixed(3)})`; }

function textOverlayFilters(overlay, width, height) {
  const x = Math.round(overlay.anchor.x * width);
  const y = Math.round(overlay.anchor.y * height);
  const enable = between(overlay.start, overlay.end);
  const opacity = overlay.opacity.toFixed(2);
  if (overlay.presetId === 'fact_card' || overlay.presetId === 'cta') {
    const size = Math.round(width * (overlay.presetId === 'cta' ? .052 : .042) * overlay.scale);
    const boxW = Math.round(width * (overlay.presetId === 'cta' ? .68 : .78));
    const boxH = Math.round(size * 2.05);
    const boxX = Math.max(20, Math.min(width - boxW - 20, x - boxW / 2));
    const boxY = Math.max(20, Math.min(height - boxH - 20, y - boxH / 2));
    const color = overlay.presetId === 'cta' ? '0x0b8f60' : 'black';
    return [
      `drawbox=x=${Math.round(boxX)}:y=${Math.round(boxY)}:w=${boxW}:h=${boxH}:color=${color}@${Math.min(.92, overlay.opacity).toFixed(2)}:t=fill:enable='${enable}'`,
      `drawtext=text='${ffText(overlay.text)}':fontcolor=white@${opacity}:fontsize=${size}:x=(w-text_w)/2:y=${Math.round(boxY + (boxH - size) / 2)}:enable='${enable}'`,
    ];
  }

  const symbols = {
    petal_bloom: ['✿', '❀', '✾'],
    sparkle: ['✦', '✧', '✶'],
    heart: ['♥', '♡', '♥'],
    energy_ring: ['◆', '◇', '●'],
    dust: ['·', '•', '·'],
  }[overlay.presetId] || ['✦'];
  const layerScale = overlay.layer === 'background' ? .72 : overlay.layer === 'foreground' ? 1.2 : 1;
  const layerOpacity = overlay.layer === 'background' ? opacity * .5 : Number(opacity);
  const radiusX = width * (overlay.layer === 'around_subject' ? .22 : .34) * overlay.scale;
  const radiusY = height * (overlay.layer === 'around_subject' ? .19 : .30) * overlay.scale;
  const count = overlay.presetId === 'dust' ? 10 : 7;
  return Array.from({ length: count }, (_, index) => {
    const phase = ((index / count) * Math.PI * 2).toFixed(4);
    const speed = (.65 + (index % 3) * .18).toFixed(3);
    const size = Math.round(width * (.026 + (index % 3) * .006) * overlay.scale * layerScale);
    const color = overlay.presetId === 'heart' ? '0xff82a9' : overlay.presetId === 'petal_bloom' ? (index % 2 ? '0xffd4e5' : 'white') : overlay.presetId === 'energy_ring' ? '0x5eead4' : overlay.presetId === 'dust' ? '0xffe6b0' : 'white';
    return `drawtext=text='${symbols[index % symbols.length]}':fontcolor=${color}@${Math.max(.05, Math.min(1, layerOpacity)).toFixed(2)}:fontsize=${size}:x='${x}+cos((t-${overlay.start.toFixed(3)})*${speed}+${phase})*${radiusX.toFixed(2)}-text_w/2':y='${y}+sin((t-${overlay.start.toFixed(3)})*${speed}+${phase})*${radiusY.toFixed(2)}-text_h/2':enable='${enable}'`;
  });
}

/** Apply color, camera motion and decorative/text layers to one normalized scene. */
function sceneEffectFilters({ source, output, scene, width, height, target, intensity }) {
  // zoompan changes timebase but preserves input frame duration. Feeding
  // AVTB frames (duration 33333 ticks) makes each output frame last 1111s.
  // Convert both PTS and duration to frame ticks before applying motion.
  const inputTiming = 'fps=30,settb=1/30,setpts=N';
  const timing = 'settb=AVTB,setpts=N/(30*TB)';
  if (!scene || !scene.enabled || intensity <= 0) return [`${source}${inputTiming},${timing}[${output}]`];
  const chain = [inputTiming, colorFilter(scene.color), motionFilter(scene.motion, width, height, target, intensity)];
  const ordered = [...scene.overlays].sort((a, b) => {
    const order = { background: 0, around_subject: 1, foreground: 2 };
    return order[a.layer] - order[b.layer];
  });
  for (const overlay of ordered) chain.push(...textOverlayFilters(overlay, width, height));
  return [`${source}${chain.join(',')},${timing}[${output}]`];
}

/** Join scenes, preserving legacy concat when every boundary is a hard cut. */
function joinSceneFilters({ labels, scenes, targets, output = 'vcat' }) {
  if (!labels.length) return { filters: [], output: `[${output}]`, duration: 0 };
  if (labels.length === 1) return { filters: [`${labels[0]}null[${output}]`], output: `[${output}]`, duration: targets[0] || 0 };
  const hasAnimatedTransition = scenes.slice(0, -1).some(scene => scene?.enabled && scene.transitionOut?.type !== 'cut' && scene.transitionOut?.duration > 0);
  if (!hasAnimatedTransition) {
    return {
      filters: [`${labels.join('')}concat=n=${labels.length}:v=1:a=0[${output}]`],
      output: `[${output}]`,
      duration: targets.reduce((sum, value) => sum + value, 0),
    };
  }
  const filters = [];
  // xfade overlaps its inputs. Padding each outgoing scene by the transition
  // duration keeps the approved output timeline length unchanged.
  const paddedLabels = labels.map((label, index) => {
    const transition = scenes[index]?.enabled ? scenes[index]?.transitionOut : null;
    const pad = transition?.type !== 'cut' ? finite(transition?.duration, 0) : .001;
    if (index === labels.length - 1) return label;
    const padded = `[effectpad${index}]`;
    filters.push(`${label}tpad=stop_mode=clone:stop_duration=${Math.max(.001, pad).toFixed(3)}${padded}`);
    return padded;
  });
  let current = paddedLabels[0];
  let cursor = targets[0] || 0;
  for (let index = 1; index < labels.length; index += 1) {
    const transition = scenes[index - 1]?.enabled ? scenes[index - 1]?.transitionOut : null;
    const type = transition?.type || 'cut';
    const duration = type === 'cut' ? .001 : Math.max(.1, finite(transition?.duration, .35));
    const ffType = ({ dissolve: 'dissolve', fade: 'fadeblack', wipe_left: 'wipeleft', wipe_right: 'wiperight' })[type] || 'fade';
    const next = index === labels.length - 1 ? output : `effectxfade${index}`;
    filters.push(`${current}${paddedLabels[index]}xfade=transition=${ffType}:duration=${duration.toFixed(3)}:offset=${cursor.toFixed(3)}[${next}]`);
    current = `[${next}]`;
    cursor += targets[index] || 0;
  }
  return { filters, output: `[${output}]`, duration: cursor };
}

const AUDIO_SOURCE = {
  whoosh: "anoisesrc=color=pink:amplitude=0.6:d=0.38,highpass=f=500,lowpass=f=5200,afade=t=in:st=0:d=0.06,afade=t=out:st=0.18:d=0.2",
  pop: "sine=frequency=760:duration=0.14,afade=t=out:st=0.04:d=0.1",
  click: "sine=frequency=1400:duration=0.06,afade=t=out:st=0.01:d=0.05",
  impact: "sine=frequency=95:duration=0.34,afade=t=out:st=0.08:d=0.26",
  sparkle: "sine=frequency=1180:duration=0.28,tremolo=f=18:d=0.55,afade=t=out:st=0.12:d=0.16",
};

/** Build synthetic, licensed-by-construction sound effects and mix into audio. */
function audioEventFilters(events, baseLabel = '[abase]', output = 'aeffects') {
  const safe = (Array.isArray(events) ? events : []).filter(event => AUDIO_SOURCE[event.presetId] && event.volume > 0);
  if (!safe.length) return { filters: [`${baseLabel}anull[${output}]`], output: `[${output}]` };
  const filters = [];
  const labels = [];
  safe.forEach((event, index) => {
    const delay = Math.max(0, Math.round(event.at * 1000));
    const label = `effectaudio${index}`;
    filters.push(`${AUDIO_SOURCE[event.presetId]},volume=${clamp(event.volume, 0, 1, .5).toFixed(3)},aformat=sample_rates=44100:channel_layouts=stereo,adelay=${delay}|${delay}[${label}]`);
    labels.push(`[${label}]`);
  });
  filters.push(`${baseLabel}${labels.join('')}amix=inputs=${labels.length + 1}:duration=longest:normalize=0[${output}]`);
  return { filters, output: `[${output}]` };
}

module.exports = {
  normalizeEffectPlan,
  sceneEffectFilters,
  joinSceneFilters,
  audioEventFilters,
  textOverlayFilters,
};
