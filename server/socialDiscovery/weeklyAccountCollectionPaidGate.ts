import type {DataStore,Record_} from '../storage/datastore.js';
import {readCurrentWeeklyAccountCollectionBudget} from './weeklyAccountCollectionBudget.js';
import {readWeeklyAccountCollectionMeteredReservation} from './weeklyAccountCollectionMeteredAuthority.js';

/** The approved source scope is not a spending grant. An immutable budget
 * record may be issued independently, but provider/FX/transport attestation
 * must still be present before constructing a paid permit. */
export async function readWeeklyAccountCollectionPaidBlocker(input:{store:DataStore;tenantId:string;programId:string;packageId:string;packageVersion:number;scopeId:string;scopeVersion:number;scopeHash:string;accountUrl:string}):Promise<string>{
 try{
  const authorization=await readCurrentWeeklyAccountCollectionBudget(input.store,input);
  const jobs=await input.store.list<Record_>('social_weekly_preproduction_jobs',{where:{tenant_id:input.tenantId,program_id:input.programId,package_id:input.packageId,package_version:input.packageVersion,kind:'discovery'},perPage:100});
  const matches=jobs.items.map(row=>row.payload as {jobId?:string;recordHash?:string;originalRunKey?:string;authority?:{scopeId?:string;scopeVersion?:number;scopeHash?:string}}).filter(job=>job.authority?.scopeId===input.scopeId&&job.authority.scopeVersion===input.scopeVersion&&job.authority.scopeHash===input.scopeHash&&job.jobId&&job.recordHash&&job.originalRunKey).sort((a,b)=>a.jobId!.localeCompare(b.jobId!));
  // One approved scope is intentionally shared by several weekly consumers.
  // The paid authority belongs to the stable shared leader, not to every peer.
  // Re-read every exact candidate and require one unambiguous reservation.
  const authorized=[];
  for(const job of matches){try{authorized.push(await readWeeklyAccountCollectionMeteredReservation({store:input.store,authorization,operation:{tenantId:input.tenantId,programId:input.programId,packageId:input.packageId,packageVersion:input.packageVersion,scopeId:input.scopeId,scopeVersion:input.scopeVersion,scopeHash:input.scopeHash,jobId:job.jobId!,jobRecordHash:job.recordHash!,runOperationId:job.originalRunKey!}}));}catch{/* not the authorized shared leader */}}
  if(authorized.length===1)return 'weekly_preproduction_collection_metered_runtime_binding_required';
  return 'weekly_preproduction_collection_cost_ceiling_unverified';
 }catch(error){
  const code=error instanceof Error?error.message:'';
  return code==='weekly_account_collection_budget_lineage_missing_or_ambiguous'?'weekly_preproduction_collection_budget_authorization_required':'weekly_preproduction_collection_budget_authorization_unverified';
 }
}
