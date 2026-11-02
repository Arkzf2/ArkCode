import type { Usage } from "@earendil-works/pi-ai";
import type { SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import { z } from "zod";

export type WebSearchProtocol = "openai-responses" | "anthropic-messages";
const ENTRY_TYPE = "arkcode-web-search-usage";
const feeSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("estimated"), currency: z.literal("USD"), amount: z.number().nonnegative(),
    perSearch: z.number().nonnegative(), source: z.url(), checkedOn: z.string() }),
  z.object({ status: z.literal("unknown"), reason: z.string() }),
]);
const chargeSchema = z.object({ version: z.literal(1), requestId: z.string(), provider: z.string(), model: z.string(),
  searches: z.number().int().nonnegative(), searchCountSource: z.enum(["provider", "events"]), fee: feeSchema,
});
export type WebSearchUsage = Omit<z.infer<typeof chargeSchema>, "version"> & { usage: Usage };

export function searchFee(protocol: WebSearchProtocol, baseUrl: string, searches: number): z.infer<typeof feeSchema> {
  const endpoint = new URL(baseUrl);
  const official = protocol === "openai-responses" ? "api.openai.com" : "api.anthropic.com";
  if (endpoint.protocol !== "https:" || endpoint.hostname !== official || endpoint.port) {
    return { status: "unknown", reason: "Search pricing for this endpoint is not configured or reported by the provider." };
  }
  return { status: "estimated", currency: "USD", amount: searches * 0.01, perSearch: 0.01, checkedOn: "2026-11-03",
    source: protocol === "openai-responses" ? "https://developers.openai.com/api/docs/pricing#tools"
      : "https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool#usage-and-pricing",
  };
}

export function recordWebSearchUsage(manager: SessionManager, receipt: WebSearchUsage, modelUsage = false): void {
  if (manager.getEntries().some((entry) => entry.type === "custom" && entry.customType === ENTRY_TYPE
    && chargeSchema.safeParse(entry.data).data?.requestId === receipt.requestId)) return;
  if (modelUsage) manager.appendUsage("web-search", receipt.provider, receipt.model, receipt.usage);
  manager.appendCustomEntry(ENTRY_TYPE, chargeSchema.parse({ version: 1, ...receipt }));
}

export function webSearchStats(entries: readonly SessionEntry[]) {
  const seen = new Set<string>();
  const totals = { requests: 0, searches: 0, estimatedSearchFeesUSD: 0, unknownFeeRequests: 0 };
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
    const result = chargeSchema.safeParse(entry.data);
    if (!result.success || seen.has(result.data.requestId)) continue;
    const charge = result.data;
    seen.add(charge.requestId);
    totals.requests++;
    totals.searches += charge.searches;
    if (charge.fee.status === "estimated") totals.estimatedSearchFeesUSD += charge.fee.amount;
    else totals.unknownFeeRequests++;
  }
  return totals;
}
