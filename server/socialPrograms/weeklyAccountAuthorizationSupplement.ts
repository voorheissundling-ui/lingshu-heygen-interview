import type {DataStore,Record_} from '../storage/datastore.js';
import type {VersionedSocialRef} from '../../shared/contracts/socialProgram.js';
import {socialAccessToken,youtubeCredentials} from '../lib/accountCredentials.js';
import {platformCapabilityDecision,platformCapabilityEvidenceIsCurrent,PLATFORM_CAPABILITY_EVIDENCE_COLLECTION,type RuntimeSocialPlatform,type PlatformCapabilityEvidence} from '../publishing/platformCapabilities.js';
import {socialRequestHash} from '../starter198/socialContentValidation.js';
import {SocialProgramError} from './service.js';
import {ACCOUNT_AUTHORIZATION_SUPPLEMENT_GAPS} from '../../shared/contracts/weeklySupplementRequests.js';
export const ACCOUNT_AUTHORIZATION_GAP_CODES=ACCOUNT_AUTHORIZATION_SUPPLEMENT_GAPS;
/** Read-only counterpart of the official publishing gate. Configuration or opaque token presence is never proof. */
export async function checkWeeklyAccountAuthorizationSupplement(input:{store:DataStore;tenantId:string;accountId:string;platform:string;ref?:VersionedSocialRef;now?:Date}){
 if(!['youtube','facebook','instagram','tiktok','linkedin'].includes(input.platform))throw new SocialProgramError('supplement_account_platform_unsupported',409,'该平台没有可复用的实际授权验证端口。');
 const platform=input.platform as RuntimeSocialPlatform,collection=platform==='youtube'?'youtube_accounts':'social_accounts';let sourceHash=socialRequestHash({tenantId:input.tenantId,accountId:input.accountId,platform,collection});
 if(input.ref&&(input.ref.type!=='publishing_account_identity'||input.ref.version!==1||input.ref.id!==input.accountId))throw new SocialProgramError('supplement_submission_scope_invalid',409,'提交引用必须对应冻结账号身份。');
 const unavailable=(rawCode:string)=>({ready:false,code:ACCOUNT_AUTHORIZATION_GAP_CODES.has(rawCode)?rawCode:'provider_probe_failed',sourceHash,evidenceRef:null as VersionedSocialRef|null});
 const account=await input.store.getById<Record_>(collection,input.accountId);if(!account||account.tenantId!==input.tenantId||platform!=='youtube'&&account.platform!==platform){if(input.ref)throw new SocialProgramError('supplement_submission_source_missing',409,'当前冻结账号缺少同租户同平台的实际连接记录。');return unavailable(`${platform}_account_not_found`);}
 sourceHash=socialRequestHash({tenantId:input.tenantId,accountId:input.accountId,platform,collection,providerIdentity:platform==='youtube'?account.channelId??null:account.providerAccountId??null});
 // Instagram Login has no registered official publishing executor yet. Legacy
 // Meta scopes/probes must not authorize a provider with different OAuth semantics.
 if(platform==='instagram'&&account.oauthProvider==='instagram_login')return unavailable('provider_capability_not_verified');
 if(account.status!=='connected')return unavailable(`${platform}_account_not_connected`);
 try{if(platform==='youtube')youtubeCredentials(account);else socialAccessToken(account);}catch{return unavailable(`${platform}_credential_unavailable`);}
 const providerId=platform==='youtube'?account.channelId:account.providerAccountId;if(typeof providerId!=='string'||!providerId.trim())return unavailable('provider_account_mismatch');const requiredScope=platform==='facebook'?'pages_manage_posts':platform==='instagram'?'instagram_content_publish':platform==='tiktok'?'video.publish':platform==='linkedin'?(String(account.parentPageId??'').startsWith('urn:li:organization:')?'w_organization_social':'w_member_social'):null;if(requiredScope&&!String(account.scope??'').split(/[\s,]+/).includes(requiredScope))return unavailable('provider_publish_scope_missing');const now=input.now??new Date(),decision=await platformCapabilityDecision({tenantId:input.tenantId,accountId:input.accountId,platform,capability:'publishing.official',dataStore:input.store,now});if(decision.status!=='available'||!decision.evidenceRef||!decision.verifiedAt)return unavailable(decision.reason||'provider_capability_not_verified');
 if(decision.evidenceRef!==`provider:${platform}:account:${providerId}`)return unavailable('provider_account_mismatch');const rows=await input.store.list<PlatformCapabilityEvidence>(PLATFORM_CAPABILITY_EVIDENCE_COLLECTION,{where:{tenant_id:input.tenantId,account_id:input.accountId,platform,capability:'publishing.official',evidence_ref:decision.evidenceRef,verified_at:decision.verifiedAt},perPage:2});if(rows.totalItems!==1||rows.items.length!==1||!platformCapabilityEvidenceIsCurrent(rows.items[0]!,now))return unavailable('capability_evidence_ambiguous');
 return{ready:true,code:'',sourceHash,evidenceRef:{type:'platform_capability_evidence',id:rows.items[0]!.id,version:1} as VersionedSocialRef};
}
