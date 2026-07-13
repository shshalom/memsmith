import { describe, it, expect } from "bun:test";
import {
  MemSmithPlugin,
  parseSearchResponse,
  REGISTERED_OPENCODE_HOOKS,
  REAL_OPENCODE_EVENT_TYPES,
} from "../../src/integrations/opencode-plugin/index";

/**
 * Regression guard for plan-08 (OpenCode event-contract correctness).
 *
 * The old plugin subscribed to bus event names that do not exist in OpenCode
 * (`session.created`, `message.updated`, `session.compacted`, `file.edited`,
 * `session.deleted` on a `(name, payload)` switch) and parsed `data.items`
 * instead of the worker's real `data.content` blocks — so it captured nothing
 * and search always returned "No results". These tests fail CI if either
 * contract regresses.
 */

// The real OpenCode plugin hook names. Anything the plugin returns as a hook
// key must be in this allowlist; a future typo (e.g. "session.created") fails.
const REAL_OPENCODE_HOOK_NAMES = new Set<string>([
  "tool.execute.after",
  "chat.message",
  "event",
  "experimental.session.compacting",
  "tool.execute.before",
  "permission.ask",
  "auth",
  "config",
  // `tool` is the custom-tool registration map, part of the plugin return shape.
  "tool",
]);

// Bus event names the old code used that DO NOT exist in OpenCode's contract.
const PHANTOM_BUS_EVENT_NAMES = [
  "session.created",
  "message.updated",
  "session.compacted",
  "file.edited",
];

const pluginCtx = {
  client: {},
  project: { name: "test-project", path: "/tmp/x" },
  directory: "/tmp/x",
  worktree: "/tmp/x",
  serverUrl: new URL("http://127.0.0.1:1234"),
  $: {},
};

describe("OpenCode plugin event contract", () => {
  it("only registers hooks that are part of OpenCode's real contract", async () => {
    const plugin = await MemSmithPlugin(pluginCtx);
    const hookKeys = Object.keys(plugin);

    for (const key of hookKeys) {
      expect(
        REAL_OPENCODE_HOOK_NAMES.has(key),
        `hook "${key}" is not a real OpenCode hook name`,
      ).toBe(true);
    }

    // The exported allowlist of hooks we bind to must itself be real.
    for (const hook of REGISTERED_OPENCODE_HOOKS) {
      expect(REAL_OPENCODE_HOOK_NAMES.has(hook)).toBe(true);
    }

    // The capture-critical hooks must be present.
    expect(hookKeys).toContain("tool.execute.after");
    expect(hookKeys).toContain("chat.message");
    expect(hookKeys).toContain("experimental.session.compacting");
    expect(hookKeys).toContain("event");
  });

  it("does not register the phantom bus event names as hooks", async () => {
    const plugin = await MemSmithPlugin(pluginCtx);
    const hookKeys = Object.keys(plugin);
    for (const phantom of PHANTOM_BUS_EVENT_NAMES) {
      expect(hookKeys).not.toContain(phantom);
    }
  });

  it("only reacts to real bus event types", () => {
    // session.idle / session.deleted are real OpenCode bus events; the phantom
    // names must never appear in the reacted-to allowlist.
    expect(REAL_OPENCODE_EVENT_TYPES).toContain("session.idle");
    expect(REAL_OPENCODE_EVENT_TYPES).toContain("session.deleted");
    for (const phantom of PHANTOM_BUS_EVENT_NAMES) {
      expect(REAL_OPENCODE_EVENT_TYPES as readonly string[]).not.toContain(phantom);
    }
  });

  it("posts observations to the worker via tool.execute.after", async () => {
    const posts: Array<{ url: string; body: unknown }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      posts.push({
        url: String(url),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return new Response(JSON.stringify({ status: "queued" }), { status: 200 });
    }) as typeof fetch;

    try {
      const plugin = await MemSmithPlugin(pluginCtx);
      const toolAfter = plugin["tool.execute.after"];
      await toolAfter(
        { tool: "read", sessionID: "ses_1", callID: "c1" },
        { title: "Read", output: "file contents", metadata: {}, args: { path: "/a" } },
      );

      const initPost = posts.find((p) => p.url.includes("/api/sessions/init"));
      const obsPost = posts.find((p) => p.url.includes("/api/sessions/observations"));
      expect(initPost, "tool.execute.after should lazily init the session").toBeTruthy();
      expect(obsPost, "tool.execute.after should POST an observation").toBeTruthy();
      const obsBody = obsPost!.body as Record<string, unknown>;
      expect(obsBody.tool_name).toBe("read");
      expect(obsBody.tool_response).toBe("file contents");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("OpenCode search client response-shape contract", () => {
  // Worker retirement — memory search now hits the server's POST /v1/search,
  // whose response is { observations: [{ id, content, ... }] }
  // (ServerSearchObservationsResponse), NOT the worker's old
  // { content: [{ type: 'text', text }] } blocks.
  it("parses the server's /v1/search observations and returns their content", () => {
    const serverResponse = JSON.stringify({
      observations: [
        { id: "obs_1", content: "Added login flow" },
        { id: "obs_2", content: "Fixed token refresh" },
      ],
    });

    const rendered = parseSearchResponse(serverResponse, "auth");
    expect(rendered).toContain("Added login flow");
    expect(rendered).toContain("Fixed token refresh");
    expect(rendered).not.toContain("No results");
  });

  it("does NOT parse the old worker data.content shape (regression guard)", () => {
    // The retired worker contract returned { content: [{ text }] } blocks. The
    // server client now reads `observations[].content`, so a worker-shaped body
    // has no observations and is correctly reported as no results.
    const oldWorkerShape = JSON.stringify({
      content: [{ type: "text", text: "should-not-render" }],
    });
    const rendered = parseSearchResponse(oldWorkerShape, "auth");
    expect(rendered).toContain("No results");
    expect(rendered).not.toContain("should-not-render");
  });

  it("returns a clear no-results message for the server's empty-observations shape", () => {
    const emptyResponse = JSON.stringify({ observations: [] });
    const rendered = parseSearchResponse(emptyResponse, "zzz");
    expect(rendered).toContain('No results found for "zzz"');
  });
});
