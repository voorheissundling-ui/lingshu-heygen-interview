import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const RENDER_TEMP_PREFIX = 'lingshu-social-render-';

export function socialContentRenderTempRoot(): string {
  return os.tmpdir();
}

/**
 * Give one render an isolated OS-temporary workspace and erase the complete
 * directory after success or failure. Durable outputs must be uploaded before
 * the callback returns.
 */
export async function withSocialContentRenderWorkspace<T>(
  action: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = await fsp.mkdtemp(path.join(socialContentRenderTempRoot(), RENDER_TEMP_PREFIX));
  try {
    return await action(directory);
  } finally {
    // A render is not complete while its transient bytes remain on the worker.
    // Surface cleanup failures so operators can repair the host instead of
    // reporting a successful, policy-violating job.
    await fsp.rm(directory, { recursive: true, force: true });
  }
}
