import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  STORYBOARD_ASSET_PATH,
  findClientTenantFields,
  parseStoryboardText,
  readStoryboardFile,
  saveStoryboardFile,
  storyboardSummary,
  validateStoryboard,
  type Storyboard,
  type StoryboardSource,
} from './storyboard.js';

const loaded = await readStoryboardFile(STORYBOARD_ASSET_PATH, {requireExists: true});
assert.ok(loaded.storyboard, JSON.stringify(loaded.issues));
const valid: Storyboard = loaded.storyboard;
const clone = (): Storyboard => structuredClone(valid);
const codes = (result: ReturnType<typeof validateStoryboard>): string[] =>
  result.ok ? [] : result.issues.map(issue => issue.code);

test('delivered storyboard passes and keeps the required shape', () => {
  const check = validateStoryboard(valid);
  assert.equal(check.ok, true, check.ok ? '' : JSON.stringify(check.issues));
  assert.deepEqual(storyboardSummary(valid), {
    shots: 6,
    presenterShots: 3,
    illustrationShots: 3,
    totalSeconds: 33.5,
  });
  assert.ok(valid.shots.every(shot => shot.kind === 'presenter' ? shot.source === null : shot.source?.license));
});

test('timeline gaps and overlaps are rejected', () => {
  const gap = clone();
  gap.shots[1].startSeconds = 5.5;
  gap.shots[1].durationSeconds = 6;
  assert.ok(codes(validateStoryboard(gap)).includes('timeline_gap'));

  const overlap = clone();
  overlap.shots[1].startSeconds = 4.5;
  overlap.shots[1].durationSeconds = 6.5;
  overlap.shots[2].startSeconds = 11;
  overlap.shots[2].durationSeconds = 5;
  assert.ok(codes(validateStoryboard(overlap)).includes('timeline_overlap'));
});

test('the two presenter / two illustration minimums are enforced', () => {
  const fewPresenters = clone();
  for (const index of [2, 5]) {
    fewPresenters.shots[index].kind = 'illustration';
    fewPresenters.shots[index].source = structuredClone(valid.shots[1].source);
  }
  assert.ok(codes(validateStoryboard(fewPresenters)).includes('presenter_shot_minimum'));

  const noIllustrations = clone();
  for (const index of [1, 3, 4]) {
    noIllustrations.shots[index].kind = 'presenter';
    noIllustrations.shots[index].source = null;
  }
  assert.ok(codes(validateStoryboard(noIllustrations)).includes('illustration_shot_minimum'));
});

test('illustration source, license and local file are validated', () => {
  const missingSource = clone();
  missingSource.shots[1].source = null;
  assert.ok(codes(validateStoryboard(missingSource)).includes('illustration_source_required'));

  const missingLicense = clone();
  missingLicense.shots[1].source = {
    localFile: valid.shots[1].source?.localFile,
    author: valid.shots[1].source?.author,
  } as StoryboardSource;
  assert.ok(codes(validateStoryboard(missingLicense)).includes('required'));

  const placeholderLicense = clone();
  placeholderLicense.shots[1].source!.license = 'TO_BE_VERIFIED';
  assert.ok(codes(validateStoryboard(placeholderLicense)).includes('placeholder_value'));

  const missingFile = clone();
  missingFile.shots[1].source!.localFile = 'assets/illustrations/does-not-exist.png';
  assert.ok(codes(validateStoryboard(missingFile)).includes('source_file_missing'));
});

test('reference-video pixels are forbidden as illustration material', () => {
  const localReference = clone();
  localReference.shots[1].source!.localFile = 'assets/reference-analysis-only.mp4';
  const localCodes = codes(validateStoryboard(localReference));
  assert.ok(localCodes.includes('reference_pixels_forbidden'));
  assert.ok(localCodes.includes('reference_used_as_source'));

  const remoteReference = clone();
  remoteReference.shots[1].source = {
    sourceUrl: 'https://www.tiktok.com/@yuchengcosmeticsfactory/video/7449962848203181354',
    license: 'Original work created for this exercise; CC0-1.0.',
  };
  assert.ok(codes(validateStoryboard(remoteReference)).includes('reference_source_forbidden'));
});

test('client-supplied tenant identity is rejected at any depth', () => {
  const payload = {
    ...clone(),
    tenantId: 'foreign',
    shots: [{...valid.shots[0], tenant_id: 'foreign'}],
  };
  const issues = findClientTenantFields(payload);
  assert.equal(issues.length, 2);
  assert.ok(issues.every(issue => issue.code === 'client_tenant_not_accepted'));
  assert.deepEqual(
    new Set(issues.map(issue => issue.path)),
    new Set(['$.tenantId', '$.shots[0].tenant_id']),
  );
});

test('invalid JSON returns a field-level issue', () => {
  const parsed = parseStoryboardText('{');
  assert.equal(parsed.ok, false);
  assert.equal(parsed.ok ? '' : parsed.issues[0].code, 'invalid_json');
});

test('catalog placeholders and clone ownership are rejected', () => {
  const placeholder = clone();
  placeholder.presenter.avatarId = 'SELECT_FROM_LIVE_CATALOG';
  assert.ok(codes(validateStoryboard(placeholder)).includes('placeholder_value'));

  const cloneOwnership = clone();
  (cloneOwnership.presenter as {ownership: string}).ownership = 'clone';
  assert.ok(codes(validateStoryboard(cloneOwnership)).includes('public_ownership_required'));
});

test('duration range and target/sum agreement are enforced', () => {
  const tooShort = clone();
  tooShort.targetDurationSeconds = 29.5;
  assert.ok(codes(validateStoryboard(tooShort)).includes('number_out_of_range'));

  const mismatch = clone();
  mismatch.targetDurationSeconds = 34;
  assert.ok(codes(validateStoryboard(mismatch)).includes('timeline_duration_mismatch'));
});

test('save is atomic and read-back validates with the same hash', async () => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'storyboard-'));
  const file = path.join(directory, 'storyboard.json');
  try {
    const saved = await saveStoryboardFile(valid, file);
    const read = await readStoryboardFile(file, {requireExists: true});
    assert.equal(read.ok, true, JSON.stringify(read.issues));
    assert.equal(read.sha256, saved.sha256);
    assert.equal(read.storyboard?.shots.length, 6);
    assert.match(saved.sha256, /^[a-f0-9]{64}$/);
  } finally {
    await fsp.rm(directory, {recursive: true, force: true});
  }
});
