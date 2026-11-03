import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import extension from "../index";
import { acquireSyncLock } from "../sync-lock";
import { mkdirSync, writeFileSync } from "node:fs";
import { createFakeHost, untilWarm, writeSession } from "./helpers/fake-pi";

describe("sync command lock notices", () => {
  for (const command of ["session-sync", "session-reindex"]) {
    it(`${command} reports the holder instead of a successful sync`, async () => {
      const host = createFakeHost(join(import.meta.dirname, `__tmp_${command}__`), extension, {
        sync: { interval: -1, initialDelay: -1 },
      });
      try {
        writeSession(host.sessionsDir, "one", "manual indexing");
        await host.start();
        await untilWarm(host, 5000);
        await host.command("session-sync");
        assert.match(await host.tool("session_list", {}), /1 sessions/);
        const lock = acquireSyncLock(host.indexDir);
        assert.ok(lock.held);
        try {
          const noteCount = host.notes.length;
          await host.command(command);
          const notices = host.notes.slice(noteCount);
          assert.ok(notices.includes(`session-search: another session (pid ${process.pid}) is syncing`));
          assert.ok(!notices.some(n => /^(Synced:|Re-indexed:)/.test(n)));
          assert.match(await host.tool("session_list", {}), /1 sessions/);
        } finally {
          lock.release();
        }
        const noteCount = host.notes.length;
        await host.command(command);
        assert.ok(host.notes.slice(noteCount).some(n => /^(Synced:|Re-indexed:)/.test(n)));
      } finally {
        await host.shutdown();
        host.cleanup();
      }
    });
  }

  it("clears the progress status when the initial sync indexes nothing", async () => {
    const host = createFakeHost(join(import.meta.dirname, "__tmp_initial_status__"), extension, {
      sync: { interval: -1, initialDelay: 0 },
    });
    try {
      mkdirSync(host.sessionsDir, { recursive: true });
      writeFileSync(
        join(host.sessionsDir, "empty.jsonl"),
        JSON.stringify({ type: "session", version: 1, id: "empty", timestamp: "2026-01-15T10:00:00Z", cwd: "/tmp/proj" }),
      );
      await host.start();
      assert.equal(await untilWarm(host, 5000), "Session index is empty.");
      assert.ok(host.statuses.some(s => /^Indexing 1 sessions/.test(s)), "progress was shown");
      assert.equal(host.statuses.at(-1), "");
    } finally {
      await host.shutdown();
      host.cleanup();
    }
  });

  it("silently skips the initial sync and finishes warming when another session holds the lock", async () => {
    const host = createFakeHost(join(import.meta.dirname, "__tmp_initial_lock__"), extension, {
      sync: { interval: -1, initialDelay: 200 },
    });
    try {
      writeSession(host.sessionsDir, "one", "not indexed by this session");
      await host.start();
      const lock = acquireSyncLock(host.indexDir);
      assert.ok(lock.held);
      try {
        assert.equal(await untilWarm(host, 5000), "Session index is empty.");
        assert.ok(!host.notes.some(n => /another session|failed|timed out|no changes/.test(n)));
      } finally {
        lock.release();
      }
    } finally {
      await host.shutdown();
      host.cleanup();
    }
  });
});
