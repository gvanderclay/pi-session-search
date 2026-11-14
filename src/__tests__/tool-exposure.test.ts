import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import extension from "../index";

/** Tool definitions exactly as pi.registerTool receives them. */
function registeredTools(): Map<string, any> {
  const tools = new Map<string, any>();
  extension({
    on: () => {},
    registerTool: (t: any) => tools.set(t.name, t),
    registerCommand: () => {},
    sendMessage: () => {},
  } as any);
  return tools;
}

describe("tool exposure", () => {
  let tools: Map<string, any>;
  before(() => {
    tools = registeredTools();
  });

  it("registers session_list as deferred so its schema stays out of every request", () => {
    const list = tools.get("session_list");
    assert.ok(list, "session_list is registered");
    assert.equal(list.exposure, "deferred");
  });

  it("keeps the deferred tool callable from codemode scripts", () => {
    const list = tools.get("session_list");
    assert.equal(typeof list.execute, "function");
    assert.ok(list.description.length > 0, "searchTools and describeTool show the description");
    assert.ok(list.parameters, "codemode validates the call against the schema");
  });

  it("leaves session_search and session_read declared to the model", () => {
    assert.equal(tools.get("session_search")?.exposure, undefined);
    assert.equal(tools.get("session_read")?.exposure, undefined);
  });
});
