import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STEP5_PHASES, adoptStep4Manifest, buildIdempotencyKey, describeError, step5ErrorCode, toPublicState,
  validateFinalProbe, type Step5State,
} from './step5Pipeline.js';

const identity = {
  taskId: 'video', runId: 'run', storyboardSha256: 'a'.repeat(64),
  avatarId: 'avatar-1', voiceId: 'voice-1',
};

test('Step 5 idempotency key is stable and changes with pinned identity', () => {
  const first = buildIdempotencyKey(identity);
  assert.equal(first, buildIdempotencyKey({...identity}));
  assert.notEqual(first, buildIdempotencyKey({...identity, storyboardSha256: 'b'.repeat(64)}));
  assert.notEqual(first, buildIdempotencyKey({...identity, avatarId: 'avatar-2'}));
  assert.notEqual(first, buildIdempotencyKey({...identity, voiceId: 'voice-2'}));
  assert.match(first, /^[a-f0-9]{64}$/);
});

test('generation mode gets its own idempotency identity but reuse stays byte-identical', () => {
  assert.equal(buildIdempotencyKey(identity), buildIdempotencyKey({...identity, mode: 'reuse'}));
  const generated = buildIdempotencyKey({...identity, mode: 'generate'});
  assert.notEqual(generated, buildIdempotencyKey(identity));
  assert.match(generated, /^[a-f0-9]{64}$/);
});

const generatedSummary = {
  capCny: 8, approvedCny: 8, budgetChargedCny: 1.2, budgetReservedCny: 0,
  budgetRemainingCny: 6.8, newPaidSubmissions: 2, newChargedCny: 1.2,
  reusedShots: 0, presentersGenerated: 1, narrationGenerated: 1, reconciledShots: 0,
  narrationEngine: 'orca' as const, preflightCheckedAt: '2026-10-24T12:00:00.000Z',
  accountRef: 'heygen:test', shots: [{
    shotId: 'hook', kind: 'presenter' as const, phase: 'downloaded',
    requestId: 'interview-step5-presenter-hook-aaaaaaaaaaaa',
    title: 'LingShu Step5 hook aaaaaaaa',
    providerTaskId: 'video_1', providerStatus: 'completed', durationSeconds: 3.1,
    chargedCny: 0.5, reusedFrom: null, reconciliation: null,
  }],
};

test('public generation state exposes mode and counters but not request bodies or media URLs', () => {
  const state: Step5State = {
    schemaVersion: 1, idempotencyKey: 'e'.repeat(64), mode: 'generate', phase: 'review_required',
    taskId: 'video', contentTaskId: 'content', runId: 'run', jobId: 'job-1', weeklyTaskId: 'video',
    storyboardSha256: 'a'.repeat(64), avatarId: 'avatar-1', voiceId: 'voice-1',
    startedAt: '2026-10-24T12:00:00.000Z', updatedAt: '2026-10-24T12:05:00.000Z',
    stages: Object.fromEntries(STEP5_PHASES.map(name => [name, {name, status: 'done'}])) as Step5State['stages'],
    provider: {
      source: 'live-generated', approvedCny: 8, chargedCny: 1.2, paidSubmissions: 2,
      shots: [], generation: generatedSummary,
      note: '页面已确认 8 CNY 上限；仅提交内容发生变化的镜头。',
      live: {
        mode: 'generation', newPaidSubmissions: 2, newChargedCny: 1.2, statusCalls: 3,
        downloads: 2, uploads: 0, presentersAdopted: 0,
        accountRef: 'heygen:test', presenterAssetId: 'presenter-public-storyboard',
      },
    },
  };
  const published = toPublicState(state);
  assert.ok(published);
  assert.equal(published.mode, 'generate');
  assert.equal(published.active, false);
  assert.equal(published.generation?.newPaidSubmissions, 2);
  assert.equal(published.generation?.shots[0]?.providerTaskId, 'video_1');
  assert.equal(published.provider?.source, 'live-generated');
  assert.equal(published.provider?.live?.mode, 'generation');
  const serialized = JSON.stringify(published);
  assert.equal(serialized.includes('"providerRequest"'), false);
  assert.equal(serialized.includes('.mp4'), false);
  assert.equal(serialized.includes('https://'), false);
});

test('an unknown submission is terminal and inactive until reconciled', () => {
  const state: Step5State = {
    schemaVersion: 1, idempotencyKey: 'e'.repeat(64), mode: 'generate', phase: 'submission_unknown',
    taskId: 'video', contentTaskId: 'content', runId: 'run', jobId: 'job-1', weeklyTaskId: 'video',
    storyboardSha256: 'a'.repeat(64), avatarId: 'avatar-1', voiceId: 'voice-1',
    startedAt: '2026-10-24T12:00:00.000Z', updatedAt: '2026-10-24T12:00:05.000Z',
    stages: Object.fromEntries(STEP5_PHASES.map(name => [name, {name, status: 'pending'}])) as Step5State['stages'],
  };
  const published = toPublicState(state);
  assert.ok(published);
  assert.equal(published.active, false);
  assert.equal(published.mode, 'generate');
  assert.equal(published.generation, null);
  assert.match(describeError(new Error('step5_submission_unknown:hook')), /对账/);
  assert.match(describeError(new Error('step5_generation_cap_not_configured')), /上限/);
  assert.match(describeError(new Error('step5_generation_disabled')), /未启用/);
});

test('Step 5 phase contract matches the workbench requirement', () => {
  assert.deepEqual([...STEP5_PHASES], [
    'prepared', 'submitting', 'accepted', 'generating',
    'downloading', 'compositing', 'writing_back', 'review_required',
  ]);
});

test('final media must be 30-37s, 1080x1920, H.264/AAC and decodable', () => {
  const good = {
    durationSeconds: 33.52, width: 1080, height: 1920,
    videoCodec: 'h264', audioCodec: 'aac', sampleRate: 44100, decodable: true,
  };
  assert.deepEqual(validateFinalProbe(good), []);
  assert.ok(validateFinalProbe({...good, durationSeconds: 29.9}).includes('final_duration_out_of_range'));
  assert.ok(validateFinalProbe({...good, durationSeconds: 37.1}).includes('final_duration_out_of_range'));
  assert.ok(validateFinalProbe({...good, width: 720}).includes('final_resolution_not_1080x1920'));
  assert.ok(validateFinalProbe({...good, videoCodec: 'vp9'}).includes('final_video_codec_not_h264'));
  assert.ok(validateFinalProbe({...good, audioCodec: 'mp3'}).includes('final_audio_codec_not_aac'));
  assert.ok(validateFinalProbe({...good, decodable: false}).includes('final_decode_failed'));
});

test('public pipeline state exposes progress but never the absolute media path', () => {
  const stages = Object.fromEntries(STEP5_PHASES.map((name, index) => [name, {
    name,
    status: index < 6 ? 'done' : 'pending',
    startedAt: '2026-10-23T10:00:00.000Z',
    completedAt: index < 6 ? '2026-10-23T10:00:01.000Z' : undefined,
  }])) as Step5State['stages'];
  const state: Step5State = {
    schemaVersion: 1,
    idempotencyKey: 'f'.repeat(64),
    phase: 'compositing',
    taskId: 'video', contentTaskId: 'content', runId: 'run', jobId: 'job-1', weeklyTaskId: 'video',
    storyboardSha256: 'a'.repeat(64), avatarId: 'avatar-1', voiceId: 'voice-1',
    startedAt: '2026-10-23T10:00:00.000Z', updatedAt: '2026-10-23T10:00:05.000Z', stages,
    composition: {
      mode: 'recomposed', providerMedia: 'step4-local', file: 'D:/secret/local/final.mp4', bytes: 123,
      sha256: 'c'.repeat(64), manifestSha256: null, adoptedManifestSha256: null,
      probe: {
        durationSeconds: 33.52, width: 1080, height: 1920,
        videoCodec: 'h264', audioCodec: 'aac', sampleRate: 44100, decodable: true,
      },
    },
    writeBack: {
      artifactId: 'socialart_1', fileId: 'socialfile_1', fileRef: 'socialfile:socialfile_1',
      sha256: 'c'.repeat(64), bytes: 123, status: 'review_required',
      taskId: 'content', runId: 'run', jobId: 'job-1',
      technicalApproved: false, creativeApproved: false,
    },
  };
  const published = toPublicState(state);
  assert.ok(published);
  assert.equal(published.active, true);
  assert.equal(published.composition?.fileName, 'final.mp4');
  assert.equal(JSON.stringify(published).includes('D:/secret/local/final.mp4'), false);
  assert.equal(published.mediaUrl, '/api/media?artifactId=socialart_1');
  assert.match(published.downloadUrl ?? '', /download=1$/);
  assert.equal(published.phases.length, 8);
  assert.equal(published.writeBack?.technicalApproved, false);
});

test('known Step 5 failures are rendered as readable Chinese messages', () => {
  const error = new Error('step5_provider_evidence_missing:hook');
  assert.equal(step5ErrorCode(error), 'step5_provider_evidence_missing');
  const message = describeError(error);
  assert.match(message, /找不到 Step 4/);
  assert.match(message, /hook/);
  assert.equal(step5ErrorCode(new Error('step5_execution_running')), 'step5_execution_running');
  assert.match(describeError(new Error('step5_execution_running')), /正在执行/);
});

test('Step 4 manifest adoption replaces only presenter videos matched by sceneId', () => {
  const manifest = {
    spec: {duration: 33.5},
    timeline: [
      {type: 'video', sceneId: 'hook', url: 'D:/old/hook.mp4', targetStart: 0, targetEnd: 3.2},
      {type: 'image', sceneId: 'product-range', url: 'assets/illustrations/product-range.png'},
      {type: 'video', sceneId: 'cta', url: 'D:/old/cta.mp4', targetStart: 26.3, targetEnd: 33.5},
    ],
    voiceover: {url: 'D:/old/voiceover.wav'},
  };
  const adopted = adoptStep4Manifest(manifest, {
    hook: 'D:/adopted/hook.mp4', cta: 'D:/adopted/cta.mp4',
  });
  assert.equal(adopted.timeline[0].url, 'D:/adopted/hook.mp4');
  assert.equal(adopted.timeline[2].url, 'D:/adopted/cta.mp4');
  assert.equal(adopted.timeline[1].url, 'assets/illustrations/product-range.png');
  assert.equal(adopted.voiceover.url, 'D:/old/voiceover.wav');
  assert.equal(manifest.timeline[0].url, 'D:/old/hook.mp4');
  assert.throws(() => adoptStep4Manifest(manifest, {hook: 'D:/adopted/hook.mp4'}),
    /step5_provider_evidence_missing:cta/);
  assert.throws(() => adoptStep4Manifest({timeline: []}, {}),
    /step5_live_bridge_requires_step4_manifest/);
});

test('public state exposes live adoption counters without scripts, evidence or paths', () => {
  const state: Step5State = {
    schemaVersion: 1, idempotencyKey: 'f'.repeat(64), phase: 'review_required',
    taskId: 'video', contentTaskId: 'content', runId: 'run', jobId: 'job-1', weeklyTaskId: 'video',
    storyboardSha256: 'a'.repeat(64), avatarId: 'avatar-1', voiceId: 'voice-1',
    startedAt: '2026-10-23T10:00:00.000Z', updatedAt: '2026-10-23T10:00:05.000Z',
    stages: Object.fromEntries(STEP5_PHASES.map(name => [name, {name, status: 'done'}])) as Step5State['stages'],
    provider: {
      source: 'live-bridge',
      shots: [{id: 'hook', kind: 'presenter', videoId: 'video-1', requestId: 'req-1',
        durationSeconds: 3.2, chargedCny: 0, providerStatus: 'completed',
        mediaSha256: 'b'.repeat(64), mediaBytes: 961494}],
      approvedCny: 8, chargedCny: 5.339473, paidSubmissions: 6,
      note: '通过原 bridge 在线查询并重新下载 Step 4 已受理的 video_id；本次新增付费提交 0 次、0 CNY，钱包不变。',
      live: {newPaidSubmissions: 0, newChargedCny: 0, statusCalls: 4, downloads: 3, uploads: 3,
        presentersAdopted: 3, accountRef: 'heygen:abc', presenterAssetId: 'presenter-public-storyboard'},
    },
    composition: {
      mode: 'recomposed', providerMedia: 'live-adopted', file: 'D:/private/final.mp4', bytes: 123,
      sha256: 'c'.repeat(64), manifestSha256: 'd'.repeat(64), adoptedManifestSha256: 'd'.repeat(64),
      probe: {durationSeconds: 33.52, width: 1080, height: 1920, videoCodec: 'h264',
        audioCodec: 'aac', sampleRate: 44100, decodable: true},
    },
  };
  const published = toPublicState(state);
  assert.ok(published);
  assert.equal(published.provider?.live?.newPaidSubmissions, 0);
  assert.equal(published.provider?.live?.downloads, 3);
  assert.equal(published.composition?.providerMedia, 'live-adopted');
  assert.equal(published.composition?.adoptedManifestSha256, 'd'.repeat(64));
  const serialized = JSON.stringify(published);
  assert.equal(serialized.includes('D:/private/final.mp4'), false);
  assert.equal(serialized.includes('authorizationRef'), false);
  assert.equal(serialized.includes('consentRef'), false);
});

test('new live-bridge failures have Chinese explanations', () => {
  assert.match(describeError(new Error('step5_credential_account_changed')), /账户与 Step 4/);
  assert.match(describeError(new Error('step5_provider_pending:hook')), /仍在处理中/);
  assert.match(describeError(new Error('step5_provider_receipt_incomplete:hook')), /回执/);
  assert.match(describeError(new Error('step5_live_bridge_requires_step4_manifest:assets')), /Step 4 清单/);
  assert.equal(step5ErrorCode(new Error('step5_adoption_only_no_new_submission')), 'step5_adoption_only_no_new_submission');
});

test('provider-side failures fall back to readable Chinese categories', () => {
  assert.match(describeError(new Error('heygen_read_401')), /鉴权失败/);
  assert.match(describeError(new Error('heygen_read_429')), /限流/);
  assert.match(describeError(new Error('provider_budget_exceeded')), /预算/);
  assert.match(describeError(new Error('media_download_http_502')), /下载|网络/);
  assert.match(describeError(new Error('ffmpeg invalid data found')), /媒体损坏/);
});
