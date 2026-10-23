import {createHash} from 'node:crypto';
import type {DataStore,Record_} from '../storage/datastore.js';
import {WEEKLY_AUTOMATION_TEMPLATE} from '../../shared/weeklyAutomationTemplate.js';
import type {ExecutionPackageScope} from './weeklyExecutionGate.js';
import {SocialProgramError} from './service.js';
import {socialRequestHash} from '../starter198/socialContentValidation.js';
export const WEEKLY_TEMPLATE_ADOPTIONS='social_weekly_template_adoptions';
const legacyId=(s:ExecutionPackageScope,version=WEEKLY_AUTOMATION_TEMPLATE.version)=>createHash('sha256').update(JSON.stringify([s.tenantId,s.programId,s.packageId,s.packageVersion,version])).digest('hex');
// Existing local receipts used the full digest. New records use the same
// deterministic identity narrowed to PocketBase's 15-character primary key.
const id=(s:ExecutionPackageScope,version=WEEKLY_AUTOMATION_TEMPLATE.version)=>legacyId(s,version).slice(0,15);
// Keep the accepted v3 contract immutable. A later default-template change
// must not retroactively invalidate this historical adoption or its CTA.
const ACCEPTED_TEMPLATE_V3=Object.freeze({
 version:'weekly-automation.v3',originalVideosPerWeek:5,
 sharedPublicationPlatforms:['youtube','tiktok','instagram','facebook'],
 productionConcurrency:3,weekdayOriginalVideosPerDay:1,
 weekendMode:'distribution_and_recovery',mondayAction:'weekly_goal_confirmation',
 sundayActions:['weekly_goal_acceptance','weekly_data_review'],
 perFinishedVideoMaxCny:10,callToAction:'Contact us on WhatsApp to get your free sample.',
 searchTermCount:5,dailyCollectionLimit:10,collectionBudgetLimitCny:null,
 ordinaryTaskStart:'06:00',residentStart:'00:00',residentEnd:'next_day_00:00',
 timeZone:'Asia/Shanghai',outboundAuthorization:false,
});
const acceptedTemplate=(version:string)=>version===ACCEPTED_TEMPLATE_V3.version?ACCEPTED_TEMPLATE_V3:null;
export async function readWeeklyAutomationTemplate(store:DataStore,s:ExecutionPackageScope){
 const matches=await store.list<Record_>(WEEKLY_TEMPLATE_ADOPTIONS,{where:{tenant_id:s.tenantId,program_id:s.programId,package_id:s.packageId,package_version:s.packageVersion},perPage:2});
 if(matches.totalItems>1)throw new SocialProgramError('weekly_template_adoption_invalid',409,'同一周包版本存在多个模板采用记录。');
 const row=matches.items[0];if(!row)return null;
 const p=row.payload as {scope:ExecutionPackageScope;template:typeof WEEKLY_AUTOMATION_TEMPLATE;adoptedAt:string;source:string;actorUserId:string;userApproval:null};
 const scope={tenantId:s.tenantId,programId:s.programId,packageId:s.packageId,packageVersion:s.packageVersion};
 if(!p||![id(s,p.template?.version),legacyId(s,p.template?.version)].includes(row.id)||row.tenant_id!==s.tenantId||row.program_id!==s.programId||row.package_id!==s.packageId||row.package_version!==s.packageVersion||socialRequestHash(p.scope)!==socialRequestHash(scope)||!acceptedTemplate(p.template?.version)||socialRequestHash(p.template)!==socialRequestHash(acceptedTemplate(p.template.version))||p.source!=='automatic_template'||typeof p.actorUserId!=='string'||!p.actorUserId.trim()||p.userApproval!==null||!Number.isFinite(Date.parse(p.adoptedAt)))throw new SocialProgramError('weekly_template_adoption_invalid',409,'默认模板留痕无效，未继续执行。');
 return p;
}
/** Caller holds authenticated, current-version package gate. No approvals granted. */
export async function adoptWeeklyAutomationTemplate(store:DataStore,s:ExecutionPackageScope,actorUserId:string){
 const old=await readWeeklyAutomationTemplate(store,s);if(old)return old;
 const scope={tenantId:s.tenantId,programId:s.programId,packageId:s.packageId,packageVersion:s.packageVersion};
 const payload={scope,template:WEEKLY_AUTOMATION_TEMPLATE,source:'automatic_template',adoptedAt:new Date().toISOString(),actorUserId,userApproval:null};
 if(!await store.create(WEEKLY_TEMPLATE_ADOPTIONS,{id:id(s),tenant_id:s.tenantId,program_id:s.programId,package_id:s.packageId,package_version:s.packageVersion,payload}))throw new SocialProgramError('weekly_template_adoption_write_failed',503,'默认模板未能留痕。');
 return payload;
}
