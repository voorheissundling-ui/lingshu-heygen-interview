import test from 'node:test';
import assert from 'node:assert/strict';
import {buildStep4Plan, buildStep4RenderManifest, validateStep4Plan, type Step4Storyboard} from './step4Plan.js';

const storyboard: Step4Storyboard = {
  targetDurationSeconds: 33.5,
  language: 'en',
  shots: [
    {id: 'hook', kind: 'presenter', startSeconds: 0, durationSeconds: 5,
      speech: 'Hi there. Ready to launch your own skincare line?', subtitle: 'Launch your own skincare line', framing: 'portrait'},
    {id: 'product-range', kind: 'illustration', startSeconds: 5, durationSeconds: 6.5,
      speech: 'From brightening serums to gentle cleansers, we turn your formula into a retail-ready product.',
      subtitle: 'Serums, creams, cleansers — retail-ready', framing: 'product hero',
      source: {localFile: 'assets/illustrations/product-range.png'}},
    {id: 'capabilities', kind: 'presenter', startSeconds: 11.5, durationSeconds: 4.5,
      speech: 'Low minimums, transparent pricing, and packaging that fits your brand.',
      subtitle: 'Low MOQs. Clear pricing. Your branding.', framing: 'portrait'},
    {id: 'lab-process', kind: 'illustration', startSeconds: 16, durationSeconds: 5.5,
      speech: 'Our lab tests every batch for stability, texture, and safety before production.',
      subtitle: 'Every batch tested for stability and safety', framing: 'process diagram',
      source: {localFile: 'assets/illustrations/lab-process.png'}},
    {id: 'factory-quality', kind: 'illustration', startSeconds: 21.5, durationSeconds: 5,
      speech: 'Then our automated line fills, seals, and inspects each unit for a consistent finish.',
      subtitle: 'Automated filling, sealing, and QC', framing: 'factory line',
      source: {localFile: 'assets/illustrations/factory-quality.png'}},
    {id: 'cta', kind: 'presenter', startSeconds: 26.5, durationSeconds: 7,
      speech: 'Fifteen years of skincare manufacturing, with documentation from sample to shipment. Contact us for a quote.',
      subtitle: '15 years of manufacturing. Contact us for a quote.', framing: 'portrait'},
  ],
};

const presenterFiles = {
  hook: {file: '/tmp/hook.mp4', durationSeconds: 3.2},
  capabilities: {file: '/tmp/capabilities.mp4', durationSeconds: 5.3},
  cta: {file: '/tmp/cta.mp4', durationSeconds: 8.4},
};

const narrationFiles = {
  'product-range': {file: '/tmp/product.mp3', durationSeconds: 5.4},
  'lab-process': {file: '/tmp/lab.mp3', durationSeconds: 4.8},
  'factory-quality': {file: '/tmp/factory.mp3', durationSeconds: 4.6},
};

test('step4 plan: measured clips produce a contiguous 30-37 s timeline', () => {
  const plan = buildStep4Plan({storyboard, presenterFiles, narrationFiles});
  assert.deepEqual(validateStep4Plan(plan), []);
  assert.equal(plan.presenterShots, 3);
  assert.equal(plan.illustrationShots, 3);
  assert.ok(plan.totalDurationSeconds >= 30 && plan.totalDurationSeconds <= 37);
  // Presenter speech is never cut.
  assert.equal(plan.shots.find(shot => shot.id === 'hook')!.durationSeconds, 3.2);
  assert.equal(plan.shots.find(shot => shot.id === 'capabilities')!.durationSeconds, 5.3);
  assert.equal(plan.shots.find(shot => shot.id === 'cta')!.durationSeconds, 8.4);
  // Illustration clips outlast their narration.
  for (const shot of plan.shots.filter(item => item.kind === 'illustration')) {
    assert.ok(shot.durationSeconds >= (shot.narrationDurationSeconds ?? 0) + 0.15);
  }
  // Contiguous timeline.
  let cursor = 0;
  for (const shot of plan.shots) {
    assert.equal(shot.startSeconds, cursor);
    cursor = shot.endSeconds;
  }
  assert.equal(cursor, plan.totalDurationSeconds);
});

test('step4 plan: small durations are extended on static shots to reach 30 s', () => {
  const plan = buildStep4Plan({
    storyboard,
    presenterFiles: {
      hook: {file: '/tmp/hook.mp4', durationSeconds: 3},
      capabilities: {file: '/tmp/capabilities.mp4', durationSeconds: 3},
      cta: {file: '/tmp/cta.mp4', durationSeconds: 3},
    },
    narrationFiles: {
      'product-range': {file: '/tmp/product.mp3', durationSeconds: 3},
      'lab-process': {file: '/tmp/lab.mp3', durationSeconds: 3},
      'factory-quality': {file: '/tmp/factory.mp3', durationSeconds: 3},
    },
  });
  assert.deepEqual(validateStep4Plan(plan), []);
  assert.ok(plan.totalDurationSeconds >= 30);
  assert.equal(plan.shots.find(shot => shot.id === 'hook')!.durationSeconds, 3);
});

test('step4 plan: presenter speech that cannot fit 37 s is a hard failure', () => {
  assert.throws(() => buildStep4Plan({
    storyboard,
    presenterFiles: {
      hook: {file: '/tmp/hook.mp4', durationSeconds: 12},
      capabilities: {file: '/tmp/capabilities.mp4', durationSeconds: 12},
      cta: {file: '/tmp/cta.mp4', durationSeconds: 12},
    },
    narrationFiles,
  }), /presenter_speech_exceeds_maximum_duration/);
});

test('step4 plan: fewer than two presenter or illustration shots is rejected', () => {
  const onlyPresenter = {...storyboard, shots: storyboard.shots.filter(shot => shot.kind === 'presenter')};
  assert.throws(() => buildStep4Plan({
    storyboard: onlyPresenter,
    presenterFiles,
    narrationFiles: {},
  }), /requires_at_least_two_presenter_and_two_illustration_shots/);
});

test('step4 manifest: presenter clips keep source audio; illustration clips use aligned voiceover', () => {
  const plan = buildStep4Plan({storyboard, presenterFiles, narrationFiles});
  const manifest = buildStep4RenderManifest({plan, jobId: 'step4-test'}) as any;
  assert.equal(manifest.spec.ratio, '9:16');
  assert.equal(manifest.spec.resolution, '1080p');
  assert.equal(manifest.spec.duration, plan.totalDurationSeconds);
  assert.equal(manifest.frameContract.expectedFrames, Math.round(plan.totalDurationSeconds * 30));
  assert.equal(manifest.timeline.length, 6);
  for (const clip of manifest.timeline.filter((item: any) => item.type === 'video')) {
    assert.equal(clip.production.sound, 'source');
    assert.equal(clip.cropMode, 'cover');
    assert.equal(clip.voiceAligned, undefined);
  }
  for (const clip of manifest.timeline.filter((item: any) => item.type === 'image')) {
    assert.equal(clip.production.sound, 'voiceover');
    assert.equal(clip.voiceAligned, true);
    assert.equal(clip.voiceStart, clip.targetStart);
  }
  assert.equal(manifest.subtitles.cues.length, 6);
  for (let index = 1; index < manifest.subtitles.cues.length; index += 1) {
    assert.ok(manifest.subtitles.cues[index].start > manifest.subtitles.cues[index - 1].end);
  }
  assert.equal(manifest.subtitles.cues.at(-1).end <= plan.totalDurationSeconds, true);
  assert.equal(manifest.requireVisualAssets, true);
});
