import { createHash } from 'node:crypto';
import type { DataStore } from '../storage/datastore.js';
import type { SocialAccountTrackingDecision } from '../../shared/contracts/socialContentWorkflow.js';
import { sourceAccountFromProviderMetadata, sourceAccountFromVideoUrl } from '../routes/videoSourceIdentity.js';
import { socialJson, socialObject } from '../starter198/socialContentValidation.js';

/** Attach accepted weekly video evidence to the existing watching-account inventory.
 * A video URL can prove its uploader, not that the uploader is a confirmed
 * long-term benchmark account. Never promote or confirm the account here. */
export async function linkObservedWeeklyAccounts(dataStore: DataStore, tenantId: string, candidateIds: string[]): Promise<number> {
  let linked = 0;
  for (const candidateId of new Set(candidateIds)) {
    const video = await dataStore.getById<Record<string, unknown>>('trend_videos', candidateId);
    if (!video || video.tenantId !== tenantId) continue;
    const platform = String(video.platform || '');
    const sourceUrl = String(video.sourceUrl || '');
    const analysis = socialObject(socialJson(video.aiAnalysis)) ?? {};
    const accountId = sourceAccountFromVideoUrl(platform, sourceUrl)
      ?? (['provider_metadata','account_homepage'].includes(String(analysis.sourceAccountEvidence || ''))
        ? sourceAccountFromProviderMetadata(platform,String(analysis.sourceAccount || '')) : null);
    if (!accountId) continue;
    const matching = await dataStore.list<SocialAccountTrackingDecision & { id: string }>('social_tracked_accounts', {
      where: { tenant_id: tenantId, accountId }, perPage: 2,
    });
    if (matching.totalItems > 1) throw Error('weekly_observed_account_ambiguous');
    const existing = matching.items[0];
    if (existing) {
      if (!existing.evidenceVideoIds.includes(candidateId)) {
        const updated = await dataStore.update('social_tracked_accounts', existing.id, { evidenceVideoIds: [...existing.evidenceVideoIds, candidateId] });
        if (!updated) throw Error('weekly_observed_account_update_failed');
      }
      linked++;
      continue;
    }
    const id = createHash('sha256').update(JSON.stringify([tenantId, accountId])).digest('hex').slice(0, 15);
    const gemini = socialObject(analysis.gemini) ?? {};
    const reason = [video.title, video.author, analysis.caption, gemini.summary]
      .map(value => String(value || '').trim()).filter(Boolean).join(' · ').slice(0, 300);
    const created = await dataStore.create('social_tracked_accounts', {
      id, tenant_id: tenantId, accountId, decision: 'watch', status: 'watching',
      accountRole: 'expression_reference', reasons: reason ? [reason] : [],
      evidenceVideoIds: [candidateId], relatedSceneIds: [],
      missingEvidence: ['账号持续性与企业身份尚未核验'], confidence: 0.8,
      recommendedBy: 'director_agent',
    } satisfies SocialAccountTrackingDecision & { id: string; tenant_id: string });
    if (!created) throw Error('weekly_observed_account_create_failed');
    linked++;
  }
  return linked;
}
