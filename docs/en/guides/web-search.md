# Use Web Search

English | [简体中文](../../zh-CN/guides/web-search.md) | [Docs home](../README.md)

## Check availability

Run `/web-search status` to view the current model state. Search requires the OpenAI Responses or Anthropic Messages protocol and an endpoint that supports server-side search. Ordinary Chat Completions do not declare `WebSearch`.

Run `/web-search check` to perform a real search and confirm the endpoint actually calls the search tool. This operation uses model usage and may incur provider search fees. A plain text answer does not prove search capability.

When the endpoint explicitly returns unsupported, the current capability record stops offering the tool. Recheck after changing the model, endpoint, or credentials.

## Enable and submit a task

`/web-search on` enables search and `/web-search off` disables it. The choice is saved in configuration and takes effect from the next task. Then submit a task that needs external information:

```text
	Search the official migration notes for this library, give sources, and explain how they relate to the current project.
```

Search uses a separate model request; it submits only the query, not the current conversation or local files. Summaries and links return to the current session and still use the selected model's credentials and endpoint.

`WebSearch` follows [tool modes](../reference/tool-modes.md). Always Ask requires approval; Ask When Needed and Never Ask allow it automatically. A manual `/web-search check` is an explicit user-initiated check.

## View usage

In `/status`, `Usage.webSearch` shows request count, search count, estimated cost, and requests with unknown cost. Provider-reported model usage is included in cumulative totals; search cost is separate from model `cost`.

Official endpoints use ArkCode's built-in rate estimates; proxies and custom endpoints show unknown. Estimates are not billing; provider billing is authoritative. When the network breaks before usage arrives, the missing usage cannot be computed later, and some discarded compaction summary attempts are also not included in the complete totals.
