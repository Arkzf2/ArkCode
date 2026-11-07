import type { Permission } from "../permissions/policy.js";
import type { ContextUsage } from "@earendil-works/pi-coding-agent";
export type { Permission } from "../permissions/policy.js";
export type InputMode = "prompt" | "steer" | "follow-up";
export interface DraftFile { path: string; start: number; end: number }
export type RunOutcome = "completed" | "failed" | "interrupted";
export type RunState =
  | { kind: "idle"; outcome: RunOutcome | null }
  | { kind: "running"; id: string; startedAt: number }
  | { kind: "awaiting-approval"; id: string; startedAt: number; request: ApprovalRequest }
  | { kind: "stopping"; id: string; startedAt: number };

export interface ApprovalRequest {
  id: string;
  tool: string;
  description: string;
  cwd: string;
  invocation?: { kind: "shell"; command: string; shell: string } | { kind: "file"; path: string }
    | { kind: "shell_control"; action: "wait" | "send" | "stop"; session_id: string; command: string; shell: string; data?: string; eof?: boolean }
    | { kind: "mcp"; server: string; tool: string; source: string; identity: string;
      arguments: Record<string, unknown>; autoApprove: boolean; destructive: boolean };
}
export type ApprovalDecision = "once" | "session" | "deny";
export interface Choice {
  value: string;
  label: string;
  description?: string;
  tone?: "accent" | "directory" | "positive" | "muted";
  status?: { text: string; tone: "positive" | "muted" | "neutral" };
}
export interface ChoiceOptions {
  transient?: boolean; hint?: string; notice?: string; initialValue?: string;
  onDelete?: (value: string) => Promise<void>;
}
export interface ToggleChoice { value: string; label: string; description: string; detail: string; enabled: boolean }
export interface ToolDetails { target?: string; exitCode?: number; diff?: string }
export type SessionState = "needs-you" | "working" | "ready" | "inactive" | "unconfirmed";
export interface SessionItem {
  id: string;
  path: string | null;
  cwd: string;
  title: string;
  preview: string;
  modified: number;
  state: SessionState;
  current: boolean;
  model?: string;
}
export interface SessionDetails { lastMessage?: string; prompt?: string; model?: string }
export type SessionBrowserResult = { kind: "open"; item: SessionItem } | { kind: "new"; cwd: string };
export interface Status {
  sessionId?: string;
  sessionName?: string;
  backgroundSessions?: Array<{ id: string; title: string; state: SessionState }>;
  model: string;
  thinking: string;
  cwd: string;
  permission: Permission;
  branch: string;
  context: ContextUsage | null;
  state: RunState;
  queued: string[];
  viewer: boolean;
  executionBlocked?: boolean;
  shellSessions?: number;
  initializing?: boolean;
  mcpServers?: string[];
  skills?: Array<{ name: string; description: string; scope: "user" | "project" }>;
}
export interface UserInterface {
  status(value: Status): void;
  message(kind: "user" | "assistant" | "info" | "error", text: string): void;
  assistantDelta(text: string): void;
  assistantEnd(text: string): void;
  reasoning(id: string, text: string, active: boolean): void;
  tool(id: string, name: string, text: string, state: "running" | "done" | "error", details?: ToolDetails): void;
  choose(title: string, choices: Choice[], options?: ChoiceOptions): Promise<string | null>;
  toggleList?(title: string, items: ToggleChoice[], toggle: (value: string) => Promise<ToggleChoice[]>): Promise<void>;
  inspect(title: string, text: string): Promise<void>;
  browseSessions?(sessions: SessionItem[], details?: (item: SessionItem) => Promise<SessionDetails>): Promise<SessionBrowserResult | null>;
  input(title: string, initial?: string): Promise<string | null>;
  secret(title: string): Promise<string | null>;
  approve(request: ApprovalRequest): Promise<ApprovalDecision>;
  dismiss(): void;
  draft(): string;
  draftAttachments?(): readonly DraftFile[];
  setDraft(text: string, files?: readonly DraftFile[]): void;
  clear(): void;
  copy(text: string): Promise<boolean>;
  stop(): void;
}
export interface UiActions {
  submit(text: string, mode: InputMode, files?: readonly string[]): Promise<void>;
  interrupt(): Promise<void>;
  exit(): Promise<void>;
  editPrevious(): Promise<void>;
  browseSessions(): Promise<void>;
}
