import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import extension from "../index";

function register() {
  const registered: string[] = [];
  extension({
    on: (event: string) => registered.push(`on:${event}`),
    registerTool: (t: { name: string }) => registered.push(`tool:${t.name}`),
    registerCommand: (name: string) => registered.push(`command:${name}`),
    sendMessage: () => {},
  } as any);
  return registered;
}

describe("PI_SESSION_SEARCH", () => {
  const original = process.env.PI_SESSION_SEARCH;
  afterEach(() => {
    if (original === undefined) delete process.env.PI_SESSION_SEARCH;
    else process.env.PI_SESSION_SEARCH = original;
  });

  it("registers nothing when set to off", () => {
    process.env.PI_SESSION_SEARCH = "off";
    assert.deepEqual(register(), []);
  });

  it("registers the tools, commands and lifecycle handlers otherwise", () => {
    delete process.env.PI_SESSION_SEARCH;
    const registered = register();
    assert.ok(registered.includes("tool:session_search"));
    assert.ok(registered.includes("command:session-sync"));
    assert.ok(registered.includes("on:session_start"));
  });
});
