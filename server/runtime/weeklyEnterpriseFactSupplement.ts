import {createHash} from 'node:crypto';
import {deterministicFingerprint} from '../socialOperating/businessGoalBuilder.js';
import {organizationRoleOrNull} from '../lib/organizationRole.js';
import {readWeeklyReviewActor} from '../socialPrograms/weeklyReviewEvidence.js';
import type {OperatingAuthoritySnapshot,BusinessContentGoal} from '../../shared/contracts/socialOperatingDecision.js';
import type {DataStore,Record_} from '../storage/datastore.js';
import type {WeeklyExecutionTask,WeeklyOperatingPackage,VersionedSocialRef,WeeklyProductionStepKind} from '../../shared/contracts/socialProgram.js';
import {verifyEnterpriseFactContent,type EnterpriseProfile} from '../routes/enterprise.js';
import {socialJson,socialObject,socialRequestHash} from '../starter198/socialContentValidation.js';
export const WEEKLY_ENTERPRISE_FACT_STEPS:ReadonlySet<WeeklyProductionStepKind>=new Set(['material_preparation','material_readiness','script','storyboard','asset_generation','video_generation']);
export const ENTERPRISE_FACT_GAP='weekly_enterprise_facts_required';
export interface WeeklyEnterpriseFactCheck {applicable:boolean;ready:boolean;code:string;reason:string;sourceHash:string;evidenceRef:VersionedSocialRef|null;}
/** Read persisted facts, never call a fallback reader that synthesizes a confirmation. */
export async function checkWeeklyEnterpriseFactSupplement(input:{store:DataStore;task:WeeklyExecutionTask;now?:Date}):Promise<WeeklyEnterpriseFactCheck>{
 const {store,task}=input,now=input.now??new Date();const unavailable=(reason:string,sourceHash=''):WeeklyEnterpriseFactCheck=>({applicable:true,ready:false,code:ENTERPRISE_FACT_GAP,reason,sourceHash,evidenceRef:null});
 const packages=await store.list<Record_>('social_weekly_operating_packages',{where:{tenant_id:task.tenantId,program_id:task.programId,package_id:task.packageId,version:task.packageVersion},perPage:2});if(packages.totalItems!==1||packages.items.length!==1)return unavailable('package_unknown');
 const row=packages.items[0]!,pkg=socialObject(socialJson(row.payload)) as unknown as WeeklyOperatingPackage;
 if(row.tenant_id!==task.tenantId||row.program_id!==task.programId||row.package_id!==task.packageId||row.version!==task.packageVersion||!pkg||pkg.programId!==task.programId||pkg.packageId!==task.packageId||pkg.version!==task.packageVersion||!['active','draft'].includes(pkg.status))return unavailable('package_scope_changed');
 const pub=pkg.socialContentPackage?.publicationTasks?.find(p=>p.publicationTaskId===task.publicationTaskId&&p.accountId===task.accountId);
 if(!pub)return {applicable:false,ready:false,code:'',reason:'no_publication_consumer',sourceHash:'',evidenceRef:null};
 const refs=pub.factRefs,sourceHash=socialRequestHash({tenantId:task.tenantId,programId:task.programId,packageId:task.packageId,packageVersion:task.packageVersion,publicationTaskId:task.publicationTaskId,refs});
 if(!Array.isArray(refs)||!refs.length||refs.some(r=>r.type!=='enterprise_fact'||!r.id||!Number.isSafeInteger(r.version)||r.version<1))return unavailable('frozen_fact_references_missing',sourceHash);
 const frozen=socialObject(task.inputSnapshot.publicationTask);if(frozen&&socialRequestHash(frozen.factRefs)!==socialRequestHash(refs))return unavailable('consumer_frozen_facts_changed',sourceHash);
 const profiles=await store.list<Record_>('tenant_profiles',{where:{tenant_id:task.tenantId},perPage:2});if(profiles.totalItems!==1||profiles.items.length!==1)return unavailable(profiles.totalItems===0?'no_data':'profile_ambiguous',sourceHash);
 const profileRow=profiles.items[0]!,profile=socialObject(socialJson(profileRow.profile)) as unknown as EnterpriseProfile,version=profile?.factVersion;
 if(profileRow.tenant_id!==task.tenantId||!profile||!version)return unavailable('confirmation_unknown',sourceHash);
 if(!version.id||!Number.isSafeInteger(version.revision)||version.revision<1||!version.confirmedBy?.trim()||['system','legacy_migration'].includes(version.confirmedBy)||!Number.isFinite(Date.parse(version.confirmedAt))||Date.parse(version.confirmedAt)>now.getTime())return unavailable('confirmation_unknown',sourceHash);
 if(!verifyEnterpriseFactContent(profile).verified)return unavailable('confirmed_content_hash_changed',sourceHash);

 const actor=await readWeeklyReviewActor(store,task.tenantId,version.confirmedBy);if(!actor||actor.tenantId!==task.tenantId||!organizationRoleOrNull(actor.role)||actor.disabled===true||actor.active===false||['disabled','suspended'].includes(String(actor.status)))return unavailable('confirmation_actor_unknown',sourceHash);
 if(refs.some(r=>r.id!==version.id||r.version!==version.revision)){
  // Canonical generation uses per-statement refs in a frozen operating snapshot,
  // not a profile version ID or a caller-supplied alias.
  const ref=pkg.operatingDecisionSnapshotRef,goalRef=pkg.businessContentGoalRef;
  if(ref?.type!=='operating_authority_snapshot'||!goalRef)return unavailable('frozen_fact_version_changed',sourceHash);
  const snapshots=await store.list<Record_>('social_operating_authority_snapshots',{where:{tenant_id:task.tenantId,program_id:task.programId,snapshot_id:ref.id,version:ref.version},perPage:2});if(snapshots.totalItems!==1||snapshots.items.length!==1)return unavailable('operating_snapshot_unknown',sourceHash);
  const stored=snapshots.items[0]!,snapshot=socialObject(socialJson(stored.payload)) as unknown as OperatingAuthoritySnapshot;
  if(stored.tenant_id!==task.tenantId||stored.program_id!==task.programId||stored.snapshot_id!==ref.id||stored.version!==ref.version||!snapshot||snapshot.snapshotId!==ref.id||snapshot.version!==ref.version||snapshot.programId!==task.programId||snapshot.planningWeekStart!==pkg.weekStart||snapshot.inputFingerprint!==stored.input_fingerprint||snapshot.businessContentGoalRef.id!==goalRef.id||snapshot.businessContentGoalRef.version!==goalRef.version)return unavailable('operating_snapshot_scope_changed',sourceHash);
  const snapshotActor=await readWeeklyReviewActor(store,task.tenantId,snapshot.createdBy);if(stored.created_by!==snapshot.createdBy||!snapshotActor||snapshotActor.tenantId!==task.tenantId||!organizationRoleOrNull(snapshotActor.role)||snapshotActor.disabled===true||snapshotActor.active===false||['disabled','suspended'].includes(String(snapshotActor.status)))return unavailable('operating_snapshot_actor_unknown',sourceHash);
  const goals=await store.list<Record_>('social_business_content_goals',{where:{tenant_id:task.tenantId,program_id:task.programId,goal_id:goalRef.id,version:goalRef.version},perPage:2});const goal=socialObject(socialJson(goals.items[0]?.payload)) as unknown as BusinessContentGoal;
  if(goals.totalItems!==1||goals.items.length!==1||!goal||goal.goalId!==goalRef.id||goal.version!==goalRef.version||goal.programId!==task.programId||goal.status!=='ready'||refs.some(r=>!goal.publicFactRefs.some(g=>g.type===r.type&&g.id===r.id&&g.version===r.version)))return unavailable('business_goal_facts_changed',sourceHash);
  const statements=[profile.company?.description,profile.brand?.usp,profile.products?.highlights,profile.products?.certifications,...(profile.products?.items??[]).flatMap(p=>[p.name,p.highlights,p.certifications])].map(s=>String(s??'').trim().slice(0,1000)).filter(Boolean);
  const enterprise=snapshot.enterprise,stableId=(prefix:string,value:unknown)=>`${prefix}_${createHash('sha256').update(deterministicFingerprint(value)).digest('hex').slice(0,24)}`;
  if(enterprise?.ref.type!=='enterprise_operating_snapshot'||enterprise.ref.id!==stableId('enterprise',{tenantId:task.tenantId,programId:task.programId}))return unavailable('operating_enterprise_identity_changed',sourceHash);
  if(refs.some(r=>{const matches=enterprise.publicFacts.filter(f=>f.ref.id===r.id&&f.ref.version===r.version&&f.ref.type===r.type);return matches.length!==1||r.version!==enterprise.ref.version||!statements.includes(matches[0]!.statement)||r.id!==stableId('fact',{enterpriseId:enterprise.ref.id,statement:matches[0]!.statement});}))return unavailable('frozen_fact_statement_changed',sourceHash);
 }

 // A saved empty shell has a version but carries no publishable enterprise facts.
 if(!profile.company?.name?.trim()||!profile.products?.categories?.trim()&&!profile.products?.items?.some(p=>p.name?.trim()))return unavailable('no_data',sourceHash);
 return {applicable:true,ready:true,code:'',reason:'',sourceHash,evidenceRef:{type:'enterprise_fact',id:version.id,version:version.revision}};
}
