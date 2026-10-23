import type {DataStore} from '../storage/datastore.js';
import {readWeeklyAutomationTemplate} from '../socialPrograms/weeklyAutomationTemplate.js';
import {SocialContentWorkflowError} from '../starter198/socialContentValidation.js';
import {readWeeklySamplePolicyEvidence} from '../socialPrograms/weeklySamplePolicyEvidence.js';

/** A repair child is a new production, not a read-only recovery of the parent.
 * Neither a contact receipt nor an internal PDF review proves this claim. */
export async function assertWeeklyCreativeRepairCtaAdmission(input:{
 store:DataStore;tenantId:string;programId:string;packageId:string;packageVersion:number;
 inheritedCallToAction:unknown;publicationTaskId?:string;
}):Promise<void>{
 const adopted=await readWeeklyAutomationTemplate(input.store,input);
 const claim=[adopted?.template.callToAction,input.inheritedCallToAction]
  .some(value=>typeof value==='string'&&/whats\s*app|free\s+samples?|免费样品/i.test(value));
 if(claim){
  const proof=input.publicationTaskId?await readWeeklySamplePolicyEvidence({store:input.store,scope:{tenantId:input.tenantId,
   programId:input.programId,packageId:input.packageId,packageVersion:input.packageVersion,
   publicationTaskId:input.publicationTaskId}}).catch(()=>null):null;
  if(!proof)throw new SocialContentWorkflowError('weekly_production_cta_evidence_required',409);
 }
}
