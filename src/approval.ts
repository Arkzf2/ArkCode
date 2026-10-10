import { createHash } from "node:crypto";
import type { ApprovalRequest, Permission, UserInterface } from "./domain.js";

export class ApprovalBroker {
  private grants = new Set<string>();
  private pending: { cancel: () => void } | null = null;
  constructor(
    private ui: UserInterface,
    private permission: () => Permission,
    private changed: (request: ApprovalRequest | null) => void,
  ) {}

  async authorize(request: ApprovalRequest): Promise<boolean> {
    const permission = this.permission();
    if (permission === "read-only") return false;
    if (permission === "full-access") return true;
    const digest = createHash("sha256").update(JSON.stringify([request.tool, request.cwd, request.description])).digest("hex");
    if (this.grants.has(digest)) return true;
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
    const pending = this.pending;
    this.pending = null;
    pending?.cancel();
    if (pending) this.ui.dismiss();
  }
  reset(): void { this.cancel(); this.grants.clear(); }
}
