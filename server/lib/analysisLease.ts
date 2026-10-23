import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

export class AnalysisAlreadyRunningError extends Error {
  constructor() { super('analysis_already_running'); }
}

// Python is already required by the yt-dlp pipeline. Kernel flock avoids stale
// file reclamation races; closing stdin (including parent death) releases it.
const lockScript = `import fcntl, sys
f = open(sys.argv[1], 'a')
try:
    fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    sys.exit(73)
print('locked', flush=True)
sys.stdin.buffer.read()
`;

/** Same-host processes sharing the data directory serialize actual analysis.
 * The owner JSON is advisory for fast queue scans; the OS lock is authoritative. */
export class AnalysisLeaseRegistry {
  constructor(private readonly directory: string) {}
  private file(key: string) { return path.join(this.directory, createHash('sha256').update(key).digest('hex')); }
  has(key: string): boolean {
    try {
      const owner = JSON.parse(fs.readFileSync(`${this.file(key)}.json`, 'utf8'));
      if (!Number.isInteger(owner.pid) || owner.pid <= 0) return false;
      try { process.kill(owner.pid, 0); return true; }
      catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
    } catch { return false; }
  }
  async run<T>(key: string, action: () => Promise<T>): Promise<T> {
    fs.mkdirSync(this.directory, { recursive: true });
    const file = this.file(key);
    const token = randomUUID();
    const ownerFile = `${file}.json`;
    const child = spawn('python3', ['-c', lockScript, `${file}.lock`], {stdio:['pipe','pipe','pipe']});
    let output = '';
    const exited = new Promise<void>(resolve => child.once('close', () => resolve()));
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.stdout.on('data', chunk => { output += String(chunk); if (output.includes('locked\n')) resolve(); });
        child.stderr.resume();
        child.once('exit', code => reject(code === 73 ? new AnalysisAlreadyRunningError() : Error('analysis_lock_process_failed')));
      });
      fs.writeFileSync(ownerFile, JSON.stringify({pid:process.pid,token,startedAt:new Date().toISOString()}));
      return await action();
    } finally {
      try { if (JSON.parse(fs.readFileSync(ownerFile,'utf8')).token === token) fs.unlinkSync(ownerFile); } catch { /* Preserve another owner's marker. */ }
      child.stdin.end();
      await exited;
    }
  }
}
