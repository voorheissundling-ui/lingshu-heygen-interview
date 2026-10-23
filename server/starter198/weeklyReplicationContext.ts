import {normalizedReferenceIdentity} from './socialContentScriptSources.js';
import type {DataStore,Record_} from '../storage/datastore.js';
import type {WeeklyOperatingPackage} from '../../shared/contracts/socialProgram.js';
import type {SocialReplicationJobContext} from '../../shared/contracts/socialContentReplication.js';
import {socialObject,socialJson,socialRequestHash,SocialContentWorkflowError} from './socialContentValidation.js';
import {verifyWeeklyTargetAccountPlaybook} from '../socialPrograms/weeklyTargetAccountPlaybook.js';
import {readWeeklyReferenceSources} from '../runtime/socialWeeklyReferenceSource.js';
import {listCompleteSocialDiscoverySupply} from '../socialDiscovery/supply.js';
import {resolveWeeklyCreativeRepairAuthority} from '../runtime/weeklyCreativeRepairAuthority.js';
const obj=(v:unknown)=>socialObject(socialJson(v));
function fail():never{throw new SocialContentWorkflowError('weekly_replication_context_changed',409);}
/** References retain their actual persisted object types. No fabricated snapshots or latest playbooks. */
export async function readWeeklyReplicationContext(input:{store:DataStore;tenantId:string;task:Record<string,unknown>;sources:Array<{kind:string;status:string;sourceRef:string;sourceVersion:string|null;sourceId?:string}>}):Promise<SocialReplicationJobContext|undefined>{
 let authority=obj(obj(input.task.brief)?._weeklyAuthority),creativeBinding:string|null=null;
 const creative=String(input.task.create_idempotency_key??'').startsWith('weekly-creative-repair:')||Boolean(obj(input.task.brief)?._weeklyCreativeRepairProof);
 if(creative){const resolved=await resolveWeeklyCreativeRepairAuthority({store:input.store,tenantId:input.tenantId,task:input.task});if(!resolved)return fail();authority=resolved.authority;creativeBinding=resolved.bindingKey;}
 if(!authority)return undefined;
 const frozen=authority.weeklyPackage as WeeklyOperatingPackage|undefined,pub=obj(authority.publicationTask);
 if(!frozen||typeof frozen.packageId!=='string'||typeof frozen.programId!=='string'||!Number.isSafeInteger(frozen.version)||!pub||typeof pub.publicationTaskId!=='string'||input.task.tenant_id!==input.tenantId||input.task.create_idempotency_key!==(creative?creativeBinding:`weekly-production:${frozen.packageId}:${frozen.version}:${pub.publicationTaskId}`))return fail();
 const rows=await input.store.list<Record_>('social_weekly_operating_packages',{where:{tenant_id:input.tenantId,program_id:frozen.programId,package_id:frozen.packageId,version:frozen.version},perPage:2});
 const pkg=obj(rows.items[0]?.payload) as WeeklyOperatingPackage|null;
 if(rows.totalItems!==1||rows.items.length!==1||!pkg||pkg.packageId!==frozen.packageId||pkg.programId!==frozen.programId||pkg.version!==frozen.version)return fail();
 const matches=pkg.agentPlanning?.dispatch?.scheduleItems.filter(item=>item.publicationTaskId===pub.publicationTaskId)??[],item=matches[0];
 const frozenItems=frozen.agentPlanning?.dispatch?.scheduleItems.filter(value=>value.publicationTaskId===pub.publicationTaskId)??[];
 if(matches.length!==1||frozenItems.length!==1||!item||socialRequestHash(item)!==socialRequestHash(frozenItems[0])||item.accountId!==pub.accountId)return fail();
 const analyses=pkg.agentPlanning?.directorAnalyses.filter(value=>value.analysisId===item.directorAnalysisRef.id)??[],analysis=analyses[0];
 if(analyses.length!==1||!analysis||item.directorAnalysisRef.type!=='weekly_director_analysis'||item.directorAnalysisRef.version!==1||analysis.packageId!==pkg.packageId||analysis.packageVersion!==pkg.version)return fail();
 const records=await readWeeklyReferenceSources(input.store,input.tenantId,authority,analysis);
 const active=input.sources.filter(source=>source.kind==='reference_link'&&source.status==='active');
 // Authority is persisted before addSource. An unbound pre-run task has no verified replication context yet.
 if(active.length===0&&!input.task.run_id)return undefined;
 if(records.length!==1||active.length!==1||records[0]!.sourceRef!==active[0]!.sourceRef||records[0]!.sourceVersion!==active[0]!.sourceVersion)return fail();
 const record=records[0]!.record,refs=analysis.frozenHandoffRefs?.filter(ref=>ref.inspirationId===record.id)??[],handoffRef=refs[0];
 if(refs.length!==1||!handoffRef)return fail();
 const handoffs=await input.store.list<Record_>('starter_social_inspiration_handoff_versions',{where:{tenant_id:input.tenantId,record_hash:handoffRef.recordHash},perPage:2});
 const handoff=obj(handoffs.items[0]?.payload);
 if(handoffs.totalItems!==1||handoffs.items.length!==1||!handoff||handoff.inspirationId!==record.id||String(handoff.version??handoff.analysisVersion)!==handoffRef.version||socialRequestHash(handoff)!==handoffRef.recordHash||obj(handoff.source)?.sourceUrl!==record.sourceUrl)return fail();
 const accountRefs=analysis.benchmarkAccountRefs;
 if(accountRefs.length!==1)return fail();
 const accountRef=accountRefs[0]!;
 if(accountRef.type==='owned_social_account'){
  const owned=await input.store.list<Record_>('social_owned_accounts',{where:{tenant_id:input.tenantId,program_id:pkg.programId,account_id:accountRef.id},perPage:2});
  const account=obj(owned.items[0]?.payload);
  if(owned.totalItems!==1||owned.items.length!==1||account?.accountId!==accountRef.id||account.programId!==pkg.programId||account.version!==accountRef.version)return fail();
 }else if(accountRef.type==='social_benchmark_account'){
  const supply=await listCompleteSocialDiscoverySupply({tenantId:input.tenantId,dataStore:input.store,filters:{candidateType:'account',decision:'accepted',businessModel:'b2b',sort:'score'}});
  if(supply.items.filter(value=>value.candidateId===accountRef.id&&value.evidenceVersion===accountRef.version).length!==1)return fail();
 }else return fail();
 const programRef=obj(authority.programRef),programs=await input.store.list<Record_>('social_programs',{where:{tenant_id:input.tenantId,program_id:pkg.programId},perPage:2});
 const program=obj(programs.items[0]?.payload);if(programs.totalItems!==1||programs.items.length!==1||programRef?.type!=='social_program'||programRef.id!==pkg.programId||programRef.version!==program?.version)return fail();
 const context:SocialReplicationJobContext={programRef:{objectType:'social_program',id:pkg.programId,version:String(programRef.version)},benchmarkAccountSnapshotRef:{objectType:accountRef.type,id:accountRef.id,version:String(accountRef.version)},referenceContentAnalysisRef:{objectType:'social_inspiration_handoff',id:handoffRef.inspirationId,version:handoffRef.version}};
 const currentAnalysis=obj(input.task.reference_video_analysis),sourceAnalysis=obj(records[0]!.resolvedRecord.aiAnalysis);
 if(handoff.referenceRole==='primary_structure'&&typeof handoff.analysisId==='string'&&handoff.analysisId&&typeof handoff.analysisVersion==='string'&&currentAnalysis?.status==='ready'&&currentAnalysis.referenceRecordId===record.id&&currentAnalysis.referenceSourceId===active[0]!.sourceId&&typeof currentAnalysis.analysisId==='string'&&typeof currentAnalysis.version==='string'&&obj(currentAnalysis.coverage)?.fullTimelineCovered===true&&typeof sourceAnalysis?.contentSha256==='string'&&/^[a-f0-9]{64}$/.test(sourceAnalysis.contentSha256)&&typeof sourceAnalysis.analysisRunId==='string'){
  const expectedVersion=socialRequestHash({recordId:record.id,analysis:records[0]!.resolvedRecord.aiAnalysis,shotReview:records[0]!.resolvedRecord.referenceShotReview,verifiedSpeech:records[0]!.resolvedRecord.referenceVerifiedSpeech}).slice(0,12);
  const expectedId=`reference-analysis-${socialRequestHash({sourceId:active[0]!.sourceId,sourceRef:normalizedReferenceIdentity(active[0]!.sourceRef),recordId:record.id,analysis:records[0]!.resolvedRecord.aiAnalysis,shotReview:records[0]!.resolvedRecord.referenceShotReview,verifiedSpeech:records[0]!.resolvedRecord.referenceVerifiedSpeech}).slice(0,20)}`;
  if(currentAnalysis.version!==expectedVersion||currentAnalysis.analysisId!==expectedId)return fail();
  context.primaryReferenceAnalysisId=handoff.analysisId;
  context.verifiedPrimaryReference={recordId:String(record.id),sourceVersion:records[0]!.sourceVersion,sourceSha256:sourceAnalysis.contentSha256,analysisRunId:sourceAnalysis.analysisRunId,runtimeAnalysisId:currentAnalysis.analysisId,runtimeAnalysisVersion:currentAnalysis.version,sourceAnalysisId:handoff.analysisId,sourceAnalysisVersion:handoff.analysisVersion};
 }
 if(item.targetAccountPlaybook){
  const selected=analysis.targetAccountPlaybooks?.filter(value=>value.accountId===item.accountId)??[];
  if(selected.length!==1||socialRequestHash(selected[0])!==socialRequestHash(item.targetAccountPlaybook))return fail();
  const actual=await verifyWeeklyTargetAccountPlaybook(input.store,input.tenantId,pkg.programId,item.targetAccountPlaybook);
  context.targetAccountRef={objectType:actual.accountRef.type,id:actual.accountRef.id,version:String(actual.accountRef.version)};
  context.accountPlaybookRef={objectType:'account_playbook',id:actual.playbookRef.id,version:String(actual.playbookRef.version),accountRef:actual.accountId};
  const ruleRows=await input.store.list<Record_>('social_playbook_versions',{where:{tenant_id:input.tenantId,program_id:pkg.programId,account_id:actual.accountId,playbook_id:actual.playbookRef.id,version:actual.playbookRef.version},perPage:2});
  const payload=obj(ruleRows.items[0]?.payload);if(ruleRows.totalItems!==1||ruleRows.items.length!==1||!payload||socialRequestHash(payload)!==actual.playbookHash)return fail();
  const strings=(key:string):string[]=>{const value=payload[key];if(!Array.isArray(value)||value.some(item=>typeof item!=='string'))return fail();return [...value];};
  const route=obj(payload.conversionRoute);if(!route||typeof route.routeId!=='string'||typeof route.callToAction!=='string'||!route.callToAction||typeof route.entryType!=='string'||!['profile_link','comment','direct_message','store','form','whatsapp','other'].includes(route.entryType))return fail();
  context.verifiedAccountPlaybook={recordHash:actual.playbookHash,audience:strings('audience'),pillars:strings('pillars'),recurringFormats:strings('recurringFormats'),conversionRoute:{routeId:route.routeId,entryType:route.entryType as import('../../shared/contracts/socialProgram.js').AccountPlaybook['conversionRoute']['entryType'],callToAction:route.callToAction,entryRef:typeof route.entryRef==='string'?route.entryRef:null,qualificationFields:Array.isArray(route.qualificationFields)&&route.qualificationFields.every(value=>typeof value==='string')?[...route.qualificationFields]:[],handoffTarget:typeof route.handoffTarget==='string'?route.handoffTarget:null,verifiedAt:typeof route.verifiedAt==='string'?route.verifiedAt:null},evidenceRules:strings('evidenceRules'),visualRules:strings('visualRules'),languageRules:strings('languageRules'),presenterRules:strings('presenterRules'),fixedFactors:strings('fixedFactors'),experimentFactors:strings('experimentFactors')};
 }
 return context;
}
