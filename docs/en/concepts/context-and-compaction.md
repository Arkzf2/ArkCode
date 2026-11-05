# Model context and compaction

English | [简体中文](../../zh-CN/concepts/context-and-compaction.md) | [Docs home](../README.md)

The model context contains the current system rules, enabled tool declarations, the user task, and the effective history of the current session. ArkCode refreshes environment, project instructions, the Skills catalog, and tool availability when it prepares a request. The full transcript shown in the terminal may not all appear in the next model request.

## How project resources enter context

AGENTS.md files load by trust, directory scope, and byte budget. Skills catalogs normally provide only names, descriptions, and paths; the body loads only on explicit selection or read. File mentions are handled together with the user's explicit input, and loaded content does not replace the original source record of the user's input.

Dynamic environment changes take effect on later requests, including requests after tool execution in the same turn. A request that was already sent cannot be revoked. Permissions and tool availability are still checked at the actual execution boundary; history prompts do not grant permissions.

## When compaction runs

`/compact` triggers compaction manually. Automatic compaction checks the input budget after a complete tool batch closes and before the next model request. An actual overflow can also trigger one compaction and retry. ArkCode manages triggering, summary policy, and checkpoints; Pi provides model calling and history primitives.

For a context window W, automatic compaction triggers at `floor(0.9 * W)`, matching Codex's default. The usable context limit is `floor(0.95 * W)`. Neither calculation subtracts `maxTokens` or uses a fixed 25k/50k reserve.

`maxTokens` caps output; the actual summary output limit also depends on the remaining context and compact target. For a 256000-token window, automatic compaction triggers at 230400 tokens and usable context is 243200 tokens. These budgets are estimates, not guarantees of provider billing tokens. The status bar statistic and cumulative cost are also different metrics.

## What compaction keeps

ArkCode generates a task summary, keeps up to 20000 tokens of real user text from the recent budget, and rebuilds current environment, rules, and tool policy. When the retained budget is insufficient, user text may be truncated by rule. See the [compaction prompt reference](../reference/compaction-prompts.md) for the exact summary instructions.

The original JSONL history is kept, so TUI resume can display messages from before compaction; that does not mean the model can still see the whole history. Skill bodies loaded in history are not automatically refilled. Queued but undelivered input keeps its own body snapshot.

Summary retries may temporarily trim the middle of large tool results. This applies only to the summary input copy and does not modify the original log. There is currently no additional history retrieval tool or background compaction service.

## Success and failure

The new summary, context baseline, and tool policy commit in the same checkpoint. After a successful compaction, pending [tool modes](../reference/tool-modes.md) apply. Failure or cancellation before commit keeps the old policy; persistence or activation errors stop further requests until recovery.

When compaction fails but the old request still fits, ArkCode warns and continues. When it no longer fits, it pauses. Empty summaries, truncated output, and unmet budget are not treated as success. A short answer that the model can continue is not resumed merely because it is short; an explicit length truncation resumes at most twice, and the run errors if it still fails.
