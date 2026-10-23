import type {DataStore,Record_} from '../storage/datastore.js';
import type {WeeklyTargetAccountPlaybook} from '../../shared/contracts/socialProgram.js';
import {socialObject,socialJson,socialRequestHash,SocialContentWorkflowError} from '../starter198/socialContentValidation.js';
const obj=(value:unknown)=>socialObject(socialJson(value));
function invalid():never {throw new SocialContentWorkflowError('weekly_target_playbook_changed',409);}
/** Missing rules remain missing. This never creates, activates, or selects a latest rule. */
export async function freezeWeeklyTargetAccountPlaybook(store:DataStore,tenantId:string,programId:string,accountId:string):Promise<WeeklyTargetAccountPlaybook|null>{
 const accounts=await store.list<Record_>('social_owned_accounts',{where:{tenant_id:tenantId,program_id:programId,account_id:accountId},perPage:2});
 if(accounts.totalItems===0&&accounts.items.length===0)return null;
 if(accounts.totalItems!==1||accounts.items.length!==1)return invalid();
 const row=accounts.items[0]!,account=obj(row.payload),ref=obj(account?.playbookRef);
 if(!ref)return null;
 if(row.tenant_id!==tenantId||row.program_id!==programId||row.account_id!==accountId||account?.accountId!==accountId||account.programId!==programId||typeof account.version!=='number'||!Number.isSafeInteger(account.version)||Number(account.version)<1)return invalid();
 if(ref.type!=='account_playbook'||typeof ref.id!=='string'||typeof ref.version!=='number'||!Number.isSafeInteger(ref.version)||Number(ref.version)<1)return invalid();
 const rules=await store.list<Record_>('social_playbook_versions',{where:{tenant_id:tenantId,program_id:programId,account_id:accountId,playbook_id:ref.id,version:ref.version},perPage:2});
 const rule=rules.items[0],payload=obj(rule?.payload);
 if(rules.totalItems!==1||rules.items.length!==1||!rule||rule.tenant_id!==tenantId||rule.program_id!==programId||rule.account_id!==accountId||rule.status!=='active'||payload?.status!=='active'||payload.playbookId!==ref.id||payload.version!==ref.version||payload.accountId!==accountId||payload.programId!==programId)return invalid();
 return {accountId,accountRef:{type:'owned_social_account',id:accountId,version:Number(account.version)},playbookRef:{type:'account_playbook',id:ref.id,version:Number(ref.version)},playbookHash:socialRequestHash(payload)};
}
export async function verifyWeeklyTargetAccountPlaybook(store:DataStore,tenantId:string,programId:string,frozen:WeeklyTargetAccountPlaybook):Promise<WeeklyTargetAccountPlaybook>{
 const actual=await freezeWeeklyTargetAccountPlaybook(store,tenantId,programId,frozen.accountId);
 if(!actual||socialRequestHash(actual)!==socialRequestHash(frozen))return invalid();
 return actual;
}

export async function verifyWeeklyPlanningPlaybooks(store:DataStore,tenantId:string,programId:string,analyses:Array<{targetAccountPlaybooks?:WeeklyTargetAccountPlaybook[]}>):Promise<void>{
 for(const analysis of analyses){const items=analysis.targetAccountPlaybooks??[];if(new Set(items.map(value=>value.accountId)).size!==items.length)return invalid();await Promise.all(items.map(value=>verifyWeeklyTargetAccountPlaybook(store,tenantId,programId,value)));}
}
