import type {AutomaticMaterialEvidence,WeeklyAssetRequirement} from '../../shared/weeklyAutomaticMaterial.js';
import {weeklyAssetRequirementIdentity} from '../../shared/weeklyAutomaticMaterial.js';
import type {GeneratedAssetArchiveInput} from '../../shared/contracts/generatedMaterial.js';
import {qualityAllowsReuse} from '../../shared/contracts/generatedMaterial.js';
export interface VerifiedMaterialObservation {subjectRef:string;action:string;scene:string;confidence:number;needsReview:boolean}
/** No filename, task product association or requested generation prompt is visual evidence. */
export function uploadAutomaticMaterialEvidence(input:{sha256:string;model:string;aspectRatio:string;durationSeconds:number;decoded:boolean;qualityPassed:boolean;observations:VerifiedMaterialObservation[];commercialUseApproved:boolean;rightsEvidenceRef:string;authorizationScopes:string[]}):AutomaticMaterialEvidence[]{
 if(!/^[a-f0-9]{64}$/.test(input.sha256)||!input.model||!input.decoded||!input.qualityPassed||!input.aspectRatio
  ||!input.commercialUseApproved||!input.rightsEvidenceRef.trim()||/unverified|unknown/i.test(input.rightsEvidenceRef)||!input.authorizationScopes.length)return [];
 return input.observations.filter(o=>!o.needsReview&&o.confidence>=.85&&o.subjectRef.trim()&&o.action.trim()&&o.scene.trim()).map(o=>({sha256:input.sha256,model:input.model,subjectRef:o.subjectRef,action:o.action,scene:o.scene,evidenceRequirement:'visible_subject',aspectRatio:input.aspectRatio,durationSeconds:input.durationSeconds,authorizationScopes:[...input.authorizationScopes],rightsEvidenceRef:input.rightsEvidenceRef,qualityPassed:true}));
}
/** Generation's semantic identity is admitted only by the independent pipeline gate, not by prompt text. */
export function generatedAutomaticMaterialEvidence(input:GeneratedAssetArchiveInput,actualSha256:string):AutomaticMaterialEvidence|null{
 const contract=input.automaticMaterial;
 if(!contract||!qualityAllowsReuse(input.quality)||input.media.contentSha256!==actualSha256
  ||!contract.independentVisualCheckRef?.trim()||!contract.rightsEvidenceRef?.trim()
  ||!contract.authorizationScopes.includes(input.rightsScope))return null;
 weeklyAssetRequirementIdentity(contract.requirement);
 if(contract.requirement.evidenceRequirement!=='non_evidentiary_visual'&&contract.requirement.evidenceRequirement!=='product_identity')return null;
 if(contract.requirement.evidenceRequirement==='product_identity'&&!input.quality.checks.some(c=>c.key==='product_identity'&&c.status==='passed'&&c.evidence.trim()))return null;
 return {sha256:actualSha256,...contract.requirement,durationSeconds:input.media.duration??0,model:input.generation.model,
  qualityPassed:true,rightsEvidenceRef:contract.rightsEvidenceRef,authorizationScopes:[...contract.authorizationScopes]};
}
export function canonicalMaterialAspectRatio(width:number,height:number):string{
 if(!(width>0&&height>0))return '';
 for(const [w,h] of [[9,16],[16,9],[1,1],[4,5],[3,4]])if(Math.abs(width/height-w!/h!)<.005)return `${w}:${h}`;
 return `${width}:${height}`;
}
