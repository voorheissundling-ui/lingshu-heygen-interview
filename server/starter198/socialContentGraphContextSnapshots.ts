import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {socialRequestHash,socialObject} from './socialContentValidation.js';
import type {SocialGraphApprovedContext} from './socialContentProductionExecution.js';
const root=()=>path.resolve('data/social-content-graph-contexts');
export function readGraphContextSnapshot(payload:Record<string,unknown>|null|undefined,snapshotRoot=root()):SocialGraphApprovedContext|null {
 if(!payload)return null;
 const inline=socialObject(payload.approvedContext);
 if(inline)return inline as unknown as SocialGraphApprovedContext;
 const hash=String(payload.approvedContextHash||'');if(!/^[a-f0-9]{64}$/.test(hash))return null;
 const context=JSON.parse(fs.readFileSync(path.join(snapshotRoot,hash+'.json'),'utf8'));
 if(socialRequestHash(context)!==hash)throw Error('graph_context_snapshot_changed');
 return context;
}
/** Snapshot bytes are durable before the compact job reference is published. */
export function compactGraphContextSnapshot(payload:Record<string,unknown>,snapshotRoot=root()):Record<string,unknown>{
 const context=readGraphContextSnapshot(payload,snapshotRoot);if(!context)throw Error('graph_context_snapshot_missing');
 const hash=socialRequestHash(context),dir=path.resolve(snapshotRoot),file=path.join(dir,hash+'.json');fs.mkdirSync(dir,{recursive:true,mode:0o700});
 if(fs.existsSync(file)){if(socialRequestHash(JSON.parse(fs.readFileSync(file,'utf8')))!==hash)throw Error('graph_context_snapshot_changed');}
 else{const temp=file+'.'+randomUUID()+'.tmp',fd=fs.openSync(temp,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(context));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temp,file);const directory=fs.openSync(dir,'r');try{fs.fsyncSync(directory);}finally{fs.closeSync(directory);}}
 const {approvedContext:_,...rest}=payload;return {...rest,approvedContextHash:hash};
}
