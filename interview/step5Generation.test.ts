import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {HeyGenRequestError} from '../server/lib/heygen.js';
import type {Storyboard} from './storyboard.js';
import {
  STEP5_GENERATION_MAX_APPROVED_CNY,
  generationTitle,
  isStep5PageGenerationEnabled,
  narrationContentHash,
  narrationRequestId,
  prepareStep5Generation,
  presenterContentHash,
  presenterRequestId,
  reconcileStep5Generation,
  runStep5Generation,
  step5GenerationCapFromEnv,
  type PreparedStep5Generation,
  type Step5GenerationDependencies,
} from './step5Generation.js';

const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const FIXED = new Date('2026-10-24T12:00:00Z');
const env = {
  INTERVIEW_REAL_MODE: '1',
  HEYGEN_API_KEY: 'test-key-not-real',
  STEP5_PAGE_GENERATION_ENABLED: '1',
  HEYGEN_INTERVIEW_MAX_CNY: '8',
};
const credentialHash = sha(String(env.HEYGEN_API_KEY));

type ClientFactory = NonNullable<Step5GenerationDependencies['clientFactory']>;
type ClientCallbacks = Parameters<ClientFactory>[1];

function storyboard(): Storyboard {
  return {
    schemaVersion: 1, referenceFile: 'assets/storyboard.json',
    targetDurationSeconds: 33.5, language: 'en',
    presenter: {
      provider: 'heygen', ownership: 'public',
      avatarId: 'avatar_public_1', voiceId: 'voice_public_1',
    },
    shots: [
      {
        id: 'hook', kind: 'presenter', startSeconds: 0, durationSeconds: 3.2,
        speech: 'Meet your new digital teammate.', subtitle: 'Meet your new teammate.',
        framing: 'medium', source: null,
      },
      {
        id: 'product', kind: 'illustration', startSeconds: 3.2, durationSeconds: 5.2,
        speech: 'It answers every question with the same care.', subtitle: 'Care in every answer.',
        framing: 'wide', source: {localFile: 'assets/illustrations/product.png', license: 'CC0'},
      },
    ],
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

function budget(): any {
  return {
    schemaVersion: 1, approvedCny: 8, credentialHash, storyboardSha256: 'd'.repeat(64),
    fx: {date: '2026-10-24', cnyPerUsd: 7.2}, avatarUsdPerMinute: 1,
    speechUsdPerMillionChars: 0.5,
    reservedCny: 0, chargedCny: 0, observedSpendCny: 0, paidSubmissions: 0, operations: [],
    createdAt: FIXED.toISOString(), updatedAt: FIXED.toISOString(),
  };
}

async function workspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'step5-generation-'));
  const budgetFile = path.join(root, 'budget.json');
  await fs.writeFile(budgetFile, JSON.stringify(budget(), null, 2));
  await fs.mkdir(path.join(root, 'step4-shots'), {recursive: true});
  await fs.mkdir(path.join(root, 'step4-narration'), {recursive: true});
  return {
    root,
    budgetFile,
    stateRoot: path.join(root, 'generated'),
    step4ShotsRoot: path.join(root, 'step4-shots'),
    step4NarrationRoot: path.join(root, 'step4-narration'),
    async cleanup() { await fs.rm(root, {recursive: true, force: true}); },
  };
}

function deps(space: Awaited<ReturnType<typeof workspace>>): Step5GenerationDependencies {
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
  };
}

function generatedClient(callbacks: ClientCallbacks, counters: {posts: number}) {
  return {
    async create(request: any, requestId: string) {
      await callbacks.beforeSubmit(request, requestId);
      counters.posts += 1;
      const id = `video_generated_${counters.posts}`;
      await callbacks.onAccepted(id, requestId);
      return id;
    },
    async status() {
      return {status: 'completed' as const, url: 'https://files.heygen.ai/video.mp4', duration: 3.1};
    },
  };
}

test('content-addressed identities are stable and change only with content', () => {
  const speech = 'Meet your new digital teammate.';
  const presenter = presenterContentHash({avatarId: 'a', voiceId: 'v', speech});
  assert.equal(presenter, presenterContentHash({avatarId: 'a', voiceId: 'v', speech}));
  assert.notEqual(presenter, presenterContentHash({avatarId: 'a', voiceId: 'v', speech: speech + '!'}));
  assert.match(presenterRequestId('hook', presenter), /^interview-step5-presenter-hook-[a-f0-9]{12}$/);
  assert.notEqual(presenterRequestId('hook', presenter), presenterRequestId('cta', presenter));

  const narration = narrationContentHash({voiceId: 'v', engine: 'orca', language: 'en', text: 'Hi'});
  assert.notEqual(narration, narrationContentHash({voiceId: 'v', engine: 'starfish', language: 'en', text: 'Hi'}));
  assert.match(narrationRequestId('product', narration), /^interview-step5-tts-product-[a-f0-9]{12}$/);
  assert.equal(generationTitle('hook', presenter), `LingShu Step5 hook ${presenter.slice(0, 8)}`);
});

test('budget cap over 8 CNY or a mismatched confirmation fails before any provider call', async () => {
  const space = await workspace();
  try {
    let walletCalls = 0;
    await assert.rejects(prepareStep5Generation({
      store: {} as any, storyboard: storyboard(), confirmedCapCny: 9,
      env: {...env, HEYGEN_INTERVIEW_MAX_CNY: '9'}, budgetFile: space.budgetFile,
      wallet: async () => { walletCalls += 1; throw new Error('must not be called'); },
    }), /step5_generation_cap_exceeds_limit/);
    assert.equal(walletCalls, 0);

    await assert.rejects(prepareStep5Generation({
      store: {} as any, storyboard: storyboard(), confirmedCapCny: 5,
      env, budgetFile: space.budgetFile,
      wallet: async () => { walletCalls += 1; throw new Error('must not be called'); },
    }), /step5_generation_cap_confirmation_mismatch/);
    assert.equal(walletCalls, 0);
    assert.equal(step5GenerationCapFromEnv(env), STEP5_GENERATION_MAX_APPROVED_CNY);
    assert.equal(isStep5PageGenerationEnabled({...env, STEP5_PAGE_GENERATION_ENABLED: '0'}), false);
  } finally {
    await space.cleanup();
  }
});

test('a lost create response stops without resubmitting and a later run reconciles by list', async () => {
  const space = await workspace();
  try {
    const board = storyboard();
    const untrusted = {
      async create(request: any, requestId: string) {
        const callbacks = untrustedCallbacks!;
        await callbacks.beforeSubmit(request, requestId);
        throw new Error('socket hang up');
      },
      async status() { throw new Error('must not poll'); },
    };
    let untrustedCallbacks: ClientCallbacks | null = null;
    const first = {
      ...deps(space),
      clientFactory: ((_key: string, callbacks: ClientCallbacks) => {
        untrustedCallbacks = callbacks;
        return untrusted;
      }) as ClientFactory,
      listVideos: async () => [],
    };
    let receiptStates: string[] = [];
    const firstRun = {
      ...first,
      recordReceipt: async (receipt: {state: string}) => { receiptStates.push(receipt.state); },
    };
    await assert.rejects(runStep5Generation({
      ...firstRun, storyboard: board, storyboardSha256: 'd'.repeat(64),
      confirmedCapCny: 8, prepared: prepared(),
    }), /step5_submission_unknown/);
    assert.equal(receiptStates.includes('submitting'), true);
    const savedBudget = JSON.parse(await fs.readFile(space.budgetFile, 'utf8'));
    assert.ok(savedBudget.reservedCny > 0, 'forecast must stay reserved while the result is unknown');

    const stateFile = path.join(space.stateRoot, 'hook', 'state.json');
    const unknown = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    assert.equal(unknown.phase, 'submission_unknown');
    assert.equal(unknown.paidSubmissions, 1);

    // Second run: no create call at all; the provider list contains the task.
    let posts = 0;
    let narrationCalls = 0;
    const title = generationTitle('hook', presenterContentHash({
      avatarId: board.presenter.avatarId, voiceId: board.presenter.voiceId,
      speech: board.shots[0]!.speech,
    }));
    const secondRun = {
      ...deps(space),
      clientFactory: ((_key: string, callbacks: ClientCallbacks) => generatedClient(callbacks, {posts})) as ClientFactory,
      listVideos: async () => [{
        id: 'video_recovered_0001', title,
        createdAtSeconds: Math.floor(FIXED.getTime() / 1000),
        status: 'completed', duration: 3.1, videoUrl: 'https://files.heygen.ai/video.mp4',
      }],
      narration: async () => {
        narrationCalls += 1;
        return {ok: true as const,
          data: {audioUrl: 'https://files.heygen.ai/narration.mp3', duration: 2.6, engine: 'orca'}};
      },
    };
    const result = await runStep5Generation({
      ...secondRun, storyboard: board, storyboardSha256: 'd'.repeat(64),
      confirmedCapCny: 8, prepared: prepared(),
    });
    assert.equal(posts, 0, 'presenter must not be submitted a second time');
    assert.equal(narrationCalls, 1);
    assert.equal(result.counters.reconciledShots, 1);
    assert.equal(result.counters.newPaidSubmissions, 1, 'only narration is new');
    const presenter = result.shots.find(shot => shot.shotId === 'hook')!;
    assert.equal(presenter.providerTaskId, 'video_recovered_0001');
    assert.equal(presenter.phase, 'downloaded');
    assert.equal(presenter.reconciliation?.lastMethod, 'list');
  } finally {
    await space.cleanup();
  }
});

test('an unknown submission can be reconciled manually by video_id without a resubmission', async () => {
  const space = await workspace();
  try {
    // Produce an unknown ledger through one failed submission.
    let callbacks: ClientCallbacks | null = null;
    await assert.rejects(runStep5Generation({
      ...deps(space),
      storyboard: storyboard(), storyboardSha256: 'd'.repeat(64),
      confirmedCapCny: 8, prepared: prepared(),
      clientFactory: ((_key: string, value: ClientCallbacks) => {
        callbacks = value;
        return {
          async create(request: any, requestId: string) {
            await value.beforeSubmit(request, requestId);
            throw new Error('connection reset');
          },
          async status() { throw new Error('must not poll'); },
        };
      }) as ClientFactory,
    }), /step5_submission_unknown/);
    assert.ok(callbacks);

    const shotState = JSON.parse(await fs.readFile(
      path.join(space.stateRoot, 'hook', 'state.json'), 'utf8'));
    const fetchImpl = (async () => ({
      ok: true, status: 200,
      json: async () => ({
        data: {
          id: 'video_manual_0001', title: shotState.title,
          created_at: Math.floor(Date.parse(shotState.submittedAt) / 1000),
          status: 'pending',
        },
      }),
    })) as unknown as typeof fetch;
    const reconciled = await reconcileStep5Generation({
      videoId: 'video_manual_0001', env, stateRoot: space.stateRoot, fetchImpl,
    });
    assert.equal(reconciled.shotId, 'hook');
    assert.equal(reconciled.providerTaskId, 'video_manual_0001');
    assert.equal(reconciled.phase, 'accepted');
    assert.equal(reconciled.reconciliation?.lastMethod, 'manual');
    const persisted = JSON.parse(await fs.readFile(
      path.join(space.stateRoot, 'hook', 'state.json'), 'utf8'));
    assert.equal(persisted.paidSubmissions, 1, 'reconciliation never submits again');
  } finally {
    await space.cleanup();
  }
});

test('a known 4xx rejection releases the reservation and never resubmits', async () => {
  const space = await workspace();
  try {
    let posts = 0;
    await assert.rejects(runStep5Generation({
      ...deps(space),
      storyboard: storyboard(), storyboardSha256: 'd'.repeat(64),
      confirmedCapCny: 8, prepared: prepared(),
      clientFactory: ((_key: string, callbacks: ClientCallbacks) => ({
        async create(request: any, requestId: string) {
          await callbacks.beforeSubmit(request, requestId);
          posts += 1;
          throw new HeyGenRequestError(400, 'invalid_avatar');
        },
        async status() { throw new Error('must not poll'); },
      })) as ClientFactory,
    }), /step5_generation_rejected_no_resubmit/);
    assert.equal(posts, 1);
    const saved = JSON.parse(await fs.readFile(space.budgetFile, 'utf8'));
    assert.equal(saved.reservedCny, 0);
    assert.equal(saved.chargedCny, 0);
    assert.equal(saved.paidSubmissions, 0);
    const state = JSON.parse(await fs.readFile(
      path.join(space.stateRoot, 'hook', 'state.json'), 'utf8'));
    assert.equal(state.phase, 'rejected');
  } finally {
    await space.cleanup();
  }
});

test('unchanged shots reuse Step 4 media with zero new submissions', async () => {
  const space = await workspace();
  try {
    const board = storyboard();
    const presenterBytes = Buffer.from('step4-presenter-media');
    const audioBytes = Buffer.from('step4-narration-media');
    const hookDir = path.join(space.step4ShotsRoot, 'hook');
    const productDir = path.join(space.step4NarrationRoot, 'product');
    await fs.mkdir(hookDir, {recursive: true});
    await fs.mkdir(productDir, {recursive: true});
    await fs.writeFile(path.join(hookDir, 'provider-output.mp4'), presenterBytes);
    await fs.writeFile(path.join(hookDir, 'state.json'), JSON.stringify({
      phase: 'downloaded', fit: 'cover',
      avatarId: board.presenter.avatarId, voiceId: board.presenter.voiceId,
      speech: board.shots[0]!.speech.trim(), duration: 3.2,
      mediaSha256: sha(presenterBytes), mediaBytes: presenterBytes.length,
      videoId: 'video_step4_hook', requestId: 'step4-req-hook',
      storyboardSha256: 'd'.repeat(64),
    }));
    await fs.writeFile(path.join(productDir, 'narration.mp3'), audioBytes);
    await fs.writeFile(path.join(productDir, 'state.json'), JSON.stringify({
      phase: 'downloaded', voiceId: board.presenter.voiceId,
      text: board.shots[1]!.speech.trim(), engine: 'orca', language: 'en',
      provider: {duration: 2.6}, audioSha256: sha(audioBytes), audioBytes: audioBytes.length,
      requestId: 'step4-req-product',
    }));

    const result = await runStep5Generation({
      ...deps(space),
      storyboard: board, storyboardSha256: 'd'.repeat(64),
      confirmedCapCny: 8, prepared: prepared(),
      clientFactory: (() => { throw new Error('must not submit presenters'); }) as ClientFactory,
      narration: async () => { throw new Error('must not submit narration'); },
    });
    assert.equal(result.counters.newPaidSubmissions, 0);
    assert.equal(result.counters.reusedShots, 2);
    assert.deepEqual(result.shots.map(shot => shot.reusedFrom), ['step4', 'step4']);
    const saved = JSON.parse(await fs.readFile(space.budgetFile, 'utf8'));
    assert.equal(saved.chargedCny, 0);
    assert.equal(saved.reservedCny, 0);
    const copied = await fs.readFile(path.join(space.stateRoot, 'hook', 'provider-output.mp4'));
    assert.deepEqual(copied, presenterBytes);
  } finally {
    await space.cleanup();
  }
});
