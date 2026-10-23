import {createHash} from 'node:crypto';
import type {DataStore,Record_} from '../storage/datastore.js';
import type {ExecutionPackageScope} from './weeklyExecutionGate.js';
import {readWeeklyReviewActor} from './weeklyReviewEvidence.js';
import {SocialProgramError} from './service.js';
import {executionPackageFrozen} from './weeklyExecutionGate.js';

export const WEEKLY_INDEPENDENT_ADMISSIONS='social_weekly_independent_admissions';
export const independentAdmissionId=(s:ExecutionPackageScope)=>createHash('sha256').update(JSON.stringify([s.tenantId,s.programId,s.packageId,s.packageVersion])).digest('hex');
export interface IndependentAdmission {tenantId:string;programId:string;packageId:string;packageVersion:number;actorUserId:string;admittedAt:string;mode:'independent_branches';authorizePublishing:false;authorizeMessaging:false;}
/** Execution opt-in is not goal/schedule approval. Never copied to a new revision. */
export async function readIndependentAdmission(store:DataStore,s:ExecutionPackageScope):Promise<IndependentAdmission|null>{
 const row=await store.getById<Record_>(WEEKLY_INDEPENDENT_ADMISSIONS,independentAdmissionId(s));if(!row)return null;
 const p=row.payload as IndependentAdmission;
 if(!p||row.tenant_id!==s.tenantId||row.program_id!==s.programId||row.package_id!==s.packageId||row.package_version!==s.packageVersion||p.tenantId!==s.tenantId||p.programId!==s.programId||p.packageId!==s.packageId||p.packageVersion!==s.packageVersion||p.mode!=='independent_branches'||p.authorizePublishing!==false||p.authorizeMessaging!==false||!Number.isFinite(Date.parse(p.admittedAt)))throw new SocialProgramError('weekly_independent_admission_invalid',409,'独立分支启用记录无效。');
 const actor=await readWeeklyReviewActor(store,s.tenantId,p.actorUserId);
 if(!actor||actor.tenantId!==s.tenantId||actor.disabled===true||actor.active===false||['disabled','suspended'].includes(String(actor.status))||!['admin','super_admin','social_operator'].includes(String(actor.role)))return null;
 const latest=await store.list<Record_>('social_weekly_operating_packages',{where:{tenant_id:s.tenantId,program_id:s.programId,package_id:s.packageId},sort:'-version',perPage:1});
 const pkg=latest.items[0]?.payload as {version?:number;status?:string}|undefined;
 if(pkg?.version!==s.packageVersion||!['draft','active'].includes(String(pkg.status))||await executionPackageFrozen(store,s))return null;
 return p;
}
