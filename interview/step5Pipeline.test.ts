import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STEP5_PHASES, buildIdempotencyKey, describeError, step5ErrorCode, toPublicState,
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
      mode: 'recomposed', file: 'D:/secret/local/final.mp4', bytes: 123,
      sha256: 'c'.repeat(64), manifestSha256: null,
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

test('provider-side failures fall back to readable Chinese categories', () => {
  assert.match(describeError(new Error('heygen_read_401')), /鉴权失败/);
  assert.match(describeError(new Error('heygen_read_429')), /限流/);
  assert.match(describeError(new Error('provider_budget_exceeded')), /预算/);
  assert.match(describeError(new Error('media_download_http_502')), /下载|网络/);
  assert.match(describeError(new Error('ffmpeg invalid data found')), /媒体损坏/);
});
