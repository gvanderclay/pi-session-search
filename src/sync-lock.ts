import { linkSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SYNC_TIMEOUT_MS = 600_000;

interface LockOwner {
  pid: number;
  startedAt: number;
}

export type SyncLock =
  | { held: true; release(): void }
  | { held: false; holderPid: number };

function readOwner(path: string): LockOwner | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  try {
    const owner = JSON.parse(raw);
    if (Number.isInteger(owner?.pid) && owner.pid > 0 &&
        Number.isFinite(owner.startedAt) && owner.startedAt >= 0) {
      return owner;
    }
  } catch {}
  return undefined;
}

function isStale(owner: LockOwner): boolean {
  if (Date.now() - owner.startedAt > SYNC_TIMEOUT_MS) return true;
  try {
    process.kill(owner.pid, 0);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
  return false;
}

// Link a fully written temp file into place so no reader ever sees a
// half-written lock and mistakes it for a stale one.
function publish(path: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
  try {
    linkSync(tmp, path);
  } finally {
    unlinkSync(tmp);
  }
}

export function acquireSyncLock(indexDir: string): SyncLock {
  const path = join(indexDir, "sync.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      publish(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const owner = readOwner(path);
      if (attempt === 1 || (owner && !isStale(owner))) {
        return { held: false, holderPid: owner?.pid ?? 0 };
      }
      try {
        unlinkSync(path);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      continue;
    }
    return {
      held: true,
      release() {
        if (readOwner(path)?.pid !== process.pid) return;
        try {
          unlinkSync(path);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
      },
    };
  }
  throw new Error("unreachable sync lock state");
}
