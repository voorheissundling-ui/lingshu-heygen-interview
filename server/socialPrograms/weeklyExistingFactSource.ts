import type {DataStore,Record_} from '../storage/datastore.js';
import {verifyEnterpriseFactContent,type EnterpriseProfile} from '../routes/enterprise.js';
import {readWeeklyReviewActor} from './weeklyReviewEvidence.js';
import {socialJson,socialObject} from '../starter198/socialContentValidation.js';
import {SocialProgramError} from './service.js';
import {organizationRoleOrNull} from '../lib/organizationRole.js';

/** Never use the profile fallback reader: it can synthesize legacy versions.
 * This binds an already saved, member-confirmed source, not a new business claim. */
export async function readWeeklyExistingFactSource(store:DataStore,tenantId:string){
 const rows=await store.list<Record_>('tenant_profiles',{where:{tenant_id:tenantId},perPage:2});
 const row=rows.items[0],profile=socialObject(socialJson(row?.profile)) as unknown as EnterpriseProfile;
 const version=profile?.factVersion;
 const fail=():never=>{throw new SocialProgramError('weekly_existing_facts_unverified',409,'已有企业及产品资料缺少可信版本或确认记录，请在企业知识库补充；不会自动确认未知资料。');};
 if(rows.totalItems!==1||rows.items.length!==1||row?.tenant_id!==tenantId||!version||!version.id||!Number.isSafeInteger(version.revision)||version.revision<1||!version.confirmedBy||['system','legacy_migration'].includes(version.confirmedBy)||!Number.isFinite(Date.parse(version.confirmedAt))||Date.parse(version.confirmedAt)>Date.now())return fail();
 const contentVerification=verifyEnterpriseFactContent(profile);
 if(!contentVerification.verified)throw new SocialProgramError('weekly_existing_facts_hash_changed',409,'已有企业及产品资料与保存的事实版本不一致，暂未绑定；请在企业知识库核对后保存，不会清空已有产品。');
 const actor=await readWeeklyReviewActor(store,tenantId,version.confirmedBy);
 if(!actor||actor.tenantId!==tenantId||actor.disabled===true||actor.active===false||['disabled','suspended'].includes(String(actor.status))||!organizationRoleOrNull(actor.role))return fail();
 if(!profile.company?.name?.trim()||!profile.products?.categories?.trim()&&!profile.products?.items?.some(p=>p.name?.trim()))return fail();
 return {ref:{type:'enterprise_fact' as const,id:version.id,version:version.revision},sourceHash:version.contentHash,confirmedBy:version.confirmedBy,confirmedAt:version.confirmedAt,productIds:(profile.products?.items??[]).filter(p=>p.name?.trim()).map(p=>p.id),contentVerification};
}
