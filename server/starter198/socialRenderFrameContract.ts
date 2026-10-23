import {socialObject} from './socialContentValidation.js';

export interface SocialRenderFrameContract {schemaVersion:'social-render-frame-contract.v1';fps:30;durationSeconds:number;expectedFrames:number}
/** The renderer uses -r 30 and -t duration. Only millisecond-frozen durations are admitted. */
export function freezeSocialRenderFrameContract(durationSeconds:number):SocialRenderFrameContract{
 if(!Number.isFinite(durationSeconds)||durationSeconds<1||durationSeconds>45||Math.abs(durationSeconds*1000-Math.round(durationSeconds*1000))>1e-6)throw Error('render_frame_contract_duration_invalid');
 const expectedFrames=Math.round(durationSeconds*30);
 if(expectedFrames<1||expectedFrames>1350)throw Error('render_frame_contract_frames_invalid');
 return {schemaVersion:'social-render-frame-contract.v1',fps:30,durationSeconds,expectedFrames};
}
export function readSocialRenderFrameContract(manifest:unknown):SocialRenderFrameContract|null{
 const m=socialObject(manifest),spec=socialObject(m?.spec),raw=socialObject(m?.frameContract);
 if(!raw||raw.schemaVersion!=='social-render-frame-contract.v1'||raw.fps!==30||typeof raw.durationSeconds!=='number'||raw.durationSeconds!==spec?.duration)return null;
 try{const expected=freezeSocialRenderFrameContract(raw.durationSeconds);return raw.expectedFrames===expected.expectedFrames?expected:null;}catch{return null;}
}
