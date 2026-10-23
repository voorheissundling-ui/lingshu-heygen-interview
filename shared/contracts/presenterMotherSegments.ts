import { createHash } from 'node:crypto';

export interface PresenterMotherSlotInput {
  slotId: string;
  referenceShotId: string;
  startSeconds: number;
  endSeconds: number;
  spokenText: string;
  materialType: string;
  frontFacing: boolean;
  lipSyncRequired: boolean;
}

export interface FrozenPresenterMotherMember {
  slotId: string;
  referenceShotId: string;
  startSeconds: number;
  endSeconds: number;
  spokenText: string;
}

export interface FrozenPresenterMotherSegment {
  segmentId: string;
  order: number;
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
  memberSlotIds: string[];
  members: FrozenPresenterMotherMember[];
  mergedSpokenText: string;
  contentHash: string;
}

export interface FrozenPresenterMotherSegments {
  schemaVersion: 'presenter-mother-segments.v1';
  taskId: string;
  referenceAnalysisHash: string;
  sourceSlotCount: number;
  groups: FrozenPresenterMotherSegment[];
  recordHash: string;
}

const HASH = /^[a-f0-9]{64}$/;
const EPSILON_SECONDS = 0.001;

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function text(value: string, field: string): string {
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!normalized) throw new Error(`presenter_mother_${field}_missing`);
  return normalized;
}

function validSlot(slot: PresenterMotherSlotInput): void {
  text(slot.slotId, 'slot_id');
  text(slot.referenceShotId, 'reference_shot_id');
  if (!Number.isFinite(slot.startSeconds) || !Number.isFinite(slot.endSeconds) || slot.startSeconds < 0 || slot.endSeconds <= slot.startSeconds) {
    throw new Error(`presenter_mother_slot_range_invalid:${slot.slotId}`);
  }
}

/**
 * Freezes one provider/cache/budget identity per contiguous presenter source
 * segment. A person appearing in B-roll is excluded unless the shot is both
 * front-facing and explicitly requires lip sync.
 */
export function freezePresenterMotherSegments(input: {
  taskId: string;
  referenceAnalysisHash: string;
  slots: PresenterMotherSlotInput[];
}): FrozenPresenterMotherSegments {
  const taskId = text(input.taskId, 'task_id');
  if (!HASH.test(input.referenceAnalysisHash)) throw new Error('presenter_mother_reference_hash_invalid');
  if (!input.slots.length) throw new Error('presenter_mother_slots_missing');

  input.slots.forEach(validSlot);
  const ordered = [...input.slots].sort((a, b) => a.startSeconds - b.startSeconds || a.endSeconds - b.endSeconds || a.slotId.localeCompare(b.slotId));
  if (new Set(ordered.map(slot => slot.slotId)).size !== ordered.length) throw new Error('presenter_mother_slot_id_duplicate');
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index]!.startSeconds < ordered[index - 1]!.endSeconds - EPSILON_SECONDS) {
      throw new Error(`presenter_mother_slot_overlap:${ordered[index]!.slotId}`);
    }
  }

  const selected = ordered.filter(slot => slot.materialType === 'talking_head' && slot.frontFacing && slot.lipSyncRequired);
  if (!selected.length) throw new Error('presenter_mother_presenter_slots_missing');
  const grouped: PresenterMotherSlotInput[][] = [];
  for (const slot of selected) {
    const current = grouped.at(-1);
    if (current && Math.abs(current.at(-1)!.endSeconds - slot.startSeconds) <= EPSILON_SECONDS) current.push(slot);
    else grouped.push([slot]);
  }

  const groups = grouped.map((members, index): FrozenPresenterMotherSegment => {
    const frozenMembers = members.map(member => ({
      slotId: text(member.slotId, 'slot_id'),
      referenceShotId: text(member.referenceShotId, 'reference_shot_id'),
      startSeconds: member.startSeconds,
      endSeconds: member.endSeconds,
      spokenText: member.spokenText.trim().replace(/\s+/g, ' '),
    }));
    const body = {
      segmentId: `presenter-mother-${index + 1}`,
      order: index + 1,
      startSeconds: frozenMembers[0]!.startSeconds,
      endSeconds: frozenMembers.at(-1)!.endSeconds,
      durationSeconds: frozenMembers.at(-1)!.endSeconds - frozenMembers[0]!.startSeconds,
      memberSlotIds: frozenMembers.map(member => member.slotId),
      members: frozenMembers,
      mergedSpokenText: frozenMembers.map(member => member.spokenText).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim(),
    };
    return { ...body, contentHash: digest(body) };
  });
  const body = {
    schemaVersion: 'presenter-mother-segments.v1' as const,
    taskId,
    referenceAnalysisHash: input.referenceAnalysisHash,
    sourceSlotCount: ordered.length,
    groups,
  };
  return { ...body, recordHash: digest(body) };
}

export function verifyFrozenPresenterMotherSegments(value: FrozenPresenterMotherSegments): boolean {
  if (value.schemaVersion !== 'presenter-mother-segments.v1' || !value.taskId || !HASH.test(value.referenceAnalysisHash) || !HASH.test(value.recordHash)) return false;
  if (!Number.isSafeInteger(value.sourceSlotCount) || value.sourceSlotCount < 1 || !value.groups.length) return false;
  if (value.groups.some((group, index) => group.order !== index + 1
    || group.segmentId !== `presenter-mother-${index + 1}`
    || group.memberSlotIds.length !== group.members.length
    || group.memberSlotIds.some((slotId, memberIndex) => slotId !== group.members[memberIndex]?.slotId)
    || group.startSeconds !== group.members[0]?.startSeconds
    || group.endSeconds !== group.members.at(-1)?.endSeconds
    || group.durationSeconds !== group.endSeconds - group.startSeconds
    || group.mergedSpokenText !== group.members.map(member => member.spokenText).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
    || group.contentHash !== digest({ segmentId: group.segmentId, order: group.order, startSeconds: group.startSeconds, endSeconds: group.endSeconds, durationSeconds: group.durationSeconds, memberSlotIds: group.memberSlotIds, members: group.members, mergedSpokenText: group.mergedSpokenText }))) return false;
  const { recordHash, ...body } = value;
  return recordHash === digest(body);
}
