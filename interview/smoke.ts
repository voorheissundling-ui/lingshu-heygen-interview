import assert from 'node:assert/strict';import {seed,snapshot,executeLocal,scan} from './control.js';
await seed();let before=await snapshot();assert.equal(before.artifacts.length,0);assert.equal(before.jobs.length,1);
const job=await executeLocal();assert.equal(job.status,'succeeded',JSON.stringify(job));const result=await scan();assert.equal(result.status,'succeeded',JSON.stringify(result));
const after=await snapshot();assert.equal(after.weekly[0].payload.status,'succeeded');assert.equal(after.artifacts.length,1);assert.equal(after.artifacts[0].status,'review_required');
await executeLocal();await scan();const replay=await snapshot();assert.equal(replay.artifacts.length,1);assert.equal(replay.jobs.length,1);assert.equal(replay.jobs[0].attempt,1);
console.log(JSON.stringify({smoke:'PASS',taskId:after.weekly[0].task_id,jobId:job.id,runId:job.runId,artifactId:after.artifacts[0].artifact_id,sha256:after.artifacts[0].content.mediaStorage.video.sha256,humanReview:'pending',replay:'no_duplicate'},null,2));
