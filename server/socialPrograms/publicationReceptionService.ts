import { createHash, randomUUID } from 'node:crypto';
import type { DataStore } from '../storage/datastore.js';
import { organizationRoleOrNull } from '../lib/organizationRole.js';
import { checkPublicationReception, type ReceptionBinding, type ReceptionCheckPorts } from './publicationReceptionReadiness.js';
import { createPublicationReceptionPorts } from './publicationReceptionPorts.js';
import { createReceptionPublicUrlProbe } from './publicationReceptionUrlProbe.js';
import {verifyEnterpriseFactContent,type EnterpriseProfile} from '../routes/enterprise.js';
import {readCustomerMessagingAuthorization} from '../digitalEmployees/customerMessagingPolicy.js';
import {socialObject,socialJson} from '../starter198/socialContentValidation.js';
import {publicationInstant} from './publicationDeadlines.js';

export const RECEPTION_BINDINGS = 'social_weekly_reception_bindings';
export const RECEPTION_CHECKS = 'social_weekly_reception_checks';
type Row = { id: string; tenant_id: string; binding_hash: string; payload: ReceptionBinding };
type Scope = Pick<ReceptionBinding, 'tenantId' | 'programId' | 'packageId' | 'packageVersion' | 'publicationId'>;
function identity(binding: ReceptionBinding) { return createHash('sha256').update(JSON.stringify(binding)).digest('hex'); }
function sameScope(a: Scope | null | undefined, b: Scope) { return Boolean(a && a.tenantId === b.tenantId && a.programId === b.programId && a.packageId === b.packageId && a.packageVersion === b.packageVersion && a.publicationId === b.publicationId); }
function validStoredBinding(value: unknown): value is ReceptionBinding {
  if (!value || typeof value !== 'object') return false;
  const binding = value as ReceptionBinding;
  try {
    return ['tenantId', 'programId', 'packageId', 'publicationId', 'cta', 'enterpriseFactHash'].every(key => typeof (value as Record<string, unknown>)[key] === 'string' && Boolean((value as Record<string, string>)[key].trim()))
      && Number.isSafeInteger(binding.packageVersion) && binding.packageVersion > 0
      && Array.isArray(binding.targets) && binding.targets.length > 0 && binding.targets.length <= 100
      && binding.targets.some(target => target.required === true)
      && new Set(binding.targets.map(target => target.id)).size === binding.targets.length
      && binding.targets.every(target => Boolean(target && typeof target.id === 'string' && target.id && typeof target.required === 'boolean' && typeof target.ownerId === 'string' && target.ownerId
        && Array.isArray(target.requiredDocumentUrls) && target.requiredDocumentUrls.every(url => typeof url === 'string' && url)
        && target.destination && ((target.destination.kind === 'url' && typeof target.destination.url === 'string' && target.destination.url)
          || (target.destination.kind === 'messaging' && ['whatsapp', 'messenger', 'instagram'].includes(target.destination.channel) && ['human', 'draft', 'automatic'].includes(target.destination.receptionMode)))));
  } catch { return false; }
}

export function productionReceptionPorts(dataStore: DataStore,now:()=>Date=()=>new Date()): ReceptionCheckPorts {
  return createPublicationReceptionPorts({
    async facts(tenantId) {
      const rows=await dataStore.list<Record<string,unknown>>('tenant_profiles',{where:{tenant_id:tenantId},perPage:2});
      if(rows.totalItems!==1||rows.items.length!==1||rows.items[0]?.tenant_id!==tenantId)throw Error('reception_confirmed_facts_unavailable');
      const profile=socialObject(socialJson(rows.items[0].profile)) as unknown as EnterpriseProfile|null;
      const version=profile?.factVersion;
      if(!profile||!version?.confirmedBy||!Number.isSafeInteger(version.revision)||version.revision<=0||!verifyEnterpriseFactContent(profile).verified||publicationInstant(version.confirmedAt)===null||Date.parse(version.confirmedAt)>now().getTime())throw Error('reception_confirmed_facts_unavailable');
      const authorizer=await dataStore.getById<Record<string,unknown>>('users',version.confirmedBy),role=organizationRoleOrNull(authorizer?.role);
      if(!authorizer||authorizer.tenantId!==tenantId||!['admin','super_admin','social_operator'].includes(role??'')||authorizer.disabled===true||authorizer.active===false||['disabled','suspended'].includes(String(authorizer.status)))throw Error('reception_confirmed_facts_authorizer_unavailable');
      return {contentHash:version.contentHash,revision:version.revision,documentUrls:(profile.products.items??[]).flatMap(product=>(product.documents??[]).flatMap(document=>document.url?[document.url]:[]))};
    },
    messaging:(tenantId,channel)=>readCustomerMessagingAuthorization(tenantId,channel,{dataStore,now:now()}),
    async ownerExists(tenantId, ownerId) {
      const owner = await dataStore.getById<Record<string, unknown>>('users', ownerId);
      return Boolean(owner && owner.tenantId === tenantId && organizationRoleOrNull(owner.role)
        && owner.disabled !== true && owner.active !== false && !['disabled','suspended'].includes(String(owner.status)));
    },
    probePublicUrl: createReceptionPublicUrlProbe(),
  });
}

/** Immutable explicit bindings: a changed requirement produces a new ID, never overwrites historical evidence. */
export async function savePublicationReceptionBinding(dataStore: DataStore, binding: ReceptionBinding, boundBy: string, now = new Date()) {
  if (!boundBy || !binding.tenantId || !binding.programId || !binding.packageId || !Number.isSafeInteger(binding.packageVersion) || binding.packageVersion <= 0 || !binding.publicationId || !binding.cta.trim() || !binding.enterpriseFactHash || !Number.isFinite(now.getTime())) throw Error('reception_binding_invalid');
  if (!validStoredBinding(binding)) throw Error('reception_targets_invalid');
  const bindingHash = identity(binding); const bindingId = bindingHash.slice(0, 15);
  const existing = await dataStore.getById<Row>(RECEPTION_BINDINGS, bindingId);
  if (existing) {
    if (existing.tenant_id !== binding.tenantId || !existing.payload || existing.binding_hash !== bindingHash || identity(existing.payload) !== bindingHash || !sameScope(existing.payload, binding)) throw Error('reception_binding_conflict');
    return { bindingId, bindingHash };
  }
  try {
    const created = await dataStore.create(RECEPTION_BINDINGS, { id: bindingId, tenant_id: binding.tenantId, program_id: binding.programId, package_id: binding.packageId, package_version: binding.packageVersion, publication_id: binding.publicationId, binding_hash: bindingHash, payload: binding, bound_by: boundBy, bound_at: now.toISOString() });
    if (!created) throw Error('reception_binding_write_failed');
  } catch (error) {
    const concurrent = await dataStore.getById<Row>(RECEPTION_BINDINGS, bindingId);
    if (!concurrent || concurrent.tenant_id !== binding.tenantId || !concurrent.payload || concurrent.binding_hash !== bindingHash || identity(concurrent.payload) !== bindingHash || !sameScope(concurrent.payload, binding)) throw error;
  }
  return { bindingId, bindingHash };
}

/** Rechecks live facts, personnel, channel and HTTP every invocation; persisted passes are never admission tokens. */
export async function checkPublicationReceptionAdmission(input: {
  dataStore: DataStore; scope: Scope; cta: string; bindingId?: string | null; required: boolean;
  ports?: ReceptionCheckPorts; now?: Date;
}) {
  if (!input.bindingId) return { status: input.required ? 'blocked' as const : 'legacy_unconfigured' as const, reason: input.required ? 'reception_binding_required' : 'legacy_contract_without_reception_requirement' };
  const row = await input.dataStore.getById<Row>(RECEPTION_BINDINGS, input.bindingId);
  if (!row || !validStoredBinding(row.payload) || typeof row.binding_hash !== 'string' || row.tenant_id !== input.scope.tenantId || !sameScope(row.payload, input.scope) || row.payload.cta !== input.cta || identity(row.payload) !== row.binding_hash || row.binding_hash.slice(0, 15) !== row.id) return { status: 'blocked' as const, reason: 'reception_binding_scope_mismatch' };
  const checked = await checkPublicationReception(row.payload, input.ports ?? productionReceptionPorts(input.dataStore,()=>input.now??new Date()), input.now ?? new Date());
  const checkId = randomUUID().replaceAll('-', '').slice(0, 15);
  const saved = await input.dataStore.create(RECEPTION_CHECKS, { id: checkId, tenant_id: input.scope.tenantId, program_id: input.scope.programId, package_id: input.scope.packageId, package_version: input.scope.packageVersion, publication_id: input.scope.publicationId, binding_id: row.id, binding_hash: checked.bindingHash, checked_at: checked.checkedAt, status: checked.status, payload: checked });
  if (!saved) throw Error('reception_check_write_failed');
  return { status: checked.status, checkId, checked, reason: checked.status === 'passed' ? '' : 'publication_reception_not_ready' };
}
