import type {WeeklyAgentPlanningState} from '../../shared/contracts/socialProgram.js';
import {socialRequestHash as scheduleHash} from '../starter198/socialContentValidation.js';
import {assertWeeklyDetailedCoverage} from './weeklyPlanningCoverage.js';
import {SocialProgramError} from './service.js';
import {WEEKLY_AUTOMATION_TEMPLATE} from '../../shared/weeklyAutomationTemplate.js';
const fail=():never=>{throw new SocialProgramError('weekly_planning_template_adoption_invalid',409,'真实分析、排期范围或默认模板采用证据已经变化。');};
export function weeklyPlanningAnalysisHash(plan:WeeklyAgentPlanningState){return scheduleHash({programId:plan.programId,packageId:plan.packageId,packageVersion:plan.packageVersion,skeleton:plan.skeleton,directorAnalyses:plan.directorAnalyses,directorGaps:plan.directorGaps??[],referenceSourcePolicy:plan.referenceSourcePolicy??null,...(plan.pinnedReference?{pinnedReference:plan.pinnedReference}:{})});}
export function verifiedWeeklyPlanningTemplateAdoption(plan:WeeklyAgentPlanningState){
 const adoption=plan.automaticTemplateAdoption;if(!adoption)return null;
 const {recordHash,...payload}=adoption;
 if(recordHash!==scheduleHash(payload)||adoption.source!=='automatic_template'||adoption.templateVersion!==WEEKLY_AUTOMATION_TEMPLATE.version||adoption.userApproval!==null||adoption.authorizesPublishing!==false||adoption.authorizesContentAcceptance!==false||adoption.authorizesCustomerMessages!==false||!adoption.actorUserId?.trim()||!Number.isFinite(Date.parse(adoption.adoptedAt))||plan.userConfirmation||!plan.detailedSchedule?.coverage||scheduleHash(plan.detailedSchedule.coverage.selectedSlotIds)!==scheduleHash(adoption.selectedSlotIds)||adoption.analysisEvidenceHash!==weeklyPlanningAnalysisHash(plan)||adoption.detailedScheduleHash!==scheduleHash(plan.detailedSchedule))return fail();
 assertWeeklyDetailedCoverage(plan);return adoption;
}
/** Execution attribution is not a fabricated user confirmation. */
export function weeklyPlanningExecutionActor(plan:WeeklyAgentPlanningState):string|null{return verifiedWeeklyPlanningTemplateAdoption(plan)?.actorUserId??plan.userConfirmation?.confirmedBy??null;}
export function weeklyPlanningExecutionSelection(plan:WeeklyAgentPlanningState){return verifiedWeeklyPlanningTemplateAdoption(plan)?.selectedSlotIds??plan.userConfirmation?.selectedSlotIds;}
