// Windows cannot fsync a directory handle; the local store still writes and
// renames durably. The offline entry point already loads this shim.
import './fsync-compat.mjs';
import path from 'node:path';
import {
  REAL_PROVIDER_HOST,
  activeProviderDownloadAllowlist,
  applyRealProviderKey,
  installRealModeRuntime,
  loadRealProviderKey,
  sanitizeRealEnvironment,
} from './realMode.js';

async function main(): Promise<void> {
  // This is intentionally not interview/bootstrap.mjs. Bootstrap removes all
  // provider keys and blocks every non-local host; real mode keeps exactly one
  // file-sourced key and allows only the HeyGen API plus registered media hosts.
  const removed = sanitizeRealEnvironment(process.env);

  process.env.NODE_ENV = 'development';
  process.env.ENABLE_LOCAL_DEV_FALLBACK = 'true';
  process.env.LOCAL_STORE_DIR = path.resolve('.interview-data/store');
  process.env.DATA_BACKEND = 'pocketbase';
  process.env.QUEUE_BACKEND = 'local';
  process.env.PB_URL = 'http://127.0.0.1:1';
  process.env.OBJECT_STORAGE_DRIVER = 'local';
  process.env.LOCAL_OBJECT_STORAGE_ROOT = path.resolve('.interview-data/object-storage');
  process.env.LINGSHU_LOCAL_PREVIEW = '1';
  process.env.SOCIAL_WEEKLY_EXECUTION_WORKER_ENABLED = 'false';

  const loaded = await loadRealProviderKey(process.env);
  applyRealProviderKey(process.env, loaded);
  installRealModeRuntime();
  const allowlist = activeProviderDownloadAllowlist();

  // The app pulls in the npm `undici` copy, and that module registers a plain
  // global dispatcher on first import. That silently overrides the proxy that
  // NODE_USE_ENV_PROXY installs for the built-in fetch, so provider calls would
  // go direct and time out. Re-assert the proxy agent here, before the app
  // modules load provider traffic.
  const envProxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  if (process.env.NODE_USE_ENV_PROXY === '1' && envProxy) {
    const {ProxyAgent, setGlobalDispatcher} = await import('undici');
    setGlobalDispatcher(new ProxyAgent(envProxy));
  }

  // Paid generation is not switched on implicitly. Step 2 is read-only; later
  // steps must set the readiness flags and a positive business budget explicitly.
  console.log(JSON.stringify({
    event: 'real_mode_started',
    mode: 'real',
    keyConfigured: true,
    credentialHash: loaded.credentialHash,
    providerHost: REAL_PROVIDER_HOST,
    allowedDownloadHosts: allowlist?.hostsSnapshot() ?? [],
    socialContentHeyGenEnabled: process.env.SOCIAL_CONTENT_HEYGEN_ENABLED === 'true',
    generationEnabled: process.env.HEYGEN_GENERATION_ENABLED === 'true',
    removedSecretEnvCount: removed.length,
    paidGenerationPerformed: false,
  }));

  await import('./web.js');
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'real_mode_start_failed';
  // Fixed error codes only; never echo file contents or URLs that might carry credentials.
  console.error('real_mode_start_failed:' + message.replace(/https?:\/\/\S+/g, '[url]'));
  process.exitCode = 1;
});
