import {randomUUID} from 'node:crypto';
import type {DataStore} from '../storage/datastore.js';
import type {DurablePublicationAttempt} from './weeklyLineage.js';
import {acquireDurableOperationLease,assertDurableOperationLease,releaseDurableOperationLease} from '../runtime/durableLease.js';
import {socialRequestHash} from '../starter198/socialContentValidation.js';

type Observation=Pick<DurablePublicationAttempt,'status'|'provider_receipt_id'|'platform_post_id'|'platform_url'|'failure_code'>;
/** Serialize only the durable observation write, never the provider request.
 * A late unknown response cannot erase a confirmed platform publication. */
export async function settlePublicationAttempt(input:{dataStore:DataStore;original:DurablePublicationAttempt;observation:Observation;resolvedAt:string}):Promise<DurablePublicationAttempt>{
 const {dataStore,original,observation,resolvedAt}=input;
 let lease:Awaited<ReturnType<typeof acquireDurableOperationLease>>=null;
 for(let attempt=0;attempt<20&&!lease;attempt++){
  lease=await acquireDurableOperationLease({dataStore,tenantId:original.tenant_id,scope:'weekly_publication_attempt_settlement',subjectId:original.assignment_id,ownerId:randomUUID(),leaseDurationMs:30000});
  if(!lease)await new Promise(resolve=>setTimeout(resolve,25));
 }
 if(!lease)throw Error('publication_attempt_settlement_busy');
 try{
  const rows=await dataStore.list<DurablePublicationAttempt>('social_publication_attempts',{where:{tenant_id:original.tenant_id,assignment_id:original.assignment_id},perPage:2});
  const current=rows.items[0];
  if(rows.totalItems!==1||rows.items.length!==1||!current||current.id!==original.id||current.tenant_id!==original.tenant_id||current.assignment_id!==original.assignment_id||current.attempt_id!==original.attempt_id||current.package_id!==original.package_id||current.provider!==original.provider)throw Error('publication_attempt_integrity_violation');
  if(current.status==='published'){
   if(!current.provider_receipt_id||!current.platform_post_id)throw Error('publication_attempt_terminal_receipt_missing');
   return current;
  }
  if(observation.status==='published'&&(!observation.provider_receipt_id||!observation.platform_post_id))throw Error('publication_attempt_terminal_receipt_missing');
  if(current.status==='failed'&&observation.status!=='published')return current;
  if(observation.status==='unknown'&&socialRequestHash(current)!==socialRequestHash(original))return current;
  if(!Number.isFinite(Date.parse(resolvedAt)))throw Error('publication_attempt_resolution_time_invalid');
  await assertDurableOperationLease({dataStore,lease,minimumRemainingMs:1000});
  const update={...observation,resolved_at:resolvedAt,updated_at:resolvedAt};
  if(!await dataStore.update('social_publication_attempts',current.id,update))throw Error('publication_attempt_result_storage_failed');
  return {...current,...update};
 }finally{await releaseDurableOperationLease({dataStore,lease});}
}
