# ArkCode v0.1 verification

Date: 2026-10-09. Platform: Windows. Node: 24.18.0. Pi SDK: 1.1.0.

## Concurrent sessions, 2026-10-16

Pi SDK 1.2.0. ArkHost retains independent SessionRuntime instances when opening, resuming or forking another session. SessionView buffers each transcript and draft, and waits for focus before displaying a background approval. SessionLease gives one host input and persistence ownership of a session ID across terminals and configuration homes. A second host opens a viewer backed by an in-memory SDK session, polls saved JSONL, and retries ownership only when the user reopens that session.

Final type checking and all 235 regression tests passed with zero failures, skips or cancellations. The production build and compiled CLI version/help smoke checks passed. Validation used local model/MCP protocol fixtures, real child processes, filesystem effects and the real TUI renderer; this change has not been tested against a remote model or manually exercised in multiple native terminal windows.

Real Pi sessions against a loopback model fixture verify concurrent pending model requests, isolated histories and drafts, independent terminal hosts in one workspace, deferred background approvals, viewer history refresh, denied viewer mutations, ownership acquisition after the owner exits, retained steer/follow-up queues, and independent forks. Editing a previous prompt branches a separate SessionManager and restores the prompt into its new draft; the original runtime keeps its identity, history and lease. Cancelling MCP startup restores the previous runtime and releases the cancelled session's ownership. A viewer remains usable if startup is cancelled while it tries to acquire input ownership. Actual CLI child processes verify overlapping requests from two sessions and rejection of input into an already-owned session without modifying its history. Lease tests include real-process stale owner recovery. The real TUI renderer verifies browsing during a run, read-only submission with draft preservation, and an approval that survives switching away and back.

Separate ArkCode toolsets with parent and child working directories target the same actual file through the installed Pi tools. Disjoint edits both survive; two overlapping edits with the same old text produce one success and one native Pi target-not-found error. ArkCode adds no file queue or version check. The Pi module queue serializes Edit/Write within one process and SDK module instance. It does not coordinate independent terminal processes, shell commands, MCP mutations or external editors, and full-file Write can overwrite earlier content.

Upstream source comparison used local checkouts of Pi at `d20c6e96625143bdb6fc533843d30601a9f6fcf8`, Kimi at `5b936697670ed15444bcb4720bd91e6ee776a941`, and Codex at `be2e129ecd67d900c016eda12d5d193e33d9c3da`. Kimi's `packages/agent-core-v2/src/app/sessionManager/sessionManagerService.ts` retains an owners map and serializes lifecycle operations by session ID. Codex's `codex-rs/thread-store/src/local/mod.rs` acquires a thread writer lock and reports a conflict when it is held. The inspected Pi SessionManager has no equivalent ownership lock. These observations establish runtime ownership or persistence behavior; they do not establish that every client prohibits simultaneous terminal input. ArkCode explicitly enforces the requested single input owner.

The previous workspace-wide writer lock and recovery restrictions described in the older sections below have been replaced by session ownership and session-local recovery restrictions. The local verification logs are `.audit/runtime/multi-session-*.log` and remain ignored.

## Tool modes and parallel calls, 2026-10-16

Pi SDK 1.2.0. The complete regression run passed 201 tests with zero failures or cancellations. Type checking and production build passed, as did the compiled CLI version/help smoke checks. A later targeted regression verifies that a tool-policy application failure after compact blocks the next model request. The earlier dated sections below retain their original release context.

Real Pi sessions and local model/MCP servers verify direct, hybrid and CodeMode-only declarations, strict script callability, MCP discovery, ordinary and incremental Chat Completions serialization, resume/fork policy retention, successful manual/automatic compact, failed compact, removed-tool dispatch rejection, and revocation during approval. Two native shell processes synchronize on each other's files to prove concurrent scheduling. Concurrent edits preserve both changes through Pi's same-file mutation queue. Approval cancellation denies queued requests and ignores late grants.

The real TUI renderer verifies Current/Pending only inside the temporary tool-mode menu, selection persistence, returning to the prior conversation, and excluding both /mcp and /tool-mode from input history. A regression also updates an MCP directory during a running direct-mode turn and verifies that unused discovery tools stay hidden.

These checks use loopback services and the installed SDK. No remote model cache-hit measurement, remote Responses/Anthropic provider acceptance, or new desktop OAuth acceptance is claimed. The local full-run log is `.audit/runtime/tool-mode-tests-final.log` and remains ignored.

## Real model

The operator authorized DEEPSEEK_API_KEY and deepseek-flash. Credentials remained in the environment. Commands ran in .audit/runtime/deepseek-workspace, outside application source.

- A print-mode request returned ARKCODE_CONNECTED from DeepSeek Flash.
- A real agent read calculator.js, replaced subtraction with addition, created a node:assert/strict test, and ran it through the managed PowerShell tool. The shell returned exit code 0. A separate local invocation printed PASS: add(2, 3) === 5.
- A second agent request attempted write of denied.txt. Print mode denied approval. The model reported denial, and Test-Path returned False.
- Resume --last restored that conversation. The model identified the prior denied write without executing tools.
- The native Windows PTY rendered ArkCode, all six footer values, streamed TUI_CONNECTED, opened /permissions, canceled the picker, and exited with the original /quit command. Raw mode and bracketed paste were restored on exit. The current release uses /exit.
- A second native PTY request opened a real write approval. Selecting option 3 denied the operation, the model reported denial, and native-approval-denied.txt did not exist. The CLI exited cleanly.

The persisted Pi JSONL files in .audit/runtime/deepseek/sessions record these calls and real tool results. This local runtime folder is ignored by Git and excluded from the package.

## Repeatable checks

Run npm run check, npm run build and npm test. The tests use real Pi sessions against a loopback model protocol fixture. They cover file effects, approval, queues, interrupt, history, writer ownership, shell process cancellation, Git branch detection and Pi TUI rendering. Fixture calls do not require external credentials. Type checking includes application and test files. npm link installs the local executable, and arkcode --version prints 0.1.0.

Model the Domain determines mutually exclusive runtime phases. Foundational Thinking establishes the shared state and test entry points before feature implementation. Prove It Works determines the checks against actual files, process exits, persisted history and native terminal output.

## Final review

An independent source review found a preparation cancellation race, incorrect manual compaction outcomes and an orphaned recovery-lock boundary. A real SDK regression first reproduced one model request after an immediate interrupt. The fix checks cancellation after marker persistence and file expansion; the final test observes zero model requests and no conversation file. Manual compaction failures now report failed, including after a prior interrupted run.

Run markers now include the canonical workspace path. Startup checks active markers even before a session history file exists. A regression creates such a marker, verifies that /permissions and /new cannot enable writes, and confirms that subsequent model inspection exposes only reading tools.

The recovery-lock boundary remains a documented limit. The viewer now identifies an incomplete lease or recovery file and gives its exact path for inspection. A real-process crash test verifies the viewer diagnostic and ownership recovery after manual removal of an orphaned recovery file. Automatic removal is not implemented. The comment review removed two narration comments and kept the bracketed-paste protocol comment. No application changes were delegated during this review.

## Command reduction on 2026-10-10

The v0.1 command menu contains /help, /model, /connect, /permissions, /status, /new, /clear, /resume, /rename, /fork, /compact, /copy, /init, and /exit. Help and autocomplete read the same command list. /new and /clear still share the same behavior.

The diff and review workflows, process-list command, theme and footer preferences, stop command, quit alias, and mention command were removed. File references use @path. Ctrl+C interrupts an active run and exits when idle. The fixed dark theme and six-field footer remain. Legacy theme and statusline settings are accepted on load and omitted on save.

Regression checks reject all eight removed commands without a model request, attach a quoted file reference through the real Pi session, check Ctrl+C on the TUI input path, and verify settings migration and rejection of unrelated unknown keys.

## Clear removal and Prism integration on 2026-10-10

Commit 4d8903f removes /clear from commands, help, autocomplete, and runtime dispatch. /new remains the sole new-session command. Regression checks reject /clear without a model request.

The visual reference is docs/arkcode-design/tui/arkcode-tui-demo.html#prism/instrument-deepfield. The native renderer uses the demo's Prism colors, header, purple composer frame, transcript gutters, compact exploration records, and six-value footer. Pi retains editor history, paste, autocomplete and cursor handling. Approvals replace the composer and preserve its draft. Targets, exit codes and reasoning come from actual Agent events and persisted Pi history. The renderer does not invent concise reasoning summaries or sandbox access reasons from demo fixtures.

Final npm run check, npm run build and npm test passed. All 51 tests passed, including actual provider reasoning lifecycle, failed shell exit codes, user-shell history restoration, narrow layouts, panel focus, and stopping input safety. Rendering checks at 24, 40, 80 and 120 columns included Chinese text, long receipts, fenced code, and a draft containing a border glyph. git diff --check passed.

A real DeepSeek Flash run in Windows ConPTY read input.txt and streamed a Markdown answer. Selecting approval option 3 denied a model-requested write, and native-denied.txt remained absent. Selecting option 1 approved a user shell command, which printed native-shell-result and exited with code 0. The terminal resized from 110 to 40 and back to 110 columns, then /exit terminated cleanly. The key remained in the environment. Actual escape-stream screenshots, terminal text, verification.json and the repeatable driver are saved under .audit/runtime/prism-20261010 and .audit/runtime/verify-prism.py, both ignored by Git.

The native run preceded the final reasoning-indicator and restored user-shell receipt fixes. The final real-Pi fixture and renderer tests cover those changes. The screenshots render the captured terminal stream with Pyte and Pillow; font glyph coverage can differ from an interactive terminal. Browser-only glow and grain are not terminal features. Chinese IME, clipboard and external-editor acceptance remain limited as described below.

## Limits

There is no OS sandbox. Read Only removes shell and mutation tools. Ask confirms every mutation or command. Approved shell commands run with the operator's privileges.

Windows process-tree cancellation is tested. POSIX process groups are implemented but not tested on a macOS or Linux host. Memory-terminal tests cover paste safety, narrow layouts and Chinese text, but they cannot prove each terminal's IME behavior. The system clipboard and external editor need desktop acceptance. Session append uses Pi JSONL storage, without database transaction or fsync guarantees.

A force-killed host cannot guarantee that its shell descendants have exited. Resuming a session with an active run marker restricts that session to inspection. Other sessions in the workspace can continue or start independently. Operators must inspect orphaned commands before manually resolving a run marker. Changing the configuration home does not share run markers; session writer leases are shared across homes. A crash during lease creation or stale-lock recovery can leave an incomplete lease or recovery file; the CLI remains a viewer and reports the path for manual inspection. The product does not claim automatic crash rollback or automatic orphan recovery.
