# ArkCode v0.1 implementation

## Workflow

- [x] Read the Principles section of poteto-mode.
- [x] Phase A: Frame. Use the current TUI v3 and the user's sandbox exception.
- [x] Phase B: Design the workflow. Reuse the settled Pi ownership design.
- [x] Phase C: Run the loop. Build and verify each unit.
- [x] Phase D: Keep the audit trail.
- [x] Phase E: Verify and hand back.

## Definition of done

The installed CLI starts in a real terminal, accepts prompts and streams model output. A local OpenAI-compatible fixture drives the real Pi SDK through read, write, edit and shell tool calls. Approvals can deny an action without side effects. Interrupt cancels pending approval and a running process tree. Read Only exposes no write or shell capability. Sessions survive restart and can be resumed and forked without replaying a tool. The status footer shows the current Git branch when available. Build and automated acceptance checks pass.

## Units

1. Package, shared discriminated states, test entry point and locked SDK version.
2. Explicit ArkCode model/auth storage, trusted text resources, session and workspace ownership.
3. File/search tools and managed native shell with shared approval broker.
4. SDK adapter, queue delivery, lifecycle, and session commands.
5. Pi TUI components, composer, pickers, approval focus, Markdown and six-value footer.
6. Protocol acceptance tests, terminal interaction checks, documentation and independent review.

## Throughput checkpoint

After the first SDK run, check whether package APIs and native terminal behavior are usable. If they differ from the documented contracts, adjust the adapter before building more commands. Keep one agent implementation and Pi's session tree as the only conversation authority. The TUI and tool modules can proceed independently against src/domain.ts.

## Decisions

Model the Domain puts runtime phases in RunState and outcomes in a separate field. Foundational Thinking establishes the shared contract before delegates edit. Prove It Works requires a real protocol and tool execution check, followed by a native terminal check.

No sandbox is implemented in this release. Ask approves each write and executable action. Read Only omits shell and writing tools. Full Access runs with the user's OS privileges. The CLI rejects sandbox modes rather than claiming isolation.

## Prism native TUI integration on 2026-10-10

- [x] Ground the selected demo and installed Pi editor and session events.
- [x] Compare a direct editor subclass with a focus and mouse forwarding wrapper.
- [x] Commit the removal of /clear separately.
- [x] Integrate the Prism transcript and composer with real tool targets and provider reasoning.
- [x] Verify widths, approvals, queued inputs, restored history, and native Windows PTY behavior.
- [x] Record the final checks and limitations.

Throughput checkpoint:

- Blocking first steps: establish the ToolDetails and reasoning UI contracts before final renderer checks.
- Independent workstreams: the renderer owns src/ui.ts; the host owns src/runtime.ts and tests; a read-only explorer compares alternative composer shapes.
- Shared mutable state: Pi owns history and Agent execution. UI records project real events by stable tool and reasoning identities.
- Smallest safe decomposition: one renderer owner avoids concurrent composer edits. The main agent integrates the backend and drives verification.

Model the Domain keeps tools, messages, and reasoning as distinct transcript records. Type System Discipline carries parsed targets through ToolDetails rather than reconstructing them from output text. Prove It Works requires both real Pi fixture execution and a native terminal run.
