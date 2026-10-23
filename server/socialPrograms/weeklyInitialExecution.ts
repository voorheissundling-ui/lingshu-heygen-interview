import type {WeeklyExecutionTask} from '../../shared/contracts/socialProgram.js';
/** A failed read-only channel preflight is not content production. Preserve
 * its audit history while allowing the first real capacity confirmation.
 * A live lease, result, completed check or messaging attempt is never ignored. */
export function hasWeeklyInitialExecution(task:WeeklyExecutionTask):boolean{
 if(task.schedule.stepKind==='customer_channel_readiness'&&task.status==='blocked'&&task.lastError&&task.ownBlockingReasons.includes(task.lastError.code)&&!task.lease&&!task.resultRefs.length&&!task.schedule.actualFinishedAt&&!task.productionProgress)return false;
 return Boolean(task.lease||task.attempt>0||task.resultRefs.length||task.schedule.actualStartedAt||task.schedule.actualFinishedAt||task.productionProgress||!['pending_activation','blocked','queued'].includes(task.status));
}
