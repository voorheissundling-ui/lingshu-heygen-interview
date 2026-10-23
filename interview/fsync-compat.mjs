/**
 * Windows compatibility shim for fsync.
 *
 * Node on Windows returns EPERM when fsync is called on a read-only file
 * handle or on a directory handle (FlushFileBuffers requires write access).
 * Linux/macOS allow both. The local interview store writes a temporary file,
 * fsyncs it, renames it into place, then fsyncs the directory; on Windows the
 * write and rename still complete, but the durability barrier cannot be
 * expressed the same way.
 *
 * Only the Windows-specific fsync failures are ignored. Every other error is
 * rethrown. This is a best-effort local-store compatibility layer; it does not
 * weaken tenant, identity, budget, or result validation.
 */
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const originalFsyncSync = fs.fsyncSync;
const originalFsync = fs.fsync;

function ignorable(error) {
  return process.platform === 'win32'
    && (error?.code === 'EPERM' || error?.code === 'EINVAL');
}

fs.fsyncSync = function fsyncSyncCompat(fd) {
  try {
    return originalFsyncSync.call(fs, fd);
  } catch (error) {
    if (ignorable(error)) return undefined;
    throw error;
  }
};

fs.fsync = function fsyncCompat(fd, callback) {
  const done = typeof callback === 'function' ? callback : () => {};
  try {
    return originalFsync.call(fs, fd, (error) => {
      if (ignorable(error)) return done(null);
      return done(error);
    });
  } catch (error) {
    if (ignorable(error)) return done(null);
    throw error;
  }
};

syncBuiltinESMExports();
