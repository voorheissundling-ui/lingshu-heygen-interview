/* eslint-disable */
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { filterAdvancedEventsForQa } = require('./emphasis-layout-qa.cjs');

let bundlePromise = null;
const RENDERER_VERSION = 'semantic-assets-v11-motion-roles-visible-hold';
const ASSET_DIRECTORY = path.join(__dirname, '../assets/reference/emphasis/v1');

const finite = value => Number.isFinite(Number(value)) ? Number(value) : null;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const stableSide = value => [...String(value || '')].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 2 ? .72 : .28;
const ASSET_INTENT_KIND = Object.freeze({
  warning_marker: 'warning', urgency_badge: 'urgency', cta_marker: 'cta',
  product_marker: 'reveal', attention: 'key_fact', fact: 'key_fact',
});
const VISUAL_INTENT_KIND = Object.freeze({
  warning: 'warning', urgency: 'urgency', cta: 'cta', focus_product: 'reveal',
  attention: 'key_fact', fact: 'key_fact',
});
const MOTION_ROLES = new Set(['surround', 'point_to', 'adjacent', 'caption_companion', 'corner_badge']);
const MOTION_ASSET_REGISTRY = Object.freeze({
  surround_rays: { allowedRoles: ['surround'], family: 'rays', runtimeEligible: true },
  pointer_shard: { allowedRoles: ['point_to'], family: 'directional', runtimeEligible: true },
  adjacent_badge: { allowedRoles: ['adjacent'], family: 'badge', runtimeEligible: true },
  caption_accent: { allowedRoles: ['caption_companion'], family: 'directional', runtimeEligible: true },
  corner_badge: { allowedRoles: ['corner_badge'], family: 'badge', runtimeEligible: true },
});

function semanticAssetKind(event) {
  const requested = ASSET_INTENT_KIND[String(event && event.assetIntent)]
    || VISUAL_INTENT_KIND[String(event && event.visualIntent)]
    || (event && event.type === 'cta' ? 'cta' : null)
    || (['warning', 'urgency'].includes(String(event && (event.semanticRole || event.emphasisKind || event.tone)))
      ? String(event.semanticRole || event.emphasisKind || event.tone) : null)
    || (event && event.type === 'reveal' ? 'reveal' : 'key_fact');
  const role = normalizeMotionRole(event);
  if (role !== 'surround' && requested === 'reveal') return 'urgency';
  if (role !== 'surround' && requested === 'key_fact') return 'warning';
  return requested;
}

const intersects = (a, b, gap = 0) => a.x < b.x + b.width + gap && a.x + a.width + gap > b.x
  && a.y < b.y + b.height + gap && a.y + a.height + gap > b.y;
const overlapArea = (a, b) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
  * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
const inside = rect => rect.x >= .035 && rect.y >= .035 && rect.x + rect.width <= .965 && rect.y + rect.height <= .70;
const normalizedBox = value => {
  if (!value || typeof value !== 'object') return null;
  const x = finite(value.x ?? value.left), y = finite(value.y ?? value.top);
  const width = finite(value.width), height = finite(value.height);
  return x === null || y === null || width === null || height === null ? null : {
    x: clamp(x, 0, 1), y: clamp(y, 0, 1), width: clamp(width, .03, .8), height: clamp(height, .03, .8),
  };
};
const targetBox = event => normalizedBox(event && event.subjectBox) || (() => {
  const anchor = event && event.subjectAnchor;
  if (!anchor || finite(anchor.x) === null || finite(anchor.y) === null) return null;
  return { x: clamp(Number(anchor.x) - .10, .03, .77), y: clamp(Number(anchor.y) - .10, .04, .50), width: .20, height: .20 };
})();

function normalizeMotionRole(event) {
  const explicit = String(event && (event.visualRole || event.motionRole || event.componentRole) || '');
  const requested = MOTION_ROLES.has(explicit) ? explicit : String(event && event.targetRelation || '');
  const target = targetBox(event);
  if (requested === 'surround') return event && event.assetFamily === 'rays' && target ? 'surround' : target ? 'adjacent' : 'corner_badge';
  if (requested === 'point_to') return target ? 'point_to' : 'caption_companion';
  if (requested === 'adjacent') return target ? 'adjacent' : 'corner_badge';
  if (requested === 'caption_companion' || requested === 'corner_badge') return requested;
  return target ? 'adjacent' : 'corner_badge';
}

function roleLayout(event, base) {
  const role = normalizeMotionRole(event), target = targetBox(event);
  if (role === 'surround' && target) {
    const pad = .025;
    const asset = { x: clamp(target.x - pad, .035, .93), y: clamp(target.y - pad, .035, .665),
      width: Math.min(.42, target.width + pad * 2), height: Math.min(.48, target.height + pad * 2) };
    asset.x = Math.min(asset.x, .965 - asset.width); asset.y = Math.min(asset.y, .70 - asset.height);
    return { ...base, asset, mode: 'role-surround' };
  }
  if (role === 'caption_companion') return { ...base,
    asset: { x: .34, y: .625, width: .32, height: .055 }, mode: 'role-caption-companion' };
  return { ...base, mode: `role-${role}-${base.mode}` };
}

/** Returns independent decoration and label rectangles. Every candidate is
 * checked as a full rectangle against the subject, caption reserve and frame. */
function resolveOverlayLayout(event, index = 0) {
  const subject = normalizedBox(event && event.subjectBox) || (() => {
    const anchor = event && event.subjectAnchor;
    if (!anchor || finite(anchor.x) === null || finite(anchor.y) === null) return null;
    return { x: clamp(Number(anchor.x) - .13, .03, .71), y: clamp(Number(anchor.y) - .17, .04, .48), width: .26, height: .34 };
  })();
  const kind = semanticAssetKind(event);
  const aspect = kind === 'cta' ? 1.08 : kind === 'warning' ? .85 : kind === 'urgency' ? .70 : 1.5;
  const detachedGraphic = !subject && event && event.presentationMode === 'graphic_only';
  const assetWidth = detachedGraphic ? .13 : kind === 'cta' ? .23 : kind === 'key_fact' || kind === 'reveal' ? .27 : .18;
  const assetHeight = assetWidth / aspect;
  const chars = Array.from(String(event && event.text || '')).length;
  const labelWidth = clamp(.14 + chars * .022, .20, .40), labelHeight = chars > 12 ? .105 : .075;
  const captionReserve = { x: 0, y: .71, width: 1, height: .29 };
  const gap = .025;
  const side = stableSide(event && event.id || `${event && event.type}-${index}`) > .5 ? 'right' : 'left';
  const candidates = [];
  if (subject) {
    const rightX = subject.x + subject.width + gap;
    const leftX = subject.x - assetWidth - gap;
    const upperY = Math.max(.05, subject.y - assetHeight * .45);
    for (const direction of side === 'right' ? ['right', 'left', 'top'] : ['left', 'right', 'top']) {
      const asset = direction === 'right' ? { x: rightX, y: upperY, width: assetWidth, height: assetHeight }
        : direction === 'left' ? { x: leftX, y: upperY, width: assetWidth, height: assetHeight }
          : { x: subject.x + subject.width / 2 - assetWidth / 2, y: subject.y - assetHeight - gap, width: assetWidth, height: assetHeight };
      const label = direction === 'left'
        ? { x: asset.x - labelWidth - gap, y: Math.max(.05, asset.y), width: labelWidth, height: labelHeight }
        : { x: asset.x + asset.width + gap, y: Math.max(.05, asset.y), width: labelWidth, height: labelHeight };
      candidates.push({ asset, label, mode: `subject-${direction}` });
    }
  } else {
    const detachedSide = detachedGraphic && !(event && ['left', 'right'].includes(String(event.preferredSide)))
      ? 'right' : side;
    const left = detachedGraphic
      ? (detachedSide === 'left' ? .055 : .945 - assetWidth)
      : (side === 'left' ? .055 : .945 - assetWidth - gap - labelWidth);
    const y = kind === 'cta' ? .57 : .08 + (index % 3) * .17;
    candidates.push({
      asset: { x: left, y, width: assetWidth, height: assetHeight },
      label: { x: detachedGraphic && detachedSide === 'right' ? left - labelWidth - gap : left + assetWidth + gap,
        y: y + Math.max(0, (assetHeight - labelHeight) / 2), width: labelWidth, height: labelHeight },
      mode: `corner-${side}`,
    });
  }
  const valid = candidates.find(({ asset, label }) => inside(asset) && inside(label)
    && !intersects(asset, label, .006) && !intersects(asset, captionReserve) && !intersects(label, captionReserve)
    && (!subject || (!intersects(asset, subject, .008) && !intersects(label, subject, .012))));
  if (valid) return valid;
  // Fixed upper corner is the final conservative result. It remains a
  // horizontal lockup and never occupies the centre or caption reserve.
  const left = side === 'left' ? .05 : .95 - assetWidth - gap - labelWidth;
  return {
    asset: { x: left, y: .06, width: assetWidth, height: assetHeight },
    label: { x: left + assetWidth + gap, y: .06 + Math.max(0, (assetHeight - labelHeight) / 2), width: labelWidth, height: labelHeight },
    mode: `fallback-${side}`,
  };
}

const PRESENTATION_MODES = new Set(['label', 'graphic_only', 'caption_emphasis', 'none', 'full']);
const TARGET_RELATIONS = new Set(['surround', 'point_to', 'adjacent']);
const eventSubject = event => normalizedBox(event && event.subjectBox) || (() => {
  const anchor = event && event.subjectAnchor;
  if (!anchor || finite(anchor.x) === null || finite(anchor.y) === null) return null;
  // An anchor-only visual result means the model could not isolate a useful
  // full box (often because products fill the frame). Use a compact proxy so
  // surround graphics stay local and clear of existing captions.
  return { x: clamp(Number(anchor.x) - .10, .03, .77), y: clamp(Number(anchor.y) - .10, .04, .50), width: .20, height: .20 };
})();
const eventOccupied = event => [
  ...(Array.isArray(event && event.occupiedBoxes) ? event.occupiedBoxes : []),
  ...(Array.isArray(event && event.captionBoxes) ? event.captionBoxes : []),
  ...(Array.isArray(event && event.occupiedRegions) ? event.occupiedRegions : []),
  ...(Array.isArray(event && event.reservedBoxes) ? event.reservedBoxes : []),
]
  .map(normalizedBox).filter(Boolean).concat([{ x: 0, y: .71, width: 1, height: .29 }]);
const rectPenalty = (rect, occupied) => {
  const outside = Math.max(0, .035 - rect.x) + Math.max(0, .035 - rect.y)
    + Math.max(0, rect.x + rect.width - .965) + Math.max(0, rect.y + rect.height - .70);
  return outside * 100 + occupied.reduce((sum, box) => sum + overlapArea(rect, box) * 1000, 0);
};

function relationLayouts(event, index = 0) {
  const base = resolveOverlayLayout(event, index);
  const subject = eventSubject(event);
  const relation = TARGET_RELATIONS.has(String(event && event.targetRelation)) ? String(event.targetRelation) : 'adjacent';
  if (!subject) return [{ ...base, relation: 'adjacent' }];
  const a = base.asset, l = base.label, gap = .02;
  if (relation === 'surround') {
    // A "surround" asset is a compact edge accent, not a frame over the
    // subject. Keep it tangent to one edge and let collision scoring choose
    // the side with usable negative space.
    const width = Math.min(a.width, .16);
    const height = Math.min(a.height, .145);
    const edgeGap = .016;
    const centreX = subject.x + subject.width / 2;
    const centreY = subject.y + subject.height / 2;
    const candidates = [
      { direction: 'right', asset: { x: subject.x + subject.width + edgeGap, y: centreY - height / 2, width, height } },
      { direction: 'left', asset: { x: subject.x - width - edgeGap, y: centreY - height / 2, width, height } },
      { direction: 'top', asset: { x: centreX - width / 2, y: subject.y - height - edgeGap, width, height } },
      { direction: 'bottom', asset: { x: centreX - width / 2, y: subject.y + subject.height + edgeGap, width, height } },
    ];
    const preferred = ['left', 'right', 'top', 'bottom'].includes(String(event && event.preferredSide))
      ? String(event.preferredSide) : '';
    if (preferred) candidates.sort((left, right) => Number(right.direction === preferred) - Number(left.direction === preferred));
    return candidates.map(({ direction, asset }) => {
      const label = direction === 'right'
        ? { ...l, x: asset.x, y: asset.y - l.height - gap }
        : direction === 'left'
          ? { ...l, x: asset.x + width - l.width, y: asset.y - l.height - gap }
          : direction === 'top'
            ? { ...l, x: asset.x + width + gap, y: asset.y }
            : { ...l, x: asset.x + width + gap, y: asset.y + height - l.height };
      return { asset, label, mode: `relation-surround-${direction}`, relation, edge: direction };
    });
  }
  if (relation === 'point_to') {
    return [
      { asset: { ...a, x: clamp(subject.x + subject.width + gap, .035, .965 - a.width), y: clamp(subject.y + subject.height * .25, .035, .70 - a.height) }, label: { ...l, x: clamp(subject.x + subject.width + gap + a.width + gap, .035, .965 - l.width), y: clamp(subject.y, .035, .70 - l.height) }, mode: 'relation-point-right', relation },
      { asset: { ...a, x: clamp(subject.x - a.width - gap, .035, .965 - a.width), y: clamp(subject.y + subject.height * .25, .035, .70 - a.height) }, label: { ...l, x: clamp(subject.x - a.width - gap - l.width - gap, .035, .965 - l.width), y: clamp(subject.y, .035, .70 - l.height) }, mode: 'relation-point-left', relation },
    ];
  }
  return [{ ...base, relation }];
}

/** Chooses a renderable relationship layout and exposes the degradation path
 * so callers/tests can distinguish a graphic-only fallback from no overlay. */
function planOverlayPresentation(event, index = 0) {
  const rawMode = PRESENTATION_MODES.has(String(event && event.presentationMode)) ? String(event.presentationMode) : 'label';
  const requested = rawMode === 'full' ? 'label' : rawMode;
  const attempted = [requested];
  if (requested === 'none') return { outcome: 'none', attempted, layout: null };
  if (requested === 'caption_emphasis') return { outcome: 'caption_emphasis', attempted, layout: null };
  const subject = eventSubject(event);
  const occupied = eventOccupied(event);
  const layouts = relationLayouts(event, index).map(layout => {
    const asset = layout.asset;
    const assetOccupied = subject ? [subject, ...occupied] : occupied;
    const score = rectPenalty(asset, assetOccupied) + rectPenalty(layout.label, subject ? [subject, ...occupied] : occupied)
      + overlapArea(asset, layout.label) * 2000;
    return { ...layout, asset, score };
  }).sort((left, right) => left.score - right.score);
  const full = layouts.find(layout => layout.score === 0);
  if (requested === 'label' && full) return { outcome: 'label', attempted, layout: full };
  if (requested === 'label') attempted.push('graphic_only');
  const graphic = layouts.map(layout => ({ ...layout, score: rectPenalty(layout.asset,
    subject ? [subject, ...occupied] : occupied) }))
    .sort((left, right) => left.score - right.score).find(layout => layout.score === 0);
  if (graphic) return { outcome: 'graphic_only', attempted, layout: graphic };
  attempted.push('caption_emphasis');
  if (String(event && event.text || '').trim()) return { outcome: 'caption_emphasis', attempted, layout: null };
  attempted.push('none');
  return { outcome: 'none', attempted, layout: null };
}

/** Resolve a sticker position without assuming that the centre of the frame is
 * empty. Coordinates are normalized. The lower 28% stays reserved for speech
 * captions and platform controls. */
function resolveOverlayPlacement(event, index = 0) {
  const placement = event && typeof event.placement === 'object' ? event.placement : {};
  const anchor = event && event.hasExplicitAnchor !== false && typeof event.anchor === 'object' ? event.anchor : {};
  const placementEvidence = event && typeof event.placementEvidence === 'object' ? event.placementEvidence : {};
  const side = stableSide(event && event.id || `${event && event.type}-${index}`);
  const yByType = { key_fact: .22, reveal: .43, cta: .62 };
  const conservative = source => ({ x: side, y: yByType[event && event.type] || .22, source });
  // Explicit negative evidence invalidates every proposed placement, including
  // an anchor supplied by an earlier analysis pass. Fall back deterministically
  // rather than treating coordinates as proof that the area is safe.
  if ((event && event.safeArea === false) || placementEvidence.safe === false || placement.safe === false) {
    return conservative('unsafe-fallback');
  }
  const explicitX = finite(placement.x) ?? finite(anchor.x);
  const explicitY = finite(placement.y) ?? finite(anchor.y);
  if (explicitX !== null && explicitY !== null) {
    return { x: clamp(explicitX, .16, .84), y: clamp(explicitY, .10, .68), source: 'anchor' };
  }
  const subjectAnchor = event && typeof event.subjectAnchor === 'object' ? event.subjectAnchor : {};
  const subjectX = finite(subjectAnchor.x), subjectY = finite(subjectAnchor.y);
  if (subjectX !== null && subjectY !== null) {
    return { x: clamp(subjectX < .5 ? subjectX + .23 : subjectX - .23, .16, .84), y: clamp(subjectY - .13, .10, .68), source: 'subject-anchor' };
  }
  const safeZones = [
    ...(Array.isArray(event && event.safeZones) ? event.safeZones : []),
    ...(event && event.safeZone && typeof event.safeZone === 'object' ? [event.safeZone] : []),
  ].filter(zone => zone && zone.safe !== false);
  if (safeZones.length) {
    const zone = [...safeZones].sort((left, right) => (Number(right.clarity) || 0) - (Number(left.clarity) || 0)
      || (Number(right.width) || 0) * (Number(right.height) || 0) - (Number(left.width) || 0) * (Number(left.height) || 0))[0];
    const x = finite(zone.x) ?? ((finite(zone.left) ?? .16) + (finite(zone.width) ?? .3) / 2);
    const y = finite(zone.y) ?? ((finite(zone.top) ?? .12) + (finite(zone.height) ?? .18) / 2);
    return { x: clamp(x, .16, .84), y: clamp(y, .10, .68), source: 'safe-zone' };
  }
  const namedZone = String(placement.zone || event && event.zone || '');
  const zoneY = { top: .18, upper: .18, middle: .40, center: .40, lower: .62, bottom: .62 }[namedZone];
  if (zoneY) return { x: side, y: zoneY, source: 'zone' };
  return conservative('fallback');
}

function mergeMotionEvents(plan) {
  const baseEvents = plan && Array.isArray(plan.events) ? plan.events : [];
  const motionEvents = plan && Array.isArray(plan.motionEvents) ? plan.motionEvents : [];
  if (!motionEvents.length) return baseEvents;
  const matched = new Set();
  const merged = motionEvents.flatMap((motion, index) => {
    if (!motion || typeof motion !== 'object') return [];
    const motionStart = finite(motion.startMs), motionEnd = finite(motion.endMs);
    const candidates = baseEvents.map((event, eventIndex) => {
      const direct = motion.id === event.id || motion.id === `motion-${event.id}`;
      const target = motion.target && motion.target.targetId && motion.target.targetId === event.targetId;
      const sameType = motion.emphasisType === event.type;
      const overlap = motionStart !== null && motionEnd !== null
        ? Math.max(0, Math.min(motionEnd, Number(event.endMs) || 0) - Math.max(motionStart, Number(event.startMs) || 0)) : 0;
      return { event, eventIndex, score: direct ? 1e9 : target && sameType ? 1e7 + overlap : sameType ? overlap : -1 };
    }).sort((left, right) => right.score - left.score);
    const match = candidates[0] && candidates[0].score > 0 ? candidates[0] : null;
    if (match) matched.add(match.eventIndex);
    const base = match ? match.event : {};
    const rawType = String(motion.emphasisType || base.type || 'key_fact');
    const type = rawType === 'cta' ? 'cta' : rawType === 'reveal' || rawType === 'hook' ? 'reveal' : 'key_fact';
    const visualRole = MOTION_ROLES.has(String(motion.visualRole)) ? String(motion.visualRole) : undefined;
    const trustedRays = visualRole === 'surround' && Number(motion.target && motion.target.confidence) >= .68
      && ['person', 'product', 'machine', 'action'].includes(String(motion.target && motion.target.kind));
    return [{ ...base, id: String(motion.id || base.id || `motion-${index + 1}`), type,
      startMs: motionStart ?? finite(base.startMs) ?? 0, endMs: motionEnd ?? finite(base.endMs) ?? 0,
      text: String(base.text || motion.target && motion.target.label || motion.anchor && motion.anchor.phrase || ''),
      visualRole, ...(trustedRays ? { assetFamily: 'rays' } : {}),
      presentationMode: base.presentationMode || 'graphic_only', motionEventId: motion.id,
      semanticAnchor: motion.anchor, target: motion.target }];
  });
  return [...merged, ...baseEvents.filter((_, index) => !matched.has(index))];
}

const mappedAdvancedEvents = plan => mergeMotionEvents(plan)
  .filter(event => ['key_fact', 'reveal', 'cta'].includes(event.type))
  .flatMap((event, index) => {
    // Shot alignment's degradation decision also governs semantic motion.
    if (['caption_emphasis', 'none'].includes(event.presentationMode)) return [];
    const evidence = event && typeof (event.evidence || event.evidenceTime || event.evidenceWindow) === 'object'
      ? (event.evidence || event.evidenceTime || event.evidenceWindow) : {};
    const startMs = Math.max(Number(event.startMs) || 0, Number(event.evidenceStartMs ?? evidence.startMs) || 0);
    const evidenceEnd = Number(event.evidenceEndMs ?? evidence.endMs);
    const endMs = Number.isFinite(evidenceEnd) ? Math.min(Number(event.endMs) || evidenceEnd, evidenceEnd) : Number(event.endMs) || 0;
    if (endMs <= startMs) return [];
    const semanticRole = MOTION_ROLES.has(String(event.visualRole)) && (event.semanticEvidence || event.semanticAnchor);
    const presentation = semanticRole
      ? { outcome: event.presentationMode === 'label' ? 'label' : 'graphic_only', layout: roleLayout(event, resolveOverlayLayout(event, index)) }
      : planOverlayPresentation(event, index);
    if (!['label', 'graphic_only'].includes(presentation.outcome) || !presentation.layout) return [];
    return [{
    id: event.id, type: event.type, startMs, endMs, text: String(event.text || ''),
    assetKind: semanticAssetKind(event),
    motionRole: normalizeMotionRole(event),
    assetId: Object.entries(MOTION_ASSET_REGISTRY).find(([, definition]) => definition.allowedRoles.includes(normalizeMotionRole(event)))?.[0],
    assetFamily: normalizeMotionRole(event) === 'surround' ? 'rays' : normalizeMotionRole(event) === 'point_to' || normalizeMotionRole(event) === 'caption_companion' ? 'directional' : 'badge',
    runtimeAssetFamily: normalizeMotionRole(event) === 'surround' ? 'rays' : normalizeMotionRole(event) === 'point_to' || normalizeMotionRole(event) === 'caption_companion' ? 'directional' : 'badge',
    allowedRoles: [normalizeMotionRole(event)],
    presentationMode: event.presentationMode === 'graphic_only' ? 'graphic_only' : 'label',
    importance: Number(event.importance) || 1,
    confidence: Number(event.confidence) || 0,
    targetRelation: event.targetRelation || normalizeMotionRole(event),
    semanticEvidence: event.semanticEvidence || event.semanticAnchor || event.placementEvidence,
    semanticAnchor: event.semanticAnchor,
    shotId: String(event.shotId || event.placementEvidence && event.placementEvidence.windowId || ''),
    occupiedBoxes: Array.isArray(event.occupiedBoxes) ? event.occupiedBoxes : [],
    captionBoxes: Array.isArray(event.captionBoxes) ? event.captionBoxes : [],
    protectedBoxes: Array.isArray(event.protectedBoxes) ? event.protectedBoxes : [],
    primaryDecorationCount: 1,
    placement: resolveOverlayPlacement(event, index),
    layout: presentation.layout,
    presentationMode: presentation.outcome,
    targetRelation: presentation.layout.relation || normalizeMotionRole(event),
    shotId: String(event.shotId || ''),
    ...(normalizedBox(event.subjectBox) ? { subjectBox: normalizedBox(event.subjectBox) } : {}),
    playbackKey: `${event.shotId || 'timeline'}:${startMs}:${endMs}`,
    ...(event.subjectAnchor && Number.isFinite(Number(event.subjectAnchor.x)) && Number.isFinite(Number(event.subjectAnchor.y))
      ? { subjectAnchor: { x: clamp(Number(event.subjectAnchor.x), .08, .92), y: clamp(Number(event.subjectAnchor.y), .08, .70) } } : {}),
  }];
  });

const advancedEvents = plan => {
  const mapped = mappedAdvancedEvents(plan);
  const modern = mapped.filter(event => event.semanticEvidence);
  const acceptedModern = new Set(filterAdvancedEventsForQa(modern, { cooldownMs: 4_000 }).map(event => event.id));
  return mapped.filter(event => !event.semanticEvidence || acceptedModern.has(event.id));
};

async function rendererModules() {
  const [{ bundle }, { renderMedia, selectComposition }] = await Promise.all([
    import('@remotion/bundler'), import('@remotion/renderer'),
  ]);
  return { bundle, renderMedia, selectComposition };
}

async function bundleOverlay(bundle) {
  if (!bundlePromise) bundlePromise = bundle({
    entryPoint: path.join(__dirname, 'remotion-overlay/index.ts'),
    publicDir: ASSET_DIRECTORY,
    onProgress: () => undefined,
  });
  return bundlePromise;
}

async function renderTransparentOverlay({ plan, width, height, durationSeconds, fps = 15, onProgress = () => {} }) {
  const events = advancedEvents(plan);
  if (!events.length || process.env.LINGSHU_REMOTION_OVERLAY === 'off') return { path: null, cacheHit: false, renderMs: 0 };
  const sourceVersion = crypto.createHash('sha256').update([
    fs.readFileSync(__filename),
    fs.readFileSync(path.join(__dirname, 'remotion-overlay/root.tsx')),
    fs.readFileSync(path.join(__dirname, 'remotion-overlay/semantic-assets.tsx')),
    fs.readFileSync(path.join(__dirname, 'remotion-overlay/asset-crops.json')),
    fs.readFileSync(path.join(__dirname, 'remotion-overlay/asset-playback.json')),
    ...['burst-rays-yellow-static.png', 'burst-rays-yellow.gif', 'emphasis-rays-yellow.gif', 'lightning-orange.gif', 'megaphone-blue-yellow.gif']
      .map(file => fs.readFileSync(path.join(ASSET_DIRECTORY, file))),
    ...['hold-burst-rays-yellow.png', 'hold-emphasis-rays-yellow.png', 'hold-lightning-orange.png', 'hold-megaphone-blue-yellow.png']
      .map(file => fs.readFileSync(path.join(ASSET_DIRECTORY, file))),
  ].map(value => crypto.createHash('sha256').update(value).digest('hex')).join(':')).digest('hex').slice(0, 16);
  const props = { rendererVersion: RENDERER_VERSION, sourceVersion, durationFrames: Math.max(1, Math.ceil(durationSeconds * fps)), fps, width, height, profile: plan.profile, events };
  const key = crypto.createHash('sha256').update(JSON.stringify(props)).digest('hex');
  const cacheDir = path.join(os.homedir(), '.cache', 'lingshu-ai', 'remotion-overlays');
  const output = path.join(cacheDir, `${key}.webm`);
  fs.mkdirSync(cacheDir, { recursive: true });
  if (fs.existsSync(output) && fs.statSync(output).size > 1024) return { path: output, cacheHit: true, renderMs: 0 };
  const started = Date.now();
  const { bundle, renderMedia, selectComposition } = await rendererModules();
  const serveUrl = await bundleOverlay(bundle);
  const composition = await selectComposition({ serveUrl, id: 'EmphasisOverlay', inputProps: props });
  const chromePath = process.platform === 'darwin' && fs.existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined;
  await renderMedia({
    serveUrl, composition, inputProps: props, outputLocation: output, overwrite: true,
    codec: 'vp9', imageFormat: 'png', pixelFormat: 'yuva420p', muted: true,
    browserExecutable: chromePath, chromeMode: 'chrome-for-testing', concurrency: 2, logLevel: 'error',
    onProgress: progress => onProgress(progress.progress),
  });
  return { path: output, cacheHit: false, renderMs: Date.now() - started };
}

module.exports = { MOTION_ASSET_REGISTRY, RENDERER_VERSION, advancedEvents, intersects, mergeMotionEvents, normalizeMotionRole, planOverlayPresentation, relationLayouts, resolveOverlayLayout, resolveOverlayPlacement, semanticAssetKind, renderTransparentOverlay };
