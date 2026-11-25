import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import extension, { withPiApiKey } from "../index";
import { createFakeHost, untilWarm, writeSession } from "./helpers/fake-pi";

const savedEnv = { MISTRAL_API_KEY: process.env.MISTRAL_API_KEY, OPENAI_API_KEY: process.env.OPENAI_API_KEY };

afterEach(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function registry(keys: Record<string, string>) {
  const asked: string[] = [];
  return {
    asked,
    getApiKeyForProvider: async (provider: string) => {
      asked.push(provider);
      return keys[provider];
    },
  };
}

describe("withPiApiKey", () => {
  it("fills a Mistral key from Pi when the config and environment have none", async () => {
    delete process.env.MISTRAL_API_KEY;
    const pi = registry({ mistral: "pi-key" });
    const result = await withPiApiKey({ type: "mistral", model: "codestral-embed" }, pi);
    assert.deepEqual(result, { type: "mistral", model: "codestral-embed", apiKey: "pi-key" });
    assert.deepEqual(pi.asked, ["mistral"]);
  });

  it("keeps a config key and an environment key ahead of Pi's", async () => {
    const pi = registry({ mistral: "pi-key", openai: "pi-key" });
    process.env.MISTRAL_API_KEY = "env-key";
    assert.equal((await withPiApiKey({ type: "mistral" }, pi))?.apiKey, undefined);
    delete process.env.OPENAI_API_KEY;
    assert.equal((await withPiApiKey({ type: "openai", apiKey: "config-key" }, pi))?.apiKey, "config-key");
    assert.deepEqual(pi.asked, []);
  });

  it("fills a key from the Pi provider the config names, for any embedder type", async () => {
    const pi = registry({ "opencode-go": "go-key" });
    const config = { type: "openai-compatible" as const, baseUrl: "http://x.test", piProvider: "opencode-go" };
    assert.equal((await withPiApiKey(config, pi))?.apiKey, "go-key");
    assert.deepEqual(pi.asked, ["opencode-go"]);
  });

  it("leaves embedders without a Pi provider, and failed lookups, unchanged", async () => {
    delete process.env.MISTRAL_API_KEY;
    const config = { type: "openai-compatible" as const, baseUrl: "http://x.test" };
    assert.equal(await withPiApiKey(config, registry({})), config);
    assert.equal(await withPiApiKey(undefined, registry({})), undefined);
    const failing = { getApiKeyForProvider: async () => { throw new Error("no auth"); } };
    assert.deepEqual(await withPiApiKey({ type: "mistral" }, failing), { type: "mistral" });
    assert.deepEqual(await withPiApiKey({ type: "mistral" }, undefined), { type: "mistral" });
  });
});

describe("Pi's key reaches the embedding requests", () => {
  it("indexes with the Mistral key Pi resolves", async () => {
    delete process.env.MISTRAL_API_KEY;
    const auth: string[] = [];
    const server = createServer((req, res) => {
      auth.push(String(req.headers.authorization));
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const input: string[] = JSON.parse(body).input;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ data: input.map((_, index) => ({ index, embedding: [1, 0, 0] })) }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    const host = createFakeHost(
      join(import.meta.dirname, "__tmp_pi_key__"),
      extension,
      {
        sync: { interval: -1, initialDelay: 0 },
        embedder: { type: "mistral", model: "codestral-embed", dimensions: 3, baseUrl: `http://127.0.0.1:${port}` },
      },
      { modelRegistry: registry({ mistral: "pi-key" }) },
    );
    try {
      writeSession(host.sessionsDir, "one", "embed me with the stored key");
      await host.start();
      assert.match(await untilWarm(host, 10000), /1 sessions/);
      assert.ok(auth.length > 0, "the embedder called the server");
      assert.ok(auth.every((value) => value === "Bearer pi-key"), auth.join(", "));
    } finally {
      await host.shutdown();
      host.cleanup();
      server.close();
    }
  });
});
