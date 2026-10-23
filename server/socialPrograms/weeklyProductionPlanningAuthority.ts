import type {BusinessContentGoal} from '../../shared/contracts/socialOperatingDecision.js';
import type {WeeklyAgentPlanningState,WeeklyOperatingPackage,VersionedSocialRef} from '../../shared/contracts/socialProgram.js';
import type {DataStore,Record_} from '../storage/datastore.js';
import {createSocialOperatingRepository} from '../socialOperating/repository.js';
import {readWeeklyExistingFactSource} from './weeklyExistingFactSource.js';
import {verifiedWeeklyPlanningTemplateAdoption} from './weeklyPlanningTemplateAdoption.js';
import {socialRequestHash} from '../starter198/socialContentValidation.js';
import {SocialProgramError} from './service.js';

export const WEEKLY_PRODUCTION_PLANNING_AUTHORITIES='social_weekly_production_planning_authorities';
const allowedDeferred=new Set(['conversion_route_required','sales_owner_required','account_required']);
function fail(code:string):never{throw new SocialProgramError(code,409,code);}
export interface WeeklyProductionPlanningAuthority {
 proofId:string;tenantId:string;programId:string;packageId:string;packageVersion:number;
 scope:'conditional_content_production_only';source:'automatic_template';templateVersion:'weekly-automation.v3';adoptedAt:string;userApproval:null;
 goalRef:VersionedSocialRef;goalHash:string;factSourceRef:VersionedSocialRef;factSourceHash:string;
 planningAdoptionHash:string;detailedScheduleHash:string;selectedSlotIds:string[];
 deferredOutboundBlockers:string[];notEvidenceOfMediaRights:true;notEvidenceOfBusinessProfileCompleteness:true;
 requiresPerStepRightsAndFacts:true;requiresOriginalCostLedger:true;perFilmIncludingRevisionsMaxCny:10;
 authorizesContentAcceptance:false;authorizesPublishing:false;authorizesCustomerMessages:false;
}
/** Do not project a blocked commercial goal into a ready one. The independent
 * decision only allows downstream executors to evaluate their own real facts,
 * media rights and costs. It never proves those downstream conditions true. */
export function buildWeeklyProductionPlanningAuthority(a:{tenantId:string;pkg:WeeklyOperatingPackage;planning:WeeklyAgentPlanningState;goal:BusinessContentGoal;factSourceRef:VersionedSocialRef;factSourceHash:string;now:string}):WeeklyProductionPlanningAuthority{
 const adoption=verifiedWeeklyPlanningTemplateAdoption(a.planning),codes=[...new Set(a.goal.blockers.map(b=>b.code))].sort();
 if(!adoption)return fail('weekly_production_planning_template_required');
 if(!adoption||!a.goal.publicFactRefs.length||!a.goal.products.length||!['ready','blocked'].includes(a.goal.status)||a.goal.status==='blocked'&&!codes.length||codes.some(code=>!allowedDeferred.has(code)))fail('weekly_production_planning_facts_or_goal_invalid');
 if(a.pkg.programId!==a.planning.programId||a.pkg.packageId!==a.planning.packageId||a.pkg.version!==a.planning.packageVersion||!a.planning.detailedSchedule||!Number.isFinite(Date.parse(a.now)))fail('weekly_production_planning_scope_invalid');
 const body={tenantId:a.tenantId,programId:a.pkg.programId,packageId:a.pkg.packageId,packageVersion:a.pkg.version,scope:'conditional_content_production_only' as const,source:'automatic_template' as const,templateVersion:'weekly-automation.v3' as const,adoptedAt:a.now,userApproval:null,goalRef:{type:'business_content_goal',id:a.goal.goalId,version:a.goal.version},goalHash:socialRequestHash(a.goal),factSourceRef:a.factSourceRef,factSourceHash:a.factSourceHash,planningAdoptionHash:adoption.recordHash,detailedScheduleHash:socialRequestHash(a.planning.detailedSchedule),selectedSlotIds:adoption.selectedSlotIds,deferredOutboundBlockers:codes,notEvidenceOfMediaRights:true as const,notEvidenceOfBusinessProfileCompleteness:true as const,requiresPerStepRightsAndFacts:true as const,requiresOriginalCostLedger:true as const,perFilmIncludingRevisionsMaxCny:10 as const,authorizesContentAcceptance:false as const,authorizesPublishing:false as const,authorizesCustomerMessages:false as const};
 return {...body,proofId:socialRequestHash(body)};
}
export async function persistWeeklyProductionPlanningAuthority(store:DataStore,proof:WeeklyProductionPlanningAuthority){
 const {proofId,...body}=proof;if(proofId!==socialRequestHash(body))fail('weekly_production_planning_proof_invalid');
 const old=await store.getById<Record_>(WEEKLY_PRODUCTION_PLANNING_AUTHORITIES,proofId);
 if(old){if(old.content_hash!==socialRequestHash(proof)||socialRequestHash(old.payload)!==socialRequestHash(proof))fail('weekly_production_planning_proof_conflict');return proof;}
 if(!await store.create(WEEKLY_PRODUCTION_PLANNING_AUTHORITIES,{id:proofId,tenant_id:proof.tenantId,program_id:proof.programId,package_id:proof.packageId,package_version:proof.packageVersion,payload:proof,content_hash:socialRequestHash(proof)}))fail('weekly_production_planning_proof_write_failed');
 return proof;
}
/** Caller uses a stored ref from the automatic execution intent, never UI data. */
export async function readWeeklyProductionPlanningAuthority(store:DataStore,a:{tenantId:string;pkg:WeeklyOperatingPackage;planning:WeeklyAgentPlanningState;proofId:string}){
 const row=await store.getById<Record_>(WEEKLY_PRODUCTION_PLANNING_AUTHORITIES,a.proofId),proof=row?.payload as WeeklyProductionPlanningAuthority|undefined;
 if(!row||!proof||row.content_hash!==socialRequestHash(proof)||proof.proofId!==a.proofId||row.tenant_id!==a.tenantId||proof.tenantId!==a.tenantId||proof.programId!==a.pkg.programId||proof.packageId!==a.pkg.packageId||proof.packageVersion!==a.pkg.version)return null;
 const {proofId,...body}=proof;if(proofId!==socialRequestHash(body))return null;
 const source=await readWeeklyExistingFactSource(store,a.tenantId),goal=await createSocialOperatingRepository(store).getGoal(a.tenantId,a.pkg.programId,proof.goalRef.id,proof.goalRef.version);
 if(!goal||source.sourceHash!==proof.factSourceHash||socialRequestHash(source.ref)!==socialRequestHash(proof.factSourceRef))return null;
 const actual=buildWeeklyProductionPlanningAuthority({tenantId:a.tenantId,pkg:a.pkg,planning:a.planning,goal,factSourceRef:source.ref,factSourceHash:source.sourceHash,now:proof.adoptedAt});
 return socialRequestHash(actual)===socialRequestHash(proof)?{proof,goal}:null;
}
