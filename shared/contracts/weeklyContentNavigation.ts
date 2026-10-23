import type {VersionedSocialRef,WeeklyExecutionTask} from './socialProgram.js';
export function isWeeklyContentNavigationExecution(task:WeeklyExecutionTask):boolean {
 return task.workflowKind==='content'&&['material_preparation','script','storyboard','material_readiness','asset_generation','video_generation','quality_check','rework','user_approval'].includes(task.schedule.stepKind)
  ||task.workflowKind==='directing'&&['script','storyboard'].includes(task.schedule.stepKind)
  ||task.workflowKind==='publishing'&&task.schedule.stepKind==='publishing';
}
export interface WeeklyContentNavigationScope {tenantId:string;programId:string;packageId:string;packageVersion:number;executionTaskId:string}
export interface WeeklyContentNavigation {scope:WeeklyContentNavigationScope;publicationTaskId:string;contentTaskId:string;runId:string|null;artifactRef:VersionedSocialRef|null;bindingKey:string;source:'production_binding'|'completed_artifact';gaps:string[]}
