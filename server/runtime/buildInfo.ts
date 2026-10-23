import { execFileSync } from 'node:child_process';

export interface RuntimeBuildInfo {
  commitSha: string;
  version: string;
  startedAt: string;
}

const startedAt = new Date().toISOString();

function normalizeSha(value: unknown): string {
  const text = String(value || '').trim();
  return /^[a-f0-9]{7,64}$/i.test(text) ? text.toLowerCase() : '';
}

function resolveCommitSha(): string {
  const configured = normalizeSha(process.env.APP_BUILD_SHA || process.env.GIT_COMMIT_SHA || process.env.COMMIT_SHA);
  if (configured) return configured;
  try {
    return normalizeSha(execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 2_000, stdio: ['ignore', 'pipe', 'ignore'],
    })) || 'unknown';
  } catch {
    return 'unknown';
  }
}

const buildInfo: RuntimeBuildInfo = {
  commitSha: resolveCommitSha(),
  version: String(process.env.npm_package_version || '0.0.0'),
  startedAt,
};

export function runtimeBuildInfo(): RuntimeBuildInfo {
  return { ...buildInfo };
}
