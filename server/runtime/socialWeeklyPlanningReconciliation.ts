import type {DataStore} from '../storage/datastore.js';
import type {WeeklyExecutionTask,WeeklyOperatingPackage} from '../../shared/contracts/socialProgram.js';
import {PACKAGES,type PackageRow} from '../socialPrograms/weeklyOperatingPackageSupport.js';
import {SocialProgramError} from '../socialPrograms/service.js';
import {SocialContentWorkflowError} from '../starter198/socialContentValidation.js';
import {validateWeeklyExecutionResults,type WeeklyExecutionResultValidationPorts} from './socialWeeklyResultValidation.js';
const STEPS={business_outline:'readiness',benchmark_collection:'discovery',benchmark_scoring:'directing',director_analysis:'directing',business_schedule:'directing'} as const;
/** A default duration estimate is not a new reservation for work whose scoped immutable results already exist.
 * This never creates planning output or completes a task; claim/dependencies/complete remain the worker's responsibility. */
export async function mayReconcileExistingWeeklyPlanning(store:DataStore,task:WeeklyExecutionTask,now:Date,ports:WeeklyExecutionResultValidationPorts={}):Promise<boolean>{
 const expected=STEPS[task.schedule.stepKind as keyof typeof STEPS];if(!expected||expected!==task.workflowKind||task.status!=='queued'||task.schedule.responsibleActor==='user'||task.nextAttemptAt&&Date.parse(task.nextAttemptAt)>now.getTime()||task.inputSnapshot.scheduleRevisionRef||task.upstreamVersionRefs.some(ref=>ref.type==='weekly_schedule_snapshot'))return false;
 const rows=await store.list<PackageRow>(PACKAGES,{where:{tenant_id:task.tenantId,program_id:task.programId,package_id:task.packageId,version:task.packageVersion},page:1,perPage:2});const pkg=rows.items[0]?.payload as (WeeklyOperatingPackage&{scheduleRevisionRef?:unknown})|undefined;if(rows.totalItems!==1||rows.items.length!==1||!pkg||rows.items[0]!.tenant_id!==task.tenantId||pkg.programId!==task.programId||pkg.packageId!==task.packageId||pkg.version!==task.packageVersion||!['draft','active'].includes(pkg.status)||pkg.scheduleRevisionRef)return false;
 // A dynamic import avoids the runtime -> worker -> eligibility import cycle. The adapter is readonly.
 const {createSocialWeeklyPlanningAdapter}=await import('./socialWeeklyExecutionRuntime.js');const result=await createSocialWeeklyPlanningAdapter(store,ports.exactAnalysisPortsForRun).execute(task);if(result.status!=='succeeded')return false;
 try{await validateWeeklyExecutionResults(store,task,result.resultRefs,now,ports);return true;}catch(error){if(error instanceof SocialProgramError||error instanceof SocialContentWorkflowError)return false;throw error;}
}
