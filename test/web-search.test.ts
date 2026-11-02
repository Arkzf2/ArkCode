import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { z } from "zod";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ArkHost } from "../src/app/host.js";
import { parseCli } from "../src/app/args.js";
import type { UserInterface, Status, ToolDetails } from "../src/app/types.js";
import { createModelRuntime } from "../src/config/settings.js";
import { WebSearchService } from "../src/integrations/web-search.js";
import { webSearchStats, type WebSearchUsage } from "../src/integrations/web-search-usage.js";

type Protocol = "openai-responses" | "anthropic-messages";
const requestSchema = z.object({ tools: z.array(z.object({ type: z.string().optional(), name: z.string().optional() }).passthrough()).optional() }).passthrough();
type Request = z.infer<typeof requestSchema>;
const source = { url: "https://example.com/news", title: "Current news" };

function send(response: ServerResponse, protocol: Protocol, reply: {
  native?: boolean; call?: { name: string; arguments: object }; ignored?: boolean; toolError?: boolean; searches?: number; inputTokens?: number;
}): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  const event = (value: { type: string; [key: string]: unknown }) => response.write(`${protocol === "anthropic-messages" ? `event: ${value.type}\n` : ""}data: ${JSON.stringify(value)}\n\n`);
  const text = reply.call ? "" : "A verified search answer.";
  if (protocol === "openai-responses") {
    const item = reply.call ? { type: "function_call", id: "fc_call", call_id: "call", name: reply.call.name, arguments: JSON.stringify(reply.call.arguments) }
      : { type: "message", id: "msg_answer", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [{ type: "url_citation", ...source, start_index: 0, end_index: 5 }] }] };
    const search = { type: "web_search_call", id: "ws_test", status: reply.toolError ? "failed" : "completed", action: { type: "search", query: "news" } };
    event({ type: "response.created", response: { id: "resp_test" } });
    if (reply.native && !reply.ignored) event({ type: "response.output_item.done", output_index: 0, item: search });
    event({ type: "response.output_item.added", output_index: 1, item });
    event({ type: "response.output_item.done", output_index: 1, item });
    event({ type: "response.completed", response: { id: "resp_test", status: "completed", model: "test", output: [...(reply.native && !reply.ignored ? [search] : []), item], usage: { input_tokens: reply.inputTokens ?? 15, output_tokens: 10, total_tokens: (reply.inputTokens ?? 15) + 10 } } });
  } else {
    event({ type: "message_start", message: { id: "msg_test", type: "message", role: "assistant", model: "test", content: [], usage: {
      input_tokens: reply.inputTokens ?? 15, output_tokens: 0, server_tool_use: { web_search_requests: reply.searches ?? 0 },
    } } });
    if (reply.native && !reply.ignored) {
      event({ type: "content_block_start", index: 0, content_block: { type: "server_tool_use", id: "srv_search", name: "web_search", input: { query: "news" } } });
      event({ type: "content_block_stop", index: 0 });
      event({ type: "content_block_start", index: 1, content_block: { type: "web_search_tool_result", tool_use_id: "srv_search", content: reply.toolError
        ? { type: "web_search_tool_result_error", error_code: "too_many_requests" }
        : [{ type: "web_search_result", ...source, encrypted_content: "must-not-leak" }] } });
      event({ type: "content_block_stop", index: 1 });
    }
    if (reply.call) {
      event({ type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "call", name: reply.call.name, input: {} } });
      event({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: JSON.stringify(reply.call.arguments) } });
    } else {
      event({ type: "content_block_start", index: 2, content_block: { type: "text", text: "" } });
      event({ type: "content_block_delta", index: 2, delta: { type: "text_delta", text } });
      event({ type: "content_block_delta", index: 2, delta: { type: "citations_delta", citation: { type: "web_search_result_location", ...source } } });
    }
    event({ type: "content_block_stop", index: 2 });
    event({ type: "message_delta", delta: { stop_reason: reply.call ? "tool_use" : "end_turn", stop_sequence: null }, usage: {
      output_tokens: 10, server_tool_use: { web_search_requests: reply.native && !reply.ignored && !reply.toolError ? reply.searches ?? 1 : 0 },
    } });
    event({ type: "message_stop" });
  }
  response.end();
}

async function fixture(t: TestContext, protocol: Protocol, respond?: (response: ServerResponse, request: Request) => void, supported = true) {
  const directory = await mkdtemp(join(tmpdir(), "arkcode-web-search-"));
  const home = join(directory, "home"); const cwd = join(directory, "workspace");
  await mkdir(home); await mkdir(cwd);
  const requests: Request[] = []; const failures: unknown[] = [];
  const server = createServer(async (request, response) => {
    try {
      if (request.method === "GET") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ capabilities: { server_tools: { web_search: { supported } } } }));
        return;
      }
      assert.equal(request.url, protocol === "openai-responses" ? "/v1/responses" : "/v1/messages?beta=true");
      let body = ""; for await (const chunk of request) body += String(chunk);
      const parsed = requestSchema.parse(JSON.parse(body)); requests.push(parsed);
      if (respond) respond(response, parsed); else send(response, protocol, { native: true });
    } catch (error) { failures.push(error); response.writeHead(500); response.end(); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  await writeFile(join(home, "models.json"), JSON.stringify({ providers: { fixture: {
    baseUrl: `http://127.0.0.1:${address.port}${protocol === "openai-responses" ? "/v1" : ""}`, api: protocol, apiKey: "test-key",
    models: [{ id: "test", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096,
      cost: { input: 2, output: 4, cacheRead: 1, cacheWrite: 3 },
    }],
  } } }));
  await writeFile(join(home, "settings.json"), JSON.stringify({ provider: "fixture", model: "test", thinking: "off", trustedWorkspaces: [cwd] }));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); assert.deepEqual(failures, []); });
  const runtime = await createModelRuntime(home);
  const model = runtime.getModel("fixture", "test"); assert.ok(model);
  const service = new WebSearchService(runtime);
  return { home, cwd, requests, service, model };
}

function recordingUI() {
  const tools: Array<{ name: string; state: string; text: string; details?: ToolDetails }> = [];
  const messages: Array<{ kind: string; text: string }> = [];
  const statuses: Status[] = [];
  const ui: UserInterface = {
    status: (value) => { statuses.push(value); }, message: (kind, text) => { messages.push({ kind, text }); },
    tool: (_id, name, text, state, details) => { tools.push({ name, state, text, details }); },
    assistantDelta() {}, assistantEnd() {}, reasoning() {},
    choose: async () => null, input: async () => null, secret: async () => null,
    approve: async () => "deny", inspect: async () => {}, dismiss() {}, draft: () => "", setDraft() {}, clear() {}, copy: async () => false, stop() {},
  };
  return { ui, tools, messages, statuses };
}

function statusUsage(messages: Array<{ text: string }>) {
  const text = messages.findLast((message) => message.text.includes("\nUsage: "))?.text.split("\nUsage: ")[1];
  assert.ok(text);
  return z.object({ tokens: z.object({ input: z.number(), output: z.number(), total: z.number() }), cost: z.number(),
    webSearch: z.object({ requests: z.number(), searches: z.number(), estimatedSearchFeesUSD: z.number(), unknownFeeRequests: z.number() }),
  }).parse(JSON.parse(text));
}

for (const protocol of ["openai-responses", "anthropic-messages"] as const) {
  test(`${protocol} executes the official search tool and preserves sources and usage`, async (t) => {
    const f = await fixture(t, protocol);
    const receipts: WebSearchUsage[] = [];
    const result = await f.service.search(f.model, "current news", { onUsage: (receipt) => receipts.push(receipt) });
    assert.equal(result.searches, 1); assert.equal(result.text, "A verified search answer.");
    assert.deepEqual(result.sources, [source]); assert.equal(result.usage.totalTokens, 25);
    assert.equal(receipts.length, 1);
    assert.equal(result.fee.status, "unknown");
    assert.ok(Math.abs(result.usage.cost.total - 0.00007) < 1e-12);
    assert.match(await f.service.status(f.model), /^verified:/);
    const tool = f.requests[0]?.tools?.[0];
    assert.equal(tool?.type, protocol === "openai-responses" ? "web_search" : "web_search_20250305");
    assert.equal(f.requests[0]?.reasoning, undefined, "Non-reasoning models must not receive reasoning options");
    assert.doesNotMatch(JSON.stringify(result), /must-not-leak|test-key/);
  });

  test(`${protocol} rejects a plain answer when the endpoint silently ignores Web Search`, async (t) => {
    const f = await fixture(t, protocol, (response) => send(response, protocol, { native: true, ignored: true }));
    await assert.rejects(f.service.search(f.model, "current news"), /did not execute/);
    assert.match(await f.service.status(f.model), /^Unverified:/);
  });

  test(`${protocol} surfaces server-side tool failures instead of claiming success`, async (t) => {
    const f = await fixture(t, protocol, (response) => send(response, protocol, { native: true, toolError: true }));
    const receipts: WebSearchUsage[] = [];
    await assert.rejects(f.service.search(f.model, "current news", { onUsage: (receipt) => receipts.push(receipt) }), /web search failed/);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0]?.usage.totalTokens, 25);
    assert.equal(receipts[0]?.searches, 0);
  });

  test(`${protocol} remembers explicit lack of support and allows a manual recheck`, async (t) => {
    let unsupported = true;
    const f = await fixture(t, protocol, (response) => {
      if (unsupported) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Unsupported tool: web_search" } }));
      } else send(response, protocol, { native: true });
    });
    await assert.rejects(f.service.search(f.model, "news"), /Unsupported tool/);
    assert.equal(await f.service.available(f.model), false);
    await assert.rejects(f.service.search(f.model, "news"), /Unsupported tool/);
    assert.equal(f.requests.length, 1, "Known unsupported endpoints must not receive another search");
    unsupported = false;
    await f.service.search(f.model, "news", { refresh: true });
    assert.equal(await f.service.available(f.model), true);
    assert.match(await f.service.status(f.model), /^verified:/);
  });

  test(`${protocol} never sends a denied WebSearch request`, async (t) => {
    let turns = 0;
    const f = await fixture(t, protocol, (response) => send(response, protocol, turns++ === 0
      ? { call: { name: "WebSearch", arguments: { query: "private query" } } } : {}));
    const ui = recordingUI();
    const host = new ArkHost(parseCli(["--home", f.home, "--cwd", f.cwd, "--permissions", "always-ask"]), ui.ui);
    t.after(() => host.exit());
    await host.start(); await host.submit("Search the web.");
    assert.ok(ui.tools.some((tool) => tool.name === "WebSearch" && tool.state === "error" && /denied/i.test(tool.text)));
    assert.equal(f.requests.length, 2, "Only the main conversation requests should reach the endpoint");
    assert.ok(f.requests.every((request) => !request.tools?.some((tool) => tool.type === "web_search" || tool.type === "web_search_20250305")));
    await host.submit("/status");
    assert.equal(statusUsage(ui.messages).tokens.total, 50);
    assert.equal(statusUsage(ui.messages).webSearch.requests, 0);
  });

  test(`${protocol} manual capability checks record model consumption`, async (t) => {
    const f = await fixture(t, protocol);
    const ui = recordingUI();
    const host = new ArkHost(parseCli(["--home", f.home, "--cwd", f.cwd]), ui.ui);
    t.after(() => host.exit());
    await host.start(); await host.submit("/web-search check"); await host.submit("/status");
    assert.equal(host.outcome, "completed", JSON.stringify(ui.messages));
    const stats = statusUsage(ui.messages);
    assert.equal(stats.tokens.total, 25);
    assert.deepEqual(stats.webSearch, { requests: 1, searches: 1, estimatedSearchFeesUSD: 0, unknownFeeRequests: 1 });
    assert.equal(f.requests.length, 1);
  });

  for (const mode of ["direct", "codemode-only"]) {
    test(`${protocol} ${mode} retains model usage when the hosted search fails`, async (t) => {
      let turns = 0;
      const f = await fixture(t, protocol, (response, request) => {
        if (request.tools?.some((tool) => tool.type === "web_search" || tool.type === "web_search_20250305")) send(response, protocol, { native: true, toolError: true });
        else send(response, protocol, turns++ === 0 ? { call: mode === "direct"
          ? { name: "WebSearch", arguments: { query: "news" } }
          : { name: "codemode", arguments: { code: 'text(await tools.WebSearch({query:"news"}));' } },
        } : {});
      });
      await writeFile(join(f.home, "settings.json"), JSON.stringify({ provider: "fixture", model: "test", thinking: "off", toolMode: mode, trustedWorkspaces: [f.cwd] }));
      const ui = recordingUI();
      const host = new ArkHost(parseCli(["--home", f.home, "--cwd", f.cwd, "--permissions", "never-ask"]), ui.ui);
      t.after(() => host.exit());
      await host.start(); await host.submit("Search."); await host.submit("/status");
      assert.equal(host.outcome, "completed");
      assert.ok(ui.tools.some((tool) => tool.name === "WebSearch" && tool.state === "error"));
      const stats = statusUsage(ui.messages);
      assert.equal(stats.tokens.total, 75);
      assert.equal(stats.webSearch.requests, 1);
      assert.equal(stats.webSearch.searches, 0);
    });
  }

  test(`${protocol} search visibility follows the saved enable setting on the next prompt`, async (t) => {
    const f = await fixture(t, protocol, (response) => send(response, protocol, {}));
    const ui = recordingUI();
    const host = new ArkHost(parseCli(["--home", f.home, "--cwd", f.cwd, "--permissions", "never-ask"]), ui.ui);
    t.after(() => host.exit());
    await host.start();
    await host.submit("/web-search off"); await host.submit("Hello");
    assert.equal(f.requests[0]?.tools?.some((tool) => tool.name === "WebSearch"), false);
    await host.submit("/web-search on"); await host.submit("Hello again");
    assert.equal(f.requests[1]?.tools?.some((tool) => tool.name === "WebSearch"), true);
    assert.equal(ui.messages.some((message) => message.kind === "error"), false, JSON.stringify(ui.messages));
  });

  for (const mode of ["direct", "codemode", "codemode-only"] as const) {
    test(`${protocol} ArkHost ${mode} exposes WebSearch correctly and saves the real search result`, async (t) => {
      let turns = 0;
      const f = await fixture(t, protocol, (response, request) => {
        if (request.tools?.some((tool) => tool.type === "web_search" || tool.type === "web_search_20250305")) send(response, protocol, { native: true });
        else if (turns++ === 0) send(response, protocol, { call: mode === "direct"
          ? { name: "WebSearch", arguments: { query: "current news" } }
          : { name: "codemode", arguments: { code: 'text(await tools.WebSearch({query:"current news"}));' } } });
        else send(response, protocol, {});
      });
      await writeFile(join(f.home, "settings.json"), JSON.stringify({ provider: "fixture", model: "test", thinking: "off", toolMode: mode, trustedWorkspaces: [f.cwd] }));
      const ui = recordingUI();
      const host = new ArkHost(parseCli(["--home", f.home, "--cwd", f.cwd, "--permissions", "never-ask"]), ui.ui);
      t.after(() => host.exit());
      await host.start(); await host.submit("Search the web.");
      assert.equal(host.outcome, "completed", JSON.stringify(ui.messages));
      const names = f.requests[0]?.tools?.map((tool) => tool.name);
      assert.equal(names?.includes("WebSearch"), mode !== "codemode-only");
      assert.equal(names?.includes("codemode"), mode !== "direct");
      assert.ok(ui.tools.some((tool) => tool.name === "WebSearch" && tool.state === "done"));
      const sessionPaths = (await readdir(join(f.home, "sessions"), { recursive: true })).filter((path) => path.endsWith(".jsonl"));
      const path = sessionPaths[0]; assert.ok(path);
      const saved = await readFile(join(f.home, "sessions", path), "utf8");
      assert.match(saved, /https:\/\/example.com\/news/);
      assert.doesNotMatch(saved, /must-not-leak|test-key/);
      assert.deepEqual(webSearchStats(SessionManager.open(join(f.home, "sessions", path)).getEntries()), {
        requests: 1, searches: 1, estimatedSearchFeesUSD: 0, unknownFeeRequests: 1,
      });
      await host.submit("/status");
      const stats = statusUsage(ui.messages);
      assert.deepEqual(stats.tokens, { input: 45, output: 30, total: 75 });
      assert.ok(Math.abs(stats.cost - 0.00021) < 1e-12);
      assert.equal(stats.webSearch.requests, 1);
      await host.exit();
      const resumed = new ArkHost(parseCli(["--home", f.home, "--cwd", f.cwd, "resume", "--last"]), ui.ui);
      t.after(() => resumed.exit());
      await resumed.start(); await resumed.submit("/status");
      assert.deepEqual(statusUsage(ui.messages), stats);
      assert.equal(f.requests.length, 3);
    });
  }
}

test("Anthropic explicitly unsupported model metadata prevents a hosted search", async (t) => {
  const f = await fixture(t, "anthropic-messages", undefined, false);
  await assert.rejects(f.service.search(f.model, "news"), /supported is false/);
  assert.equal(f.requests.length, 0);
  assert.equal(await f.service.available(f.model), false);
});

test("Anthropic provider search usage takes precedence over deduplicated visible search events", async (t) => {
  const f = await fixture(t, "anthropic-messages", (response) => send(response, "anthropic-messages", { native: true, searches: 3 }));
  const result = await f.service.search(f.model, "news");
  assert.equal(result.searches, 3);
  assert.equal(result.searchCountSource, "provider");
});

test("search helper token usage does not become main conversation context usage", async (t) => {
  let turns = 0;
  const f = await fixture(t, "openai-responses", (response, request) => {
    if (request.tools?.some((tool) => tool.type === "web_search")) send(response, "openai-responses", { native: true, inputTokens: 100000 });
    else send(response, "openai-responses", turns++ === 0 ? { call: { name: "WebSearch", arguments: { query: "news" } } } : {});
  });
  const ui = recordingUI();
  const host = new ArkHost(parseCli(["--home", f.home, "--cwd", f.cwd, "--permissions", "never-ask"]), ui.ui);
  t.after(() => host.exit());
  await host.start(); await host.submit("Search."); await host.submit("/status");
  assert.equal(host.outcome, "completed");
  assert.equal(f.requests.length, 3);
  assert.equal(statusUsage(ui.messages).tokens.total, 100060);
  assert.ok((ui.statuses.at(-1)?.context?.tokens ?? Infinity) < 25000);
});

test("interrupting /web-search check cancels its request and restores the idle state", async (t) => {
  let received = () => {};
  const started = new Promise<void>((resolve) => { received = resolve; });
  const f = await fixture(t, "openai-responses", () => { received(); });
  const ui = recordingUI();
  const host = new ArkHost(parseCli(["--home", f.home, "--cwd", f.cwd, "--permissions", "never-ask"]), ui.ui);
  t.after(() => host.exit());
  await host.start();
  const check = host.submit("/web-search check");
  await started;
  await host.interrupt(); await check;
  assert.equal(host.outcome, "interrupted");
  assert.equal(ui.messages.some((message) => message.kind === "error"), false, JSON.stringify(ui.messages));
  await host.submit("/web-search status");
  assert.match(ui.messages.at(-1)?.text ?? "", /Unverified:/);
});

test("CodeMode Promise.all runs independent hosted searches concurrently", async (t) => {
  let turns = 0;
  const waiting: ServerResponse[] = [];
  const f = await fixture(t, "openai-responses", (response, request) => {
    if (request.tools?.some((tool) => tool.type === "web_search")) {
      waiting.push(response);
      if (waiting.length === 2) for (const pending of waiting) send(pending, "openai-responses", { native: true });
    } else send(response, "openai-responses", turns++ === 0
      ? { call: { name: "codemode", arguments: { code: 'const results = await Promise.all([tools.WebSearch({query:"one"}), tools.WebSearch({query:"two"})]); for (const result of results) text(result);' } } } : {});
  });
  const ui = recordingUI();
  const host = new ArkHost(parseCli(["--home", f.home, "--cwd", f.cwd, "--permissions", "never-ask"]), ui.ui);
  t.after(() => host.exit());
  await host.start();
  const prompt = host.submit("Search twice in parallel.");
  const timeout = setTimeout(() => { void host.interrupt(); }, 10000);
  try { await prompt; } finally { clearTimeout(timeout); }
  assert.equal(host.outcome, "completed", JSON.stringify(ui.messages));
  assert.equal(waiting.length, 2);
  assert.equal(ui.tools.filter((tool) => tool.name === "WebSearch" && tool.state === "done").length, 2);
  await host.submit("/status");
  const stats = statusUsage(ui.messages);
  assert.equal(stats.tokens.total, 100);
  assert.deepEqual(stats.webSearch, { requests: 2, searches: 2, estimatedSearchFeesUSD: 0, unknownFeeRequests: 2 });
});

test("independent searches execute concurrently and cancellation reaches the provider request", async (t) => {
  const waiting: ServerResponse[] = [];
  const f = await fixture(t, "openai-responses", (response) => {
    waiting.push(response);
    if (waiting.length === 2) for (const pending of waiting) send(pending, "openai-responses", { native: true });
  });
  const deadline = AbortSignal.timeout(5000);
  const results = await Promise.all([f.service.search(f.model, "one", { signal: deadline }), f.service.search(f.model, "two", { signal: deadline })]);
  assert.equal(results.length, 2); assert.equal(waiting.length, 2);
  const controller = new AbortController();
  const search = f.service.search(f.model, "cancel", { signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(search, /abort/i);
});
