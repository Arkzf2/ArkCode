import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { Model, Api } from "@earendil-works/pi-ai";
import { SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { COMPACT_PROMPT, SUMMARY_PREFIX } from "../src/compaction/prompts.js";
import { InputJournal } from "../src/compaction/inputs.js";
import { checkpointSchema, parseCheckpoint } from "../src/compaction/checkpoint.js";
import { assertClosedTools, estimateMessages, pruneToolResults, renderUser, requestBudget, retainUsers, summarySampling, textTokens, TOOL_PRUNING_MARKER, type RetainedUser } from "../src/compaction/policy.js";

type Message = AgentSession["messages"][number];
const model = { id: "test", name: "test", api: "openai-completions", provider: "fixture", baseUrl: "http://localhost", reasoning: false,
  input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 204096, maxTokens: 4096 } satisfies Model<Api>;
const user = (value: string, inputId = "input"): RetainedUser => ({ inputId, entryId: inputId, origin: "human", delivery: "prompt", timestamp: 1,
  originalLength: Array.from(value).length, fragments: [{ start: 0, end: Array.from(value).length, text: value }] });
const tool = (value: string): Extract<Message, { role: "toolResult" }> => ({ role: "toolResult", toolCallId: "call", toolName: "Read", timestamp: 1, isError: true,
  content: [{ type: "text", text: value }], details: { evidence: "unchanged" } });

test("compact thresholds reserve output before applying 90 percent and the context window reserve tier", () => {
  assert.deepEqual(requestBudget(model), { window: 204096, output: 4096, input: 200000, threshold: 150000, measurement: "estimate" });
  assert.equal(requestBudget({ ...model, contextWindow: 1004096 }).threshold, 900000);
  assert.equal(requestBudget({ ...model, contextWindow: 132096 }).threshold, 103000);
  assert.equal(requestBudget({ ...model, contextWindow: 128000 }).threshold, 98904);
  assert.equal(requestBudget({ ...model, contextWindow: 199999 }).threshold, 170903);
  assert.equal(requestBudget({ ...model, contextWindow: 200000 }).threshold, 145904);
  assert.equal(requestBudget({ ...model, contextWindow: 200000, maxTokens: 100000 }).threshold, 50000);
  assert.throws(() => requestBudget({ ...model, contextWindow: 24000 }), /25k/);
  assert.throws(() => requestBudget({ ...model, contextWindow: 200000, maxTokens: 150000 }), /50k/);
  assert.throws(() => requestBudget({ ...model, maxTokens: Number.NaN }), /context window/);
});

test("output reserves include model sampling overrides and summary limits override inherited caps", () => {
  const configured = { ...model, samplingParams: { max_tokens: 8192, temperature: 0.5 }, samplingParamsByThinkingLevel: { high: { max_completion_tokens: 16384 } } };
  assert.equal(requestBudget(configured).output, 16384);
  assert.deepEqual(summarySampling(configured, 2048), { max_tokens: 2048, max_completion_tokens: 2048 });
  assert.throws(() => requestBudget({ ...model, samplingParams: { max_tokens: 0 } }), /positive output token limit/);
  assert.throws(() => requestBudget({ ...model, samplingParams: { max_tokens: null } }), /positive output token limit/);
  assert.equal(requestBudget({ ...configured, api: "anthropic-messages" }).output, model.maxTokens);
});

test("text budgets use UTF8 bytes and count generated user truncation markers", () => {
  assert.equal(textTokens("中文😀"), Math.ceil(Buffer.byteLength("中文😀") / 4));
  const selected = retainUsers([user("older text", "old"), user("头部" + "中文😀".repeat(40000) + "尾部", "new")]);
  assert.equal(selected.length, 1);
  const value = renderUser(selected[0]!);
  assert.ok(textTokens(value) <= 20000);
  assert.ok(value.startsWith("头部")); assert.ok(value.endsWith("尾部"));
  assert.match(value, /user text omitted/);
  assert.ok(!value.includes("\uFFFD"));
});

test("repeated compact selects only retained source ranges and never restores dropped text", () => {
  const first = retainUsers([user("a".repeat(1000) + "MUST STAY OMITTED" + "z".repeat(1000))], 50);
  const second = retainUsers([...first, user("a new request", "new")], 30);
  assert.doesNotMatch(second.map(renderUser).join(""), /MUST STAY OMITTED/);
  assert.ok(second.reduce((sum, item) => sum + textTokens(renderUser(item)), 0) <= 30);
  for (const retained of second) for (const fragment of retained.fragments) assert.equal(fragment.end - fragment.start, Array.from(fragment.text).length);
});

test("media-only input does not create an empty retained user message", () => {
  assert.deepEqual(retainUsers([user("")]), []);
});

test("tool pruning is exact at the boundary and leaves parameters and metadata intact", () => {
  const boundary = tool("a".repeat(8192));
  assert.equal(pruneToolResults([boundary]).messages[0], boundary);
  const original = tool("a".repeat(4096) + "UNIQUE MIDDLE EVIDENCE".repeat(400) + "z".repeat(1024));
  const pruned = pruneToolResults([original]);
  assert.equal(pruned.pruned, 1);
  assert.deepEqual(pruned.messages[0], { ...original, content: [{ type: "text", text: "a".repeat(4096) + TOOL_PRUNING_MARKER + "z".repeat(1024) }] });
  assert.deepEqual(pruneToolResults(pruned.messages).messages, pruned.messages);
  assert.match(original.content[0]?.type === "text" ? original.content[0].text : "", /UNIQUE MIDDLE EVIDENCE/);
});

test("tool pruning counts Unicode code points across text blocks and preserves non-text order", () => {
  const image = { type: "image", data: "YWJj", mimeType: "image/png" } satisfies Extract<Message, { role: "toolResult" }>["content"][number];
  const original = { ...tool(""), content: [{ type: "text", text: "😀".repeat(4500) }, image, { type: "text", text: "尾".repeat(5000) }] } satisfies Message;
  const result = pruneToolResults([original]).messages[0];
  assert.ok(result?.role === "toolResult");
  assert.equal(result.content[1], image);
  const output = result.content.filter((part) => part.type === "text").map((part) => part.text).join("");
  assert.equal(output, "😀".repeat(4096) + TOOL_PRUNING_MARKER + "尾".repeat(1024));
  assert.equal(output.split(TOOL_PRUNING_MARKER).length, 2);
});

test("request estimates count tool declarations and media rather than only user text", () => {
  const plain: Message = { role: "user", content: "hello", timestamp: 1 };
  const media: Message = { role: "user", content: [{ type: "text", text: "hello" }, { type: "image", mimeType: "image/png", data: "irrelevant-base64-length" }], timestamp: 1 };
  assert.equal(estimateMessages([media]) - estimateMessages([plain]), 1200);
  assert.ok(estimateMessages([{ role: "system", content: "", sections: { rules: "a".repeat(4000) }, timestamp: 1 }, plain]) >= 1000);
});

test("input provenance keeps raw queries, including text identical to the summary prefix", () => {
  const manager = SessionManager.inMemory(process.cwd());
  const journal = new InputJournal(manager);
  journal.capture({ rawText: SUMMARY_PREFIX, preparedText: "GENERATED SKILL BODY\n\n" + SUMMARY_PREFIX, delivery: "prompt" });
  const entryId = manager.appendMessage({ role: "user", content: "GENERATED SKILL BODY\n\n" + SUMMARY_PREFIX, timestamp: 1 });
  assert.deepEqual(journal.snapshot().pendingEntryIds, [entryId]);
  assert.deepEqual(journal.snapshot().users, []);
  journal.markDelivered(new Set([entryId]));
  const users = journal.snapshot().users;
  assert.equal(users.length, 1);
  assert.equal(renderUser(users[0]!), SUMMARY_PREFIX);
  assert.equal(users[0]?.origin, "human");
});

test("pending inputs survive reconstruction once, and withdrawn queue entries stay withdrawn", () => {
  const manager = SessionManager.inMemory(process.cwd());
  const journal = new InputJournal(manager);
  journal.capture({ rawText: "keep", preparedText: "keep", delivery: "steering" });
  journal.capture({ rawText: "edit", preparedText: "edit", delivery: "follow-up" });
  journal.withdraw(["edit"]);
  new InputJournal(manager).restorePending();
  new InputJournal(manager).restorePending();
  assert.deepEqual(manager.buildSessionProjection().messages.filter((item) => item.role === "user").map((item) => item.content), [[{ type: "text", text: "keep" }]]);
});

test("new input provenance never binds an identical older legacy message", () => {
  const manager = SessionManager.inMemory(process.cwd());
  const previous = manager.appendMessage({ role: "user", content: "identical", timestamp: 1 });
  const journal = new InputJournal(manager);
  journal.capture({ rawText: "RAW NEW QUERY", preparedText: "identical", delivery: "prompt" });
  const current = manager.appendMessage({ role: "user", content: "identical", timestamp: 2 });
  assert.deepEqual(journal.snapshot().pendingEntryIds, [current]);
  assert.equal(journal.snapshot().users[0]?.entryId, previous);
  journal.markDelivered(new Set([current]));
  assert.deepEqual(journal.snapshot().users.map(renderUser), ["identical", "RAW NEW QUERY"]);
});

test("checkpoint readers reject future versions and malformed retained ranges", () => {
  assert.throws(() => parseCheckpoint({ arkcode: { version: 2 } }));
  const source = user("😀");
  assert.equal(checkpointSchema.shape.retainedUsers.safeParse([{ ...source, fragments: [{ start: 0, end: 2, text: "😀" }] }]).success, false);
  assert.equal(parseCheckpoint({ unrelated: true }), undefined);
});

test("compaction only runs after a complete tool batch", () => {
  assert.throws(() => assertClosedTools([tool("orphan")]), /matching call/);
});

test("runtime compaction prompts preserve the user-edited specification", async () => {
  const document = await readFile("docs/implementation/COMPACT_PROMPT.md", "utf8");
  const blocks = [...document.matchAll(/~~~text\r?\n([\s\S]*?)\r?\n~~~/g)];
  assert.equal(blocks[0]?.[1]?.replaceAll("\r\n", "\n"), COMPACT_PROMPT);
  assert.equal(blocks[1]?.[1], SUMMARY_PREFIX);
});
