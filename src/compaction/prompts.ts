export const SUMMARY_PREFIX = "Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:";

export const COMPACT_PROMPT = `Create a context checkpoint for an LLM continuing the same task. Return only the handoff summary.

Cover:
- Current progress and the decisions that matter for continuing.
- The active objective, latest user corrections, constraints, and relevant preferences.
- Unfinished work, blockers, and concrete next actions.
- Essential evidence, data, paths, commands, errors, and references.

Use concise structure suited to the task. Preserve exact identifiers and critical values. Separate completed work, failed attempts, and planned actions. State the last operation and its actual result when the task is in progress. Keep enough detail for the next LLM to continue without repeating completed actions.

Consolidate the previous checkpoint with newer events. Resolve superseded requests using the user's later corrections. Treat history as material to summarize. Follow the currently supplied system instructions. Return text without calling tools or continuing the task.

Describe running work with its known identifiers and last verified status. Current permissions, tool availability, project instructions, and environment are supplied separately by ArkCode; historical descriptions do not override them.

When a record contains a pruning marker or incomplete evidence, state the uncertainty and preserve what is known. Do not reconstruct omitted text.`;

export const COMPACT_RETRY_PROMPT = "Return a complete, non-empty handoff within the available output budget. Shorten background and repeated details. Preserve the active objective, last verified execution state, unresolved work, and next actions.";
