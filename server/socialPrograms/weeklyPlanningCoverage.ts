import type {WeeklyAgentPlanningState,WeeklyReferenceSourcePolicy} from '../../shared/contracts/socialProgram.js';
import {SocialProgramError} from './service.js';
import {ownedDiagnosisReady} from './ownedReferenceDiagnosis.js';
import {scheduleHash} from './weeklyScheduleSnapshots.js';
export interface WeeklyPlanningCoverage {selectedSlotIds:string[];pendingSlotIds:string[];referenceSourcePolicy:WeeklyReferenceSourcePolicy|null}
export interface WeeklyDirectorSlotGap {slotId:string;referenceSource:'owned'|'external'|'unknown';code:string;message:string;observedAt:string}
const fail=(code:string,message:string,status=409):never=>{throw new SocialProgramError(code,status,message);};
export function selectWeeklyPlanningCoverage(plan:WeeklyAgentPlanningState,selectedSlotIds?:string[]):WeeklyPlanningCoverage{
 if(selectedSlotIds!==undefined&&(!Array.isArray(selectedSlotIds)||!selectedSlotIds.length||selectedSlotIds.length>1000||selectedSlotIds.some(id=>typeof id!=='string'||!id||id.length>150||id.trim()!==id||! /^[a-zA-Z0-9_.:@-]+$/.test(id))))return fail('weekly_partial_selection_invalid','Selected slot IDs must be a bounded array of exact real IDs.',400);
 const all=plan.skeleton.slots.map(s=>s.slotId),selected=selectedSlotIds??all;
 if(!selected.length||new Set(selected).size!==selected.length||selected.some(id=>!all.includes(id))||new Set(all).size!==all.length)return fail('weekly_partial_selection_invalid','请明确选择真实且不重复的视频制作位。');
 return {selectedSlotIds:all.filter(id=>selected.includes(id)),pendingSlotIds:all.filter(id=>!selected.includes(id)),referenceSourcePolicy:structuredClone(plan.referenceSourcePolicy??null)};
}
export function assertWeeklyPlanningCoverage(plan:WeeklyAgentPlanningState,coverage:WeeklyPlanningCoverage,selectedSlotIds?:string[]):void{
 if(selectedSlotIds!==undefined)selectWeeklyPlanningCoverage(plan,selectedSlotIds);
 const actual=selectWeeklyPlanningCoverage(plan,coverage.selectedSlotIds);if(scheduleHash(actual)!==scheduleHash(coverage))return fail('weekly_partial_coverage_changed','视频范围或原来源配额已变化，需重新确认。');
 if(coverage.pendingSlotIds.length&&(!selectedSlotIds||scheduleHash([...selectedSlotIds].sort())!==scheduleHash([...coverage.selectedSlotIds].sort())))return fail('weekly_partial_confirmation_required','请明确确认本次独立继续的独立视频，未完成条目仍保留原配额和阻塞。');
}

export function assertWeeklyDetailedCoverage(plan:WeeklyAgentPlanningState):void{
 const detail=plan.detailedSchedule;if(!detail?.coverage)return;
 assertWeeklyPlanningCoverage(plan,detail.coverage,detail.coverage.selectedSlotIds);
 const slots=plan.skeleton.slots.filter(s=>detail.coverage!.selectedSlotIds.includes(s.slotId));
 const publications=slots.flatMap(s=>s.publicationTaskIds);
 if(detail.items.length!==publications.length||new Set(detail.items.map(i=>i.publicationTaskId)).size!==detail.items.length||detail.items.some(i=>!publications.includes(i.publicationTaskId)))return fail('weekly_partial_schedule_lineage','详细排期与所选视频范围不一致。');
 const referenceIds=slots.flatMap(slot=>plan.directorAnalyses.filter(analysis=>analysis.slotId===slot.slotId).flatMap(analysis=>analysis.benchmarkVideoRefs.map(ref=>ref.id)));
 if(new Set(referenceIds).size!==referenceIds.length)return fail('weekly_unique_benchmark_video_required','每条母版必须使用不同的对标视频，不能重复派单。');
 for(const slot of slots){const analysis=plan.directorAnalyses.filter(a=>a.slotId===slot.slotId);if(analysis.length!==1||analysis[0]!.packageId!==plan.packageId||analysis[0]!.packageVersion!==plan.packageVersion||!analysis[0]!.benchmarkVideoRefs.length||!analysis[0]!.benchmarkAccountRefs.length||!analysis[0]!.benchmarkEvidenceRefs.length||!analysis[0]!.contentDirection.trim()||plan.directorGaps?.some(g=>g.slotId===slot.slotId)||(slot.referenceSource==='owned'&&!ownedDiagnosisReady(analysis[0]!)))return fail('weekly_partial_analysis_not_ready','所选独立视频分析证据不完整，不能确认派单。');for(const id of slot.publicationTaskIds){const item=detail.items.find(i=>i.publicationTaskId===id)!;if(item.slotId!==slot.slotId||item.directorAnalysisRef.id!==analysis[0]!.analysisId||item.directorAnalysisRef.type!=='weekly_director_analysis'||item.directorAnalysisRef.version!==1||scheduleHash(item.benchmarkVideoRefs)!==scheduleHash(analysis[0]!.benchmarkVideoRefs)||scheduleHash(item.benchmarkAccountRefs)!==scheduleHash(analysis[0]!.benchmarkAccountRefs))return fail('weekly_partial_schedule_lineage','所选独立视频的分析引用与实际详细排期不一致。');}}
}
