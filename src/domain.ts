export type Permission = "read-only" | "ask" | "full-access";
export type InputMode = "prompt" | "steer" | "follow-up";
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
}
export type ApprovalDecision = "once" | "session" | "deny";
export interface Choice { value: string; label: string; description?: string }
export interface Status {
  model: string;
  thinking: string;
  cwd: string;
  permission: Permission;
  branch: string;
  context: string;
  state: RunState;
  queued: string[];
  viewer: boolean;
}
export interface UserInterface {
  status(value: Status): void;
  message(kind: "user" | "assistant" | "info" | "error", text: string): void;
  assistantDelta(text: string): void;
  assistantEnd(text: string): void;
  tool(id: string, name: string, text: string, state: "running" | "done" | "error"): void;
  choose(title: string, choices: Choice[]): Promise<string | null>;
  input(title: string, initial?: string): Promise<string | null>;
  approve(request: ApprovalRequest): Promise<ApprovalDecision>;
  dismiss(): void;
  draft(): string;
  setDraft(text: string): void;
  clear(): void;
  copy(text: string): Promise<boolean>;
  stop(): void;
}
export interface UiActions {
  submit(text: string, mode: InputMode): Promise<void>;
  interrupt(): Promise<void>;
  exit(): Promise<void>;
  editPrevious(): Promise<void>;
}
