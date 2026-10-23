import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export function createVideoDownloaderPythonResolver(ports: {
  env?: NodeJS.ProcessEnv;
  root?: string;
  home?: string;
  platform?: string;
  exists?: (value: string) => boolean;
  check?: (python: string) => boolean;
} = {}) {
  let verified = '';
  return () => {
    if (verified) return verified;
    const env = ports.env ?? process.env, exists = ports.exists ?? fs.existsSync;
    const root = ports.root ?? fileURLToPath(new URL('../../', import.meta.url));
    const project = path.join(root, '.venv-video-downloader', (ports.platform ?? process.platform) === 'win32' ? 'Scripts/python.exe' : 'bin/python3');
    const bundled = path.join(ports.home ?? os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3');
    const candidates = [...new Set([String(env.YT_DLP_PYTHON ?? '').trim(), exists(project) ? project : '', exists(bundled) ? bundled : '', String(env.PYTHON ?? '').trim(), 'python3'].filter(Boolean))];
    const check = ports.check ?? ((candidate: string) => {
      const result = spawnSync(candidate, ['-c', 'import yt_dlp'], { stdio: 'ignore', timeout: 5_000 });
      return !result.error && result.status === 0;
    });
    for (const candidate of candidates) if (check(candidate)) { verified = candidate; return candidate; }
    throw Error('video_downloader_not_installed: Python yt-dlp module is required; prepare project-local dependencies with scripts/prepare-video-downloader.mjs');
  };
}
