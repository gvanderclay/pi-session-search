import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { createIndexService } from "../index-service";
import type { IndexOptions } from "../index-service";
import { writeSession } from "./helpers/fake-pi";

function fixture() {
  const root = mkdtempSync(join(import.meta.dirname, "__tmp_reload__"));
  const options: IndexOptions = {
    indexDir: join(root, "index"),
    extraSessionDirs: [],
    extraArchiveDirs: [],
    sessionDir: join(root, "sessions"),
    archiveDir: join(root, "archive"),
    embedder: { type: "openai-compatible", baseUrl: "https://embeddings.test", model: "test" },
  };
  const originalFetch = globalThis.fetch;
  let embeddedTexts = 0;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const texts = Array.isArray(body.input) ? body.input : [body.input];
    embeddedTexts += texts.length;
    return new Response(JSON.stringify({
      data: texts.map((_: string, index: number) => ({ index, embedding: [1, 0, 0] })),
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return {
    root,
    options,
    embedded: () => embeddedTexts,
    advanceMtime() {
      const path = join(options.indexDir, "session-index.json");
      const st = statSync(path);
      utimesSync(path, st.atime, new Date(st.mtimeMs + 1000));
    },
    cleanup() {
      globalThis.fetch = originalFetch;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe("hybrid index reload", () => {
  for (const read of ["search", "list", "get"] as const) {
    it(`${read} sees another service's saved sessions without syncing`, async () => {
      const f = fixture();
      const a = createIndexService(f.options);
      const b = createIndexService(f.options);
      try {
        await a.load();
        await b.load();
        assert.deepEqual(await b.list(), []);
        writeSession(join(f.options.sessionDir!, "--project--"), "shared", "shared indexing");
        assert.equal((await a.sync()).added, 1);
        f.advanceMtime();
        if (read === "search") {
          assert.equal((await b.search("shared", 5))[0]?.session.id, "shared");
        } else if (read === "list") {
          assert.equal((await b.list())[0]?.id, "shared");
        } else {
          assert.equal((await b.get("shared"))?.session.id, "shared");
        }
        assert.equal(f.embedded(), read === "search" ? 2 : 1);
      } finally {
        await a.close();
        await b.close();
        f.cleanup();
      }
    });
  }

  it("reloads before sync so another service's sessions are neither re-embedded nor lost", async () => {
    const f = fixture();
    const a = createIndexService(f.options);
    const b = createIndexService(f.options);
    const c = createIndexService(f.options);
    try {
      await a.load();
      await b.load();
      writeSession(join(f.options.sessionDir!, "--project--"), "first", "first saved session");
      assert.equal((await a.sync()).added, 1);
      f.advanceMtime();
      writeSession(join(f.options.sessionDir!, "--project--"), "second", "second saved session");
      assert.deepEqual(await b.sync(), { added: 1, updated: 0, removed: 0, moved: 0 });
      assert.equal(f.embedded(), 2, "each session is embedded only once");
      await c.load();
      assert.deepEqual((await c.list()).map(s => s.id).sort(), ["first", "second"]);
      assert.deepEqual(await b.sync(), { added: 0, updated: 0, removed: 0, moved: 0 });
      assert.equal(f.embedded(), 2);
    } finally {
      await a.close();
      await b.close();
      await c.close();
      f.cleanup();
    }
  });

  it("refreshes an already loaded index again after a later save", async () => {
    const f = fixture();
    const a = createIndexService(f.options);
    const b = createIndexService(f.options);
    try {
      writeSession(join(f.options.sessionDir!, "--project--"), "first", "original session");
      await a.load();
      await a.sync();
      await b.load();
      assert.equal((await b.list()).length, 1);
      writeSession(join(f.options.sessionDir!, "--project--"), "second", "later session");
      await a.sync();
      f.advanceMtime();
      assert.equal((await b.list()).length, 2);
    } finally {
      await a.close();
      await b.close();
      f.cleanup();
    }
  });
});
