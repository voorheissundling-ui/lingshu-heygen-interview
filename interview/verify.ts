import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';
import {snapshot,local} from './control.js';import {pbStore as store} from '../server/storage/pbStore.js';
import {objectStorageLocalRoot} from '../server/storage/objectStorage.js';
import {validateWeeklyExecutionResults} from '../server/runtime/socialWeeklyResultValidation.js';
await local(async()=>{const state=await snapshot();const task=state.weekly[0].payload;assert.equal(task.status,'succeeded');assert.equal(state.jobs[0].status,'succeeded');
 const check=(t=task)=>validateWeeklyExecutionResults(store,t,task.resultRefs,new Date('2026-10-02T12:00:00Z'));
 await check();await assert.rejects(check({...task,tenantId:'foreign'}));
 const artifact=state.artifacts[0],file=state.files.find((r:any)=>r.file_id===artifact.content.mediaStorage.video.fileId)!;
 assert.equal(file.storage_kind,'object');const base=objectStorageLocalRoot();const location=path.resolve(base,file.storage_key);assert.ok(location.startsWith(base+path.sep));const original=await fs.readFile(location);
 try{await fs.writeFile(location,Buffer.from('corrupted-media'));await assert.rejects(check());}finally{await fs.writeFile(location,original)}
 await check();console.log(JSON.stringify({verify:'PASS',persistedCompletedTask:true,wrongTenantRejected:true,corruptActualMediaRejected:true,restoredActualMediaAccepted:true,artifactStatus:artifact.status}));});
