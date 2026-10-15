import type { Status } from "../app/types.js";

export function tokenCount(value: number): string {
  if (value < 1000) return String(Math.round(value));
  const divisor = value >= 1_000_000 ? 1_000_000 : 1000;
  return `${Number((value / divisor).toFixed(1))}${divisor === 1000 ? "k" : "m"}`;
}

export function contextReadout(usage: Status["context"], width: number): { text: string; tone: "normal" | "warning" | "critical" } {
  if (!usage || usage.contextWindow <= 0) return { text: "Usage unavailable", tone: "normal" };
  const capacity = tokenCount(usage.contextWindow);
  if (usage.tokens === null) return { text: `? / ${capacity} tokens · waiting for usage`, tone: "normal" };
  const tokens = Math.max(0, usage.tokens);
  const percent = tokens / usage.contextWindow * 100;
  const tone = percent >= 90 ? "critical" : percent >= 70 ? "warning" : "normal";
  const label = `~${tokenCount(tokens)} / ${capacity} tokens · ${percent.toFixed(1)}% used`;
  const barWidth = width >= 75 ? 10 : 5;
  const filled = Math.min(barWidth, Math.round(percent / 100 * barWidth));
  const bar = `${"█".repeat(filled)}${"░".repeat(barWidth - filled)}`;
  return { text: width >= label.length + barWidth + 1 ? `${bar} ${label}` : label, tone };
}

export function contextDetails(status: Status): string {
  const usage = status.context;
  const lines = [`Model: ${status.model}`];
  if (!usage || usage.contextWindow <= 0) return [...lines, "Context usage unavailable."].join("\n");
  lines.push(`Context window: ${usage.contextWindow.toLocaleString("en-US")} tokens`);
  if (usage.tokens === null) lines.push("Usage pending. Waiting for a model response after compaction.");
  else {
    const tokens = Math.max(0, usage.tokens);
    lines.push(`Estimated used: ${tokens.toLocaleString("en-US")} tokens`,
      `Remaining: ${Math.max(0, usage.contextWindow - tokens).toLocaleString("en-US")} tokens`,
      `Used: ${(tokens / usage.contextWindow * 100).toFixed(1)}%`,
      "", "Usage is estimated from the current conversation and the latest model response.");
  }
  return lines.join("\n");
}
