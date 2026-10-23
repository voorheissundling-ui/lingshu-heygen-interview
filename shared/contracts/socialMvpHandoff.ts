/** Frozen C intake contract. References are claims until the server resolves them
 * against authoritative records; a client boolean is never verification. */
export interface SocialMvpScope {tenantId:string;accountId:string;productId:string;projectId:string;taskId:string;runId:string;version:string;}
export interface SocialMvpEvidenceRef {id:string;version:string;sha256:string;}
export interface SocialMvpExecutionPackage {
 schemaVersion:'social-mvp-execution-package.v1';scope:SocialMvpScope;recordHash:string;
 reference:SocialMvpEvidenceRef&{sourceRef:string;usageBoundaryRef:SocialMvpEvidenceRef};
 personaBasis:SocialMvpEvidenceRef;director:SocialMvpEvidenceRef;script:SocialMvpEvidenceRef;storyboard:SocialMvpEvidenceRef;voiceover:SocialMvpEvidenceRef;
 avatar:{id:string;version:string;rightsRef:SocialMvpEvidenceRef};voice:{id:string;version:string;rightsRef:SocialMvpEvidenceRef};
 scenes:Array<{sceneId:string;role:'digital_human'|'key_aigc'|'enterprise';inputFingerprint:string;factRefs:SocialMvpEvidenceRef[];rightsRefs:SocialMvpEvidenceRef[]}>;
 recovery:{mode:'resume_original_attempt';ledgerScopeRef:SocialMvpEvidenceRef};
 budgets:{A:SocialMvpBudget;B:SocialMvpBudget;total:SocialMvpBudget};qualityStandardRef:SocialMvpEvidenceRef;
}
export interface SocialMvpBudget {currency:string;maximum:number;authorizationRef:SocialMvpEvidenceRef;}
export interface SocialMvpClipHandoff {
 schemaVersion:'social-mvp-clip-handoff.v1';scope:SocialMvpScope;packageHash:string;lane:'A'|'B';sceneId:string;inputFingerprint:string;
 avatarVersion:string|null;voiceVersion:string|null;file:{path:string;sha256:string};
 provider:{providerId:string;taskId:string;requestId:string;attemptId:string;receiptRef:SocialMvpEvidenceRef};
 cost:{state:'reserved'|'settled';currency:string;actual:number;reserved:number;ledgerRef:SocialMvpEvidenceRef};factRefs:SocialMvpEvidenceRef[];rightsRefs:SocialMvpEvidenceRef[];
}
export const SOCIAL_MVP_SCOPE_KEYS=['tenantId','accountId','productId','projectId','taskId','runId','version'] as const;
const text=(v:unknown):v is string=>typeof v==='string'&&v.trim().length>0;
const hash=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const obj=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
function need(v:unknown,code:string):asserts v{if(!v)throw Error(`social_mvp_${code}`);}
function evidence(v:unknown){const r=obj(v);need(text(r.id)&&text(r.version)&&hash(r.sha256),'evidence_ref_missing');}
function refs(v:unknown,nonempty=false){need(Array.isArray(v)&&(!nonempty||v.length>0),'evidence_refs_missing');v.forEach(evidence);}
function scope(v:unknown){const s=obj(v);need(SOCIAL_MVP_SCOPE_KEYS.every(k=>text(s[k])),'scope_missing');}
export function assertSocialMvpExecutionPackage(value:unknown):asserts value is SocialMvpExecutionPackage{
 const p=obj(value);need(p.schemaVersion==='social-mvp-execution-package.v1','package_schema');scope(p.scope);need(hash(p.recordHash),'package_hash_missing');
 const reference=obj(p.reference);evidence(reference);need(text(reference.sourceRef),'reference_source_missing');evidence(reference.usageBoundaryRef);
 for(const k of ['personaBasis','director','script','storyboard','voiceover','qualityStandardRef'])evidence(p[k]);
 for(const k of ['avatar','voice']){const r=obj(p[k]);need(text(r.id)&&text(r.version),'identity_version_missing');evidence(r.rightsRef);}
 need(Array.isArray(p.scenes)&&p.scenes.length>0,'scenes_missing');const seen=new Set<string>();
 for(const raw of p.scenes){const s=obj(raw);need(text(s.sceneId)&&!seen.has(s.sceneId)&&hash(s.inputFingerprint)&&['digital_human','key_aigc','enterprise'].includes(String(s.role)),'scene_invalid');seen.add(s.sceneId);refs(s.factRefs,s.role==='enterprise');refs(s.rightsRefs,true);}
 need(p.scenes.some(s=>obj(s).role==='digital_human')&&p.scenes.some(s=>obj(s).role==='key_aigc'),'required_stack_missing');
 const recovery=obj(p.recovery);need(recovery.mode==='resume_original_attempt','recovery_missing');evidence(recovery.ledgerScopeRef);
 const budgets=obj(p.budgets);for(const lane of ['A','B','total']){const b=obj(budgets[lane]);need(text(b.currency)&&typeof b.maximum==='number'&&Number.isFinite(b.maximum)&&b.maximum>=0,'budget_missing');evidence(b.authorizationRef);}
 need(obj(budgets.A).currency===obj(budgets.B).currency&&obj(budgets.A).currency===obj(budgets.total).currency&&Number(obj(budgets.A).maximum)+Number(obj(budgets.B).maximum)<=Number(obj(budgets.total).maximum),'budget_allocation_invalid');
}
export function assertSocialMvpClipHandoff(value:unknown,p:SocialMvpExecutionPackage):asserts value is SocialMvpClipHandoff{
 assertSocialMvpExecutionPackage(p);const c=obj(value);need(c.schemaVersion==='social-mvp-clip-handoff.v1','clip_schema');scope(c.scope);
 need(SOCIAL_MVP_SCOPE_KEYS.every(k=>obj(c.scope)[k]===p.scope[k]),'scope_mismatch');need(c.packageHash===p.recordHash,'package_mismatch');
 const scene=p.scenes.find(s=>s.sceneId===c.sceneId);need(scene&&scene.inputFingerprint===c.inputFingerprint,'scene_fingerprint_mismatch');
 need((c.lane==='A'&&scene.role==='digital_human')||(c.lane==='B'&&scene.role==='key_aigc'),'lane_mismatch');
 if(c.lane==='A')need(c.avatarVersion===p.avatar.version&&c.voiceVersion===p.voice.version,'identity_version_mismatch');
 const file=obj(c.file);need(text(file.path)&&hash(file.sha256),'media_missing');const provider=obj(c.provider);need(['providerId','taskId','requestId','attemptId'].every(k=>text(provider[k])),'provider_identity_missing');evidence(provider.receiptRef);
 const cost=obj(c.cost),budget=p.budgets[c.lane as 'A'|'B'];need(cost.currency===budget.currency&&typeof cost.actual==='number'&&Number.isFinite(cost.actual)&&cost.actual>=0&&typeof cost.reserved==='number'&&Number.isFinite(cost.reserved)&&cost.reserved>=0&&cost.actual+cost.reserved<=budget.maximum,'cost_invalid');need((cost.state==='settled'&&cost.reserved===0)||(cost.state==='reserved'&&cost.actual===0),'cost_state_invalid');evidence(cost.ledgerRef);
 refs(c.factRefs);refs(c.rightsRefs,true);for(const key of ['factRefs','rightsRefs'] as const){const actual=c[key] as SocialMvpEvidenceRef[];need(scene[key].every(r=>actual.some(a=>a.id===r.id&&a.version===r.version&&a.sha256===r.sha256)),'scene_evidence_mismatch');}
}
/** All must be resolved server-side, including historical attempts in the budget ledger. */
export function socialMvpEvidenceRefs(p:SocialMvpExecutionPackage,c:SocialMvpClipHandoff):SocialMvpEvidenceRef[]{
 assertSocialMvpClipHandoff(c,p);return [p.recovery.ledgerScopeRef,p.reference,p.reference.usageBoundaryRef,p.personaBasis,p.director,p.script,p.storyboard,p.voiceover,p.qualityStandardRef,p.avatar.rightsRef,p.voice.rightsRef,...Object.values(p.budgets).map(b=>b.authorizationRef),...p.scenes.flatMap(s=>[...s.factRefs,...s.rightsRefs]),c.provider.receiptRef,c.cost.ledgerRef,...c.factRefs,...c.rightsRefs];
}

export interface SocialMvpHandoffRead {package:SocialMvpExecutionPackage|null;clips:SocialMvpClipHandoff[];estimatedCosts:{A:number|null;B:number|null;total:number|null};gaps:string[];}
/** Historical committed/reserved attempts belong to the same budget even after retries. */
export function assertSocialMvpClipBatch(p:SocialMvpExecutionPackage,clips:SocialMvpClipHandoff[],historical:{A:number;B:number}){
 assertSocialMvpExecutionPackage(p);const sums={A:historical.A,B:historical.B};need(Object.values(sums).every(v=>Number.isFinite(v)&&v>=0),'ledger_history_invalid');
 const seen=new Set<string>(),scenes=new Set<string>();for(const c of clips){assertSocialMvpClipHandoff(c,p);need(!scenes.has(c.sceneId),'duplicate_scene');scenes.add(c.sceneId);
 for(const key of ['taskId','requestId','attemptId'] as const){const id=`${c.provider.providerId}:${key}:${c.provider[key]}`;need(!seen.has(id),'provider_attempt_reused');seen.add(id);}sums[c.lane]+=c.cost.actual+c.cost.reserved;}
 need(sums.A<=p.budgets.A.maximum&&sums.B<=p.budgets.B.maximum&&sums.A+sums.B<=p.budgets.total.maximum,'aggregate_budget_exceeded');
}
