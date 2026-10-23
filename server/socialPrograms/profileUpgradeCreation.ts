import type {DataStore,Record_} from '../storage/datastore.js';
import type {WeeklyOperatingPackage} from '../../shared/contracts/socialProgram.js';
import type {WeeklyProfileUpgradeScope} from '../../shared/contracts/weeklyProfileUpgrade.js';
import {SocialProgramError} from './service.js';
import {socialRequestHash} from '../starter198/socialContentValidation.js';
import {createWeeklyProfileUpgradeService} from './weeklyProfileUpgrade.js';
import {publicationInstant} from './publicationDeadlines.js';
export type ProfileUpgradeConsumption=NonNullable<WeeklyOperatingPackage['profileUpgradeConsumption']>;
export function profileUpgradePublicationHash(pkg:WeeklyOperatingPackage){return socialRequestHash(pkg.socialContentPackage.publicationTasks.map(({status:ignored,...p})=>p));}
export function profileUpgradeTargetHash(p:WeeklyOperatingPackage){return socialRequestHash({weekStart:p.weekStart,weekEnd:p.weekEnd,objective:p.objective,successCriteria:p.successCriteria,enterpriseProfileRef:p.enterpriseProfileRef,businessContentGoalRef:p.businessContentGoalRef,monthlyPlanRef:p.monthlyPlanRef,capacityPlanRef:p.capacityPlanRef,automationPolicyRef:p.automationPolicyRef,operatingDecisionSnapshotRef:p.operatingDecisionSnapshotRef,referenceModeRef:p.referenceModeRef,referenceSourcePolicy:p.referenceSourcePolicy,promotionQuotaRef:p.promotionQuotaRef,discoveryBudgetCny:p.discoveryBudgetCny,publicationInputHash:profileUpgradePublicationHash(p),originalContentTarget:p.socialContentPackage.originalContentTarget,weeklyBudgetCny:p.socialContentPackage.weeklyBudgetCny,perItemBudgetCny:p.socialContentPackage.perItemBudgetCny});}
export function assertProfileUpgradeCreationInput(input:Record<string,unknown>){
 if(typeof input.profileUpgradeCreationRequestId!=='string'||!/^[a-zA-Z0-9_-]{16,160}$/.test(input.profileUpgradeCreationRequestId))throw new SocialProgramError('profile_upgrade_creation_request_required',400,'新周创建需要稳定的请求身份。');
 if(typeof input.profileUpgradeTimeZone!=='string')throw new SocialProgramError('profile_upgrade_creation_timezone_required',400,'请选择下一周发布时间所用时区。');
 try{new Intl.DateTimeFormat('en',{timeZone:input.profileUpgradeTimeZone}).format();}catch{throw new SocialProgramError('profile_upgrade_creation_timezone_invalid',400,'发布时间时区无效。');}
 if(!Array.isArray(input.publicationTasks)||!input.publicationTasks.length)throw new SocialProgramError('profile_upgrade_new_publications_required',400,'请明确下一周每条视频的新发布目标与日期。');
 if(typeof input.weekStart!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(input.weekStart)||!Number.isFinite(Date.parse(`${input.weekStart}T00:00:00Z`))||new Date(`${input.weekStart}T00:00:00Z`).toISOString().slice(0,10)!==input.weekStart)throw new SocialProgramError('profile_upgrade_target_week_invalid',400,'下一周日期无效。');
 for(const p of input.publicationTasks){
  if(!p||typeof p!=='object'||Array.isArray(p))throw new SocialProgramError('profile_upgrade_publication_invalid',400,'发布目标必须是对象。');
  if(['publicationTaskId','motherContentId','adaptationOfPublicationTaskId','inventoryReuseRef','contentTemplateBindingRef','customerFeedbackTopicRef','materialRequirement','receptionRequirement'].some(k=>Object.hasOwn(p,k)))throw new SocialProgramError('profile_upgrade_old_publication_identity_forbidden',400,'下一周必须生成新的目标身份；旧周绑定不能复制。');
  if(typeof (p as Record<string,unknown>).accountId!=='string'||!(p as Record<string,unknown>).accountId)throw new SocialProgramError('profile_upgrade_publication_account_required',400,'每条新发布目标必须明确真实账号。');
  assertProfileUpgradePublicationWindow((p as Record<string,unknown>).publishWindow,String(input.weekStart),input.profileUpgradeTimeZone);
 }
}
export function assertProfileUpgradePublicationWindow(value:unknown,week:string,timeZone:string){
 const instant=typeof value==='string'?publicationInstant(value):null;if(instant===null)throw new SocialProgramError('profile_upgrade_publication_time_required',400,'每条新发布目标需要明确时区的具体时间。');
 const parts=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(instant)),part=(type:string)=>parts.find(p=>p.type===type)?.value;
 const date=`${part('year')}-${part('month')}-${part('day')}`,end=new Date(Date.parse(`${week}T00:00:00Z`)+6*86400000).toISOString().slice(0,10);
 if(date<week||date>end)throw new SocialProgramError('profile_upgrade_old_publication_date_forbidden',400,'新发布目标必须位于下一周所选时区的周一至周日。');
}
export async function findProfileUpgradeCreation(store:DataStore,a:WeeklyProfileUpgradeScope,who:string,upgradeId:string,creationRequestId:string):Promise<WeeklyOperatingPackage|null>{
 const upgrade=await createWeeklyProfileUpgradeService(store).get(a,who,upgradeId);if(!upgrade.confirmedBy||!upgrade.confirmedAt)throw new SocialProgramError('profile_upgrade_confirmation_required',409,'建议尚未确认。');
 const matches:WeeklyOperatingPackage[]=[],ids=new Set<string>();let total:number|null=null,count=0;
 for(let page=1;page<=1000;page++){
  const r=await store.list<Record_>('social_weekly_operating_packages',{where:{tenant_id:a.tenantId,program_id:a.programId,version:1},page,perPage:200,sort:'id'});
  if(total!==null&&total!==r.totalItems)throw new SocialProgramError('profile_upgrade_creation_scan_changed',409,'查回期间任务包发生变化。');total=r.totalItems;
  for(const row of r.items){if(ids.has(row.id))throw new SocialProgramError('profile_upgrade_creation_scan_changed',409,'创建记录重复。');ids.add(row.id);count++;let p:WeeklyOperatingPackage;try{p=(typeof row.payload==='string'?JSON.parse(row.payload):row.payload) as WeeklyOperatingPackage;}catch{throw new SocialProgramError('profile_upgrade_creation_payload_invalid',409,'创建记录损坏。');}const c=p?.profileUpgradeConsumption;if(!c||c.creationRequestId!==creationRequestId)continue;
   const {recordHash,...body}=c;
   if(c.schemaVersion!=='weekly-profile-upgrade-consumption.v1'||socialRequestHash(body)!==recordHash||c.createdBy!==who||c.upgradeId!==upgradeId||c.sourcePackageId!==a.packageId||c.sourcePackageVersion!==a.packageVersion||c.confirmationHash!==socialRequestHash(upgrade)||c.evidenceHash!==upgrade.evidenceHash||c.confirmedBy!==upgrade.confirmedBy||c.confirmedAt!==upgrade.confirmedAt||c.targetPackageId!==p.packageId||c.targetPackageVersion!==1||p.version!==1||p.createdBy!==c.createdBy||p.createdAt!==c.createdAt||socialRequestHash(p.referenceSourcePolicy)!==socialRequestHash(upgrade.policy)||p.programId!==a.programId||row.package_id!==p.packageId||c.targetWeekStart!==p.weekStart||p.weekStart!==upgrade.targetWeekStart||c.targetInputHash!==profileUpgradeTargetHash(p)||c.publicationInputHash!==profileUpgradePublicationHash(p)||socialRequestHash(c.publicationTaskIds)!==socialRequestHash(p.socialContentPackage.publicationTasks.map(x=>x.publicationTaskId)))throw new SocialProgramError('profile_upgrade_creation_receipt_invalid',409,'实际创建记录与原升级意图不一致。');
   matches.push(p);
  }
  if(count===total){if(matches.length>1)throw new SocialProgramError('profile_upgrade_creation_ambiguous',409,'同一请求存在多个任务包。');return matches[0]??null;}
  if(!r.items.length||count>total!)throw new SocialProgramError('profile_upgrade_creation_scan_incomplete',409,'创建记录查回不完整。');
 }
 throw new SocialProgramError('profile_upgrade_creation_scan_limit',409,'创建记录超出安全查回范围。');
}
