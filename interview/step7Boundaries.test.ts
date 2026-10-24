import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {HeyGenRequestError} from '../server/lib/heygen.js';
import type {Storyboard} from './storyboard.js';
import {assertCanReserve, settle} from './step4Budget.js';
import {describeError, step5ErrorCode} from './step5Pipeline.js';
import {
  runStep5Generation,
  validateGenerationPresenterMedia,
  type PreparedStep5Generation,
  type Step5GenerationDependencies,
  type Step5GenerationReceipt,
} from './step5Generation.js';

const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const FIXED = new Date('2026-10-24T12:00:00Z');
const STORYBOARD_SHA = 'd'.repeat(64);
const env = {
  INTERVIEW_REAL_MODE: '1',
  HEYGEN_API_KEY: 'test-key-not-real',
  STEP5_PAGE_GENERATION_ENABLED: '1',
  HEYGEN_INTERVIEW_MAX_CNY: '8',
};
const credentialHash = sha(String(env.HEYGEN_API_KEY));

type ClientFactory = NonNullable<Step5GenerationDependencies['clientFactory']>;
type ClientCallbacks = Parameters<ClientFactory>[1];

function board(): Storyboard {
  return {
    schemaVersion: 1, referenceFile: 'assets/storyboard.json',
    targetDurationSeconds: 3.2, language: 'en',
    presenter: {
      provider: 'heygen', ownership: 'public',
      avatarId: 'avatar_public_1', voiceId: 'voice_public_1',
    },
    shots: [{
      id: 'hook', kind: 'presenter', startSeconds: 0, durationSeconds: 3.2,
      speech: 'Meet your new digital teammate.', subtitle: 'Meet your new teammate.',
      framing: 'medium', source: null,
    }],
  };
}

function prepared(): PreparedStep5Generation {
  return {
    capCny: 8,
    credentialHash,
    accountRef: 'acct_test',
    wallet: {billingType: 'wallet', currency: 'USD', balance: 2.3, autoReload: false},
    preflight: {
      checkedAt: FIXED.toISOString(), catalogSha256: 'c'.repeat(64),
      avatar: {}, voice: {}, engine: 'orca',
    },
    publicEvidence: {ownership: 'public'},
    providerEvidenceRef: 'heygen-public-catalog:c',
    presenterAssetId: 'presenter-public-storyboard',
    narrationEngine: 'orca',
  } as unknown as PreparedStep5Generation;
}

function budget(overrides: Record<string, unknown> = {}): any {
  return {
    schemaVersion: 1, approvedCny: 8, credentialHash, storyboardSha256: STORYBOARD_SHA,
    fx: {date: '2026-10-24', cnyPerUsd: 7.2}, avatarUsdPerMinute: 1,
    speechUsdPerMillionChars: 0.5,
    reservedCny: 0, chargedCny: 0, observedSpendCny: 0, paidSubmissions: 0, operations: [],
    createdAt: FIXED.toISOString(), updatedAt: FIXED.toISOString(),
    ...overrides,
  };
}

async function workspace(overrides: Record<string, unknown> = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'step7-boundaries-'));
  const budgetFile = path.join(root, 'budget.json');
  await fs.writeFile(budgetFile, JSON.stringify(budget(overrides), null, 2));
  const step4ShotsRoot = path.join(root, 'step4-shots');
  const step4NarrationRoot = path.join(root, 'step4-narration');
  await fs.mkdir(step4ShotsRoot, {recursive: true});
  await fs.mkdir(step4NarrationRoot, {recursive: true});
  return {
    root, budgetFile, stateRoot: path.join(root, 'generated'),
    step4ShotsRoot, step4NarrationRoot,
    async cleanup() { await fs.rm(root, {recursive: true, force: true}); },
  };
}

function deps(
  space: Awaited<ReturnType<typeof workspace>>,
  overrides: Partial<Step5GenerationDependencies> = {},
): Step5GenerationDependencies {
  return {
    env,
    budgetFile: space.budgetFile,
    stateRoot: space.stateRoot,
    step4ShotsRoot: space.step4ShotsRoot,
    step4NarrationRoot: space.step4NarrationRoot,
    now: () => FIXED,
    sleep: async () => undefined,
    pollIntervalMs: 1,
    pollTimeoutMs: 5_000,
    wallet: async () => ({billingType: 'wallet', currency: 'USD', balance: 2.3, autoReload: false}),
    download: async (_url, kind) => Buffer.from(`media-${kind}`),
    validatePresenterMedia: async () => ({durationSeconds: 3.1, width: 720, height: 1280}),
    validateNarrationMedia: async () => ({durationSeconds: 2.6, codec: 'mp3'}),
    narration: async () => ({
      ok: true as const,
      data: {audioUrl: 'https://files.heygen.ai/narration.mp3', duration: 2.6, engine: 'orca'},
    }),
    listVideos: async () => [],
    getVideo: async () => null,
    ...overrides,
  };
}

function run(space: Awaited<ReturnType<typeof workspace>>, overrides: Partial<Step5GenerationDependencies> = {}) {
  return runStep5Generation({
    ...deps(space, overrides),
    storyboard: board(), storyboardSha256: STORYBOARD_SHA,
    confirmedCapCny: 8, prepared: prepared(),
  });
}

function creatingClient(
  callbacks: ClientCallbacks,
  counters: {posts: number},
  failure?: Error,
): ReturnType<ClientFactory> {
  return {
    async create(request, requestId) {
      await callbacks.beforeSubmit(request, requestId);
      counters.posts += 1;
      if (failure) throw failure;
      await callbacks.onAccepted('video_known_0001', requestId);
      return 'video_known_0001';
    },
    async status() {
      return {status: 'completed' as const, url: 'https://files.heygen.ai/video.mp4', duration: 3.1};
    },
  };
}

function statusOnlyClient(): ReturnType<ClientFactory> {
  return {
    async create() { throw new Error('must not submit again'); },
    async status() {
      return {status: 'completed' as const, url: 'https://files.heygen.ai/video.mp4', duration: 3.1};
    },
  };
}

test('a 401 auth failure is rejected once, releases the reservation and is readable', async () => {
  const space = await workspace();
  const receipts: Step5GenerationReceipt[] = [];
  const counters = {posts: 0};
  try {
    await assert.rejects(run(space, {
      recordReceipt: async receipt => { receipts.push(receipt); },
      clientFactory: ((_key, callbacks) => creatingClient(
        callbacks, counters, new HeyGenRequestError(401, 'unauthorized'))) as ClientFactory,
    }), /step5_generation_rejected_no_resubmit/);

    assert.equal(counters.posts, 1, 'auth failure must not be retried');
    const saved = JSON.parse(await fs.readFile(space.budgetFile, 'utf8'));
    assert.equal(saved.reservedCny, 0, 'known rejection releases the reservation');
    assert.equal(saved.chargedCny, 0);
    assert.equal(saved.paidSubmissions, 0);
    const state = JSON.parse(await fs.readFile(
      path.join(space.stateRoot, 'hook', 'state.json'), 'utf8'));
    assert.equal(state.phase, 'rejected');
    assert.equal(state.paidSubmissions, 1);
    assert.match(describeError(new HeyGenRequestError(401, 'unauthorized')), /鉴权/);
    assert.equal(receipts.filter(item => item.state === 'failed').length, 1);
  } finally {
    await space.cleanup();
  }
});

test('429 and 5xx submissions stay unknown, keep the reservation and never resubmit', async () => {
  for (const status of [429, 500]) {
    const space = await workspace();
    const counters = {posts: 0};
    try {
      await assert.rejects(run(space, {
        clientFactory: ((_key, callbacks) => creatingClient(
          callbacks, counters, new HeyGenRequestError(status, 'provider_unavailable'))) as ClientFactory,
      }), /step5_submission_unknown/);
      assert.equal(counters.posts, 1);

      const saved = JSON.parse(await fs.readFile(space.budgetFile, 'utf8'));
      assert.ok(saved.reservedCny > 0, 'unknown result must keep the reservation');
      assert.equal(saved.paidSubmissions, 0);
      const state = JSON.parse(await fs.readFile(
        path.join(space.stateRoot, 'hook', 'state.json'), 'utf8'));
      assert.equal(state.phase, 'submission_unknown');
      assert.equal(state.paidSubmissions, 1);

      // A later run may only list-reconcile; it must not send another POST.
      await assert.rejects(run(space, {
        clientFactory: (() => { throw new Error('must not submit or poll'); }) as ClientFactory,
        listVideos: async () => [],
      }), /step5_submission_unknown/);
      assert.equal(counters.posts, 1);
    } finally {
      await space.cleanup();
    }
  }
});

test('a status-read 429 waits on the existing video id instead of resubmitting', async () => {
  const space = await workspace();
  const counters = {posts: 0};
  try {
    await assert.rejects(run(space, {
      pollTimeoutMs: 0,
      clientFactory: ((_key, callbacks) => ({
        async create(request, requestId) {
          await callbacks.beforeSubmit(request, requestId);
          counters.posts += 1;
          await callbacks.onAccepted('video_status_0001', requestId);
          return 'video_status_0001';
        },
        async status() { throw new HeyGenRequestError(429, 'rate_limited'); },
      })) as ClientFactory,
    }), /step5_provider_pending/);

    assert.equal(counters.posts, 1);
    const saved = JSON.parse(await fs.readFile(space.budgetFile, 'utf8'));
    assert.ok(saved.reservedCny > 0);
    const state = JSON.parse(await fs.readFile(
      path.join(space.stateRoot, 'hook', 'state.json'), 'utf8'));
    assert.equal(state.phase, 'accepted');
    assert.match(String(state.lastError), /429/);
    assert.match(describeError(new Error('step5_provider_pending:hook:status_read_failed')), /仍在处理/);
  } finally {
    await space.cleanup();
  }
});

test('a download failure retries the same video id without a second submission', async () => {
  const space = await workspace();
  const counters = {posts: 0};
  const receipts: Step5GenerationReceipt[] = [];
  try {
    await assert.rejects(run(space, {
      recordReceipt: async receipt => { receipts.push(receipt); },
      download: async () => { throw new Error('step5_generation_download_failed:502'); },
      clientFactory: ((_key, callbacks) => creatingClient(callbacks, counters)) as ClientFactory,
    }), /step5_generation_download_failed/);

    assert.equal(counters.posts, 1);
    assert.equal(receipts.some(item => item.state === 'completed'), false);
    const failedState = JSON.parse(await fs.readFile(
      path.join(space.stateRoot, 'hook', 'state.json'), 'utf8'));
    assert.equal(failedState.phase, 'accepted');
    assert.match(String(failedState.lastError), /download_failed/);
    const failedBudget = JSON.parse(await fs.readFile(space.budgetFile, 'utf8'));
    assert.ok(failedBudget.reservedCny > 0);

    const result = await run(space, {
      recordReceipt: async receipt => { receipts.push(receipt); },
      download: async (_url, kind) => Buffer.from(`retried-${kind}`),
      clientFactory: (() => statusOnlyClient()) as ClientFactory,
    });
    assert.equal(counters.posts, 1, 'the retry must not create a new provider task');
    assert.equal(result.counters.newPaidSubmissions, 0);
    const recovered = JSON.parse(await fs.readFile(
      path.join(space.stateRoot, 'hook', 'state.json'), 'utf8'));
    assert.equal(recovered.phase, 'downloaded');
    assert.equal(recovered.provider.videoId, 'video_known_0001');
    const settled = JSON.parse(await fs.readFile(space.budgetFile, 'utf8'));
    assert.equal(settled.reservedCny, 0);
    assert.ok(settled.chargedCny > 0);
    assert.ok(receipts.some(item => item.state === 'completed'));
  } finally {
    await space.cleanup();
  }
});

test('a real ffmpeg probe rejects corrupt media without writing it back as success', async () => {
  const space = await workspace();
  try {
    const corrupt = path.join(space.root, 'corrupt.mp4');
    await fs.writeFile(corrupt, 'this is not an mp4');
    await assert.rejects(
      validateGenerationPresenterMedia(corrupt, 3.1),
      /step5_generation_media_probe_failed/,
    );
    assert.match(describeError(new Error('step5_generation_media_probe_failed')), /无法解析/);
  } finally {
    await space.cleanup();
  }
});

test('corrupt media retries the download and never marks the shot completed early', async () => {
  const space = await workspace();
  const counters = {posts: 0};
  const receipts: Step5GenerationReceipt[] = [];
  try {
    await assert.rejects(run(space, {
      recordReceipt: async receipt => { receipts.push(receipt); },
      download: async () => Buffer.from('corrupt-media'),
      validatePresenterMedia: async () => { throw new Error('step5_generation_media_probe_failed'); },
      clientFactory: ((_key, callbacks) => creatingClient(callbacks, counters)) as ClientFactory,
    }), /step5_generation_media_probe_failed/);

    assert.equal(counters.posts, 1);
    assert.equal(receipts.some(item => item.state === 'completed'), false);
    const failedState = JSON.parse(await fs.readFile(
      path.join(space.stateRoot, 'hook', 'state.json'), 'utf8'));
    assert.equal(failedState.phase, 'accepted');
    assert.equal(failedState.mediaFile, undefined);

    const result = await run(space, {
      recordReceipt: async receipt => { receipts.push(receipt); },
      download: async () => Buffer.from('valid-media'),
      clientFactory: (() => statusOnlyClient()) as ClientFactory,
    });
    assert.equal(counters.posts, 1);
    assert.equal(result.counters.newPaidSubmissions, 0);
    const recovered = JSON.parse(await fs.readFile(
      path.join(space.stateRoot, 'hook', 'state.json'), 'utf8'));
    assert.equal(recovered.phase, 'downloaded');
    assert.ok(receipts.some(item => item.state === 'completed'));
  } finally {
    await space.cleanup();
  }
});

test('insufficient budget is rejected before any provider or wallet call', async () => {
  const space = await workspace({chargedCny: 7.9});
  const counters = {posts: 0};
  let walletCalls = 0;
  try {
    await assert.rejects(run(space, {
      wallet: async () => {
        walletCalls += 1;
        return {billingType: 'wallet', currency: 'USD', balance: 2.3, autoReload: false};
      },
      clientFactory: ((_key, callbacks) => creatingClient(callbacks, counters)) as ClientFactory,
    }), /step4_forecast_exceeds_approved_budget/);

    assert.equal(counters.posts, 0);
    assert.equal(walletCalls, 0, 'budget guard runs before the wallet read');
    await assert.rejects(fs.access(path.join(space.stateRoot, 'hook', 'state.json')));
    const saved = JSON.parse(await fs.readFile(space.budgetFile, 'utf8'));
    assert.equal(saved.reservedCny, 0);
    assert.equal(saved.chargedCny, 7.9);
    assert.match(describeError(new Error('step4_forecast_exceeds_approved_budget')), /预算不足/);

    // Reservations from other in-flight operations count toward the same cap.
    const concurrencyLedger = budget({chargedCny: 7, reservedCny: 0.9});
    assert.throws(() => assertCanReserve(concurrencyLedger, 0.744),
      /step4_forecast_exceeds_approved_budget/);
  } finally {
    await space.cleanup();
  }
});

test('settlement uses the larger of wallet delta and price estimate and increments paid submissions', () => {
  const lowWallet = budget({reservedCny: 1});
  const low = settle(lowWallet, {
    kind: 'presenter_shot', id: 'hook', at: FIXED.toISOString(),
    requestedAt: FIXED.toISOString(), forecastCny: 1, estimatedCny: 0.8,
    observedDeltaCny: 0.5, walletBefore: 2.3, walletAfter: 2.25, providerRef: 'video_1',
  });
  assert.equal(low.chargedCny, 0.8);
  assert.equal(lowWallet.reservedCny, 0);
  assert.equal(lowWallet.chargedCny, 0.8);
  assert.equal(lowWallet.observedSpendCny, 0.5);
  assert.equal(lowWallet.paidSubmissions, 1);

  const highWallet = budget({reservedCny: 1});
  const high = settle(highWallet, {
    kind: 'presenter_shot', id: 'hook', at: FIXED.toISOString(),
    requestedAt: FIXED.toISOString(), forecastCny: 1, estimatedCny: 0.8,
    observedDeltaCny: 1.2, walletBefore: 2.3, walletAfter: 1.1, providerRef: 'video_1',
  });
  assert.equal(high.chargedCny, 1.2);
  assert.equal(highWallet.observedSpendCny, 1.2);
  assert.equal(step5ErrorCode(new Error('step5_generation_download_failed:502')),
    'step5_generation_download_failed');
});
