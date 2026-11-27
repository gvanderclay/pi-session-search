import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import extension from "../index";

/** A fake host: registered tools, the declared (active) tools, and one handler per event. */
function host(builtins: string[] = []) {
  const tools = new Map<string, any>();
  const handlers = new Map<string, (event: any, ctx: any) => unknown>();
  // Registering a direct tool activates it, as Pi does.
  let active = new Set(builtins);
  extension({
    on: (event: string, fn: any) => handlers.set(event, fn),
    registerTool: (t: any) => {
      tools.set(t.name, t);
      if (t.exposure === undefined || t.exposure === "direct") active.add(t.name);
    },
    getAllTools: () => [...builtins, ...tools.keys()].map((name) => ({ name })),
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => {
      active = new Set(names);
    },
    registerCommand: () => {},
    sendMessage: () => {},
  } as any);
  return {
    tools,
    declared: () => [...active].filter((name) => name.startsWith("session_")).sort(),
    selectModel: (model: unknown) => handlers.get("model_select")!({ type: "model_select", model, source: "set" }, {}),
  };
}

// Models whose tool changes Pi sends in place, and one it resends the whole tool list for.
const inPlace = {
  api: "anthropic-messages",
  compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true },
};
const resends = { api: "anthropic-messages", compat: {} };

describe("tool exposure", () => {
  let tools: Map<string, any>;
  before(() => {
    tools = host().tools;
  });

  it("registers session_list and session_read as deferred and session_search as declared", () => {
    assert.equal(tools.get("session_list")?.exposure, "deferred");
    assert.equal(tools.get("session_read")?.exposure, "deferred");
    assert.equal(tools.get("session_search")?.exposure, undefined);
  });

  it("keeps the deferred tools callable from codemode scripts", () => {
    for (const name of ["session_list", "session_read"]) {
      const tool = tools.get(name);
      assert.equal(typeof tool.execute, "function");
      assert.ok(tool.description.length > 0, "searchTools and describeTool show the description");
      assert.ok(tool.parameters, "codemode validates the call against the schema");
    }
  });

  it("leaves session_read undeclared where codemode or a cache-keeping tool_search reaches it", () => {
    for (const [builtins, model] of [
      [["codemode"], resends],
      [["tool_search"], inPlace],
    ] as const) {
      const h = host([...builtins]);
      h.selectModel(model);
      assert.deepEqual(h.declared(), ["session_search"], builtins.join());
    }
  });

  it("declares session_read where nothing else reaches it without losing the cache, and never withdraws it", () => {
    for (const builtins of [[], ["tool_search"]]) {
      const h = host(builtins);
      h.selectModel(resends);
      assert.deepEqual(h.declared(), ["session_read", "session_search"], builtins.join());
      h.selectModel(inPlace);
      assert.deepEqual(h.declared(), ["session_read", "session_search"], builtins.join());
    }
  });
});
