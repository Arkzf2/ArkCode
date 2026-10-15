# Pi SDK migration

Acceptance: ArkCode uses the official Pi 1.2.0 MCP extension and CodeMode, delegates all six basic tools to SDK definitions, preserves host permissions and execution protection, and has no duplicate MCP connection manager or flat source layout. Type checks, build, regression tests, and a real MCP connection smoke check must pass.

Workflow:
- [x] Read the implementation, SDK contracts, and skill principles.
- [x] Capture the existing test baseline: 132 passed.
- [x] Add a reproducible, version-checked SDK patch for host MCP lifecycle, credentials, and authorization hooks.
- [x] Replace the custom MCP manager and enable official CodeMode.
- [x] Delegate Read, Write, Edit, Grep, Glob, and Bash to SDK definitions with host operations.
- [x] Organize source by application, configuration, permissions, integrations, tools, session, context, and UI responsibilities; migrate all imports.
- [x] Run focused behavior checks and full verification: 152 passed; type check and build passed. Independent review found the truncated-output read gap, now fixed and tested.
- [x] Verify a packed release installs and runs in a fresh directory: online install, installed CLI help, and patch idempotence passed. Offline attempt lacked a cached dependency.

Scope: 20 source files, 10 existing test files, the pinned SDK integration patch, and documentation. The SDK API patch is the riskiest unit. Tool delegation can be implemented in an isolated worktree while the host integration is completed.

Design: keep ArkCode's user-facing tool names and permission semantics; reuse SDK definitions and structured results. CodeMode starts in `on` mode with model execution disabled. MCP configuration stays under ArkCode's home/project directories. No private runtime imports or edits to the separate Pi checkout.

Verification evidence:
- `.audit/runtime/migration-baseline.log`: 132 tests passed before migration.
- `.audit/runtime/migration-final-tests.log`: 152 tests passed after migration, including actual SDK sessions and local MCP/shell behavior.
- `.audit/runtime/migration-final-check.log` and `migration-final-build.log`: type check and clean build.
- `.audit/runtime/mcp-live-smoke.log`: installed Playwright and Bing Search connected with 25 and 2 tools; targeted reconnect and shutdown completed; no remote tool calls.
- `docs/development/PI_SDK_PATCH.md`: reproducible patch boundaries and upgrade procedure.
- `.audit/runtime/package-install-online.log` and `installed-cli-help.log`: fresh packed-release installation and installed CLI startup. The offline attempt in `package-install.log` failed with `ENOTCACHED` before the successful online retry.

Limits: MCP resources/prompts are disabled pending per-server resource authorization. CodeMode model execution is disabled. Browser OAuth login is wired to the official flow but was not completed against a real external authorization server. Tests run on Windows; no macOS/Linux runtime verification in this migration. A kimi-k3 review attempt failed with HTTP 429; a separate Codex reviewer performed the independent review instead.
