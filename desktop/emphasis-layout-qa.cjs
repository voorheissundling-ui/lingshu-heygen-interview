/* eslint-disable */
const SAFE_FRAME = Object.freeze({ x: .035, y: .035, width: .93, height: .665 });
const finiteRect = rect => rect && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)
  && rect.width > 0 && rect.height > 0;
const contains = (outer, inner) => inner.x >= outer.x && inner.y >= outer.y
  && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
const intersects = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x
  && a.y < b.y + b.height && a.y + a.height > b.y;
const centre = rect => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const rectDistance = (a, b) => Math.hypot(
  Math.max(a.x - (b.x + b.width), b.x - (a.x + a.width), 0),
  Math.max(a.y - (b.y + b.height), b.y - (a.y + a.height), 0),
);
const timeOverlaps = (a, b) => a.startMs < b.endMs && a.endMs > b.startMs;
const targetOf = event => finiteRect(event.subjectBox) ? event.subjectBox : finiteRect(event.targetBox) ? event.targetBox : null;
const actualAssetFamily = event => event.runtimeAssetFamily
  || (['reveal', 'key_fact'].includes(String(event.assetKind)) ? 'rays' : 'directional');

function spatialIssues(event) {
  const layout = event.layout || {};
  const asset = layout.asset;
  const label = event.presentationMode === 'label' ? layout.label : null;
  const target = targetOf(event);
  const role = String(event.motionRole || event.targetRelation || '');
  const issues = [];
  if (!finiteRect(asset)) return ['missing_asset_layout'];
  if (!contains(SAFE_FRAME, asset) || (finiteRect(label) && !contains(SAFE_FRAME, label))) issues.push('outside_safe_frame');
  const occupied = [...(event.occupiedBoxes || []), ...(event.captionBoxes || []), ...(event.protectedBoxes || [])].filter(finiteRect);
  if ([asset, ...(finiteRect(label) ? [label] : [])].some(rect => occupied.some(box => intersects(rect, box)))) issues.push('occupied_collision');
  if (finiteRect(label) && intersects(asset, label)) issues.push('asset_label_collision');
  if ((event.primaryDecorationCount || 1) > 1) issues.push('multiple_primary_decorations');
  if (actualAssetFamily(event) === 'rays' && role !== 'surround') issues.push('detached_rays');
  if (Array.isArray(event.allowedRoles) && event.allowedRoles.length && !event.allowedRoles.includes(role)) issues.push('asset_role_mismatch');

  if (role === 'surround') {
    if (!target) issues.push('surround_missing_target');
    else {
      const targetCentre = centre(target), assetCentre = centre(asset);
      const encloses = asset.x <= target.x - .01 && asset.y <= target.y - .01
        && asset.x + asset.width >= target.x + target.width + .01
        && asset.y + asset.height >= target.y + target.height + .01;
      if (!encloses || distance(targetCentre, assetCentre) > .06) issues.push('surround_not_on_outer_edges');
    }
  } else if (role === 'point_to') {
    const anchor = event.subjectAnchor || event.targetAnchor;
    if (!target || !anchor || intersects(asset, target)) issues.push('point_to_missing_or_colliding_target');
    else {
      const nearest = { x: Math.max(asset.x, Math.min(anchor.x, asset.x + asset.width)),
        y: Math.max(asset.y, Math.min(anchor.y, asset.y + asset.height)) };
      if (distance(nearest, anchor) > .25) issues.push('point_to_direction_misses_target');
    }
  } else if (role === 'adjacent') {
    if (!target) issues.push('adjacent_missing_target');
    else {
      const gap = rectDistance(asset, target);
      if (intersects(asset, target) || gap < .03 - 1e-9 || gap > .10 + 1e-9) issues.push('adjacent_distance_invalid');
    }
  } else if (role === 'corner_badge') {
    const c = centre(asset);
    const cornerDistance = Math.min(distance(c, { x: 0, y: 0 }), distance(c, { x: 1, y: 0 }),
      distance(c, { x: 0, y: 1 }), distance(c, { x: 1, y: 1 }));
    if (cornerDistance > .32) issues.push('corner_badge_not_in_corner');
    if (target && intersects(asset, target)) issues.push('corner_badge_target_collision');
  }
  if (role !== 'surround' && target && [asset, ...(finiteRect(label) ? [label] : [])].some(rect => intersects(rect, target))) {
    issues.push('target_collision');
  }
  return [...new Set(issues)];
}

/** Final fail-closed gate before Remotion. Invalid advanced events disappear;
 * their ordinary subtitle cue remains the caption-emphasis fallback. */
function qaAdvancedEvents(events, { cooldownMs = 4_000 } = {}) {
  const decisions = events.map(event => {
    const role = String(event.motionRole || event.targetRelation || '');
    const semanticEvidence = event.semanticEvidence || event.semanticAnchor || event.anchor;
    const spatialRole = ['surround', 'point_to', 'adjacent'].includes(role);
    return { event, issues: [
      ...(!semanticEvidence ? ['missing_semantic_evidence'] : []),
      ...(spatialRole && !event.shotId ? ['missing_shot_window'] : []),
      ...spatialIssues(event),
    ] };
  });
  const accepted = [];
  const ranked = [...decisions].sort((a, b) => (Number(b.event.importance) || 0) - (Number(a.event.importance) || 0)
    || (Number(b.event.confidence) || 0) - (Number(a.event.confidence) || 0)
    || a.event.startMs - b.event.startMs || String(a.event.id).localeCompare(String(b.event.id)));
  for (const decision of ranked) {
    if (decision.issues.length) continue;
    const conflict = accepted.find(other => timeOverlaps(decision.event, other.event));
    if (conflict) { decision.issues.push(`same_screen_conflict:${conflict.event.id}`); continue; }
    const assetKey = String(decision.event.assetId || decision.event.assetKind || '');
    const repeated = assetKey && accepted.find(other => String(other.event.assetId || other.event.assetKind || '') === assetKey
      && Math.abs(decision.event.startMs - other.event.startMs) < cooldownMs);
    if (repeated) { decision.issues.push(`asset_cooldown:${repeated.event.id}`); continue; }
    accepted.push(decision);
  }
  const acceptedIds = new Set(accepted.map(decision => decision.event.id));
  return {
    events: events.filter(event => acceptedIds.has(event.id)),
    decisions: decisions.map(decision => ({ eventId: decision.event.id, accepted: acceptedIds.has(decision.event.id),
      outcome: acceptedIds.has(decision.event.id) ? decision.event.presentationMode : (decision.event.text ? 'caption_emphasis' : 'none'),
      issues: decision.issues })),
  };
}

const filterAdvancedEventsForQa = (events, options) => qaAdvancedEvents(events, options).events;

module.exports = { filterAdvancedEventsForQa, qaAdvancedEvents, spatialIssues };
