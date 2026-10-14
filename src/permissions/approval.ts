import { createHash } from "node:crypto";
import type { ApprovalRequest, Permission, UserInterface } from "../app/types.js";
import { inspectShell } from "./shell-policy.js";

export class ApprovalBroker {
  private grants = new Set<string>();
  private pending: { cancel: () => void } | null = null;
  private generation = 0;
  constructor(
    private ui: UserInterface,
    private permission: () => Permission,
    private changed: (request: ApprovalRequest | null) => void,
  ) {}

  async authorize(request: ApprovalRequest): Promise<boolean> {
    const permission = this.permission();
    if (permission === "never-ask") return true;
    const mcp = request.invocation?.kind === "mcp" ? request.invocation : undefined;
    if (!mcp && ["Read", "Grep", "Glob"].includes(request.tool)) return true;
    const generation = this.generation;
    const inspection = request.invocation?.kind === "shell"
      ? await inspectShell(request.invocation.command, request.invocation.shell) : undefined;
    if (generation !== this.generation || this.permission() !== permission) return false;
    const digest = createHash("sha256").update(JSON.stringify([request.tool, request.cwd, request.description, request.invocation])).digest("hex");
    const dangerous = inspection?.dangerous || mcp?.destructive;
    if (!dangerous && this.grants.has(digest)) return true;
    if (!dangerous && (mcp ? permission === "ask-when-needed" && mcp.autoApprove : permission === "ask-when-needed" || inspection?.listing)) return true;
    this.changed(request);
    let cancel: () => void = () => {};
    const cancelled = new Promise<"deny">((resolve) => { cancel = () => resolve("deny"); });
    const current = { cancel };
    this.pending = current;
    try {
      const decision = await Promise.race([this.ui.approve(request), cancelled]);
      if (this.pending !== current || this.permission() !== permission) return false;
      if (decision === "session") this.grants.add(digest);
      return decision !== "deny";
    } finally {
      if (this.pending === current) this.pending = null;
      this.changed(null);
    }
  }

  cancel(): void {
    this.generation++;
    const pending = this.pending;
    this.pending = null;
    pending?.cancel();
    if (pending) this.ui.dismiss();
  }
  reset(): void { this.cancel(); this.grants.clear(); }
}
