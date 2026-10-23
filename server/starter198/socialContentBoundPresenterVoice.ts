import type { DataStore } from '../storage/datastore.js';
import { paidProductionHash } from './socialContentPaidOperationPlan.js';
import { validateHeyGenPresenterRecord } from '../lib/presenterAssetTrust.js';

async function assertWeeklyPresenterSource(store: DataStore, tenantId: string, presenter: any): Promise<void> {
  const ref = String(presenter?.rightsEvidence?.authorizationRef || '');
  const match = /^document:\/\/studio_presenter_assets\/([^/]+)\/([^/]+)$/.exec(ref);
  if (!match) throw Error('weekly_default_voice_source_missing');
  const row = await store.getById<any>('studio_presenter_assets', match[1]!);
  const avatarId = String(presenter?.toolMappings?.heygen?.avatarId || presenter?.avatarId || '');
  const voiceId = String(presenter?.toolMappings?.heygen?.voiceId || presenter?.voiceId || '');
  if (!row || row.tenant_id !== tenantId || match[2] !== avatarId || !row.payload) throw Error('weekly_default_voice_source_mismatch');
  const source = row.payload;
  const assertReboundVoice = async (originalVoiceId: string) => {
    if (originalVoiceId === voiceId) return;
    const voiceRef = /^document:\/\/studio_presenter_assets\/([^/]+)\/([^/]+)$/.exec(String(presenter?.voiceAuthorization?.authorizationRef || ''));
    if (!voiceRef || voiceRef[2] !== voiceId) throw Error('weekly_default_voice_binding_missing');
    const binding = await store.getById<any>('studio_presenter_assets', voiceRef[1]!);
    if (!binding || binding.tenant_id !== tenantId || binding.kind !== 'voice_binding_authorization'
      || binding.payload?.presenterId !== presenter.id || binding.payload?.avatarId !== avatarId
      || binding.payload?.voiceId !== voiceId || binding.payload?.authorizationDeclared !== true
      || binding.payload?.providerVoiceConfirmed !== true || binding.payload?.revokedAt
      || binding.payload?.recordedAt !== presenter.voiceAuthorization.recordedAt) {
      throw Error('weekly_default_voice_binding_mismatch');
    }
  };
  if (row.kind === 'import_authorization') {
    if (source.revokedAt || source.lookId !== avatarId || !source.voiceId || source.authorizationDeclared !== true
      || source.adultConfirmed !== true || source.reviewed !== true || !source.groupId
      || presenter.rightsEvidence.consentRef !== (source.providerConsentAccepted === true
        ? `consent://heygen/${source.groupId}` : `consent://user-declaration/${row.id}`)) {
      throw Error('weekly_default_voice_source_mismatch');
    }
    await assertReboundVoice(source.voiceId);
  } else if (row.kind === 'creation') {
    if (source.revokedAt || source.mock === true || source.status !== 'completed' || source.authorized !== true
      || source.authorizationDeclared !== true || source.subjectAdultConfirmed !== true
      || source.look?.id !== avatarId || !source.voiceId || !source.groupId) {
      throw Error('weekly_default_voice_source_mismatch');
    }
    await assertReboundVoice(source.voiceId);
  } else throw Error('weekly_default_voice_source_mismatch');
}

export interface BoundPresenterVoice {
  presenters: Array<{ id: string; assetVersion: number; avatarId: string; voiceId: string }>;
  provider: 'heygen'; voiceId: string; logicalVoice: string; fingerprint: string;
}

/** Projects presenter identities from the immutable reviewed supply plan. */
export function weeklyProductionPresenterIds(plan: unknown): string[] {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return [];
  const shots = (plan as { shots?: unknown }).shots;
  if (!Array.isArray(shots)) return [];
  const ids: string[] = [];
  for (const value of shots) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const shot = value as Record<string, unknown>;
    if (shot.sourceStrategy !== 'authorized_digital_presenter') continue;
    const digital = shot.digitalHumanPlan && typeof shot.digitalHumanPlan === 'object' && !Array.isArray(shot.digitalHumanPlan)
      ? shot.digitalHumanPlan as Record<string, unknown> : null;
    if (digital?.silentMotion === true) continue;
    const selected = Array.isArray(digital?.presenterAssetIds) && digital.presenterAssetIds.length
      ? digital.presenterAssetIds : Array.isArray(shot.sourceRefs) ? shot.sourceRefs : [];
    for (const id of selected) if (typeof id === 'string' && id.trim()) ids.push(id.trim());
  }
  return [...new Set(ids)].sort();
}

/** Only authoritative tenant assets may select a production voice. */
export async function readBoundPresenterVoice(store: DataStore, tenantId: string, ids: string[]): Promise<BoundPresenterVoice | null> {
  const selected = [...new Set(ids)].sort();
  if (!selected.length) return null;
  const rows = await store.list<any>('studio_production_defaults', { where: { tenant_id: tenantId }, perPage: 2 });
  if (rows.items.length !== 1 || rows.items[0].tenant_id !== tenantId) throw Error('selected_presenter_voice_registry_missing');
  const assets = rows.items[0].payload?.presenters || [];
  const presenters = selected.map(id => {
    const matches = assets.filter((item: any) => item.id === id);
    if (matches.length !== 1) throw Error('selected_presenter_voice_registry_ambiguous:' + id);
    const p = matches[0];
    const voiceId = String(p?.toolMappings?.heygen?.voiceId || p?.voiceId || '').trim();
    const avatarId = String(p?.toolMappings?.heygen?.avatarId || p?.avatarId || '').trim();
    if (p?.authorized !== true || !voiceId || !avatarId || (p.voiceId && p.voiceId !== voiceId) || (p?.avatarId && p.avatarId !== avatarId)) throw Error('selected_presenter_bound_voice_missing_or_conflicting:' + id);
    return { id, assetVersion: Math.max(1, p.assetVersion || 1), avatarId, voiceId };
  });
  if (new Set(presenters.map(p => p.voiceId)).size !== 1) throw Error('multiple_presenter_voices_require_separate_audio_tracks');
  const voiceId = presenters[0]!.voiceId;
  const fingerprint = paidProductionHash({ tenantId, presenters, provider: 'heygen', voiceId });
  return { presenters, provider: 'heygen', voiceId, fingerprint, logicalVoice: `heygen:${voiceId}:${fingerprint}` };
}

/** Weekly acceptance authorizes the enterprise's default voice for the whole
 * film, including product-only and silent-motion shots. A generic TTS preset
 * must never stand in for that identity. Manual creation keeps its own rules. */
export async function readWeeklyProductionVoice(store: DataStore, tenantId: string, selectedPresenterIds: string[]): Promise<BoundPresenterVoice> {
  const rows = await store.list<any>('studio_production_defaults', { where: { tenant_id: tenantId }, perPage: 2 });
  if (rows.totalItems !== 1 || rows.items.length !== 1 || rows.items[0].tenant_id !== tenantId) throw Error('weekly_default_voice_registry_missing');
  const defaults = rows.items[0].payload || {};
  const defaultId = String(defaults.defaultPresenterId || '').trim();
  const matches = (Array.isArray(defaults.presenters) ? defaults.presenters : []).filter((item: any) => item.id === defaultId);
  if (!defaultId || matches.length !== 1) throw Error('weekly_default_voice_identity_missing');
  const ids = [...new Set([defaultId, ...selectedPresenterIds])];
  for (const id of ids) {
    const selected = (Array.isArray(defaults.presenters) ? defaults.presenters : []).filter((item: any) => item.id === id);
    if (selected.length !== 1 || !validateHeyGenPresenterRecord(selected[0]).ok) throw Error(`weekly_default_voice_authorization_missing:${id}`);
    await assertWeeklyPresenterSource(store, tenantId, selected[0]);
  }
  const voice = await readBoundPresenterVoice(store, tenantId, ids);
  if (!voice) throw Error('weekly_default_voice_identity_missing');
  return voice;
}

export function assertBoundPresenterAudio(expectedVoiceId: string, actual: { provider: string; physicalVoiceId: string }) {
  if (actual.provider !== 'heygen' || actual.physicalVoiceId !== expectedVoiceId) throw Error('selected_presenter_audio_voice_mismatch');
}
