import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {
  ProviderDownloadAllowlist,
  applyRealProviderKey,
  installRealNetworkGuard,
  isAllowedRealNetworkTarget,
  isAllowedRealProviderUrl,
  loadRealProviderKey,
  sanitizeRealEnvironment,
  validateProviderDownloadUrl,
} from './realMode.js';

const dummyKey = 'dummy-interview-key-0123456789';

async function temporaryDirectory(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'lingxu-real-mode-'));
}

test('real mode rejects a missing key file setting', async () => {
  await assert.rejects(() => loadRealProviderKey({}), /real_mode_key_file_missing/);
});

test('real mode refuses key files inside the repository', async () => {
  await assert.rejects(
    () => loadRealProviderKey({HEYGEN_KEY_FILE: './interview/realMode.ts'}),
    /real_mode_key_file_must_be_outside_repo/,
  );
});

test('real mode reports a missing file without echoing the path', async () => {
  const missing = path.join(os.tmpdir(), `lingxu-missing-${randomUUID()}`, 'heygen.key');
  await assert.rejects(
    () => loadRealProviderKey({HEYGEN_KEY_FILE: missing}),
    (error: Error) => error.message === 'real_mode_key_file_not_found' && !error.message.includes(missing),
  );
});

test('real mode rejects empty, multiline and short key files', async () => {
  const directory = await temporaryDirectory();
  try {
    const empty = path.join(directory, 'empty.key');
    const multiline = path.join(directory, 'multiline.key');
    const short = path.join(directory, 'short.key');
    await fs.writeFile(empty, '  \n');
    await fs.writeFile(multiline, `${dummyKey}\nsecond-line`);
    await fs.writeFile(short, 'short');
    await assert.rejects(() => loadRealProviderKey({HEYGEN_KEY_FILE: empty}), /real_mode_key_empty/);
    await assert.rejects(() => loadRealProviderKey({HEYGEN_KEY_FILE: multiline}), /real_mode_key_must_be_a_single_token/);
    await assert.rejects(() => loadRealProviderKey({HEYGEN_KEY_FILE: short}), /real_mode_key_length_invalid/);
  } finally {
    await fs.rm(directory, {recursive: true, force: true});
  }
});

test('real mode loads a key outside the repository and records only its hash', async () => {
  const directory = await temporaryDirectory();
  try {
    const keyFile = path.join(directory, 'heygen.key');
    await fs.writeFile(keyFile, `${dummyKey}\n`);
    const loaded = await loadRealProviderKey({HEYGEN_KEY_FILE: keyFile});
    assert.equal(loaded.key, dummyKey);
    assert.equal(loaded.credentialHash, createHash('sha256').update(dummyKey).digest('hex'));
    assert.equal(loaded.keyFile, path.resolve(keyFile));

    const env: NodeJS.ProcessEnv = {HEYGEN_KEY_FILE: keyFile};
    applyRealProviderKey(env, loaded);
    assert.equal(env.HEYGEN_API_KEY, dummyKey);
    assert.equal(env.INTERVIEW_REAL_MODE, '1');
    assert.equal(env.INTERVIEW_CREDENTIAL_SHA256, loaded.credentialHash);
  } finally {
    await fs.rm(directory, {recursive: true, force: true});
  }
});

test('real mode clears inherited secrets but preserves the key-file location', () => {
  const env: NodeJS.ProcessEnv = {
    HEYGEN_KEY_FILE: 'D:/secrets/heygen.key',
    HEYGEN_API_KEY: 'inherited-key',
    OPENAI_API_KEY: 'inherited-openai',
    AWS_SECRET_ACCESS_KEY: 'inherited-aws',
    R2_ACCESS_KEY_ID: 'inherited-r2',
    DATABASE_URL: 'postgres://user:pass@example/db',
    ADMIN_EMAIL: 'admin@example.test',
    INTERVIEW_REAL_MODE: '1',
    INTERVIEW_CREDENTIAL_SHA256: 'stale',
    PORT: '4319',
    HEYGEN_INTERVIEW_MAX_CNY: '30',
  };
  const removed = sanitizeRealEnvironment(env);
  assert.deepEqual(Object.keys(env).sort(), [
    'HEYGEN_INTERVIEW_MAX_CNY',
    'HEYGEN_KEY_FILE',
    'PORT',
  ]);
  for (const name of ['HEYGEN_API_KEY', 'OPENAI_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'R2_ACCESS_KEY_ID', 'DATABASE_URL', 'ADMIN_EMAIL', 'INTERVIEW_REAL_MODE', 'INTERVIEW_CREDENTIAL_SHA256']) {
    assert.ok(removed.includes(name), `${name} should be removed`);
  }
});

test('real mode admits only the v3 API over HTTPS on the default port', () => {
  assert.equal(isAllowedRealProviderUrl('https://api.heygen.com/v3/users/me'), true);
  assert.equal(isAllowedRealProviderUrl('https://api.heygen.com/v3/videos'), true);
  assert.equal(isAllowedRealProviderUrl('http://api.heygen.com/v3/users/me'), false);
  assert.equal(isAllowedRealProviderUrl('https://api.heygen.com/other'), false);
  assert.equal(isAllowedRealProviderUrl('https://api.heygen.com.evil.example/v3/users/me'), false);
  assert.equal(isAllowedRealProviderUrl('https://user:pass@api.heygen.com/v3/users/me'), false);
  assert.equal(isAllowedRealProviderUrl('https://api.heygen.com:8443/v3/users/me'), false);
});

test('download hosts must be validated before they are allowed', () => {
  const allowlist = new ProviderDownloadAllowlist();
  const media = 'https://files.heygen.com/output/video.mp4';
  assert.equal(allowlist.allows(media), false);
  assert.equal(allowlist.register('https://evil.example/video.mp4'), null);
  assert.equal(allowlist.register('http://files.heygen.com/video.mp4'), null);
  assert.equal(allowlist.register('https://user:pass@files.heygen.com/video.mp4'), null);
  assert.equal(allowlist.register('https://files.heygen.com:8443/video.mp4'), null);
  assert.equal(allowlist.register(media), 'files.heygen.com');
  assert.equal(allowlist.allows(media), true);
  assert.equal(allowlist.allows('https://files.heygen.com/other.mp4'), true);
  assert.equal(allowlist.allows('https://evil.example/output.mp4'), false);
  assert.deepEqual(allowlist.hostsSnapshot(), ['files.heygen.com']);
});

test('download URL validation rejects lookalike and non-media hosts', () => {
  assert.ok(validateProviderDownloadUrl('https://files.heygen.com/v.mp4'));
  assert.ok(validateProviderDownloadUrl('https://s3.amazonaws.com/bucket/v.mp4'));
  assert.equal(validateProviderDownloadUrl('https://heygen.com.evil.example/v.mp4'), null);
  assert.equal(validateProviderDownloadUrl('https://notheygen.com/v.mp4'), null);
  assert.equal(validateProviderDownloadUrl('https://evil.example/v.mp4'), null);
});

test('network target policy keeps localhost and registered hosts only', () => {
  const allowlist = new ProviderDownloadAllowlist();
  assert.equal(isAllowedRealNetworkTarget('http://127.0.0.1:4318/', allowlist), true);
  assert.equal(isAllowedRealNetworkTarget('http://localhost:4318/api/state', allowlist), true);
  assert.equal(isAllowedRealNetworkTarget('https://api.heygen.com/v3/users/me', allowlist), true);
  assert.equal(isAllowedRealNetworkTarget('https://api.heygen.com/other', allowlist), false);
  assert.equal(isAllowedRealNetworkTarget('https://files.heygen.com/v.mp4', allowlist), false);
  allowlist.register('https://files.heygen.com/v.mp4');
  assert.equal(isAllowedRealNetworkTarget('https://files.heygen.com/v.mp4', allowlist), true);
  assert.equal(isAllowedRealNetworkTarget('https://user:pass@api.heygen.com/v3/users/me', allowlist), false);
});

test('the installed guard blocks a non-allowlisted fetch before it leaves the process', async () => {
  const allowlist = new ProviderDownloadAllowlist();
  let calls = 0;
  const guard = installRealNetworkGuard({
    allowlist,
    fetchImpl: (async () => { calls += 1; return new Response('stub', {status: 200}); }) as typeof fetch,
    syncExports: false,
  });
  try {
    await assert.rejects(() => fetch('https://evil.example/steal'), /interview_real_network_blocked/);
    assert.equal(calls, 0);
    const allowed = await fetch('https://api.heygen.com/v3/users/me');
    assert.equal(allowed.status, 200);
    assert.equal(calls, 1);
    const local = await fetch('http://127.0.0.1:4318/api/state');
    assert.equal(local.status, 200);
    assert.equal(calls, 2);
  } finally {
    guard.dispose();
  }
});
