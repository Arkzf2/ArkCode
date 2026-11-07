import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { Api, AssistantMessage, Model, Usage } from "@earendil-works/pi-ai";
import { getCurrentSystemMessage, toToolDeclaration } from "@earendil-works/pi-ai";
import { isContextOverflow } from "@earendil-works/pi-ai/compat";
import { convertToLlm, type AgentSession } from "@earendil-works/pi-coding-agent";
import type { SessionToolSettings, ToolSettingsSnapshot } from "../session/tool-settings.js";
import { inspectSession } from "../session/storage.js";
import { CONTEXT_MESSAGE } from "../context/dynamic.js";
import { InputJournal } from "./inputs.js";
import { latestCheckpoint, parseCheckpoint, type Checkpoint } from "./checkpoint.js";
import { assertClosedTools, CompactionError, estimateMessages, pruneToolResults, renderUser, requestBudget, retainUsers, summarySampling, textTokens } from "./policy.js";
import { COMPACT_PROMPT, COMPACT_RETRY_PROMPT, SUMMARY_PREFIX } from "./prompts.js";

type Message = AgentSession["messages"][number];
type CustomMessage = Extract<Message, { role: "custom" }>;
type Reason = "manual" | "threshold" | "overflow";
const signature = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const overflowBlockSchema = z.object({ provider: z.string(), id: z.string(), window: z.number(), output: z.number(), checkpointId: z.string().nullable() }).strict();

export class CompactionController {
  readonly inputs: InputJournal;
  private failedSnapshot: string | undefined;
  private requestModel: Model<Api> | undefined;
  private preparedEntryIds = new Set<string>();
  private recovery: { kind: "checkpoint"; checkpointId: string } | { kind: "original" | "storage"; settings: ToolSettingsSnapshot } | undefined;
  private paused = false;
  private warnedLegacy = false;
  private busy = false;
  private overflowBlock: z.infer<typeof overflowBlockSchema> | undefined;

  constructor(private session: AgentSession, private options: {
    settings: SessionToolSettings;
    captureContext: (signal?: AbortSignal) => Promise<CustomMessage>;
    warning: (message: string) => void;
  }) {
    this.inputs = new InputJournal(session.sessionManager);
    for (const entry of session.sessionManager.getBranch()) if (entry.type === "compaction") parseCheckpoint(entry.details);
    for (const entry of session.sessionManager.getBranch()) if (entry.type === "custom" && entry.customType === "arkcode-overflow-pause") this.overflowBlock = overflowBlockSchema.parse(entry.data);
    session.subscribe((event) => {
      if (event.type !== "compaction_end" || event.reason !== "overflow" || event.result) return;
      const model = this.requestModel ?? session.model;
      if (!model) return;
      this.overflowBlock = { provider: model.provider, id: model.id, window: model.contextWindow, output: requestBudget(model).output, checkpointId: latestCheckpoint(session.sessionManager)?.checkpoint.id ?? null };
      try { session.sessionManager.appendCustomEntry("arkcode-overflow-pause", this.overflowBlock); }
      catch { this.recovery = { kind: "storage", settings: this.options.settings.current }; }
      this.paused = true;
    });
    const onPayload = session.agent.onPayload;
    session.agent.onPayload = async (payload, model) => {
      try { this.beforeProviderRequest(); }
      catch (error) { this.recovery = { kind: "storage", settings: this.options.settings.current }; throw error; }
      return await onPayload?.(payload, model);
    };
    session.setHostCompaction((request) => this.compact(request));
    const previous = session.agent.prepareRequest;
    session.agent.prepareRequest = async (request, signal) => {
      if (this.recovery) throw new CompactionError("activation", "Checkpoint or tool state must be recovered before another model request. Retry /compact or reopen this session.");
      const prepared = await previous?.(request, signal);
      const context = prepared?.context ?? request.context;
      const model = prepared?.model ?? request.model;
      this.requestModel = model;
      let budget;
      try { budget = requestBudget(model); }
      catch (error) { this.paused = true; throw error; }
      const block = this.overflowBlock;
      if (block && block.provider === model.provider && block.id === model.id && block.window === model.contextWindow
        && block.output === budget.output && block.checkpointId === (latestCheckpoint(session.sessionManager)?.checkpoint.id ?? null)) {
        this.paused = true;
        throw new CompactionError("overflow", "The task remains paused after context overflow. Retry /compact or select a larger-context model before continuing this conversation.");
      }
      this.inputs.bind();
      this.paused = false;
      const system = getCurrentSystemMessage(convertToLlm(context.messages));
      const tools = context.tools?.map(toToolDeclaration) ?? [];
      const messages: Message[] = [{ role: "system", content: system?.content ?? "", sections: system?.sections,
        toolsAdded: tools, timestamp: system?.timestamp ?? Date.now() }, ...context.messages.filter((message) => message.role !== "system")];
      const tokens = this.measure(messages, model);
      if (tokens >= budget.threshold) {
        let pendingSettings: unknown;
        try { pendingSettings = this.options.settings.defaults(); }
        catch (error) { pendingSettings = { error: String(error) }; }
        const key = signature([messages, model.provider, model.id, budget, pendingSettings]);
        if (key !== this.failedSnapshot) {
          try {
            await session.runHostCompaction("threshold", undefined, signal);
            const updated = session.sessionManager.buildSessionProjection();
            this.preparedEntryIds = new Set(updated.entries.map((entry) => entry.sourceEntry.id));
            return { ...prepared, context: { ...context, messages: updated.messages, tools: session.agent.state.tools }, model };
          } catch (error) {
            this.failedSnapshot = key;
            if (signal?.aborted || this.recovery) throw error;
            if (tokens > budget.input) { this.paused = true; throw new CompactionError("overflow", "The task is paused: compact failed and the original request no longer fits. Retry /compact or select a larger-context model.", { cause: error }); }
            this.options.warning("Automatic compact failed. Continuing with the original context, which is still within the estimated request limit.");
          }
        } else if (tokens > budget.input) { this.paused = true; throw new CompactionError("overflow", "The task is paused: the original context does not fit, and this compact snapshot already failed. Retry /compact or select a larger-context model."); }
      }
      this.preparedEntryIds = new Set(session.sessionManager.buildSessionProjection().entries.map((entry) => entry.sourceEntry.id));
      return prepared ?? undefined;
    };
  }

  beforeProviderRequest(): void { this.inputs.markDelivered(this.preparedEntryIds); }
  get executionPaused(): boolean { return this.paused || Boolean(this.recovery); }
  restorePending(): string[] { const restored = this.inputs.restorePending(); this.session.activateHostCheckpoint(); return restored; }

  private measure(messages: Message[], model: Model<Api>): number {
    let result = estimateMessages(messages);
    const index = messages.findLastIndex((message) => message.role === "assistant" && message.provider === model.provider && message.model === model.id && message.stopReason !== "error" && message.stopReason !== "aborted");
    const assistant = messages[index];
    if (assistant?.role === "assistant") {
      const usage = assistant.usage;
      result = Math.max(result, usage.input + usage.cacheRead + usage.cacheWrite + usage.output + estimateMessages(messages.slice(index + 1)));
    }
    return result;
  }

  private async summarize(source: Message[], model: Model<Api>, output: number, signal: AbortSignal, prompt: string): Promise<{ response: AssistantMessage; usage: Usage }> {
    // Prefix timestamps let the SDK reuse historical usage when capping summary output.
    const messages = convertToLlm([
      ...source.filter((message) => !(message.role === "assistant" && message.stopReason === "error")),
      { role: "user", content: prompt, timestamp: Date.now() },
    ]);
    if (!model.input.includes("image") && messages.some((message) => typeof message.content !== "string" && message.content.some((block) => block.type === "image")))
      throw new CompactionError("budget-insufficient", "The selected model cannot summarize the images in this context. Select an image-capable model.");
    for (let retry = 0; ; retry++) {
      signal.throwIfAborted();
      let retryAfter = 0;
      const response = await this.session.modelRuntime.completeSimple(model, { messages }, {
        maxTokens: output, samplingParams: summarySampling(model, output), maxRetries: 0,
        reasoning: this.session.thinkingLevel === "off" ? undefined : this.session.thinkingLevel, signal, sessionId: this.session.sessionId,
        onResponse: (response) => {
          const header = response.headers["retry-after"];
          if (header) retryAfter = /^\d+(?:\.\d+)?$/.test(header) ? Number(header) * 1000 : Math.max(0, Date.parse(header) - Date.now());
        },
      });
      this.session.sessionManager.appendUsage("compaction", model.provider, model.id, response.usage);
      signal.throwIfAborted();
      if (response.stopReason !== "error" || isContextOverflow(response) || retry >= 2 || !/(?:429|rate.?limit|timed?\s*out|ECONNRESET|fetch failed|temporar|network|\b50[02349]\b|overloaded)/i.test(response.errorMessage ?? ""))
        return { response, usage: response.usage };
      await delay(Math.min(Math.max(retryAfter, 250 * 2 ** retry), this.session.agent.maxRetryDelayMs ?? 60_000), undefined, { signal });
    }
  }

  private async compact(request: { reason: Reason; customInstructions?: string; signal: AbortSignal }) {
    if (this.busy) throw new CompactionError("conflict", "Compaction is already in progress.");
    this.busy = true;
    try { return await this.buildAndCommit(request); }
    finally { this.busy = false; }
  }

  private async buildAndCommit({ reason, customInstructions, signal }: { reason: Reason; customInstructions?: string; signal: AbortSignal }) {
    const { session } = this;
    const manager = session.sessionManager;
    if (this.recovery) {
      const path = manager.getSessionFile();
      if (path) { await inspectSession(path, manager.getCwd()); manager.setSessionFile(path); }
      const saved = latestCheckpoint(manager);
      if (this.recovery.kind === "checkpoint" && saved?.checkpoint.id !== this.recovery.checkpointId)
        throw new CompactionError("activation", "The committed checkpoint is missing. Inspect the session file before continuing.");
      const settings = this.recovery.kind === "checkpoint" ? saved?.checkpoint.toolSettings
        : this.recovery.kind === "storage" ? saved?.checkpoint.toolSettings ?? this.recovery.settings : this.recovery.settings;
      if (!settings) throw new CompactionError("activation", "The checkpoint tool configuration cannot be restored.");
      await this.options.settings.restore(settings);
      session.activateHostCheckpoint();
      this.recovery = undefined;
    }
    const selected = session.model;
    const model = reason === "threshold" ? this.requestModel : selected;
    if (!model) throw new CompactionError("budget-insufficient", "Select a model before compacting.");
    const budget = requestBudget(model);
    const old = latestCheckpoint(manager);
    const inputs = this.inputs.snapshot();
    const cutoff = manager.getLeafId();
    const projection = manager.buildSessionProjection();
    const pendingIds = new Set(inputs.pendingEntryIds);
    const source = projection.entries.filter((entry) => !pendingIds.has(entry.sourceEntry.id)).flatMap((entry) => entry.messages);
    if (!source.some((message) => message.role !== "system" && !(message.role === "custom" && [CONTEXT_MESSAGE, "arkcode-tool-availability"].includes(message.customType))))
      throw new CompactionError("invalid-summary", "Nothing to compact (no conversation history).");
    assertClosedTools(source);
    const nextSettings = this.options.settings.defaults();
    const context = await this.options.captureContext(signal);
    const contextBaseline = context.details;
    const newHistory = projection.entries.some((entry) => entry.sourceEntry.type !== "compaction" && !pendingIds.has(entry.sourceEntry.id)
      && entry.messages.some((message) => message.role !== "system" && !(message.role === "assistant" && message.stopReason === "error")
        && !(message.role === "custom" && [CONTEXT_MESSAGE, "arkcode-tool-availability"].includes(message.customType))));
    const refresh = Boolean(old && !newHistory);
    if (refresh && old && JSON.stringify(old.checkpoint.toolSettings) === JSON.stringify(nextSettings)
      && JSON.stringify(old.checkpoint.contextBaseline) === JSON.stringify(contextBaseline)
      && !old.checkpoint.replacementMessages.some((message) => message.role === "custom" && message.customType === "arkcode-active-skills")) {
      const tokens = this.measure(projection.messages, model);
      if (tokens >= budget.threshold) throw new CompactionError("budget-insufficient", "No new history can be summarized, and the pending input does not fit below the compact target. Reduce the pending input or select a larger-context model.");
      return { summary: old.checkpoint.summary, firstKeptEntryId: old.entry.id, tokensBefore: tokens,
        estimatedTokensAfter: tokens, details: { outcome: "unchanged" } };
    }
    const retainedUsers = retainUsers(inputs.users);
    const users: Message[] = retainedUsers.map((user) => ({ role: "user", content: renderUser(user), timestamp: user.timestamp }));
    const latestUser = users.pop();
    const pendingMessages = projection.entries.filter((entry) => pendingIds.has(entry.sourceEntry.id)).flatMap((entry) => entry.messages);
    const tokensBefore = this.measure(projection.messages, model);
    const oldTools = this.options.settings.current;
    let staged;
    try { staged = await this.options.settings.stage(); }
    catch (error) {
      if (this.options.settings.needsRecovery) this.recovery = { kind: "original", settings: oldTools };
      throw error;
    }
    let committed = false;
    try {
      signal.throwIfAborted();
      const system = await session.prepareHostCheckpointSystem();
      const base: Message[] = [system, ...users, context, ...(latestUser ? [latestUser] : [])];
      const summaryMessage = (summary: string): CustomMessage => ({ role: "custom", customType: "arkcode-summary", display: false,
        content: `${SUMMARY_PREFIX}\n${summary}`, timestamp: Date.now(), details: { origin: "summary", version: 1 } });
      const fixed = estimateMessages([...base, summaryMessage(""), ...pendingMessages]);
      let output = Math.min(budget.output, budget.threshold - fixed - 1);
      if (output <= 0) throw new CompactionError("budget-insufficient", "Fixed context, tools, pending input and retained user text leave no space for a summary below the configured compact target.");
      let summary = refresh ? old?.checkpoint.summary : undefined;
      let usage: Usage | undefined;
      let prunedResults = 0;
      let summarySource = source;
      let complete = Boolean(summary);
      for (let attempt = 0; !complete && attempt < 2; attempt++) {
        const instruction = [COMPACT_PROMPT, customInstructions ? `Additional user instructions for this summary:\n${customInstructions}` : "", attempt ? COMPACT_RETRY_PROMPT : ""].filter(Boolean).join("\n\n");
        const summaryInput = () => estimateMessages(summarySource) + textTokens(instruction) + 6;
        if (summaryInput() >= budget.input) {
          const pruned = pruneToolResults(summarySource);
          if (prunedResults || !pruned.pruned) throw new CompactionError("overflow", "The summary request does not fit, and tool-result pruning cannot reduce it further.");
          summarySource = pruned.messages; prunedResults = pruned.pruned;
          if (summaryInput() >= budget.input) throw new CompactionError("overflow", "The summary request still exceeds the usable context window after pruning large tool results.");
        }
        output = Math.min(output, budget.input - summaryInput());
        const result = await this.summarize(summarySource, model, output, signal, instruction);
        usage = result.usage;
        const response = result.response;
        if (response.stopReason === "error") {
          if (isContextOverflow(response) && !prunedResults && attempt === 0) {
            const pruned = pruneToolResults(summarySource);
            if (pruned.pruned) { summarySource = pruned.messages; prunedResults = pruned.pruned; continue; }
          }
          throw new CompactionError(isContextOverflow(response) ? "overflow" : "invalid-summary", response.errorMessage ?? "Summary generation failed.");
        }
        if (response.stopReason === "aborted") throw new CompactionError("cancelled", "Compaction cancelled.");
        summary = response.content.filter((block) => block.type === "text").map((block) => block.text).join("\n").trim();
        if (response.stopReason !== "stop" || !summary || response.content.some((block) => block.type === "toolCall")) {
          if (attempt === 1) throw new CompactionError("invalid-summary", "Compaction did not produce a complete, non-empty text summary.");
          continue;
        }
        const after = estimateMessages([...base, summaryMessage(summary), ...pendingMessages]);
        complete = after < budget.threshold && after < tokensBefore;
        if (!complete) {
          output = Math.min(output - 1, Math.floor(textTokens(summary) * 0.75), budget.threshold - fixed - 1, tokensBefore - fixed - 1);
          if (attempt === 1 || output <= 0) throw new CompactionError("budget-insufficient", "The generated summary does not reduce the complete request below the compact target.");
        }
      }
      if (!complete || !summary) throw new CompactionError("invalid-summary", "Compaction did not produce a usable summary.");
      const replacementMessages = [...base, summaryMessage(summary)];
      const tokensAfter = estimateMessages([...replacementMessages, ...pendingMessages]);
      if (tokensAfter >= budget.threshold || (!refresh && tokensAfter >= tokensBefore)) throw new CompactionError("budget-insufficient", "The complete compacted request does not fit the target.");
      signal.throwIfAborted();
      const finalContext = await this.options.captureContext(signal);
      const finalSystem = await session.prepareHostCheckpointSystem();
      if (signature(finalContext.details) !== signature(contextBaseline)
        || signature([finalSystem.content, finalSystem.sections, finalSystem.toolsAdded]) !== signature([system.content, system.sections, system.toolsAdded]))
        throw new CompactionError("conflict", "Project instructions, environment or tool declarations changed during compaction. Retry against the current state.");
      signal.throwIfAborted();
      const branch = manager.getBranch();
      const cutoffIndex = cutoff === null ? -1 : branch.findIndex((entry) => entry.id === cutoff);
      if ((cutoff !== null && cutoffIndex < 0) || branch.slice(cutoffIndex + 1).some((entry) => entry.type !== "custom" && entry.type !== "usage")
        || session.model !== selected || JSON.stringify(this.options.settings.defaults()) !== JSON.stringify(nextSettings))
        throw new CompactionError("conflict", "The session branch, model or configuration changed during compaction. Retry against the current state.");
      const checkpoint: Checkpoint = {
        version: 1, kind: refresh ? "refresh" : "summary", id: randomUUID(), cutoff, summary,
        replacementMessages: replacementMessages.filter((message): message is Checkpoint["replacementMessages"][number] => message.role === "system" || message.role === "user" || message.role === "custom"),
        retainedUsers, pendingEntryIds: inputs.pendingEntryIds, deliveredInputIds: inputs.deliveredInputIds,
        contextBaseline, toolSettings: staged.snapshot, model: { provider: model.provider, id: model.id }, reason,
        budget, tokensBefore, tokensAfter, prunedResults,
      };
      parseCheckpoint({ arkcode: checkpoint });
      try {
        manager.appendCompaction(summary, null, tokensBefore, { arkcode: checkpoint }, true);
        committed = true;
        const path = manager.getSessionFile();
        if (path) { const fd = openSync(path, "r+"); try { fsyncSync(fd); } finally { closeSync(fd); } }
        session.activateHostCheckpoint();
      } catch (error) {
        const path = manager.getSessionFile();
        if (!committed && path) {
          try {
            const records: unknown[] = readFileSync(path, "utf8").trimEnd().split(/\r?\n/).map((line) => JSON.parse(line));
            committed = records.some((record) => {
              if (!record || typeof record !== "object" || !("details" in record)) return false;
              return parseCheckpoint(record.details)?.id === checkpoint.id;
            });
            manager.setSessionFile(path);
          } catch { this.recovery = { kind: "storage", settings: oldTools }; }
        }
        if (committed) this.recovery = { kind: "checkpoint", checkpointId: checkpoint.id };
        throw new CompactionError(this.recovery ? "activation" : "conflict", this.recovery
          ? "Checkpoint persistence or activation needs recovery. Model requests are blocked; reopen this session or retry /compact."
          : "The checkpoint was not committed; the original context is retained.", { cause: error });
      }
      if (inputs.legacy && !this.warnedLegacy) { this.warnedLegacy = true; this.options.warning("Legacy user messages have no input provenance. Known generated wrappers were excluded; retained legacy text is best-effort."); }
      this.failedSnapshot = undefined;
      this.paused = false;
      this.options.settings.clearFailure();
      return { summary, firstKeptEntryId: manager.getLeafId() ?? "", tokensBefore, estimatedTokensAfter: tokensAfter, usage, details: { arkcode: checkpoint } };
    } catch (error) {
      if (!committed && !this.recovery) {
        try { await staged.rollback(); }
        catch (rollbackError) {
          this.recovery = { kind: "original", settings: oldTools };
          throw new CompactionError("activation", `Tool configuration rollback failed. Model requests are blocked until compact recovery. ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`, { cause: rollbackError });
        }
      } else if (committed) this.options.settings.current = latestCheckpoint(manager)?.checkpoint.toolSettings ?? oldTools;
      throw error;
    }
  }
}
