import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { recordWebSearchUsage, searchFee, webSearchStats, type WebSearchUsage } from "../src/integrations/web-search-usage.js";

test("search call fees use official prices only for official endpoints and remain separate from model tokens", () => {
  for (const [protocol, baseUrl] of [["openai-responses", "https://api.openai.com/v1"], ["anthropic-messages", "https://api.anthropic.com"]] as const) {
    const fee = searchFee(protocol, baseUrl, 3);
    assert.equal(fee.status, "estimated");
    if (fee.status !== "estimated") assert.fail("Expected official search price");
    assert.equal(fee.amount, 0.03);
    assert.equal(fee.currency, "USD");
    assert.equal(fee.checkedOn, "2026-11-03");
  }
  for (const endpoint of ["https://proxy.example/v1", "https://api.openai.com.proxy.example/v1", "http://api.openai.com/v1"]) {
    assert.equal(searchFee("openai-responses", endpoint, 3).status, "unknown");
  }
});

test("search receipts count once, survive compaction and record manual check usage without invented tokens", () => {
  const manager = SessionManager.inMemory();
  const receipt: WebSearchUsage = { requestId: "request-one", provider: "openai", model: "test", searches: 3, searchCountSource: "events",
    fee: searchFee("openai-responses", "https://api.openai.com/v1", 3),
    usage: { input: 20, output: 5, reasoning: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 32,
      cost: { input: 0.001, output: 0.002, cacheRead: 0.003, cacheWrite: 0.004, total: 0.01 },
    },
  };
  recordWebSearchUsage(manager, receipt, true);
  recordWebSearchUsage(manager, receipt, true);
  const usages = manager.getEntries().filter((entry) => entry.type === "usage");
  assert.equal(usages.length, 1);
  assert.deepEqual(usages[0]?.usage, receipt.usage);
  const charge = manager.getEntries().find((entry) => entry.type === "custom");
  assert.ok(charge?.type === "custom");
  manager.appendCustomEntry(charge.customType, charge.data);
  recordWebSearchUsage(manager, { ...receipt, requestId: "request-two", searches: 1,
    fee: { status: "unknown", reason: "Proxy price not supplied." },
  });
  manager.appendCompaction("Search evidence summary", null, 100);
  assert.deepEqual(webSearchStats(manager.getEntries()), { requests: 2, searches: 4, estimatedSearchFeesUSD: 0.03, unknownFeeRequests: 1 });
  assert.equal(manager.getEntries().filter((entry) => entry.type === "usage").length, 1);
});
