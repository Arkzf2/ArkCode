# ArkCode v0.1 verification

Date: 2026-10-09. Platform: Windows. Node: 24.18.0. Pi SDK: 1.1.0.

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

A force-killed host cannot guarantee that its shell descendants have exited. On normal startup, active run markers in the same ArkCode home keep the workspace Read Only across new sessions, including runs without a history file. Operators must inspect orphaned commands before manually resolving those markers. Changing the configuration home does not share those run markers. Workspace writer leases themselves are shared across homes. A crash during lease creation or stale-lock recovery can leave an incomplete lease or recovery file; the CLI remains a viewer and reports the path for manual inspection. The product does not claim automatic crash rollback or automatic orphan recovery.
