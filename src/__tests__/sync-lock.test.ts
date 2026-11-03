import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquireSyncLock, SYNC_TIMEOUT_MS } from "../sync-lock";
import { createIndexService, spawnIndexWorker } from "../index-service";
import type { IndexOptions } from "../index-service";
import { writeSession } from "./helpers/fake-pi";

function fixture() {
  const root = mkdtempSync(join(import.meta.dirname, "__tmp_sync_lock__"));
  const options: IndexOptions = {
    indexDir: root,
    extraSessionDirs: [],
    extraArchiveDirs: [],
    sessionDir: join(root, "sessions"),
    archiveDir: join(root, "archive"),
  };
  return {
    root,
    path: join(root, "sync.lock"),
    options,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("sync lock", () => {
  it("skips a live holder and permits sync after release", () => {
    const f = fixture();
    try {
      const lock = acquireSyncLock(f.root);
      assert.ok(lock.held);
      assert.deepEqual(acquireSyncLock(f.root), { held: false, holderPid: process.pid });
      lock.release();
      assert.equal(existsSync(f.path), false);
      const next = acquireSyncLock(f.root);
      assert.ok(next.held);
      next.release();
    } finally {
      f.cleanup();
    }
  });

  it("takes over a dead process's lock", async () => {
    const f = fixture();
    try {
      const child = spawn(process.execPath, ["--version"], { stdio: "ignore" });
      await once(child, "exit");
      assert.ok(child.pid);
      writeFileSync(f.path, JSON.stringify({ pid: child.pid, startedAt: Date.now() }));
      const lock = acquireSyncLock(f.root);
      assert.ok(lock.held);
      assert.equal(JSON.parse(readFileSync(f.path, "utf8")).pid, process.pid);
      lock.release();
    } finally {
      f.cleanup();
    }
  });

  it("takes over an expired lock even while its process is alive", () => {
    const f = fixture();
    try {
      writeFileSync(f.path, JSON.stringify({
        pid: process.ppid,
        startedAt: Date.now() - SYNC_TIMEOUT_MS - 1,
      }));
      const lock = acquireSyncLock(f.root);
      assert.ok(lock.held);
      lock.release();
    } finally {
      f.cleanup();
    }
  });

  for (const raw of ["not json", "null", '{"pid":-1,"startedAt":0}', '{"pid":1}']) {
    it(`takes over an invalid lock containing ${raw}`, () => {
      const f = fixture();
      try {
        writeFileSync(f.path, raw);
        const lock = acquireSyncLock(f.root);
        assert.ok(lock.held);
        lock.release();
      } finally {
        f.cleanup();
      }
    });
  }

  it("does not release a replacement lock belonging to another live process", () => {
    const f = fixture();
    try {
      const lock = acquireSyncLock(f.root);
      assert.ok(lock.held);
      const replacement = JSON.stringify({ pid: process.ppid, startedAt: Date.now() });
      writeFileSync(f.path, replacement);
      lock.release();
      assert.equal(readFileSync(f.path, "utf8"), replacement);
      assert.deepEqual(acquireSyncLock(f.root), { held: false, holderPid: process.ppid });
    } finally {
      f.cleanup();
    }
  });
});

describe("index service sync lock", () => {
  it("runs exactly one of two services syncing the same index at once", async () => {
    const f = fixture();
    const a = createIndexService(f.options);
    const b = createIndexService(f.options);
    try {
      writeSession(join(f.options.sessionDir!, "--project--"), "one", "concurrent indexing");
      await a.load();
      await b.load();
      const results = await Promise.all([a.sync(), b.sync()]);
      assert.equal(results.filter(r => r.skipped).length, 1);
      assert.deepEqual(results.find(r => r.skipped), {
        added: 0, updated: 0, removed: 0, moved: 0, skipped: true, holderPid: process.pid,
      });
      assert.equal(results.find(r => !r.skipped)?.added, 1);
      assert.equal((await b.search("concurrent", 5))[0]?.session.id, "one");
      assert.equal(existsSync(f.path), false);
      assert.equal((await b.sync()).skipped, undefined);
    } finally {
      await a.close();
      await b.close();
      f.cleanup();
    }
  });

  it("releases the lock when sync fails", async () => {
    const f = fixture();
    const service = createIndexService(f.options);
    try {
      writeSession(join(f.options.sessionDir!, "--project--"), "one", "retry indexing");
      await service.load();
      await assert.rejects(service.sync({
        onProgress() { throw new Error("interrupted sync"); },
      }), /interrupted sync/);
      assert.equal(existsSync(f.path), false);
      assert.equal((await service.sync()).added, 1);
    } finally {
      await service.close();
      f.cleanup();
    }
  });

  it("returns sync and rebuild skips across the real worker boundary without clearing data", async () => {
    const f = fixture();
    const service = spawnIndexWorker(
      join(import.meta.dirname, "../../dist/index-worker.js"),
      f.options,
      () => {},
    );
    try {
      writeSession(join(f.options.sessionDir!, "--project--"), "one", "preserved session");
      await service.load();
      await service.sync();
      const lock = acquireSyncLock(f.root);
      assert.ok(lock.held);
      try {
        assert.deepEqual(await service.sync(), {
          added: 0, updated: 0, removed: 0, moved: 0, skipped: true, holderPid: process.pid,
        });
        assert.deepEqual(await service.rebuild(), { skipped: true, holderPid: process.pid });
        assert.equal((await service.get("one"))?.session.id, "one");
      } finally {
        lock.release();
      }
      assert.equal(await service.rebuild(), undefined);
      assert.equal(await service.size(), 1);
      assert.equal(existsSync(f.path), false);
    } finally {
      await service.close();
      f.cleanup();
    }
  });
});
