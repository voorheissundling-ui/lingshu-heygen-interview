import type {DataStore,Record_} from '../storage/datastore.js';
import {socialObject,socialJson,socialRequestHash} from './socialContentValidation.js';
import {assertSocialMvpExecutionPackage,assertSocialMvpClipBatch,socialMvpEvidenceRefs,SOCIAL_MVP_SCOPE_KEYS,type SocialMvpScope,type SocialMvpExecutionPackage,type SocialMvpClipHandoff,type SocialMvpHandoffRead} from '../../shared/contracts/socialMvpHandoff.js';
export const SOCIAL_MVP_HANDOFFS='social_mvp_handoffs';
export const SOCIAL_MVP_EVIDENCE='social_mvp_evidence';
/** Read-only authority boundary. No client handoff or verified boolean is accepted.
 * These collections must be populated by source-owning server adapters; absence
 * is a missing state. This verifies lineage records, never media or creativity. */
export async function readSocialMvpHandoff(store:DataStore,scope:SocialMvpScope):Promise<SocialMvpHandoffRead>{
 const missing:SocialMvpHandoffRead={package:null,clips:[],estimatedCosts:{A:null,B:null,total:null},gaps:[]};
 const where=Object.fromEntries(SOCIAL_MVP_SCOPE_KEYS.map(k=>[k,scope[k]]));
 const rows=await store.list<Record_>(SOCIAL_MVP_HANDOFFS,{where,perPage:2});
 if(rows.totalItems!==1||rows.items.length!==1)return {...missing,gaps:[rows.totalItems===0?'mvp_authoritative_handoff_missing':'mvp_authoritative_handoff_ambiguous']};
 try{
 const row=rows.items[0]!;if(!SOCIAL_MVP_SCOPE_KEYS.every(k=>row[k]===scope[k]))throw Error('scope_mismatch');
 const content=socialObject(socialJson(row.content));if(!content||row.content_hash!==socialRequestHash(content))throw Error('handoff_hash_mismatch');
 const p=content.package;assertSocialMvpExecutionPackage(p);const {recordHash,...frozen}=p;if(recordHash!==socialRequestHash(frozen)||!SOCIAL_MVP_SCOPE_KEYS.every(k=>p.scope[k]===scope[k]))throw Error('package_changed');
 if(!Array.isArray(content.clips))throw Error('clips_missing');const clips=content.clips as SocialMvpClipHandoff[];
 const history=socialObject(content.history);if(!history||typeof history.A!=='number'||typeof history.B!=='number')throw Error('ledger_history_missing');
 assertSocialMvpClipBatch(p,clips,{A:history.A,B:history.B});
 if(p.scenes.filter(s=>s.role==='digital_human'||s.role==='key_aigc').some(s=>!clips.some(c=>c.sceneId===s.sceneId)))throw Error('required_scene_clip_missing');
 // Resolve each reference through server storage and check exact scope/content
 // bytes. Source adapters remain responsible for provider/rights/authenticity.
 const refs=clips.flatMap(c=>socialMvpEvidenceRefs(p,c));if(!clips.length)throw Error('clips_missing');
 for(const ref of refs){const found=await store.list<Record_>(SOCIAL_MVP_EVIDENCE,{where:{...where,evidence_id:ref.id,evidence_version:ref.version},perPage:2});
 if(found.totalItems!==1||found.items.length!==1)throw Error('evidence_missing');const evidence=found.items[0]!;
 if(!Object.entries({...where,evidence_id:ref.id,evidence_version:ref.version}).every(([k,v])=>evidence[k]===v)||evidence.content_hash!==ref.sha256||socialRequestHash(socialJson(evidence.content))!==ref.sha256)throw Error('evidence_changed');}
 return {package:p as SocialMvpExecutionPackage,clips,estimatedCosts:{A:null,B:null,total:null},gaps:['mvp_source_adapter_authority_verification_required','mvp_media_technical_inspection_required','mvp_final_human_creative_acceptance_required']};
 }catch(error){return {...missing,gaps:[error instanceof Error?error.message:'mvp_handoff_invalid']};}
}
