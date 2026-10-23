import type {DataStore, Record_} from '../storage/datastore.js';
import {socialObject, socialRequestHash} from '../starter198/socialContentValidation.js';
import {collectionBusinessDate} from './dailyCollectionQuota.js';

export interface WeeklyOriginalCollectionScope {
  programId:string;
  packageId:string;
  packageVersion:number;
  originalRunKey:string;
}

/** A revision is not a fresh daily collection allowance for a package that
 * already submitted an earlier version's collection on a previous business
 * day. A genuinely never-submitted package may still start on a later day. */
export async function assertWeeklyOriginalCrossDayFence(store:DataStore,tenantId:string,scope:WeeklyOriginalCollectionScope,now:Date){
  const today=collectionBusinessDate(now);
  if(!tenantId||!scope.programId||!scope.packageId||!Number.isSafeInteger(scope.packageVersion)||scope.packageVersion<1||!scope.originalRunKey||!Number.isFinite(now.getTime()))throw Error('weekly_discovery_original_authority_invalid');
  const current=await store.list<Record_>('social_weekly_preproduction_jobs',{where:{tenant_id:tenantId,program_id:scope.programId,package_id:scope.packageId,package_version:scope.packageVersion,original_run_key:scope.originalRunKey},perPage:2});
  if(current.totalItems!==1||current.items.length!==1||current.items[0]?.kind!=='discovery')throw Error('weekly_discovery_original_authority_missing');
  const currentJob=socialObject(current.items[0]!.payload);
  if(!currentJob||currentJob.tenantId!==tenantId||currentJob.programId!==scope.programId||currentJob.packageId!==scope.packageId||currentJob.packageVersion!==scope.packageVersion||currentJob.originalRunKey!==scope.originalRunKey||current.items[0]!.record_hash!==currentJob.recordHash||currentJob.recordHash!==socialRequestHash({...currentJob,recordHash:''}))throw Error('weekly_discovery_original_authority_changed');
  const authority=socialObject(currentJob.authority),activeScope=authority?.scopeId?await store.getById<Record_>('social_discovery_scopes',String(authority.scopeId)):null;
  const approval=socialObject(socialObject(activeScope?.payload)?.approval);
  const freshApprovedScope=!!activeScope&&activeScope.tenant_id===tenantId&&activeScope.status==='active'&&activeScope.version===authority?.scopeVersion&&socialRequestHash(activeScope.payload)===authority?.scopeHash&&approval?.status==='approved'&&approval.scopeVersion===authority.scopeVersion&&typeof approval.approvedAt==='string'&&Number.isFinite(Date.parse(approval.approvedAt))&&collectionBusinessDate(new Date(approval.approvedAt))===today;
  let expectedTotal:number|null=null,seen=0;
  for(let page=1;;page++){
    const rows=await store.list<Record_>('social_weekly_preproduction_jobs',{where:{tenant_id:tenantId,program_id:scope.programId,package_id:scope.packageId},page,perPage:100});
    if(!Number.isSafeInteger(rows.totalItems)||!Number.isSafeInteger(rows.totalPages)||rows.totalPages<1||expectedTotal!==null&&rows.totalItems!==expectedTotal)throw Error('weekly_discovery_prior_jobs_invalid');
    expectedTotal=rows.totalItems;seen+=rows.items.length;
    for(const row of rows.items){
      if(row.kind!=='discovery')continue;
      const version=Number(row.package_version);
      if(!Number.isSafeInteger(version)||version<1)throw Error('weekly_discovery_prior_job_changed');
      if(version>=scope.packageVersion)continue;
      const job=socialObject(row.payload);
      if(!job||job.tenantId!==tenantId||job.programId!==scope.programId||job.packageId!==scope.packageId||job.packageVersion!==version||job.originalRunKey!==row.original_run_key||row.record_hash!==job.recordHash||job.recordHash!==socialRequestHash({...job,recordHash:''}))throw Error('weekly_discovery_prior_job_changed');
      // An actual newly approved discovery scope is a separate user action.
      // Only that current-day, different-scope authority can supersede an
      // older version's sources. A budget/fact-only revision cannot.
      if(freshApprovedScope&&typeof socialObject(job.authority)?.scopeHash==='string'&&socialObject(job.authority)?.scopeHash!==authority?.scopeHash)continue;
      await checkRun(String(job.originalRunKey));
      for(let childPage=1;;childPage++){
        const children=await store.list<Record_>('social_weekly_preproduction_retry_attempts',{where:{tenant_id:tenantId,program_id:scope.programId,package_id:scope.packageId,package_version:version,root_job_id:row.id},page:childPage,perPage:100});
        if(!Number.isSafeInteger(children.totalPages)||children.totalPages<1)throw Error('weekly_discovery_prior_attempts_invalid');
        for(const child of children.items){const attempt=socialObject(child.payload);if(!attempt||attempt.tenantId!==tenantId||attempt.programId!==scope.programId||attempt.packageId!==scope.packageId||attempt.packageVersion!==version||attempt.retry===undefined||child.record_hash!==attempt.recordHash||attempt.recordHash!==socialRequestHash({...attempt,recordHash:''}))throw Error('weekly_discovery_prior_attempt_changed');await checkRun(String(attempt.originalRunKey));}
        if(childPage>=children.totalPages)break;
      }
    }
    if(page>=rows.totalPages){if(seen!==expectedTotal)throw Error('weekly_discovery_prior_jobs_incomplete');break;}
    if(!rows.items.length)throw Error('weekly_discovery_prior_jobs_incomplete');
  }
  async function checkRun(key:string){
    if(!key)throw Error('weekly_discovery_prior_run_key_missing');
    const runId=`weekly_discovery_${socialRequestHash({tenantId,key})}`;
    const runs=await store.list<Record_>('social_discovery_runs',{where:{tenant_id:tenantId,runId},perPage:2});
    if(runs.totalItems>1||runs.items.length!==runs.totalItems)throw Error('weekly_discovery_prior_run_ambiguous');
    const run=runs.items[0];if(!run)return;
    const marker=socialObject(socialObject(run.scopeSnapshot)?.weeklyProducer);
    if(run.tenant_id!==tenantId||run.runId!==runId||marker?.key!==key||!Number.isFinite(Date.parse(String(run.startedAt??''))))throw Error('weekly_discovery_prior_run_changed');
    if(run.status==='running'||run.error==='weekly_discovery_original_execution_interrupted')throw Error('weekly_discovery_prior_submission_unknown');
    if(collectionBusinessDate(new Date(String(run.startedAt)))!==today)throw Error('weekly_discovery_cross_day_revision_collection_required');
  }
}
